import type { TunnelBroker, TunnelRequest, TunnelResponse } from "@supreme/tunnel-broker";
import type { LinkRecord } from "./oauth.js";

/**
 * The bridge from a voice directive to local device control. The cloud Voice service never controls
 * a device directly — it forwards a Supreme command to the hub over the Tunnel Broker, where
 * identity + RBAC are enforced exactly as on the LAN (blueprint §9, invariant: HA never exposed).
 *
 * `HubRouter` is the seam: production uses `BrokerHubRouter` (resolve home→hub, forward over the
 * mTLS tunnel, present the link's hub-scoped token); tests inject a fake.
 */

/** A device as the hub returns it (subset of the Supreme Device we need for voice). */
export interface HubDevice {
  id: string;
  name: string;
  roomId: string | null;
  supremeType: string;
  status?: string;
  capabilities: { kind: string }[];
  state?: Record<string, { kind: string } & Record<string, unknown>>;
}

export interface HubRouter {
  /** Enumerate the linked home's devices (Discovery / SYNC). */
  listDevices(link: LinkRecord): Promise<HubDevice[]>;
  /** Fetch one device (QUERY / ReportState). */
  getDevice(link: LinkRecord, deviceId: string): Promise<HubDevice | undefined>;
  /** Send a Supreme capability command (EXECUTE / directive). */
  command(link: LinkRecord, deviceId: string, command: HubCommand): Promise<{ ok: boolean; status: number }>;
}

// ── Canonical intent → Supreme hub command ─────────────────────────────────────────────────────
/** The canonical directive shape every assistant webhook normalizes to before the hub command. */
export type CanonicalIntent =
  | { intent: "TurnOn" }
  | { intent: "TurnOff" }
  | { intent: "SetBrightness"; brightnessPct: number }
  | { intent: "SetColor"; hue: number; saturationPct: number }
  | { intent: "SetColorTemperature"; kelvin: number }
  | { intent: "SetTargetTemperature"; targetC: number }
  | { intent: "SetPosition"; positionPct: number }
  | { intent: "Open" }
  | { intent: "Close" }
  | { intent: "Lock" }
  | { intent: "Unlock" };

/** A Supreme CapabilityCommand (mirrors domain-model's discriminated union the hub validates). */
export type HubCommand =
  | { capability: "onoff"; action: "on" | "off" | "toggle" }
  | { capability: "brightness"; action: "set" | "on" | "off"; level?: number }
  | { capability: "color"; hue?: number; saturation?: number; kelvin?: number; level?: number }
  | { capability: "temperature"; targetC?: number; mode?: "off" | "heat" | "cool" | "auto" | "fan_only" }
  | { capability: "position"; action: "open" | "close" | "stop" | "set"; position?: number }
  | { capability: "lock"; action: "lock" | "unlock" };

const clampPct = (v: number): number => Math.max(0, Math.min(100, Math.round(v)));

/**
 * Translate a canonical intent into the hub's real CapabilityCommand. This is the single source of
 * truth shared by the Alexa and Google webhooks — both normalize to CanonicalIntent first, so the
 * mapping to a valid Supreme command lives in exactly one place.
 */
export function toHubCommand(c: CanonicalIntent): HubCommand {
  switch (c.intent) {
    case "TurnOn":
      return { capability: "onoff", action: "on" };
    case "TurnOff":
      return { capability: "onoff", action: "off" };
    case "SetBrightness":
      return { capability: "brightness", action: "set", level: clampPct(c.brightnessPct) };
    case "SetColor":
      return { capability: "color", hue: Math.max(0, Math.min(360, Math.round(c.hue))), saturation: clampPct(c.saturationPct) };
    case "SetColorTemperature":
      return { capability: "color", kelvin: Math.max(1000, Math.min(10000, Math.round(c.kelvin))) };
    case "SetTargetTemperature":
      return { capability: "temperature", targetC: c.targetC };
    case "SetPosition":
      return { capability: "position", action: "set", position: clampPct(c.positionPct) };
    case "Open":
      return { capability: "position", action: "open" };
    case "Close":
      return { capability: "position", action: "close" };
    case "Lock":
      return { capability: "lock", action: "lock" };
    case "Unlock":
      return { capability: "lock", action: "unlock" };
  }
}

// ── Broker-backed implementation ───────────────────────────────────────────────────────────────
export interface BrokerHubRouterOptions {
  broker: TunnelBroker;
  /** Resolve a Supreme homeId to the hubId the broker keys connections by. */
  resolveHubId: (homeId: string) => string | undefined;
  timeoutMs?: number;
}

/** Routes voice directives to a hub over the Tunnel Broker, authenticated by the link's hub token. */
export class BrokerHubRouter implements HubRouter {
  constructor(private readonly opts: BrokerHubRouterOptions) {}

  private async forward(link: LinkRecord, req: Omit<TunnelRequest, "headers"> & { headers?: Record<string, string> }): Promise<TunnelResponse> {
    const hubId = this.opts.resolveHubId(link.homeId);
    if (!hubId) throw new HubUnavailableError(`no hub registered for home ${link.homeId}`);
    if (!this.opts.broker.isOnline(hubId)) throw new HubUnavailableError(`hub ${hubId} offline`);
    return this.opts.broker.forward(
      hubId,
      {
        method: req.method,
        path: req.path,
        headers: { ...req.headers, authorization: `Bearer ${link.hubToken}` },
        body: req.body,
      },
      this.opts.timeoutMs,
    );
  }

  async listDevices(link: LinkRecord): Promise<HubDevice[]> {
    const res = await this.forward(link, { method: "GET", path: "/v1/devices" });
    if (res.status !== 200) throw new HubUnavailableError(`device list failed (${res.status})`);
    return (JSON.parse(res.body) as { devices: HubDevice[] }).devices;
  }

  async getDevice(link: LinkRecord, deviceId: string): Promise<HubDevice | undefined> {
    // The hub has no single-device GET; the flat list is the source of truth and stays cheap.
    const devices = await this.listDevices(link);
    return devices.find((d) => d.id === deviceId);
  }

  async command(link: LinkRecord, deviceId: string, command: HubCommand): Promise<{ ok: boolean; status: number }> {
    const res = await this.forward(link, {
      method: "POST",
      path: `/v1/devices/${encodeURIComponent(deviceId)}/command`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command }),
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  }
}

/** The hub for a linked home is offline / unreachable — assistants map this to a transient error. */
export class HubUnavailableError extends Error {}

import dgram from "node:dgram";
import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
} from "@supreme/domain-model";
import {
  bindingKey,
  type DiscoveredDevice,
  type INativeProtocolDriver,
  type ProtocolBinding,
  type StateListener,
} from "@supreme/integration-layer";
import type { AvrRange } from "./avr-capabilities.js";
import {
  buildYamahaMediaState,
  commandToYamaha,
  isYamahaZone,
  parseUpnpDescription,
  parseYamahaEvent,
  parseYamahaFeatures,
  parseYamahaPlayInfo,
  parseYamahaZoneStatus,
  supremeRepeatFromYamaha,
  supremeShuffleFromYamaha,
  yamahaCapabilityConfig,
  yamahaUrl,
  YAMAHA_ZONES,
  type YamahaFeatures,
  type YamahaMediaCache,
  type YamahaZone,
} from "./yamaha-codec.js";
import { ssdpSearch, type SsdpResponse, type SsdpSearchOptions } from "./ssdp.js";
import { bestEffortMacForIp } from "./arp-lookup.js";
import { DriverDiagnosticsTracker, type DriverDiagnosticsSnapshot } from "./driver-diagnostics.js";

/** Kept in sync with `supreme-yamaha`'s manifest `version` (services/drivers/src/manifests.ts). */
const DRIVER_VERSION = "1.0.0";

/** Minimal UDP listening-socket surface (so tests inject a fake instead of a real
 * `dgram` bind) — mirrors the `SsdpSocket` shape in ssdp.ts. */
export interface YamahaEventSocket {
  on(event: "message", cb: (msg: Buffer, rinfo: { address: string }) => void): void;
  bind(cb: () => void): void;
  address(): { port: number };
  close(): void;
}
export type YamahaEventSocketFactory = () => YamahaEventSocket;

function defaultYamahaEventSocket(): YamahaEventSocket {
  const sock = dgram.createSocket({ type: "udp4" });
  return {
    on: (event, cb) => sock.on(event, cb),
    bind: (cb) => sock.bind(cb),
    address: () => sock.address() as { port: number },
    close: () => sock.close(),
  };
}

export interface YamahaDriverOptions {
  fetchImpl?: typeof fetch;
  /** Injectable UDP event listener (tests); defaults to a real bound `dgram` socket. */
  createEventSocket?: YamahaEventSocketFactory;
  /** How often to refresh the device's event-push registration (spec §11.2: it times
   * out after 10 minutes of silence). Default 8 minutes — safely under that. */
  eventRefreshMs?: number;
  /** Sent as the `X-AppName` header identifying this controller (spec §11.2). */
  appName?: string;
  /** Injectable SSDP searcher (tests); defaults to a real multicast M-SEARCH. */
  ssdp?: (opts?: SsdpSearchOptions) => Promise<SsdpResponse[]>;
}

interface YamahaBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  host: string;
  zone: YamahaZone;
  /** UPnP device-description `<modelName>`, threaded through from discovery's
   * `bindConfig.model` when present (§ Diagnostics Console). */
  model: string | null;
}

interface YamahaHostInfo {
  features: YamahaFeatures;
  refreshTimer: ReturnType<typeof setInterval>;
}

/**
 * Real Yamaha Extended Control (YXC/MusicCast) driver (§3) — one physical unit per IP
 * host, up to 4 zones (main/zone2/zone3/zone4) each bindable as its own Supreme device
 * sharing that host's HTTP control + one shared UDP event listener. Every input's
 * dynamic capability (its `play_info_type`) and every zone's volume range/tone range/
 * input list/sound-program list come from a genuine wire query (`/system/getFeatures`)
 * — never hardcoded, unlike the Denon Telnet driver's installer-declared fallback,
 * because Yamaha's API actually offers this data.
 */
export class YamahaProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "yamaha";
  private connected = false;
  private readonly opts: YamahaDriverOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly bindings: YamahaBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly hosts = new Map<string, YamahaHostInfo>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly media = new Map<DeviceId, YamahaMediaCache>();
  private readonly listeners = new Set<StateListener>();
  private readonly diagnostics = new Map<string, DriverDiagnosticsTracker>();
  /** True once a host has had at least one failed request without a successful one
   * since — cleared on the next success, at which point that success counts as a
   * "reconnect" (§ Diagnostics Console). Yamaha has no persistent control socket to
   * literally reconnect (per-request HTTP, see module doc), so this is the honest
   * equivalent: "the host stopped answering, then answered again". */
  private readonly hostDown = new Map<string, boolean>();
  private eventSocket: YamahaEventSocket | null = null;
  private eventPort: number | null = null;

  constructor(opts: YamahaDriverOptions = {}) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async connect(): Promise<void> {
    this.connected = true;
    const factory = this.opts.createEventSocket ?? defaultYamahaEventSocket;
    const socket = factory();
    this.eventPort = await new Promise<number>((resolve) => {
      socket.bind(() => resolve(socket.address().port));
    });
    socket.on("message", (msg, rinfo) => this.onEventMessage(rinfo.address, msg.toString()));
    this.eventSocket = socket;
  }

  async disconnect(): Promise<void> {
    for (const info of this.hosts.values()) clearInterval(info.refreshTimer);
    this.hosts.clear();
    this.diagnostics.clear();
    this.hostDown.clear();
    this.eventSocket?.close();
    this.eventSocket = null;
    this.eventPort = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    const host = binding.address;
    const zoneRaw = typeof binding.config?.zone === "string" ? binding.config.zone : "main";
    const zone: YamahaZone = isYamahaZone(zoneRaw) ? zoneRaw : "main";
    const model = typeof binding.config?.model === "string" ? binding.config.model : null;
    this.bindings.push({ deviceId: binding.deviceId, capability: binding.capability, host, zone, model });
    this.devices.add(binding.deviceId);
    if (!this.media.has(binding.deviceId)) {
      this.media.set(binding.deviceId, { power: false, volume: 0, muted: false, input: "", netusb: null });
    }
    if (this.connected) {
      await this.ensureHostFeatures(host);
      await this.syncZone(host, zone);
    }
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`yamaha: ${deviceId} not bound for ${command.capability}`);
    const hostInfo = await this.ensureHostFeatures(b.host);
    const volumeRange = hostInfo.features.zones.find((z) => z.id === b.zone)?.volumeRange ?? { min: 0, max: 100, step: 1 };
    const cache = this.media.get(deviceId);

    if (command.capability === "media" && command.action === "shuffle" && typeof command.shuffle === "boolean") {
      const current = cache?.netusb ? supremeShuffleFromYamaha(cache.netusb.shuffle) : false;
      if (current === command.shuffle) return; // toggle is the only wire primitive; already there
    }
    if (command.capability === "media" && command.action === "repeat" && command.repeat) {
      const current = cache?.netusb ? supremeRepeatFromYamaha(cache.netusb.repeat) : "off";
      if (current === command.repeat) return;
    }

    const requests = commandToYamaha(command, b.zone, { volumeRange });
    if (!requests) {
      throw new Error(`yamaha: unsupported command for ${command.capability}/${"action" in command ? command.action : "?"}`);
    }
    for (const req of requests) await this.getJson(b.host, req.group, req.method, req.params);
    await this.syncZone(b.host, b.zone); // reflect promptly; the UDP event confirms shortly after
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  getCapabilityConfig(deviceId: DeviceId, capability: CapabilityKind): Record<string, unknown> | null {
    if (capability !== "media") return null;
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === "media");
    if (!b) return null;
    const zf = this.hosts.get(b.host)?.features.zones.find((z) => z.id === b.zone);
    return zf ? (yamahaCapabilityConfig(zf) as unknown as Record<string, unknown>) : null;
  }

  /** Diagnostics Console (§ Universal AV Driver SDK) — real per-host request/response
   * counters, never fabricated. Yamaha's UPnP device description genuinely reports a
   * `<modelName>`; there is no firmware field anywhere in the Basic YXC spec, so that
   * stays honestly `null`. Yamaha has no persistent control socket (per-request HTTP,
   * see module doc) — "connection status"/"reconnect" are the closest honest
   * equivalent: whether the host is currently answering, and how many times it stopped
   * answering and then answered again. */
  getDiagnostics(deviceId: DeviceId): DriverDiagnosticsSnapshot | null {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b) return null;
    const tracker = this.diagnostics.get(b.host);
    const hasFeatures = this.hosts.has(b.host);
    const status = this.hostDown.get(b.host) ? "disconnected" : hasFeatures ? "connected" : "connecting";
    const empty = new DriverDiagnosticsTracker();
    return (tracker ?? empty).snapshot(status, {
      protocol: this.protocol,
      driverVersion: DRIVER_VERSION,
      model: b.model,
      firmware: null,
      ip: b.host,
      mac: bestEffortMacForIp(b.host),
    });
  }

  async discover(): Promise<DiscoveredDevice[]> {
    // Real SSDP discovery: MediaRenderer devices, filtered to Yamaha by fetching each
    // one's UPnP description XML and checking <manufacturer> (spec doesn't define a
    // Yamaha-specific ST, so this is the standard UPnP-level check).
    const search = this.opts.ssdp ?? ssdpSearch;
    const responses = await search({ st: "urn:schemas-upnp-org:device:MediaRenderer:1" });
    const out: DiscoveredDevice[] = [];
    for (const r of responses) {
      if (!r.location) continue;
      try {
        const res = await this.fetchImpl(r.location);
        if (!res.ok) continue;
        const xml = await res.text();
        const { manufacturer, friendlyName, modelName } = parseUpnpDescription(xml);
        if (!manufacturer || !/yamaha/i.test(manufacturer)) continue;
        // §Automatic Zone Generation: `/system/getFeatures` is a genuine wire query
        // (not fabricated — same call `bind()` makes) that lists every zone this
        // physical unit actually has, so extra zones (zone2/3/4) are discoverable up
        // front instead of staying a manual second/third/fourth bind.
        let zones: { id: string; label: string }[] = [{ id: "main", label: "Main Zone" }];
        try {
          const featuresJson = await this.getJson(r.address, "system", "getFeatures", {});
          const parsed = parseYamahaFeatures(featuresJson);
          if (parsed.zones.length > 0) {
            zones = parsed.zones.map((z) => ({ id: z.id, label: z.id === "main" ? "Main Zone" : `Zone ${z.id.slice(4)}` }));
          }
        } catch {
          // getFeatures failed but the UPnP description succeeded — still a real find,
          // just main-zone-only until the next successful discovery/bind.
        }
        out.push({
          backendId: r.address,
          suggestedName: friendlyName || `Yamaha ${r.address}`,
          capabilities: ["onoff", "media"] as DiscoveredDevice["capabilities"],
          raw: {
            ip: r.address,
            location: r.location,
            manufacturer,
            friendlyName: friendlyName ?? null,
            zones,
            bindConfig: { zone: "main", ...(modelName ? { model: modelName } : {}) },
            // §Automatic Room Assignment: MusicCast's own setup flow has the installer
            // name each physical unit by room — a persistent, user-configurable name,
            // not a generic model string (confirmed in ADR 0015 §2.12).
            ...(friendlyName ? { locationHint: { raw: friendlyName, source: "persistent_user_zone_name" } } : {}),
          },
        });
      } catch {
        // tolerate one bad device during discovery
      }
    }
    return out;
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async ensureHostFeatures(host: string): Promise<YamahaHostInfo> {
    const existing = this.hosts.get(host);
    if (existing) return existing;
    const featuresJson = await this.getJson(host, "system", "getFeatures", {});
    const features = parseYamahaFeatures(featuresJson);
    const refreshMs = this.opts.eventRefreshMs ?? 8 * 60 * 1000;
    const refreshTimer = setInterval(() => {
      void this.getJson(host, "system", "getFeatures", {}).catch(() => {
        // transient network error — the next scheduled refresh tries again
      });
    }, refreshMs);
    (refreshTimer as { unref?: () => void }).unref?.();
    const info: YamahaHostInfo = { features, refreshTimer };
    this.hosts.set(host, info);
    return info;
  }

  private async syncZone(host: string, zone: YamahaZone): Promise<void> {
    const statusJson = await this.getJson(host, zone, "getStatus", {});
    const status = parseYamahaZoneStatus(statusJson);
    const inputType = this.hosts.get(host)?.features.systemInputs.find((i) => i.id === status.input)?.playInfoType ?? "none";
    let netusb: YamahaMediaCache["netusb"] = null;
    if (inputType === "netusb") {
      try {
        const playJson = await this.getJson(host, "netusb", "getPlayInfo", {});
        netusb = parseYamahaPlayInfo(playJson, host);
      } catch {
        // tolerate transient errors; last-known netusb state (if any) is left in place below
      }
    }
    for (const b of this.bindings.filter((x) => x.host === host && x.zone === zone)) {
      const cache = this.media.get(b.deviceId);
      if (!cache) continue;
      cache.power = status.power;
      cache.volume = status.volume;
      cache.muted = status.muted;
      cache.input = status.input;
      cache.soundProgram = status.soundProgram;
      cache.bass = status.bass;
      cache.treble = status.treble;
      cache.netusb = netusb;
      this.media.set(b.deviceId, cache);
    }
    this.emitZone(host, zone);
  }

  private onEventMessage(sourceIp: string, raw: string): void {
    const event = parseYamahaEvent(raw);
    if (!event) return;
    const host = this.bindings.find((b) => b.host === sourceIp)?.host;
    if (!host) return; // event from an IP we don't manage — ignore
    for (const zone of YAMAHA_ZONES) {
      const ze = event.zones[zone];
      if (!ze) continue;
      if (!this.bindings.some((b) => b.host === host && b.zone === zone)) continue;
      if (ze.statusUpdated || event.netusbPlayInfoUpdated) {
        void this.syncZone(host, zone);
        continue;
      }
      for (const b of this.bindings.filter((x) => x.host === host && x.zone === zone)) {
        const cache = this.media.get(b.deviceId);
        if (!cache) continue;
        if (ze.power !== undefined) cache.power = ze.power;
        if (ze.volume !== undefined) cache.volume = ze.volume;
        if (ze.muted !== undefined) cache.muted = ze.muted;
        if (ze.input !== undefined) cache.input = ze.input;
        this.media.set(b.deviceId, cache);
      }
      this.emitZone(host, zone);
    }
  }

  private emitZone(host: string, zone: YamahaZone): void {
    const volumeRange: AvrRange = this.hosts.get(host)?.features.zones.find((z) => z.id === zone)?.volumeRange ?? {
      min: 0, max: 100, step: 1,
    };
    for (const b of this.bindings.filter((x) => x.host === host && x.zone === zone)) {
      const cache = this.media.get(b.deviceId);
      if (!cache) continue;
      if (b.capability === "onoff") this.record(b.deviceId, "onoff", { kind: "onoff", on: cache.power });
      else if (b.capability === "media") this.record(b.deviceId, "media", buildYamahaMediaState(cache, volumeRange));
    }
  }

  private diagnosticsFor(host: string): DriverDiagnosticsTracker {
    let t = this.diagnostics.get(host);
    if (!t) {
      t = new DriverDiagnosticsTracker();
      this.diagnostics.set(host, t);
    }
    return t;
  }

  private async getJson(host: string, group: string, method: string, params: Record<string, string | number>): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {};
    if (this.eventPort !== null) {
      headers["X-AppName"] = this.opts.appName ?? "SupremeOS/1.0";
      headers["X-AppPort"] = String(this.eventPort);
    }
    const tracker = this.diagnosticsFor(host);
    const label = `${group}/${method}`;
    tracker.recordSend(label);
    try {
      const res = await this.fetchImpl(yamahaUrl(host, group, method, params), { method: "GET", headers });
      if (!res.ok) throw new Error(`yamaha: ${res.status} ${group}/${method}`);
      const json = (await res.json()) as Record<string, unknown>;
      tracker.recordReceive(`${label} ${res.status}`);
      if (this.hostDown.get(host)) tracker.recordReconnect();
      this.hostDown.set(host, false);
      return json;
    } catch (err) {
      this.hostDown.set(host, true);
      tracker.recordError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private record(deviceId: DeviceId, capability: CapabilityKind, state: CapabilityState): void {
    const k = bindingKey(deviceId, capability);
    const prev = this.states.get(k);
    if (prev && JSON.stringify(prev) === JSON.stringify(state)) return;
    this.states.set(k, state);
    for (const l of this.listeners) {
      l({ deviceId, capability, state, ts: new Date().toISOString() });
    }
  }
}

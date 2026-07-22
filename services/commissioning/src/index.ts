import {
  newId,
  type CapabilityKind,
  type Device,
  type DeviceId,
  type Home,
  type ProtocolKind,
  type RoomId,
  type SupremeDeviceType,
} from "@supreme/domain-model";
import { SupremeError } from "@supreme/contracts";
import type { DiscoveredDevice, SupremeIntegrationLayer } from "@supreme/integration-layer";
import type { HomeService } from "@supreme/home";
import type { LocationHint } from "./room-assignment-engine.js";

/**
 * Commissioning orchestration (§9, Phase 2). Discovery aggregates devices the
 * backend already exposes (via the SIL) plus protocol-specific scans (KNX/DALI/
 * Modbus…) provided by the Python commissioning tooling behind {@link IProtocolScanner}.
 * Commissioning turns a discovered device into a first-class Supreme device, binding
 * its capabilities into the SIL registry — all in Supreme terms, no HA leakage.
 */
export interface IProtocolScanner {
  protocol: ProtocolKind;
  scan(): Promise<DiscoveredDevice[]>;
}

/** Real network coordinates resolved during discovery (IP/MAC/host). Only ever set when known. */
export interface NetworkInfo {
  ip?: string;
  mac?: string;
  host?: string;
}

export interface DiscoveredView {
  backendId: string;
  suggestedName: string;
  capabilities: CapabilityKind[];
  /** Where it came from: "backend" (SIL) or a protocol scan. */
  source: string;
  /** Native bus protocol this device lives on (e.g. "mqtt"), enabling auto-bind. */
  protocol?: string;
  /** Network coordinates when the discovery source resolved them (mDNS/Shelly/Matter…). */
  network?: NetworkInfo;
  /** Protocol-specific binding config the driver already resolved at discovery time (a
   * HEOS player's `pid`, an AVR/Yamaha `zone`, …) — pass straight through as the bind
   * `config` so commissioning needs no manual entry beyond room + name. */
  bindConfig?: Record<string, unknown>;
  /** Structural per-capability config the driver already normalized at discovery time (§ ADR
   * 0017 — Capability Normalization), e.g. `{ color: { colorModes: { rgb, cct } } }` — passed
   * straight through to `commission()` so the persisted device's capability carries the SAME
   * structural signal the UI's `getDeviceUiCapabilities()` prefers over state inference. */
  capabilityConfig?: Partial<Record<CapabilityKind, Record<string, unknown>>>;
  /** Room-name hint the driver's own discovery already resolved (a Casambi Group name,
   * an ETS Function/Space, …) — never a guess invented here, only ever what the driver's
   * `raw.room` genuinely reported. Threaded through to `InstallerServices.commissionDevice()`
   * so the SAME shared `resolveOrCreateRoom()` KNX already uses can find-or-create the
   * matching Supreme room, protocol-independently (§ Universal Room Intelligence). */
  roomHint?: string | null;
  /** §Automatic Room Assignment — a real location signal this discovery source
   * genuinely carries (a HEOS/MusicCast zone name, an SSDP friendlyName, …), fed
   * straight into {@link resolveRoomAssignment}. Any driver can supply this; it isn't
   * AVR-specific. Absent when the source has no location signal (e.g. classic Denon
   * Telnet, verified to have none on the wire). */
  locationHint?: LocationHint;
  /** §Automatic Zone Generation — extra logical zones this ONE physical unit exposes,
   * discovered via a genuine wire query (e.g. Yamaha's `getFeatures`), each becoming
   * its own Supreme device sharing the same physical connection. Absent for
   * single-zone devices/protocols. */
  zones?: { id: string; label: string }[];
}

/**
 * Pull real network coordinates out of a discovered device's opaque `raw` metadata. Discovery
 * sources use different shapes (mDNS resolves `addresses`/`host`; Shelly/Matter carry an `ip`/`mac`
 * in TXT), so this reads the common keys defensively and returns only the fields genuinely present —
 * a device on a non-IP bus yields `undefined`, never a fabricated address.
 */
export function extractNetwork(raw: Record<string, unknown> | undefined): NetworkInfo | undefined {
  if (!raw) return undefined;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

  // IP: a direct `ip`/`address` string, or the first entry of an `addresses` array (mDNS A records).
  const addresses = Array.isArray(raw.addresses) ? (raw.addresses as unknown[]) : [];
  const ip = str(raw.ip) ?? str(raw.address) ?? str(addresses.find((a) => typeof a === "string"));
  // MAC: a direct field, or a Shelly-style TXT `id` that is a bare 12-hex MAC.
  const txt = (raw.txt && typeof raw.txt === "object" ? (raw.txt as Record<string, unknown>) : {}) ?? {};
  const macRaw = str(raw.mac) ?? str(txt.mac) ?? str(txt.id);
  const mac = macRaw && /^[0-9a-fA-F]{12}$|^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(macRaw) ? macRaw : undefined;
  const host = str(raw.host);

  if (!ip && !mac && !host) return undefined;
  return { ...(ip ? { ip } : {}), ...(mac ? { mac } : {}), ...(host ? { host } : {}) };
}

export class CommissioningService {
  private readonly scanners = new Map<ProtocolKind, IProtocolScanner>();

  constructor(
    private readonly sil: SupremeIntegrationLayer,
    private readonly home: HomeService,
    scanners: IProtocolScanner[] = [],
  ) {
    for (const s of scanners) this.scanners.set(s.protocol, s);
  }

  /** Discover candidate devices from the backend and any registered scanners. */
  async discover(protocol?: ProtocolKind): Promise<DiscoveredView[]> {
    return (await this.discoverWithStatus(protocol ? [protocol] : undefined)).discovered;
  }

  /**
   * Discovery Driver Selector backend (§ Priority 4): the same discovery `discover()`
   * always did, but when `driverProtocols` is given, ONLY those native-bus protocols
   * actually run (never a frontend-only result filter — `SupremeIntegrationLayer.
   * discoverWithStatus` stops the excluded drivers from being scanned at all), and one
   * driver failing is captured against it without discarding every other driver's
   * successful results (§ Driver Failure Isolation).
   */
  async discoverWithStatus(driverProtocols?: string[]): Promise<{
    discovered: DiscoveredView[];
    driverResults: { protocol: string; status: "complete" | "failed"; count: number; error?: string }[];
  }> {
    const out: DiscoveredView[] = [];
    let driverResults: { protocol: string; status: "complete" | "failed"; count: number; error?: string }[] = [];

    if (!driverProtocols || driverProtocols.length > 0) {
      const result = await this.sil.discoverWithStatus(driverProtocols);
      for (const d of result.devices) out.push(view(d, "backend"));
      driverResults = result.driverResults;
    }
    const scanners = driverProtocols
      ? driverProtocols.map((p) => this.scanners.get(p as ProtocolKind)).filter(Boolean)
      : [...this.scanners.values()];
    for (const scanner of scanners as IProtocolScanner[]) {
      for (const d of await scanner.scan()) out.push(view(d, scanner.protocol));
    }

    // De-duplicate by backendId; backend-sourced entries win.
    const seen = new Map<string, DiscoveredView>();
    for (const v of out) if (!seen.has(v.backendId)) seen.set(v.backendId, v);

    // Never re-surface an already-commissioned device as a "new find". Discovery sources
    // that poll (CoolMaster indoor units, AVR/HEOS/Yamaha SSDP, Shelly/mDNS…) report the
    // same stable backendId on every scan; without this a rescan shows the same physical
    // unit again and pairing it a second time silently creates a duplicate Supreme device
    // for the same hardware — "why are there multiple cards for one AC/light/curtain".
    const discovered = [...seen.values()].filter((v) => !this.sil.registry.reverseLookup(v.backendId));
    return { discovered, driverResults };
  }

  /**
   * Commission a discovered device into a Supreme device in a given room. Each of
   * its capabilities is bound to the discovered backend entity inside the SIL.
   */
  async commission(input: {
    backendId: string;
    name: string;
    roomId: RoomId;
    capabilities: CapabilityKind[];
    /** § ADR 0017 Capability Normalization — structural per-capability config threaded straight
     * from discovery (never state-derived) into the persisted device's own capability config. */
    capabilityConfig?: Partial<Record<CapabilityKind, Record<string, unknown>>>;
    supremeType?: SupremeDeviceType;
    manufacturer?: string | null;
    model?: string | null;
    network?: NetworkInfo;
  }): Promise<Device> {
    const home = await this.requireHome();
    if (input.capabilities.length === 0) {
      throw new SupremeError("validation_failed", "device must declare at least one capability");
    }
    await this.home.requireRoom(input.roomId);

    // Persist the real network coordinates resolved at discovery so the Device Manager can show the
    // device's IP/MAC. Absent for non-IP-bus devices — we store nothing rather than a blank.
    const network = input.network && (input.network.ip || input.network.mac || input.network.host)
      ? input.network
      : undefined;
    const device: Device = {
      id: newId("device") as DeviceId,
      homeId: home.id,
      roomId: input.roomId,
      name: input.name,
      supremeType: input.supremeType ?? inferType(input.capabilities),
      manufacturer: input.manufacturer ?? null,
      model: input.model ?? null,
      driverId: null,
      status: "online",
      capabilities: input.capabilities.map((kind) => ({ kind, config: input.capabilityConfig?.[kind] ?? {} })),
      state: {},
      metadata: { commissionedAt: new Date().toISOString(), ...(network ? { network } : {}) },
    };
    const backendIds = Object.fromEntries(input.capabilities.map((c) => [c, input.backendId]));
    await this.home.addDevice(device, backendIds);
    return device;
  }

  registerScanner(scanner: IProtocolScanner): void {
    this.scanners.set(scanner.protocol, scanner);
  }

  private async requireHome(): Promise<Home> {
    const home = await this.home.getHome();
    if (!home) throw new SupremeError("conflict", "home is not commissioned");
    return home;
  }
}

export { HttpProtocolScanner, type HttpScannerOptions } from "./http-scanner.js";
export { decryptAesEntry, KnxDecryptError, type AesStrength } from "./knx-crypto.js";
export * from "./knx/index.js";
export {
  normalizeLocationName,
  resolveRoomAssignment,
  UNASSIGNED_ROOM_NAME,
  type LocationHint,
  type LocationHintSource,
  type RoomAssignmentDecision,
} from "./room-assignment-engine.js";

function extractLocationHint(raw: Record<string, unknown> | undefined): LocationHint | undefined {
  const h = raw?.locationHint;
  if (!h || typeof h !== "object") return undefined;
  const rec = h as Record<string, unknown>;
  if (typeof rec.raw !== "string" || typeof rec.source !== "string") return undefined;
  if (rec.source !== "explicit_attribute" && rec.source !== "persistent_user_zone_name" && rec.source !== "friendly_name_heuristic") return undefined;
  return { raw: rec.raw, source: rec.source };
}

function extractZones(raw: Record<string, unknown> | undefined): { id: string; label: string }[] | undefined {
  if (!Array.isArray(raw?.zones)) return undefined;
  const zones = (raw.zones as unknown[]).filter(
    (z): z is { id: string; label: string } => !!z && typeof z === "object" && typeof (z as Record<string, unknown>).id === "string" && typeof (z as Record<string, unknown>).label === "string",
  );
  return zones.length > 0 ? zones : undefined;
}

function view(d: DiscoveredDevice, source: string): DiscoveredView {
  const protocol = typeof d.raw?.protocol === "string" ? d.raw.protocol : undefined;
  const network = extractNetwork(d.raw);
  const bindConfig =
    d.raw?.bindConfig && typeof d.raw.bindConfig === "object" && !Array.isArray(d.raw.bindConfig)
      ? (d.raw.bindConfig as Record<string, unknown>)
      : undefined;
  const roomHint = typeof d.raw?.room === "string" && d.raw.room.trim().length > 0 ? d.raw.room : undefined;
  const locationHint = extractLocationHint(d.raw);
  const zones = extractZones(d.raw);
  return {
    backendId: d.backendId,
    suggestedName: d.suggestedName,
    capabilities: d.capabilities,
    // A native-bus device reports its protocol as the source (e.g. "mqtt"), not "backend".
    source: protocol ?? source,
    protocol,
    ...(network ? { network } : {}),
    ...(bindConfig ? { bindConfig } : {}),
    ...(roomHint ? { roomHint } : {}),
    ...(locationHint ? { locationHint } : {}),
    ...(zones ? { zones } : {}),
    ...(d.capabilityConfig ? { capabilityConfig: d.capabilityConfig } : {}),
  };
}

/** Infer a Supreme device type from its capabilities for a sensible default. */
function inferType(caps: CapabilityKind[]): SupremeDeviceType {
  if (caps.includes("color")) return "color_light";
  if (caps.includes("brightness")) return "dimmer";
  if (caps.includes("temperature")) return "thermostat";
  if (caps.includes("position")) return "cover";
  if (caps.includes("media")) return "media_player";
  if (caps.includes("lock")) return "lock";
  if (caps.includes("sensor")) return "sensor";
  if (caps.includes("onoff")) return "switch";
  return "switch";
}

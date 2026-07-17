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
  /** Room-name hint the driver's own discovery already resolved (a Casambi Group name,
   * an ETS Function/Space, …) — never a guess invented here, only ever what the driver's
   * `raw.room` genuinely reported. Threaded through to `InstallerServices.commissionDevice()`
   * so the SAME shared `resolveOrCreateRoom()` KNX already uses can find-or-create the
   * matching Supreme room, protocol-independently (§ Universal Room Intelligence). */
  roomHint?: string | null;
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
    const out: DiscoveredView[] = [];

    if (!protocol) {
      for (const d of await this.sil.discover()) out.push(view(d, "backend"));
    }
    const scanners = protocol
      ? [this.scanners.get(protocol)].filter(Boolean)
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
    return [...seen.values()].filter((v) => !this.sil.registry.reverseLookup(v.backendId));
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
      capabilities: input.capabilities.map((kind) => ({ kind, config: {} })),
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

function view(d: DiscoveredDevice, source: string): DiscoveredView {
  const protocol = typeof d.raw?.protocol === "string" ? d.raw.protocol : undefined;
  const network = extractNetwork(d.raw);
  const bindConfig =
    d.raw?.bindConfig && typeof d.raw.bindConfig === "object" && !Array.isArray(d.raw.bindConfig)
      ? (d.raw.bindConfig as Record<string, unknown>)
      : undefined;
  const roomHint = typeof d.raw?.room === "string" && d.raw.room.trim().length > 0 ? d.raw.room : undefined;
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

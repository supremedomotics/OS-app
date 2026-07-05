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

export interface DiscoveredView {
  backendId: string;
  suggestedName: string;
  capabilities: CapabilityKind[];
  /** Where it came from: "backend" (SIL) or a protocol scan. */
  source: string;
  /** Native bus protocol this device lives on (e.g. "mqtt"), enabling auto-bind. */
  protocol?: string;
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
    return [...seen.values()];
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
  }): Promise<Device> {
    const home = await this.requireHome();
    if (input.capabilities.length === 0) {
      throw new SupremeError("validation_failed", "device must declare at least one capability");
    }
    await this.home.requireRoom(input.roomId);

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
      metadata: { commissionedAt: new Date().toISOString() },
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
export {
  parseKnxGroupExport,
  inferCapability,
  groupIntoDevices,
  normalizeDpt,
  type KnxGroupAddress,
  type ImportedDevice,
  type ImportedBinding,
} from "./knx-import.js";
export { unzipKnxproj, parseKnxProject, addressFromInt } from "./knx-project.js";
export { decryptAesEntry, KnxDecryptError, type AesStrength } from "./knx-crypto.js";

function view(d: DiscoveredDevice, source: string): DiscoveredView {
  const protocol = typeof d.raw?.protocol === "string" ? d.raw.protocol : undefined;
  return {
    backendId: d.backendId,
    suggestedName: d.suggestedName,
    capabilities: d.capabilities,
    // A native-bus device reports its protocol as the source (e.g. "mqtt"), not "backend".
    source: protocol ?? source,
    protocol,
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

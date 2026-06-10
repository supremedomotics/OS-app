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
import {
  capabilitiesFromZclClusters,
  commandToZcl,
  stateFromZclReport,
  zclClusterForCapability,
} from "./zigbee-codec.js";

/** A device endpoint on the Zigbee network. */
export interface ZigbeeAddress {
  ieeeAddr: string;
  endpoint: number;
}

/** An inbound ZCL attribute report from a device. */
export interface ZigbeeReport {
  ieeeAddr: string;
  endpoint?: number;
  cluster: string;
  data: Record<string, unknown>;
}

export interface ZigbeeDeviceInfo {
  ieeeAddr: string;
  endpoint: number;
  clusters: string[];
  manufacturerName?: string;
  modelId?: string;
}

/**
 * Zigbee coordinator transport seam. A real hub provides a zigbee-herdsman controller
 * bound to the coordinator radio (ConBee/Sonoff/CC26x2…); tests inject a fake. All
 * radio + ZCL framing stays behind this interface so the codec/driver are unit-tested.
 */
export interface ZigbeeController {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Send a ZCL cluster command to a device endpoint. */
  command(addr: ZigbeeAddress, cluster: string, command: string, payload: Record<string, unknown>): Promise<void>;
  /** Subscribe to inbound ZCL attribute reports. */
  onReport(handler: (report: ZigbeeReport) => void): void;
  /** Paired devices (for discovery). */
  devices(): Promise<ZigbeeDeviceInfo[]>;
}

export interface ZigbeeDriverOptions {
  /** Coordinator serial port, e.g. "/dev/ttyACM0". */
  port?: string;
  /** herdsman adapter type, e.g. "zstack" | "deconz" | "ezsp". */
  adapter?: string;
  /** Path for the herdsman device database. */
  databasePath?: string;
  /** Injectable controller (tests pass a fake; prod wires zigbee-herdsman). */
  createController?: (opts: ZigbeeDriverOptions) => Promise<ZigbeeController>;
}

interface ZigbeeBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  addr: ZigbeeAddress;
  cluster: string;
  config: Record<string, unknown>;
}

/**
 * Real native Zigbee protocol driver (§3) — speaks ZCL directly to a coordinator radio
 * via zigbee-herdsman, no MQTT broker or Zigbee2MQTT in the path. Commands become ZCL
 * cluster commands; device reports arrive as attribute reports; discover() lists paired
 * devices. Confines all radio/ZCL detail; emits pure Supreme capabilities.
 */
export class ZigbeeProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "zigbee";
  private controller: ZigbeeController | null = null;
  private readonly opts: ZigbeeDriverOptions;
  private readonly bindings: ZigbeeBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();

  constructor(opts: ZigbeeDriverOptions = {}) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.controller) return;
    const factory = this.opts.createController ?? defaultZigbeeController;
    this.controller = await factory(this.opts);
    await this.controller.start();
    this.controller.onReport((report) => this.onReport(report));
  }

  async disconnect(): Promise<void> {
    await this.controller?.stop();
    this.controller = null;
  }

  isConnected(): boolean {
    return this.controller !== null;
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    const cluster = zclClusterForCapability(binding.capability);
    if (!cluster) throw new Error(`zigbee: capability ${binding.capability} has no ZCL cluster mapping`);
    this.bindings.push({
      deviceId: binding.deviceId,
      capability: binding.capability,
      addr: parseAddress(binding.address),
      cluster,
      config: binding.config ?? {},
    });
    this.devices.add(binding.deviceId);
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    if (!this.controller) throw new Error("zigbee: not connected");
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`zigbee: ${deviceId} not bound for ${command.capability}`);
    const prev = this.states.get(bindingKey(deviceId, command.capability)) ?? null;
    const zcl = commandToZcl(command, prev);
    if (!zcl) throw new Error(`zigbee: unsupported command for ${command.capability}`);
    await this.controller.command(b.addr, zcl.cluster, zcl.command, zcl.payload);
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    if (!this.controller) return [];
    const devices = await this.controller.devices();
    return devices
      .map((d) => ({
        backendId: `${d.ieeeAddr}/${d.endpoint}`,
        suggestedName: d.modelId ?? `Zigbee ${d.ieeeAddr}`,
        capabilities: capabilitiesFromZclClusters(d.clusters),
        raw: { manufacturer: d.manufacturerName ?? null, model: d.modelId ?? null },
      }))
      .filter((d) => d.capabilities.length > 0);
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private onReport(report: ZigbeeReport): void {
    for (const b of this.bindings) {
      if (b.addr.ieeeAddr !== report.ieeeAddr) continue;
      if (report.endpoint !== undefined && b.addr.endpoint !== report.endpoint) continue;
      const prev = this.states.get(bindingKey(b.deviceId, b.capability)) ?? null;
      const state = stateFromZclReport(b.capability, report.cluster, report.data, prev, b.config);
      if (state) this.record(b, state);
    }
  }

  private record(b: ZigbeeBinding, state: CapabilityState): void {
    const k = bindingKey(b.deviceId, b.capability);
    const prev = this.states.get(k);
    if (prev && JSON.stringify(prev) === JSON.stringify(state)) return;
    this.states.set(k, state);
    for (const l of this.listeners) {
      l({ deviceId: b.deviceId, capability: b.capability, state, ts: new Date().toISOString() });
    }
  }
}

function parseAddress(address: string): ZigbeeAddress {
  const [ieeeAddr, endpoint] = address.split("/");
  return { ieeeAddr: ieeeAddr ?? address, endpoint: Number(endpoint ?? 1) };
}

/** Default controller backed by the optional `zigbee-herdsman` stack. */
async function defaultZigbeeController(_opts: ZigbeeDriverOptions): Promise<ZigbeeController> {
  throw new Error(
    "zigbee: no controller configured — provide createController (a zigbee-herdsman " +
      "controller bound to the coordinator radio) or run the Zigbee subsystem on the hub",
  );
}

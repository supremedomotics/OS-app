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
  capabilitiesFromClusters,
  clusterForCapability,
  invocationFromCommand,
  stateFromAttribute,
} from "./matter-codec.js";
import { parseMatterSetupCode, type MatterOnboardingPayload } from "./matter-pairing.js";

/** A node/endpoint address on the Matter fabric. */
export interface MatterAddress {
  nodeId: string;
  endpoint: number;
}

export interface MatterAttributeReport {
  cluster: string;
  attribute: string;
  value: unknown;
}

export interface MatterNodeInfo {
  nodeId: string;
  endpoint: number;
  clusters: string[];
  vendor?: string;
  product?: string;
}

/**
 * Matter controller transport seam. A real hub provides a fabric-initialized
 * controller (the optional `@matter/main` stack running on the hub); tests inject a
 * fake. Keeping the controller behind this interface keeps all Matter/CHIP detail out
 * of the driver and makes the capability mapping fully unit-testable.
 */
export interface MatterController {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Invoke a cluster command on a node endpoint. */
  invoke(addr: MatterAddress, cluster: string, command: string, fields: Record<string, unknown>): Promise<void>;
  /** Subscribe to a node endpoint's attribute reports. */
  subscribe(addr: MatterAddress, handler: (report: MatterAttributeReport) => void): void;
  /** Commissioned nodes on the fabric (for discovery). */
  nodes(): Promise<MatterNodeInfo[]>;
  /**
   * Onboard a NEW node onto the fabric from a parsed setup code: opens a PASE session with the
   * discriminator + passcode, runs CASE, installs the operational cert, and returns the joined
   * node. The real (hardware) controller performs PASE/CASE; tests fake it.
   */
  commission(payload: MatterOnboardingPayload): Promise<MatterNodeInfo>;
}

export interface MatterDriverOptions {
  /** Filesystem path for the controller's fabric/credential storage. */
  storagePath?: string;
  /** Injectable controller (tests pass a fake; prod wires the @matter/main controller). */
  createController?: (opts: { storagePath?: string }) => Promise<MatterController>;
}

interface MatterBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  addr: MatterAddress;
  cluster: string;
  config: Record<string, unknown>;
}

/**
 * Real Matter protocol driver (§3, §9) — the blueprint's local, user-activatable
 * controller for Matter-over-Thread/Wi-Fi devices. Commands become cluster
 * invocations; device state arrives as attribute reports. Ships disabled; enabled on
 * demand (gated at the boot edge).
 */
export class MatterProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "matter";
  private controller: MatterController | null = null;
  private readonly opts: MatterDriverOptions;
  private readonly bindings: MatterBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();
  private readonly commissionListeners = new Set<(node: MatterNodeInfo) => void>();

  constructor(opts: MatterDriverOptions = {}) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.controller) return;
    const factory = this.opts.createController ?? defaultMatterController;
    this.controller = await factory({ storagePath: this.opts.storagePath });
    await this.controller.connect();
    for (const b of this.bindings) this.observe(b);
  }

  async disconnect(): Promise<void> {
    await this.controller?.disconnect();
    this.controller = null;
  }

  isConnected(): boolean {
    return this.controller !== null;
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    const cluster = clusterForCapability(binding.capability);
    if (!cluster) throw new Error(`matter: capability ${binding.capability} has no cluster mapping`);
    const entry: MatterBinding = {
      deviceId: binding.deviceId,
      capability: binding.capability,
      addr: parseAddress(binding.address),
      cluster,
      config: binding.config ?? {},
    };
    this.bindings.push(entry);
    this.devices.add(binding.deviceId);
    if (this.controller) this.observe(entry);
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    if (!this.controller) throw new Error("matter: not connected");
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`matter: ${deviceId} not bound for ${command.capability}`);
    const prev = this.states.get(bindingKey(deviceId, command.capability)) ?? null;
    const inv = invocationFromCommand(command, prev);
    if (!inv) throw new Error(`matter: unsupported command for ${command.capability}`);
    await this.controller.invoke(b.addr, inv.cluster, inv.command, inv.fields);
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    if (!this.controller) return [];
    const nodes = await this.controller.nodes();
    return nodes
      .map((n) => ({
        backendId: `${n.nodeId}/${n.endpoint}`,
        suggestedName: n.product ?? `Matter ${n.nodeId}/${n.endpoint}`,
        capabilities: capabilitiesFromClusters(n.clusters),
        raw: { vendor: n.vendor ?? null, product: n.product ?? null },
      }))
      .filter((d) => d.capabilities.length > 0);
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Notified when a new node joins the fabric (the fabric manager mirrors it to the cloud). */
  onCommissioned(listener: (node: MatterNodeInfo) => void): () => void {
    this.commissionListeners.add(listener);
    return () => this.commissionListeners.delete(listener);
  }

  /**
   * Commission a device from its setup code (manual pairing code or `MT:` QR). Validates the code,
   * onboards the node onto the fabric, and returns it as a Supreme DiscoveredDevice the SIL can
   * register. Throws a clear error if Matter isn't connected or the code is invalid.
   */
  async commission(setupCode: string): Promise<DiscoveredDevice> {
    if (!this.controller) throw new Error("matter: not connected");
    const payload = parseMatterSetupCode(setupCode);
    const node = await this.controller.commission(payload);
    for (const l of this.commissionListeners) l(node);
    const caps = capabilitiesFromClusters(node.clusters);
    if (caps.length === 0) throw new Error(`matter: node ${node.nodeId} exposes no controllable capability`);
    return {
      backendId: `${node.nodeId}/${node.endpoint}`,
      suggestedName: node.product ?? `Matter ${node.nodeId}/${node.endpoint}`,
      capabilities: caps,
      raw: { vendor: node.vendor ?? null, product: node.product ?? null, nodeId: node.nodeId },
    };
  }

  private observe(b: MatterBinding): void {
    if (!this.controller) return;
    this.controller.subscribe(b.addr, (report) => {
      const prev = this.states.get(bindingKey(b.deviceId, b.capability)) ?? null;
      const state = stateFromAttribute(b.capability, report.cluster, report.attribute, report.value, prev, b.config);
      if (state) this.record(b, state);
    });
  }

  private record(b: MatterBinding, state: CapabilityState): void {
    const k = bindingKey(b.deviceId, b.capability);
    const prev = this.states.get(k);
    if (prev && JSON.stringify(prev) === JSON.stringify(state)) return;
    this.states.set(k, state);
    for (const l of this.listeners) {
      l({ deviceId: b.deviceId, capability: b.capability, state, ts: new Date().toISOString() });
    }
  }
}

function parseAddress(address: string): MatterAddress {
  const [nodeId, endpoint] = address.split("/");
  return { nodeId: nodeId ?? address, endpoint: Number(endpoint ?? 1) };
}

/**
 * Default controller backed by the optional `@matter/main` stack. Real Matter
 * commissioning + fabric storage is a substantial subsystem; a production hub
 * initializes it here. Until that is provisioned this surfaces a clear, actionable
 * error rather than pretending to be connected.
 */
async function defaultMatterController(_opts: { storagePath?: string }): Promise<MatterController> {
  throw new Error(
    "matter: no controller configured — provide createController (a fabric-initialized " +
      "@matter/main controller that performs PASE/CASE commissioning) or run the Matter " +
      "controller subsystem on the hub",
  );
}

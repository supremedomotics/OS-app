import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
} from "@supreme/domain-model";
import type {
  BackendStateEvent,
  DiscoveredDevice,
  IBackendAdapter,
  StateListener,
} from "./adapter.js";
import type { EntityRegistryMirror } from "./registry.js";
import { MigrationPolicy } from "./migration.js";
import { SupremeNativeAdapter } from "./native-adapter.js";

/**
 * Routing backend adapter (blueprint §7, §16 Phase 4) — the strangler-fig seam.
 *
 * Implements {@link IBackendAdapter} by delegating each call to EITHER the Home
 * Assistant adapter or the Supreme-native engine, chosen per backend domain by the
 * {@link MigrationPolicy}. Migrating a domain to native is a one-line flag flip; the
 * SIL, domain services, gateway, and clients above are entirely unaware. When every
 * domain is native, the HA adapter is dead weight and can be dropped.
 */
export interface RoutingAdapterOptions {
  ha: IBackendAdapter;
  native?: SupremeNativeAdapter;
  registry: EntityRegistryMirror;
  policy?: MigrationPolicy;
}

export class RoutingBackendAdapter implements IBackendAdapter {
  readonly kind = "routing";
  readonly ha: IBackendAdapter;
  readonly native: SupremeNativeAdapter;
  readonly policy: MigrationPolicy;
  private readonly registry: EntityRegistryMirror;
  private readonly listeners = new Set<StateListener>();

  constructor(opts: RoutingAdapterOptions) {
    this.ha = opts.ha;
    this.native = opts.native ?? new SupremeNativeAdapter();
    this.registry = opts.registry;
    this.policy = opts.policy ?? new MigrationPolicy();
    // State from either engine flows up unchanged.
    this.ha.onState((e) => this.fanout(e));
    this.native.onState((e) => this.fanout(e));
  }

  async connect(): Promise<void> {
    await Promise.all([this.ha.connect(), this.native.connect()]);
  }
  async disconnect(): Promise<void> {
    await Promise.all([this.ha.disconnect(), this.native.disconnect()]);
  }
  isConnected(): boolean {
    return this.ha.isConnected() || this.native.isConnected();
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    await this.pick(deviceId, command.capability).command(deviceId, command);
  }

  async getState(deviceId: DeviceId, capability: CapabilityKind): Promise<CapabilityState | null> {
    return this.pick(deviceId, capability).getState(deviceId, capability);
  }

  async discover(): Promise<DiscoveredDevice[]> {
    const [ha, native] = await Promise.all([this.ha.discover(), this.native.discover()]);
    return [...ha, ...native];
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Migrate a domain to the native engine: seed native state from the current
   * (HA) state for every mapped device in the domain, then flip the routing flag.
   * After this, commands and reads for that domain go native — nothing above the
   * SIL changes. Returns the device/capability pairs moved.
   */
  async migrateDomainToNative(domain: string): Promise<number> {
    let moved = 0;
    for (const deviceId of this.registry.devicesInDomain(domain)) {
      for (const capability of this.registry.capabilitiesOf(deviceId, domain)) {
        const current = await this.ha.getState(deviceId, capability);
        this.native.provision(deviceId, capability, current ?? undefined);
        moved++;
      }
    }
    this.policy.setEngine(domain, "native");
    return moved;
  }

  private pick(deviceId: DeviceId, capability: CapabilityKind): IBackendAdapter {
    // A device bound to a real native protocol stack (KNX/Modbus/MQTT) is owned by
    // the native engine regardless of the per-domain migration flag — its commands
    // and reads must always go to the bus it lives on.
    if (this.native.manages(deviceId)) return this.native;
    const domain = this.registry.domainOf(deviceId, capability);
    if (domain) this.policy.register(domain);
    return domain && this.policy.isNative(domain) ? this.native : this.ha;
  }

  private fanout(event: BackendStateEvent): void {
    for (const l of this.listeners) l(event);
  }
}

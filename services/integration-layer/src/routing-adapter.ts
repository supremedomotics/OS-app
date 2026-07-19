import { SupremeError } from "@supreme/contracts";
import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
} from "@supreme/domain-model";
import type {
  BackendStateEvent,
  DiscoveredDevice,
  DriverDiagnosticsSnapshot,
  IBackendAdapter,
  MediaArtwork,
  MediaQueueItem,
  StateListener,
} from "./adapter.js";
import type { EntityRegistryMirror } from "./registry.js";
import { MigrationPolicy } from "./migration.js";
import { OwnershipRegistry } from "./ownership.js";
import { SupremeNativeAdapter } from "./native-adapter.js";

/**
 * Routing backend adapter (blueprint §7, § Native Driver Architecture Refactor) — the
 * strangler-fig seam.
 *
 * Implements {@link IBackendAdapter} by delegating each call to whichever backend
 * OWNS the device, per the explicit {@link OwnershipRegistry} — never a heuristic.
 * A native-owned device NEVER falls back to Home Assistant, even transiently: if its
 * driver isn't currently bound, the command fails loudly (`backend_unavailable`)
 * rather than silently executing against the wrong backend. Home Assistant is only
 * ever consulted for devices explicitly owned by it (§ Home Assistant's Future
 * Role — an integration provider, never an execution fallback for native protocols).
 */
export interface RoutingAdapterOptions {
  ha: IBackendAdapter;
  native?: SupremeNativeAdapter;
  registry: EntityRegistryMirror;
  /** Defaults to a fresh, empty registry when omitted — every device then starts
   * "unassigned" (uncommandable) until something explicitly claims ownership. Tests
   * that need a device pre-owned must set it up via `ownership.set(...)`. */
  ownership?: OwnershipRegistry;
  policy?: MigrationPolicy;
}

export class RoutingBackendAdapter implements IBackendAdapter {
  readonly kind = "routing";
  readonly ha: IBackendAdapter;
  readonly native: SupremeNativeAdapter;
  readonly ownership: OwnershipRegistry;
  /** Retained only for the legacy `/v1/migration` HA→native domain-status surface;
   * no longer consulted by {@link pick} — ownership is authoritative (§ Command
   * Routing: never on backend IDs, never on naming conventions, never on fallback
   * heuristics). */
  readonly policy: MigrationPolicy;
  private readonly registry: EntityRegistryMirror;
  private readonly listeners = new Set<StateListener>();

  constructor(opts: RoutingAdapterOptions) {
    this.ha = opts.ha;
    this.native = opts.native ?? new SupremeNativeAdapter();
    this.registry = opts.registry;
    this.ownership = opts.ownership ?? new OwnershipRegistry();
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
    await this.pick(deviceId).command(deviceId, command);
  }

  async getState(deviceId: DeviceId, capability: CapabilityKind): Promise<CapabilityState | null> {
    return this.pick(deviceId).getState(deviceId, capability);
  }

  async discover(): Promise<DiscoveredDevice[]> {
    const [ha, native] = await Promise.all([this.ha.discover(), this.native.discover()]);
    return [...ha, ...native];
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Artwork is a native-engine feature (the protocol drivers expose it); a device
   * bound to the native bus resolves there, otherwise we try whichever side has it. */
  async getArtwork(deviceId: DeviceId): Promise<MediaArtwork | null> {
    if (this.native.manages(deviceId)) return this.native.getArtwork(deviceId);
    return this.ha.getArtwork ? this.ha.getArtwork(deviceId) : null;
  }

  /** Same routing as {@link getArtwork}: native-engine feature first. */
  async getQueue(deviceId: DeviceId): Promise<MediaQueueItem[] | null> {
    if (this.native.manages(deviceId)) return this.native.getQueue(deviceId);
    return this.ha.getQueue ? this.ha.getQueue(deviceId) : null;
  }

  /** Same routing as {@link getArtwork}: native-engine feature first. Previously
   * unimplemented here (a routed device never reached its driver's capability config,
   * only ever `null`) — this was a real gap fixed alongside the identically-shaped
   * {@link getDiagnostics}, not new surface. */
  async getCapabilityConfig(deviceId: DeviceId, capability: CapabilityKind): Promise<Record<string, unknown> | null> {
    if (this.native.manages(deviceId)) return this.native.getCapabilityConfig(deviceId, capability);
    return this.ha.getCapabilityConfig ? this.ha.getCapabilityConfig(deviceId, capability) : null;
  }

  /** Same routing as {@link getArtwork}: native-engine feature first. */
  async getDiagnostics(deviceId: DeviceId): Promise<DriverDiagnosticsSnapshot | null> {
    if (this.native.manages(deviceId)) return this.native.getDiagnostics(deviceId);
    return this.ha.getDiagnostics ? this.ha.getDiagnostics(deviceId) : null;
  }

  /** § Driver Lifecycle Completion: unlike the "first side that manages it" routing
   * above, this deliberately runs on BOTH sides unconditionally — a device being
   * deleted must have every trace of it released regardless of which backend
   * currently (or previously) owned it, and both `unbindDevice` implementations are
   * required to be safe no-ops for a device they don't manage. Over-cleaning is the
   * safe failure mode here; under-cleaning is the leak this whole effort exists to
   * close. */
  async unbindDevice(deviceId: DeviceId): Promise<void> {
    await this.native.unbindDevice(deviceId);
    await this.ha.unbindDevice?.(deviceId);
  }

  /**
   * Migrate a domain to the native engine: seed native state from the current
   * (HA) state for every mapped device in the domain, transfer OWNERSHIP for each
   * (§ "If a Home Assistant device later migrates to a native SupremeOS driver,
   * ownership must transfer automatically"), then flip the legacy domain flag for
   * the `/v1/migration` status surface. After this, commands and reads for these
   * devices go native — nothing above the SIL changes. Returns the pairs moved.
   */
  async migrateDomainToNative(domain: string): Promise<number> {
    let moved = 0;
    for (const deviceId of this.registry.devicesInDomain(domain)) {
      for (const capability of this.registry.capabilitiesOf(deviceId, domain)) {
        const current = await this.ha.getState(deviceId, capability);
        this.native.provision(deviceId, capability, current ?? undefined);
        moved++;
      }
      await this.ownership.set(deviceId, "native", "supreme-native");
    }
    this.policy.setEngine(domain, "native");
    return moved;
  }

  /**
   * The command router (§ Command Routing). Routing is based EXCLUSIVELY on
   * {@link OwnershipRegistry} — never on a backend id's shape, never on a naming
   * convention, never on a domain-based fallback. A device with no recorded owner,
   * or a native owner whose driver isn't currently bound, fails loudly rather than
   * silently executing against whatever backend happens to be left standing.
   */
  private pick(deviceId: DeviceId): IBackendAdapter {
    const owner = this.ownership.get(deviceId);
    if (!owner || owner.kind === "unassigned") {
      throw new SupremeError(
        "backend_unavailable",
        `device ${deviceId} has no assigned owner — it must be commissioned (or its driver must finish binding) before it can be commanded`,
      );
    }
    if (owner.kind === "native") {
      if (!this.native.manages(deviceId)) {
        throw new SupremeError(
          "backend_unavailable",
          `device ${deviceId} is owned by the native "${owner.protocol}" driver, but that driver is not currently bound — it will NOT fall back to Home Assistant; reconnect or reconfigure the "${owner.protocol}" driver`,
        );
      }
      return this.native;
    }
    if (owner.kind === "ha") return this.ha;
    throw new SupremeError("backend_unavailable", `device ${deviceId} is owned by "${owner.kind}", which has no command path wired up yet`);
  }

  private fanout(event: BackendStateEvent): void {
    for (const l of this.listeners) l(event);
  }
}

import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
} from "@supreme/domain-model";
import { READONLY_CAPABILITIES } from "@supreme/domain-model";
import { SupremeError } from "@supreme/contracts";
import type { BackendStateEvent, DriverDiagnosticsSnapshot, IBackendAdapter, MediaArtwork, MediaQueueItem } from "./adapter.js";
import { EntityRegistryMirror, type BackendEntityRef } from "./registry.js";
import { RoutingBackendAdapter } from "./routing-adapter.js";
import type { EngineKind } from "./migration.js";
import { OwnershipRegistry, type IDeviceOwnershipStore } from "./ownership.js";
import type { INativeProtocolDriver, ProtocolBinding } from "./protocols/driver.js";

/**
 * Supreme Integration Layer — the facade the rest of the hub talks to.
 *
 * Domain services call `command()` / `getState()` / `subscribe()` in pure Supreme
 * terms. The SIL owns the registry and the adapter; swapping the adapter (HA today,
 * Supreme-native tomorrow) is invisible here and above. This is the single seam
 * the entire migration strategy pivots on (§7, §16).
 */
export interface SilOptions {
  adapter: IBackendAdapter;
  registry?: EntityRegistryMirror;
  /** Explicit device ownership (§ Native Driver Architecture Refactor) — required
   * whenever `adapter` is a {@link RoutingBackendAdapter}, since ownership is the
   * ONLY signal the command router consults. */
  ownership?: OwnershipRegistry;
  ownershipStore?: IDeviceOwnershipStore;
}

export class SupremeIntegrationLayer {
  private readonly adapter: IBackendAdapter;
  readonly registry: EntityRegistryMirror;
  readonly ownership: OwnershipRegistry;

  constructor(opts: SilOptions) {
    this.adapter = opts.adapter;
    this.registry = opts.registry ?? new EntityRegistryMirror();
    // A RoutingBackendAdapter owns its own OwnershipRegistry (the router IS the thing
    // that consults it on every command); reuse that exact instance when the caller
    // didn't hand one in explicitly, rather than silently creating a second, empty
    // registry the router never sees — that split-brain is easy to introduce by
    // accident (constructing the adapter and the SIL as two separate calls) and would
    // make every device look "unassigned" to command() even though it's genuinely owned.
    this.ownership = opts.ownership ?? (opts.adapter instanceof RoutingBackendAdapter ? opts.adapter.ownership : new OwnershipRegistry(opts.ownershipStore));
  }

  async start(): Promise<void> {
    await this.ownership.hydrate();
    await this.adapter.connect();
  }

  async stop(): Promise<void> {
    await this.adapter.disconnect();
  }

  get backendKind(): string {
    return this.adapter.kind;
  }

  /**
   * Native-migration controls (§16 Phase 4), available only when the SIL is backed
   * by a {@link RoutingBackendAdapter}. Returns null for single-backend setups.
   */
  private get router(): RoutingBackendAdapter | null {
    return this.adapter instanceof RoutingBackendAdapter ? this.adapter : null;
  }

  /** Whether per-domain HA→native migration is available on this hub. */
  get migrationEnabled(): boolean {
    return this.router !== null;
  }

  /** Current per-domain routing (ha/native). Domains are seeded from the registry. */
  migrationStatus(): { domain: string; engine: EngineKind }[] {
    const router = this.router;
    if (!router) return [];
    for (const d of this.registry.domains()) router.policy.register(d);
    return router.policy.status();
  }

  /** Migrate a backend domain onto the Supreme-native engine. Returns pairs moved. */
  async migrateDomain(domain: string, engine: EngineKind): Promise<number> {
    const router = this.router;
    if (!router) throw new SupremeError("conflict", "native migration is not enabled on this hub");
    if (engine === "native") return router.migrateDomainToNative(domain);
    router.policy.setEngine(domain, "ha");
    return 0;
  }

  isHealthy(): boolean {
    return this.adapter.isConnected();
  }

  /** Per-protocol native driver status (for driver health/diagnostics). Empty without a native router. */
  nativeProtocolStatus(): Array<{ protocol: string; connected: boolean; error: string | null }> {
    return this.router?.native.protocolStatus() ?? [];
  }

  /** (Re)connect a single native protocol driver — the Driver Manager "Connect" action. */
  async connectNativeProtocol(protocol: string): Promise<boolean> {
    return (await this.router?.native.connectProtocol(protocol)) ?? false;
  }

  /** Disconnect a single native protocol driver — the "Disconnect" action. */
  async disconnectNativeProtocol(protocol: string): Promise<boolean> {
    return (await this.router?.native.disconnectProtocol(protocol)) ?? false;
  }

  /** Register (or replace) a native protocol driver at runtime — the manifest↔runtime bridge. */
  async registerNativeDriver(driver: INativeProtocolDriver): Promise<boolean> {
    if (!this.router) return false;
    await this.router.native.registerDriver(driver);
    return true;
  }

  /** Remove a protocol's native driver at runtime (driver disabled/uninstalled). */
  async unregisterNativeProtocol(protocol: string): Promise<boolean> {
    if (!this.router) return false;
    await this.router.native.unregisterProtocol(protocol);
    return true;
  }

  /**
   * Bind a device/capability to a real native protocol stack (KNX/Modbus/MQTT/…). On
   * success this is also the ONLY place ownership transitions to "native" — a bind
   * that throws leaves ownership exactly as it was (§ Ownership changes must be
   * transactional: never partially applied). Available only when the SIL is backed
   * by a routing adapter.
   */
  async bindNative(binding: ProtocolBinding, protocol: string): Promise<void> {
    const router = this.router;
    if (!router) throw new SupremeError("conflict", "native protocol binding is not enabled on this hub");
    await router.native.bind(binding, protocol);
    await this.ownership.set(binding.deviceId, "native", protocol);
  }

  /** Register a Supreme device capability ↔ backend entity mapping (HA-side registry —
   * distinct from ownership, which records WHO commands the device; this records what
   * HA-native reads/discovery-dedup consult). */
  mapEntity(deviceId: DeviceId, capability: CapabilityKind, ref: BackendEntityRef): void {
    this.registry.map(deviceId, capability, ref);
  }

  /** Drop every backend mapping AND ownership record for a device (used when the
   * device is deleted) — an orphaned ownership row would otherwise let a future
   * device reuse the same id (unlikely, but ownership must never lie). Also releases
   * the owning driver's own per-device resources (§ Driver Lifecycle Completion) —
   * timers, sockets, subscriptions, diagnostics trackers — BEFORE clearing ownership,
   * so a driver's `unbind()` can still legitimately answer "do I manage this device"
   * while it runs. Previously this only cleared Supreme-side bookkeeping and left
   * every driver's own internal Maps holding the device forever. */
  async unmapDevice(deviceId: DeviceId): Promise<void> {
    if (this.adapter.unbindDevice) await this.adapter.unbindDevice(deviceId);
    this.registry.unmapDevice(deviceId);
    await this.ownership.clear(deviceId);
  }

  /** Issue a Supreme capability command. Rejects read-only capabilities. */
  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    if (READONLY_CAPABILITIES.includes(command.capability)) {
      throw new SupremeError("validation_failed", `capability ${command.capability} is read-only`);
    }
    if (!this.adapter.isConnected()) {
      // HaAdapter buffers; others surface a typed error the gateway maps to 503.
      if (this.adapter.kind !== "ha") {
        throw new SupremeError("backend_unavailable", "integration backend is not connected");
      }
    }
    await this.adapter.command(deviceId, command);
  }

  async getState(deviceId: DeviceId, capability: CapabilityKind): Promise<CapabilityState | null> {
    return this.adapter.getState(deviceId, capability);
  }

  /** Fetch a device's current media artwork bytes (null if none/unsupported). Served
   * out-of-band by the gateway so cover art never rides on every state delta. */
  async getArtwork(deviceId: DeviceId): Promise<MediaArtwork | null> {
    return this.adapter.getArtwork ? this.adapter.getArtwork(deviceId) : null;
  }

  /** Fetch a media device's current play queue (null if none/unsupported). */
  async getQueue(deviceId: DeviceId): Promise<MediaQueueItem[] | null> {
    return this.adapter.getQueue ? this.adapter.getQueue(deviceId) : null;
  }

  /** Fetch a device+capability's real AudioCapabilityConfig (null if none/unsupported). */
  async getCapabilityConfig(deviceId: DeviceId, capability: CapabilityKind): Promise<Record<string, unknown> | null> {
    return this.adapter.getCapabilityConfig ? this.adapter.getCapabilityConfig(deviceId, capability) : null;
  }

  /** Fetch a device's real connection/traffic diagnostics from its owning driver
   * (null if none/unsupported — e.g. an HA-backed or unbound device). */
  async getDiagnostics(deviceId: DeviceId): Promise<DriverDiagnosticsSnapshot | null> {
    return this.adapter.getDiagnostics ? this.adapter.getDiagnostics(deviceId) : null;
  }

  /** Subscribe to normalized state changes for all mapped devices. */
  subscribe(listener: (event: BackendStateEvent) => void): () => void {
    return this.adapter.onState(listener);
  }

  discover() {
    return this.adapter.discover();
  }

  /** The live, connected driver instance currently registered for a protocol (e.g.
   * "knx") — null when unavailable (single-backend HA setups, or no driver registered
   * for that protocol yet). Read-only introspection for diagnostics/orchestration
   * callers that need to check driver identity/ownership without going through the
   * command() path (§ Phase 5 installer-workflow validation — never a second command
   * routing mechanism, purely a lookup). */
  getNativeDriver(protocol: string): INativeProtocolDriver | null {
    return this.router?.native.driverFor(protocol) ?? null;
  }
}

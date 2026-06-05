import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
} from "@supreme/domain-model";
import { READONLY_CAPABILITIES } from "@supreme/domain-model";
import { SupremeError } from "@supreme/contracts";
import type { BackendStateEvent, IBackendAdapter } from "./adapter.js";
import { EntityRegistryMirror, type BackendEntityRef } from "./registry.js";
import { RoutingBackendAdapter } from "./routing-adapter.js";
import type { EngineKind } from "./migration.js";

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
}

export class SupremeIntegrationLayer {
  private readonly adapter: IBackendAdapter;
  readonly registry: EntityRegistryMirror;

  constructor(opts: SilOptions) {
    this.adapter = opts.adapter;
    this.registry = opts.registry ?? new EntityRegistryMirror();
  }

  async start(): Promise<void> {
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

  /** Register a Supreme device capability ↔ backend entity mapping. */
  mapEntity(deviceId: DeviceId, capability: CapabilityKind, ref: BackendEntityRef): void {
    this.registry.map(deviceId, capability, ref);
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

  /** Subscribe to normalized state changes for all mapped devices. */
  subscribe(listener: (event: BackendStateEvent) => void): () => void {
    return this.adapter.onState(listener);
  }

  discover() {
    return this.adapter.discover();
  }
}

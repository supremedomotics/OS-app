import { SupremeError } from "@supreme/contracts";
import type { CapabilityCommand, CapabilityKind, CapabilityState, DeviceId, KeypadFeedbackCommand, KeypadInputEvent } from "@supreme/domain-model";
import type {
  BackendStateEvent,
  DiscoveredDevice,
  DriverDiagnosticsSnapshot,
  DriverTraceEntry,
  IBackendAdapter,
  MediaArtwork,
  MediaQueueItem,
  StateListener,
} from "./adapter.js";
import { DriverBindingEngine } from "./driver-binding-engine.js";
import { ProviderRegistry } from "./provider-registry.js";
import type { SupremeNativeAdapter } from "./native-adapter.js";

export interface ProviderRouterOptions {
  /** The driver-hosting engine every provider (native protocols AND Home Assistant,
   * via `HomeAssistantProviderDriver`) registers into identically. */
  engine: SupremeNativeAdapter;
  registry: ProviderRegistry;
  bindingEngine: DriverBindingEngine;
}

const COMMANDABLE_STATES = new Set(["BOUND", "ONLINE", "OFFLINE"]);

/**
 * Provider Router (ADR-0023) — the complete, non-wrapping replacement for
 * `RoutingBackendAdapter`. Locates a device's provider + driver via
 * {@link ProviderRegistry}, dispatches commands/events/diagnostics through the
 * shared driver engine, and never assumes any particular provider (including
 * Home Assistant) is present. A device that isn't BOUND/ONLINE/OFFLINE — i.e. never
 * bound, mid-bind, or in error — fails loudly with its real lifecycle state; nothing
 * routes around that by falling back to a simulator or a "default" backend.
 */
export class ProviderRouter implements IBackendAdapter {
  readonly kind = "provider-router";
  readonly registry: ProviderRegistry;
  readonly bindingEngine: DriverBindingEngine;
  /** The shared driver-hosting engine every provider registers into — public so the
   * SIL can reach native-adapter-specific orchestration (protocolStatus,
   * registerDriver, discoverWithStatus, …) that isn't part of the generic
   * {@link IBackendAdapter} surface, exactly mirroring how the ownership-era router
   * exposed `.native`. */
  readonly engine: SupremeNativeAdapter;

  constructor(opts: ProviderRouterOptions) {
    this.engine = opts.engine;
    this.registry = opts.registry;
    this.bindingEngine = opts.bindingEngine;
  }

  async connect(): Promise<void> {
    await this.engine.connect();
  }
  async disconnect(): Promise<void> {
    await this.engine.disconnect();
  }
  isConnected(): boolean {
    return this.engine.isConnected();
  }

  /** Throws with the device's real lifecycle state when it isn't currently
   * commandable — never silently routes to a default, never simulates. */
  private assertCommandable(deviceId: DeviceId): void {
    const record = this.registry.get(deviceId);
    if (!record) {
      throw new SupremeError("backend_unavailable", `device ${deviceId} has no provider assigned`);
    }
    if (!COMMANDABLE_STATES.has(record.state)) {
      throw new SupremeError(
        "backend_unavailable",
        `device ${deviceId} is ${record.state} — not currently commandable (provider "${record.provider}")`,
      );
    }
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    this.assertCommandable(deviceId);
    await this.engine.command(deviceId, command);
  }

  async getState(deviceId: DeviceId, capability: CapabilityKind): Promise<CapabilityState | null> {
    const record = this.registry.get(deviceId);
    if (!record || !COMMANDABLE_STATES.has(record.state)) return null;
    return this.engine.getState(deviceId, capability);
  }

  async discover(): Promise<DiscoveredDevice[]> {
    return this.engine.discover();
  }

  onState(listener: StateListener): () => void {
    return this.engine.onState(listener);
  }

  onInputEvent(listener: (event: KeypadInputEvent) => void): () => void {
    return this.engine.onInputEvent(listener);
  }

  async getArtwork(deviceId: DeviceId): Promise<MediaArtwork | null> {
    return this.engine.getArtwork(deviceId);
  }
  async getQueue(deviceId: DeviceId): Promise<MediaQueueItem[] | null> {
    return this.engine.getQueue(deviceId);
  }
  async getCapabilityConfig(deviceId: DeviceId, capability: CapabilityKind): Promise<Record<string, unknown> | null> {
    return this.engine.getCapabilityConfig(deviceId, capability);
  }

  /** Real diagnostics only — provider, lifecycle state, binding/connection health,
   * never a fabricated online/offline. */
  async getDiagnostics(deviceId: DeviceId): Promise<DriverDiagnosticsSnapshot | null> {
    return this.engine.getDiagnostics(deviceId);
  }
  async getTrace(deviceId: DeviceId): Promise<DriverTraceEntry[] | null> {
    return this.engine.getTrace(deviceId);
  }
  async exportDiagnosticsLog(deviceId: DeviceId): Promise<string | null> {
    return this.engine.exportDiagnosticsLog(deviceId);
  }
  async sendRaw(deviceId: DeviceId, token: string): Promise<void> {
    return this.engine.sendRaw(deviceId, token);
  }
  async refreshCapabilities(deviceId: DeviceId): Promise<void> {
    return this.engine.refreshCapabilities(deviceId);
  }
  async getKeypadCapabilities(deviceId: DeviceId) {
    return this.engine.getKeypadCapabilities(deviceId);
  }
  async sendKeypadFeedback(command: KeypadFeedbackCommand): Promise<void> {
    return this.engine.sendKeypadFeedback(command);
  }

  /** Full lifecycle teardown for a deleted device: release the driver's per-device
   * resources via the binding engine, then drop the provider record entirely. */
  async unbindDevice(deviceId: DeviceId): Promise<void> {
    await this.bindingEngine.unbind(deviceId);
    await this.registry.remove(deviceId);
  }

  /** Runtime diagnostics surface (ADR-0023 § Runtime Diagnostics): provider,
   * lifecycle state, and real binding/connection health — never fabricated. */
  deviceDiagnostics(deviceId: DeviceId): {
    provider: string | null;
    state: string;
    bound: boolean;
    connected: boolean;
    error: string | null;
  } {
    const record = this.registry.get(deviceId);
    const health = this.bindingEngine.health(deviceId);
    return {
      provider: record?.provider ?? null,
      state: record?.state ?? "UNBOUND",
      bound: health.bound,
      connected: health.connected,
      error: health.error,
    };
  }
}

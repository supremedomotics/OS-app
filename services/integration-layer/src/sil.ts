import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
  KeypadCapabilityDeclaration,
  KeypadFeedbackCommand,
  KeypadInputEvent,
} from "@supreme/domain-model";
import { READONLY_CAPABILITIES } from "@supreme/domain-model";
import { SupremeError } from "@supreme/contracts";
import type { BackendStateEvent, DriverDiagnosticsSnapshot, DriverTraceEntry, IBackendAdapter, MediaArtwork, MediaQueueItem } from "./adapter.js";
import { EntityRegistryMirror, type BackendEntityRef } from "./registry.js";
import { ProviderRouter } from "./provider-router.js";
import type { SupremeNativeAdapter } from "./native-adapter.js";
import { MigrationPolicy, type EngineKind } from "./migration.js";
import { ProviderRegistry, type IDeviceProviderStore } from "./provider-registry.js";
import type { INativeProtocolDriver, ProtocolBinding } from "./protocols/driver.js";

/**
 * Supreme Integration Layer — the facade the rest of the hub talks to (ADR-0023).
 *
 * Domain services call `command()` / `getState()` / `subscribe()` in pure Supreme
 * terms. The SIL owns the entity registry and the adapter; the adapter is always a
 * {@link ProviderRouter} in production — no separate HA-vs-native split exists above
 * this layer, so swapping/adding a provider is invisible here.
 */
export interface SilOptions {
  adapter: IBackendAdapter;
  registry?: EntityRegistryMirror;
  /** Provider + lifecycle registry (ADR-0023) — required whenever `adapter` is a
   * {@link ProviderRouter}, since it's the ONLY signal the router consults. */
  providers?: ProviderRegistry;
  providerStore?: IDeviceProviderStore;
  /** Legacy per-domain HA↔native status tracking for the `/v1/migration` installer
   * surface (see {@link MigrationPolicy}). Pass the caller's already-hydrated
   * instance to survive a reboot; defaults to a fresh, unhydrated one otherwise. */
  migrationPolicy?: MigrationPolicy;
}

export class SupremeIntegrationLayer {
  private readonly adapter: IBackendAdapter;
  readonly registry: EntityRegistryMirror;
  readonly providers: ProviderRegistry;
  /** Legacy per-domain HA↔native status tracking for the `/v1/migration` installer
   * surface — kept isolated from routing (nothing here gates `command()`), purely a
   * reporting/UX convenience for the migration wizard. */
  private readonly policy: MigrationPolicy;

  constructor(opts: SilOptions) {
    this.adapter = opts.adapter;
    this.registry = opts.registry ?? new EntityRegistryMirror();
    // A ProviderRouter owns its own ProviderRegistry (the router IS the thing that
    // consults it on every command); reuse that exact instance when the caller didn't
    // hand one in explicitly — the same split-brain guard the ownership model used.
    this.providers = opts.providers ?? (opts.adapter instanceof ProviderRouter ? opts.adapter.registry : new ProviderRegistry(opts.providerStore));
    this.policy = opts.migrationPolicy ?? new MigrationPolicy();
  }

  async start(): Promise<void> {
    await this.providers.hydrate();
    await this.adapter.connect();
  }

  async stop(): Promise<void> {
    await this.adapter.disconnect();
  }

  get backendKind(): string {
    return this.adapter.kind;
  }

  /** Available only when the SIL is backed by a {@link ProviderRouter}. Returns null
   * for single-backend test setups. */
  private get router(): ProviderRouter | null {
    return this.adapter instanceof ProviderRouter ? this.adapter : null;
  }

  /** Whether the `/v1/migration` installer surface is available on this hub. */
  get migrationEnabled(): boolean {
    return this.router !== null;
  }

  /** Current per-domain routing (ha/native) for the installer migration UI. Domains
   * are seeded from the entity registry. */
  migrationStatus(): { domain: string; engine: EngineKind }[] {
    if (!this.router) return [];
    for (const d of this.registry.domains()) this.policy.register(d);
    return this.policy.status();
  }

  /**
   * Flip a domain's tracked engine for the migration wizard. ADR-0023 § Remove
   * Runtime Simulation: this NO LONGER fabricates native state for devices that
   * have no real bound driver (the previous "instant migrate" convenience copied
   * HA's last-known state into the native engine without a real driver — that is
   * exactly the kind of simulated state the new architecture forbids). A device
   * only becomes commandable through native once it's explicitly bound via
   * {@link bindNative} to a real driver; until then it is honestly UNBOUND.
   */
  async migrateDomain(domain: string, engine: EngineKind): Promise<number> {
    const router = this.router;
    if (!router) throw new SupremeError("conflict", "migration is not enabled on this hub");
    this.policy.setEngine(domain, engine);
    if (engine !== "native") return 0;
    let affected = 0;
    for (const deviceId of this.registry.devicesInDomain(domain)) {
      const existing = this.providers.get(deviceId);
      if (existing?.provider === "supreme-native") continue; // already tracked as native
      if (existing) {
        // Release whatever currently binds it (e.g. Home Assistant) via the real
        // driver-level unbind — never leave two providers simultaneously claiming
        // the same device.
        await router.unbindDevice(deviceId);
      }
      await this.providers.assign(deviceId, "supreme-native");
      affected++;
    }
    return affected;
  }

  isHealthy(): boolean {
    return this.adapter.isConnected();
  }

  /** Per-protocol native driver status (for driver health/diagnostics). Empty without a router. */
  nativeProtocolStatus(): Array<{ protocol: string; connected: boolean; error: string | null }> {
    return this.router?.engine.protocolStatus() ?? [];
  }

  /** (Re)connect a single native protocol driver — the Driver Manager "Connect" action. */
  async connectNativeProtocol(protocol: string): Promise<boolean> {
    return (await this.router?.engine.connectProtocol(protocol)) ?? false;
  }

  /** Disconnect a single native protocol driver — the "Disconnect" action. */
  async disconnectNativeProtocol(protocol: string): Promise<boolean> {
    return (await this.router?.engine.disconnectProtocol(protocol)) ?? false;
  }

  /** Register (or replace) a native protocol driver at runtime — the manifest↔runtime
   * bridge. Every provider, including Home Assistant (via `HomeAssistantProviderDriver`),
   * registers through this identical path. */
  async registerNativeDriver(driver: INativeProtocolDriver): Promise<boolean> {
    if (!this.router) return false;
    await this.router.engine.registerDriver(driver);
    return true;
  }

  /** Remove a protocol's native driver at runtime (driver disabled/uninstalled). */
  async unregisterNativeProtocol(protocol: string): Promise<boolean> {
    if (!this.router) return false;
    await this.router.engine.unregisterProtocol(protocol);
    return true;
  }

  /**
   * Bind a device/capability to a real driver — ANY provider, native protocol or
   * Home Assistant alike (ADR-0023 § Driver Binding). Delegates entirely to
   * {@link DriverBindingEngine}, the only code path allowed to change a device's
   * lifecycle state. Available only when the SIL is backed by a {@link ProviderRouter}.
   */
  async bindNative(binding: ProtocolBinding, provider: string): Promise<void> {
    if (!this.router) throw new SupremeError("conflict", "provider binding is not enabled on this hub");
    await this.router.bindingEngine.bind(binding, provider);
  }

  /** Register a Supreme device capability ↔ backend entity mapping — used by
   * providers (e.g. Home Assistant) whose commissioning resolves through an entity
   * id rather than a wire address alone. */
  mapEntity(deviceId: DeviceId, capability: CapabilityKind, ref: BackendEntityRef): void {
    this.registry.map(deviceId, capability, ref);
  }

  /** Drop every backend mapping AND provider/lifecycle record for a device (used
   * when the device is deleted) — an orphaned record would otherwise let a future
   * device reuse the same id. Also releases the owning driver's own per-device
   * resources (§ Driver Lifecycle Completion) BEFORE clearing the record. */
  async unmapDevice(deviceId: DeviceId): Promise<void> {
    if (this.router) {
      await this.router.unbindDevice(deviceId);
    } else {
      if (this.adapter.unbindDevice) await this.adapter.unbindDevice(deviceId);
      await this.providers.remove(deviceId);
    }
    this.registry.unmapDevice(deviceId);
  }

  /** Issue a Supreme capability command. Rejects read-only capabilities. */
  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    if (READONLY_CAPABILITIES.includes(command.capability)) {
      throw new SupremeError("validation_failed", `capability ${command.capability} is read-only`);
    }
    if (!this.adapter.isConnected()) {
      // Never fabricate connectivity — surface a typed error the gateway maps to 503.
      throw new SupremeError("backend_unavailable", "integration backend is not connected");
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

  /** § Pass 12.6, Part E — fetch a device's real AVR input list (null if none/unsupported). */
  async getAvrInputs(deviceId: DeviceId): Promise<{ technicalId: string; reportedName: string; customName: string | null; displayName: string }[] | null> {
    return this.adapter.getAvrInputs ? this.adapter.getAvrInputs(deviceId) : null;
  }

  /** § Pass 12.6, Part E — set/clear one AVR input's custom label. `false` if unsupported
   * or the device's owning driver rejected the technicalId. */
  async setAvrInputCustomName(deviceId: DeviceId, technicalId: string, name: string | null): Promise<boolean> {
    return this.adapter.setAvrInputCustomName ? this.adapter.setAvrInputCustomName(deviceId, technicalId, name) : false;
  }

  /** Fetch a device's real connection/traffic diagnostics from its owning driver
   * (null if none/unsupported — e.g. an unbound device). */
  async getDiagnostics(deviceId: DeviceId): Promise<DriverDiagnosticsSnapshot | null> {
    return this.adapter.getDiagnostics ? this.adapter.getDiagnostics(deviceId) : null;
  }

  /** Fetch a device's owning driver's recent raw protocol trace (null if
   * unsupported, or trace logging isn't enabled for that driver instance). */
  async getTrace(deviceId: DeviceId): Promise<DriverTraceEntry[] | null> {
    return this.adapter.getTrace ? this.adapter.getTrace(deviceId) : null;
  }

  /** § AVR Diagnostic Mode — export a device's owning driver's complete diagnostic trace
   * log (null if unsupported, or diagnostics isn't enabled for that driver instance). */
  async exportDiagnosticsLog(deviceId: DeviceId): Promise<string | null> {
    return this.adapter.exportDiagnosticsLog ? this.adapter.exportDiagnosticsLog(deviceId) : null;
  }

  /** § RTI Capability Audit, Category C.4 — devMode-only raw-token escape hatch. Throws
   * (validation_failed) when the underlying adapter/driver doesn't support one. */
  async sendRaw(deviceId: DeviceId, token: string): Promise<void> {
    if (!this.adapter.sendRaw) throw new SupremeError("validation_failed", `device ${deviceId}'s backend does not support raw commands`);
    await this.adapter.sendRaw(deviceId, token);
  }

  /** § Capability Refresh — ask the owning driver to re-query whatever it can
   * genuinely re-discover, in place. A no-op for backends/drivers with nothing to
   * re-query (never a throw). */
  async refreshCapabilities(deviceId: DeviceId): Promise<void> {
    if (this.adapter.refreshCapabilities) await this.adapter.refreshCapabilities(deviceId);
  }

  /** Subscribe to normalized state changes for all mapped devices. */
  subscribe(listener: (event: BackendStateEvent) => void): () => void {
    return this.adapter.onState(listener);
  }

  // ── Universal Keypad Framework (§ Driver SDK Extension) ─────────────────────
  // Same optional-passthrough shape as getArtwork/getCapabilityConfig/getDiagnostics
  // above: absent on the current adapter → an honest empty/no-op, never fabricated.

  /** Fetch a keypad's real capability declaration (null if none/unsupported). */
  async getKeypadCapabilities(deviceId: DeviceId): Promise<KeypadCapabilityDeclaration | null> {
    return this.adapter.getKeypadCapabilities ? this.adapter.getKeypadCapabilities(deviceId) : null;
  }

  /** Subscribe to normalized keypad input (§ Universal Input Engine) across every
   * keypad-capable driver this hub has registered. */
  subscribeKeypadInput(listener: (event: KeypadInputEvent) => void): () => void {
    return this.adapter.onInputEvent ? this.adapter.onInputEvent(listener) : () => {};
  }

  /** Issue a generic feedback command to a keypad's owning driver (§ Universal
   * Feedback Engine, § Feedback Routing). Throws if no adapter/driver supports it. */
  async sendKeypadFeedback(command: KeypadFeedbackCommand): Promise<void> {
    if (!this.adapter.sendKeypadFeedback) {
      throw new SupremeError("backend_unavailable", "no keypad feedback driver is registered on this hub");
    }
    await this.adapter.sendKeypadFeedback(command);
  }

  discover() {
    return this.adapter.discover();
  }

  /** Discovery Driver Selector backend (§ Priority 4) — protocol-filtered, per-driver-
   * failure-isolated discovery. Falls back to the plain aggregate `discover()` (one
   * synthetic "complete" result, no per-driver breakdown) when the underlying adapter
   * isn't a {@link ProviderRouter} (e.g. a bare native adapter in a unit test) — never
   * throws just because the richer path isn't wired up. */
  async discoverWithStatus(protocols?: string[]): ReturnType<SupremeNativeAdapter["discoverWithStatus"]> {
    if (this.router) return this.router.engine.discoverWithStatus(protocols);
    // A bare (non-routing) adapter has no protocol concept of its own — it can't attribute
    // its devices to any of the requested protocols, so an explicit filter must exclude it
    // rather than silently ignore the filter and return everything unfiltered.
    if (protocols) return { devices: [], driverResults: [] };
    const devices = await this.adapter.discover();
    return { devices, driverResults: [] };
  }

  /** The live, connected driver instance currently registered for a protocol (e.g.
   * "knx" or "homeassistant") — null when unavailable. Read-only introspection for
   * diagnostics/orchestration callers, never a second command routing mechanism. */
  getNativeDriver(protocol: string): INativeProtocolDriver | null {
    return this.router?.engine.driverFor(protocol) ?? null;
  }

  /** § Live Feedback Diagnostic Pass — thin passthrough to the KNX driver's own
   * composed diagnostic snapshot for one device (see `SupremeKnxDriver.knxFeedbackDiagnostics`).
   * `null` when no "knx" driver is registered, or that driver doesn't manage this device. */
  getKnxFeedbackDiagnostics(deviceId: DeviceId): unknown {
    return this.getNativeDriver("knx")?.knxFeedbackDiagnostics?.(deviceId) ?? null;
  }

  /** § Live Feedback Diagnostic Pass — whether an arbitrary GA has a live KNX subscription. */
  isKnxGaSubscribed(groupAddress: string): boolean {
    return this.getNativeDriver("knx")?.isSubscribedToGa?.(groupAddress) ?? false;
  }

  /** Runtime diagnostics (ADR-0023 § Runtime Diagnostics): provider, lifecycle
   * state, binding/connection health — never fabricated. Null when this hub isn't
   * backed by a router (no provider concept to report). */
  deviceDiagnostics(deviceId: DeviceId): ReturnType<ProviderRouter["deviceDiagnostics"]> | null {
    return this.router?.deviceDiagnostics(deviceId) ?? null;
  }
}

import { SupremeError } from "@supreme/contracts";
import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
  KeypadCapabilityDeclaration,
  KeypadFeedbackCommand,
  KeypadInputEvent,
} from "@supreme/domain-model";
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
  private readonly inputListeners = new Set<(event: KeypadInputEvent) => void>();

  constructor(opts: RoutingAdapterOptions) {
    this.ha = opts.ha;
    this.native = opts.native ?? new SupremeNativeAdapter();
    this.registry = opts.registry;
    this.ownership = opts.ownership ?? new OwnershipRegistry();
    this.policy = opts.policy ?? new MigrationPolicy();
    // State from either engine flows up unchanged.
    this.ha.onState((e) => this.fanout(e));
    this.native.onState((e) => this.fanout(e));
    // Universal Keypad Framework: keypad input from either engine flows up the same
    // way — HA has none today (no HA integration reports button/encoder events
    // through this adapter), but the fan-out is symmetric with onState so a future
    // HA-side keypad integration needs zero change here.
    this.ha.onInputEvent?.((e) => this.fanoutInput(e));
    this.native.onInputEvent((e) => this.fanoutInput(e));
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

  /** Same routing as {@link getArtwork}: native-engine feature first. */
  async getTrace(deviceId: DeviceId): Promise<DriverTraceEntry[] | null> {
    if (this.native.manages(deviceId)) return this.native.getTrace(deviceId);
    return this.ha.getTrace ? this.ha.getTrace(deviceId) : null;
  }

  /** § AVR Diagnostic Mode — same routing as {@link getArtwork}: native-engine feature first. */
  async exportDiagnosticsLog(deviceId: DeviceId): Promise<string | null> {
    if (this.native.manages(deviceId)) return this.native.exportDiagnosticsLog(deviceId);
    return this.ha.exportDiagnosticsLog ? this.ha.exportDiagnosticsLog(deviceId) : null;
  }

  /** § RTI Capability Audit, Category C.4 — same routing as {@link getArtwork}. */
  async sendRaw(deviceId: DeviceId, token: string): Promise<void> {
    if (this.native.manages(deviceId)) return this.native.sendRaw(deviceId, token);
    if (this.ha.sendRaw) return this.ha.sendRaw(deviceId, token);
    throw new SupremeError("validation_failed", `device ${deviceId}'s adapter does not support raw commands`);
  }

  /** § Capability Refresh — same routing as {@link getArtwork}: native-engine feature
   * first. Without this, a routed device's refresh request would silently no-op here
   * (this class's own missing method, not the underlying native adapter's) even
   * though `SupremeNativeAdapter.refreshCapabilities` is fully implemented — the same
   * class of gap {@link getCapabilityConfig}'s own doc comment already flags. */
  async refreshCapabilities(deviceId: DeviceId): Promise<void> {
    if (this.native.manages(deviceId)) return this.native.refreshCapabilities(deviceId);
    await this.ha.refreshCapabilities?.(deviceId);
  }

  // ── Universal Keypad Framework (§ Driver SDK Extension) ─────────────────────

  /** Same routing as {@link getArtwork}: native-engine feature first. */
  async getKeypadCapabilities(deviceId: DeviceId): Promise<KeypadCapabilityDeclaration | null> {
    if (this.native.manages(deviceId)) return this.native.getKeypadCapabilities(deviceId);
    return this.ha.getKeypadCapabilities ? this.ha.getKeypadCapabilities(deviceId) : null;
  }

  onInputEvent(listener: (event: KeypadInputEvent) => void): () => void {
    this.inputListeners.add(listener);
    return () => this.inputListeners.delete(listener);
  }

  /** Feedback always targets a specific keypad device, so — unlike `command()`,
   * which must pick a side for an arbitrary deviceId — this routes on whichever side
   * actually owns `command.keypadId`, falling loudly to native's own
   * `backend_unavailable` error when neither owns it. */
  async sendKeypadFeedback(command: KeypadFeedbackCommand): Promise<void> {
    if (this.native.manages(command.keypadId)) return this.native.sendKeypadFeedback(command);
    if (this.ha.sendKeypadFeedback) return this.ha.sendKeypadFeedback(command);
    throw new SupremeError("backend_unavailable", `keypad ${command.keypadId} has no assigned owner`);
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
        // `owner.protocol` is unset for a device that has a native ownership record but
        // has never actually been bound to a specific protocol driver yet (e.g. a
        // device just commissioned on a native-default hub, before its own
        // bindProtocol()/bindNative() call — or a device whose driver's bind restore
        // failed on this boot). Named or not, the answer is the same: it will NOT fall
        // back to Home Assistant.
        const driverLabel = owner.protocol ? `the native "${owner.protocol}" driver` : "a native driver";
        throw new SupremeError(
          "backend_unavailable",
          `device ${deviceId} is owned by ${driverLabel}, but it is not currently bound — it will NOT fall back to Home Assistant; reconnect or reconfigure ${owner.protocol ? `the "${owner.protocol}" driver` : "its driver"}`,
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

  private fanoutInput(event: KeypadInputEvent): void {
    for (const l of this.inputListeners) l(event);
  }
}

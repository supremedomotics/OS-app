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
  DriverTraceEntry,
  IBackendAdapter,
  MediaArtwork,
  MediaQueueItem,
  StateListener,
} from "./adapter.js";
import { applyCommand } from "./apply.js";
import type { INativeProtocolDriver, ProtocolBinding } from "./protocols/driver.js";

export interface SupremeNativeAdapterOptions {
  /**
   * Real protocol drivers (KNX/DALI/Modbus/MQTT/…) this engine fronts. Bound devices
   * route to their driver; everything else uses the built-in in-process model, so the
   * migration path stays fully testable with or without hardware.
   */
  drivers?: INativeProtocolDriver[];
}

/**
 * The Supreme-native device engine (blueprint §7, §16 Phase 4).
 *
 * Implements the exact same {@link IBackendAdapter} contract as `HaAdapter`, but
 * executes entirely on the hub with NO Home Assistant involvement — this is the
 * engine HA is migrated onto, domain by domain. It fronts real native protocol
 * stacks via {@link INativeProtocolDriver}s; any device not bound to a driver is
 * served by an in-process device model, so the migration path is real and testable
 * with or without hardware present. Devices are "provisioned" onto it (native
 * commissioning); commanding an unprovisioned, unbound device auto-provisions it.
 */
export class SupremeNativeAdapter implements IBackendAdapter {
  readonly kind = "supreme-native";
  private connected = false;
  private readonly listeners = new Set<StateListener>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly managed = new Set<DeviceId>();
  private readonly drivers: INativeProtocolDriver[];
  /** deviceId → the protocol driver that owns it (when bound to a real bus). */
  private readonly ownerByDevice = new Map<DeviceId, INativeProtocolDriver>();
  /** protocol → its onState unsubscribe, so a driver can be added/removed at runtime. */
  private readonly unsubByProtocol = new Map<string, () => void>();

  constructor(opts: SupremeNativeAdapterOptions = {}) {
    this.drivers = opts.drivers ?? [];
  }

  /** Connect a single driver and wire its state upward; a connect failure is recorded, not fatal. */
  private async wireDriver(driver: INativeProtocolDriver): Promise<void> {
    try {
      await driver.connect();
    } catch (err) {
      this.connectErrors.push({ protocol: driver.protocol, error: err as Error });
      return;
    }
    const unsub = driver.onState((event) => {
      this.states.set(key(event.deviceId, event.capability), event.state);
      for (const l of this.listeners) l(event);
    });
    this.unsubByProtocol.set(driver.protocol, unsub);
  }

  async connect(): Promise<void> {
    // § Driver Lifecycle Completion: idempotent — a repeated connect() (e.g. a reconnect
    // storm at the SIL boundary) must never re-subscribe onState a second time per driver.
    // Without this guard, each call adds ANOTHER listener to every driver's own listener
    // set (they never get unsubscribed until disconnect()), duplicating every subsequent
    // state event once per extra call.
    if (this.connected) return;
    // Bring up every real protocol driver and re-emit its normalized state upward, so callers can't
    // tell a native engine event from an in-process one. A driver that can't reach its bus at boot
    // must NOT crash the hub — it's skipped and stays disconnected until the bus recovers.
    for (const driver of this.drivers) await this.wireDriver(driver);
    this.connected = true;
  }

  /** Drivers that failed to connect (diagnostics). */
  readonly connectErrors: Array<{ protocol: string; error: Error }> = [];
  async disconnect(): Promise<void> {
    for (const unsub of this.unsubByProtocol.values()) unsub();
    this.unsubByProtocol.clear();
    for (const driver of this.drivers) await driver.disconnect();
    this.connected = false;
  }
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Add (or replace) a native protocol driver at RUNTIME — the manifest↔runtime bridge. When a
   * driver is installed + enabled + configured, the Driver runtime builds its INativeProtocolDriver
   * from the stored config and registers it here; it connects immediately (failures recorded).
   */
  async registerDriver(driver: INativeProtocolDriver): Promise<void> {
    await this.unregisterProtocol(driver.protocol); // replace any existing instance for this protocol
    this.drivers.push(driver);
    await this.wireDriver(driver);
  }

  /** Remove a protocol's native driver (driver disabled/uninstalled). Disconnects + cleans up. */
  async unregisterProtocol(protocol: string): Promise<void> {
    const idx = this.drivers.findIndex((d) => d.protocol === protocol);
    if (idx === -1) return;
    const [driver] = this.drivers.splice(idx, 1);
    const unsub = this.unsubByProtocol.get(protocol);
    if (unsub) {
      unsub();
      this.unsubByProtocol.delete(protocol);
    }
    try {
      await driver!.disconnect();
    } catch {
      /* best-effort */
    }
    for (const [dev, owner] of this.ownerByDevice) if (owner === driver) this.ownerByDevice.delete(dev);
    for (let i = this.connectErrors.length - 1; i >= 0; i--) if (this.connectErrors[i]!.protocol === protocol) this.connectErrors.splice(i, 1);
  }

  /** Protocols with a currently-registered native driver. */
  registeredProtocols(): string[] {
    return this.drivers.map((d) => d.protocol);
  }

  /** The live driver instance for a protocol, or null when none is registered
   * (§ Phase 5 — read-only lookup for orchestration/diagnostics callers). */
  driverFor(protocol: string): INativeProtocolDriver | null {
    return this.drivers.find((d) => d.protocol === protocol) ?? null;
  }

  /** Per-protocol runtime status (for driver health): connectivity + any boot connect error. */
  protocolStatus(): Array<{ protocol: string; connected: boolean; error: string | null }> {
    const errByProto = new Map<string, string>();
    for (const e of this.connectErrors) errByProto.set(e.protocol, e.error.message);
    return this.drivers.map((d) => ({ protocol: d.protocol, connected: d.isConnected(), error: errByProto.get(d.protocol) ?? null }));
  }

  /** (Re)connect a single protocol's native driver — the Driver Manager "Connect" action. */
  async connectProtocol(protocol: string): Promise<boolean> {
    const driver = this.drivers.find((d) => d.protocol === protocol);
    if (!driver) return false;
    await driver.connect();
    // Drop any stale boot error for this protocol now that it reconnected.
    for (let i = this.connectErrors.length - 1; i >= 0; i--) if (this.connectErrors[i]!.protocol === protocol) this.connectErrors.splice(i, 1);
    return true;
  }

  /** Disconnect a single protocol's native driver — the "Disconnect" action. */
  async disconnectProtocol(protocol: string): Promise<boolean> {
    const driver = this.drivers.find((d) => d.protocol === protocol);
    if (!driver) return false;
    await driver.disconnect();
    return true;
  }

  /** Native commissioning: place a device (capability state) under native control. */
  provision(deviceId: DeviceId, capability: CapabilityKind, state?: CapabilityState): void {
    this.managed.add(deviceId);
    if (state) this.states.set(key(deviceId, capability), state);
  }

  /**
   * Bind a device/capability to a real protocol driver (the protocol's commissioning
   * output). Subsequent commands/state for that device flow over the real bus.
   */
  async bind(binding: ProtocolBinding, protocol: string): Promise<void> {
    const driver = this.drivers.find((d) => d.protocol === protocol);
    // A driver package can be installed (its manifest has no license requirement) without its
    // native protocol actually being wired up at boot — e.g. MQTT needs SUPREME_MQTT_URL set.
    // Surfacing this as a plain Error made every one of these a bare, unhelpful "internal error"
    // (§6 error model) instead of the client seeing why the device can't be commissioned yet.
    if (!driver) {
      throw new SupremeError(
        "backend_unavailable",
        `"${protocol}" isn't configured on this hub yet — check its connection settings (e.g. broker URL, host) before adding devices.`,
      );
    }
    await driver.bind(binding);
    this.managed.add(binding.deviceId);
    this.ownerByDevice.set(binding.deviceId, driver);
  }

  manages(deviceId: DeviceId): boolean {
    return this.managed.has(deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    if (!this.connected) throw new SupremeError("backend_unavailable", "supreme-native engine not connected");
    // Bound to a real bus → translate + write through the protocol driver. The driver
    // emits the resulting state asynchronously via its onState stream.
    const owner = this.ownerByDevice.get(deviceId);
    if (owner) {
      await owner.command(deviceId, command);
      return;
    }
    // Otherwise the in-process model responds deterministically.
    this.managed.add(deviceId);
    const prev = this.states.get(key(deviceId, command.capability));
    const next = applyCommand(prev, command);
    if (next) {
      this.states.set(key(deviceId, command.capability), next);
      const event: BackendStateEvent = {
        deviceId,
        capability: command.capability,
        state: next,
        ts: new Date().toISOString(),
      };
      for (const l of this.listeners) l(event);
    }
  }

  async getState(deviceId: DeviceId, capability: CapabilityKind): Promise<CapabilityState | null> {
    const owner = this.ownerByDevice.get(deviceId);
    if (owner) return owner.getState(deviceId, capability);
    return this.states.get(key(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    return (await this.discoverWithStatus()).devices;
  }

  /**
   * Discovery Driver Selector backend (§ Priority 4): the same aggregation `discover()`
   * always did, but (1) filterable to a specific set of protocols so an installer's
   * driver selection actually controls which drivers run — not a frontend-only result
   * filter — and (2) failure-isolated per driver, so one driver throwing (a real
   * connection timeout, a bad scan) never discards every other driver's successful
   * results. True live per-driver progress would need a streaming transport (SSE/WS)
   * this adapter doesn't have; this returns per-driver status ONLY after each driver's
   * scan completes — a documented limitation, not fabricated progress.
   */
  async discoverWithStatus(protocols?: string[]): Promise<{
    devices: DiscoveredDevice[];
    driverResults: { protocol: string; status: "complete" | "failed"; count: number; error?: string }[];
  }> {
    const targets = protocols ? this.drivers.filter((d) => protocols.includes(d.protocol)) : this.drivers;
    const devices: DiscoveredDevice[] = [];
    const driverResults: { protocol: string; status: "complete" | "failed"; count: number; error?: string }[] = [];
    for (const driver of targets) {
      try {
        const found = await driver.discover();
        for (const d of found) devices.push({ ...d, raw: { ...d.raw, protocol: driver.protocol } });
        driverResults.push({ protocol: driver.protocol, status: "complete", count: found.length });
      } catch (err) {
        driverResults.push({ protocol: driver.protocol, status: "failed", count: 0, error: (err as Error).message });
      }
    }
    return { devices, driverResults };
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fetch artwork from the owning driver, if it's a media driver that supports it. */
  async getArtwork(deviceId: DeviceId): Promise<MediaArtwork | null> {
    const owner = this.ownerByDevice.get(deviceId);
    if (owner?.getArtwork) return owner.getArtwork(deviceId);
    return null;
  }

  /** Fetch the play queue from the owning driver, if it exposes one. */
  async getQueue(deviceId: DeviceId): Promise<MediaQueueItem[] | null> {
    const owner = this.ownerByDevice.get(deviceId);
    if (owner?.getQueue) return owner.getQueue(deviceId);
    return null;
  }

  /** Fetch the owning driver's real AudioCapabilityConfig for this device+capability. */
  async getCapabilityConfig(deviceId: DeviceId, capability: CapabilityKind): Promise<Record<string, unknown> | null> {
    const owner = this.ownerByDevice.get(deviceId);
    if (owner?.getCapabilityConfig) return owner.getCapabilityConfig(deviceId, capability);
    return null;
  }

  /** Fetch the owning driver's real connection/traffic diagnostics for this device. */
  async getDiagnostics(deviceId: DeviceId): Promise<DriverDiagnosticsSnapshot | null> {
    const owner = this.ownerByDevice.get(deviceId);
    if (owner?.getDiagnostics) return owner.getDiagnostics(deviceId);
    return null;
  }

  /** Fetch the owning driver's recent raw protocol trace for this device. */
  async getTrace(deviceId: DeviceId): Promise<DriverTraceEntry[] | null> {
    const owner = this.ownerByDevice.get(deviceId);
    if (owner?.getTrace) return owner.getTrace(deviceId);
    return null;
  }

  /** § Capability Refresh — ask the owning driver to re-query whatever it can
   * genuinely re-discover over the wire, in place, without recreating the device. A
   * no-op (not a throw) for a driver that doesn't implement this or doesn't own the
   * device — matching every other optional per-device driver call in this class. */
  async refreshCapabilities(deviceId: DeviceId): Promise<void> {
    const owner = this.ownerByDevice.get(deviceId);
    if (owner?.refreshCapabilities) await owner.refreshCapabilities(deviceId);
  }

  /** Release the owning driver's per-device resources (§ Driver Lifecycle Completion)
   * — called when a Supreme device is deleted while its driver keeps running for
   * other devices. Safe to call for a device with no native owner (e.g. in-process
   * model only, or already unbound) — a no-op, never a throw, matching every other
   * optional per-device driver call in this class. */
  async unbindDevice(deviceId: DeviceId): Promise<void> {
    const owner = this.ownerByDevice.get(deviceId);
    this.ownerByDevice.delete(deviceId);
    this.managed.delete(deviceId);
    const prefix = `${deviceId}:`;
    for (const k of [...this.states.keys()]) {
      if (k.startsWith(prefix)) this.states.delete(k);
    }
    if (owner?.unbind) await owner.unbind(deviceId);
  }
}

function key(deviceId: DeviceId, capability: CapabilityKind): string {
  return `${deviceId}:${capability}`;
}

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
  private readonly driverUnsubs: Array<() => void> = [];

  constructor(opts: SupremeNativeAdapterOptions = {}) {
    this.drivers = opts.drivers ?? [];
  }

  async connect(): Promise<void> {
    // Bring up every real protocol driver and re-emit its normalized state upward,
    // so callers can't tell a native engine event from an in-process one.
    for (const driver of this.drivers) {
      await driver.connect();
      this.driverUnsubs.push(
        driver.onState((event) => {
          this.states.set(key(event.deviceId, event.capability), event.state);
          for (const l of this.listeners) l(event);
        }),
      );
    }
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    for (const unsub of this.driverUnsubs.splice(0)) unsub();
    for (const driver of this.drivers) await driver.disconnect();
    this.connected = false;
  }
  isConnected(): boolean {
    return this.connected;
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
    if (!driver) throw new Error(`no native protocol driver for "${protocol}"`);
    await driver.bind(binding);
    this.managed.add(binding.deviceId);
    this.ownerByDevice.set(binding.deviceId, driver);
  }

  manages(deviceId: DeviceId): boolean {
    return this.managed.has(deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    if (!this.connected) throw new Error("supreme-native engine not connected");
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
    // Aggregate discovery across real protocol drivers (none → empty, as before),
    // tagging each with its owning protocol so commissioning can auto-bind it.
    const all: DiscoveredDevice[] = [];
    for (const driver of this.drivers) {
      for (const d of await driver.discover()) {
        all.push({ ...d, raw: { ...d.raw, protocol: driver.protocol } });
      }
    }
    return all;
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function key(deviceId: DeviceId, capability: CapabilityKind): string {
  return `${deviceId}:${capability}`;
}

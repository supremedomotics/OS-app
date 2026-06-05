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

/**
 * The Supreme-native device engine (blueprint §7, §16 Phase 4).
 *
 * Implements the exact same {@link IBackendAdapter} contract as `HaAdapter`, but
 * executes entirely on the hub with NO Home Assistant involvement — this is the
 * engine HA is migrated onto, domain by domain. In a full build it fronts native
 * protocol stacks (Zigbee/Matter/…); here it runs an in-process device model so
 * the migration path is real and testable. Devices are "provisioned" onto it
 * (native commissioning); commanding an unprovisioned device auto-provisions it.
 */
export class SupremeNativeAdapter implements IBackendAdapter {
  readonly kind = "supreme-native";
  private connected = false;
  private readonly listeners = new Set<StateListener>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly managed = new Set<DeviceId>();

  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
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

  manages(deviceId: DeviceId): boolean {
    return this.managed.has(deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    if (!this.connected) throw new Error("supreme-native engine not connected");
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
    return this.states.get(key(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    return []; // native discovery is driver-specific; none in the in-process model
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function key(deviceId: DeviceId, capability: CapabilityKind): string {
  return `${deviceId}:${capability}`;
}

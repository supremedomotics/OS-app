import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
} from "@supreme/domain-model";
import type { DiscoveredDevice, StateListener } from "../adapter.js";

/**
 * Native protocol driver contract (blueprint §7, §9, §16).
 *
 * `SupremeNativeAdapter` is "the engine HA is migrated onto"; in a real build it
 * fronts native protocol stacks (KNX/DALI/Modbus/MQTT/Zigbee/Matter). This is the
 * seam those stacks implement. A driver speaks one real wire protocol and is the
 * ONLY place that knows that protocol's framing — it translates Supreme capability
 * commands to bus writes and normalizes bus traffic back into Supreme state events,
 * exactly mirroring how `HaAdapter` confines HA. Drivers live in `@supreme/protocols`
 * (which carries the protocol client deps); the SIL depends only on this interface,
 * so no protocol library leaks above the adapter.
 */

/** Binds a Supreme device+capability to a concrete protocol address (e.g. an MQTT
 * topic root or a Modbus register). Produced by commissioning; consumed by a driver. */
export interface ProtocolBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  /** Protocol-native address. Interpreted by the owning driver only. */
  address: string;
  /** Optional per-binding tuning (scale factor, payload template, unit, …). */
  config?: Record<string, unknown>;
}

export interface INativeProtocolDriver {
  /** Protocol identifier, e.g. "mqtt" | "modbus" | "knx". */
  readonly protocol: string;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  /** Place a Supreme device/capability under this driver's control. Idempotent. */
  bind(binding: ProtocolBinding): Promise<void>;
  /** True if this driver owns the given device. */
  manages(deviceId: DeviceId): boolean;

  /** Translate + write a Supreme command to the bus for a bound device. */
  command(deviceId: DeviceId, command: CapabilityCommand): Promise<void>;
  /** Last normalized state this driver observed for the device capability. */
  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null;

  /** Protocol-native discovery (returns Supreme capability hints). */
  discover(): Promise<DiscoveredDevice[]>;

  /** Subscribe to normalized (already Supreme) state changes from the bus. */
  onState(listener: StateListener): () => void;
}

/** Compose key for a device+capability binding. */
export function bindingKey(deviceId: DeviceId, capability: CapabilityKind): string {
  return `${deviceId}:${capability}`;
}

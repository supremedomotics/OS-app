import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
  KeypadCapabilityDeclaration,
  KeypadFeedbackCommand,
  KeypadInputEvent,
} from "@supreme/domain-model";
import type { DiscoveredDevice, DriverDiagnosticsSnapshot, MediaArtwork, MediaQueueItem, StateListener } from "../adapter.js";

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

  /**
   * Optional: release EVERY resource this driver holds for ONE device — timers,
   * sockets/socket references, subscriptions, cached state, diagnostics trackers,
   * in-flight-promise entries — without tearing down the whole driver instance
   * (§ Driver Lifecycle Completion). Called when a Supreme device is deleted while
   * its owning driver keeps running (e.g. one HEOS player removed while the rest of
   * the network stays bound). Optional because not every driver has been migrated
   * yet (see `docs/architecture/driver-lifecycle.md`'s compliance report) and because
   * a driver with truly nothing per-device to release (rare) doesn't need it — but
   * every driver that owns ANY per-device state (which is nearly all of them) should
   * implement this. MUST be idempotent: calling it twice for an already-unbound
   * device must be a safe no-op, never a throw. MUST NOT throw for a device this
   * driver doesn't currently manage — a caller doesn't need to check `manages()`
   * first. If this device shares a physical link with other still-bound devices
   * (HEOS's one-connection-many-players, AVR's zone2-on-the-same-socket), the driver
   * decides whether to close the shared resource (only when it was the LAST device
   * referencing it) or just remove this device's own entries — see the Driver Author
   * Guide for the exact pattern.
   */
  unbind?(deviceId: DeviceId): Promise<void>;

  /** Translate + write a Supreme command to the bus for a bound device. */
  command(deviceId: DeviceId, command: CapabilityCommand): Promise<void>;
  /** Last normalized state this driver observed for the device capability. */
  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null;

  /** Protocol-native discovery (returns Supreme capability hints). */
  discover(): Promise<DiscoveredDevice[]>;

  /** Subscribe to normalized (already Supreme) state changes from the bus. */
  onState(listener: StateListener): () => void;

  /** Optional: fetch the device's current media artwork bytes (media drivers only). */
  getArtwork?(deviceId: DeviceId): Promise<MediaArtwork | null>;

  /** Optional: fetch the device's current play queue (media drivers with a real
   * queue concept on the wire only — e.g. HEOS; not fabricated where none exists). */
  getQueue?(deviceId: DeviceId): Promise<MediaQueueItem[] | null>;

  /** Optional: this device+capability's real AudioCapabilityConfig (inputs, sound
   * modes, zones, advancedControls, …), if this driver has one to report. Called once
   * right after a successful `bind()` so a rich console has real, capability-driven
   * data to render instead of a device with no config at all. */
  getCapabilityConfig?(deviceId: DeviceId, capability: CapabilityKind): Record<string, unknown> | null;

  /** Optional: this device's real connection/traffic diagnostics (§ Diagnostics
   * Console) — connection status, last command/response, RX/TX packet counts,
   * reconnect count, response time, last error. `null` when this driver doesn't
   * manage the device. Synchronous: reading counters already held in memory, never a
   * network round-trip. */
  getDiagnostics?(deviceId: DeviceId): DriverDiagnosticsSnapshot | null;

  // ── Universal Keypad Framework (§ Driver SDK Extension) ─────────────────────
  // Every member below is OPTIONAL, exactly like getArtwork/getCapabilityConfig/
  // getDiagnostics above — a driver that isn't a keypad (or hasn't been migrated to
  // declare keypad support yet) implements none of them and is completely unaffected.
  // A driver never needs to know any other protocol's keypad implementation exists;
  // it only ever produces/consumes the protocol-independent types from
  // `@supreme/domain-model` (`KeypadCapabilityDeclaration`, `KeypadInputEvent`,
  // `KeypadFeedbackCommand`).

  /** Optional: this device's real keypad capability declaration (buttons/encoders/
   * their input+feedback capabilities) — called once right after a successful
   * `bind()`, mirroring `getCapabilityConfig`. `null` when this driver doesn't manage
   * the device or the device isn't a keypad. Never fabricated: a driver with no real
   * capability data to report simply omits this member entirely. */
  getKeypadCapabilities?(deviceId: DeviceId): KeypadCapabilityDeclaration | null;

  /** Optional: subscribe to this driver's raw/derived keypad input (button presses,
   * encoder rotation, gestures, …), already normalized into {@link KeypadInputEvent}
   * — the driver is the ONLY place that ever sees the protocol-native payload.
   * Returns an unsubscribe function, exactly like {@link onState}. */
  onInputEvent?(listener: (event: KeypadInputEvent) => void): () => void;

  /** Optional: translate + write a generic {@link KeypadFeedbackCommand} to the bus
   * for a bound keypad — the write-side mirror of `onInputEvent`. A driver whose
   * keypad has no feedback hardware at all (pure input, no LED/display) simply omits
   * this member. A driver that HAS some feedback hardware but not every type in the
   * union (e.g. LED-only, no display) still implements this member and silently
   * no-ops (or throws a typed, caller-visible error) for feedback types its control
   * didn't declare in `getKeypadCapabilities` — the Universal Feedback Engine already
   * gates on the declaration before calling this, so a compliant caller never sends
   * an undeclared type, but the driver must not crash if one arrives regardless. */
  sendKeypadFeedback?(command: KeypadFeedbackCommand): Promise<void>;
}

/** A binding tagged with the owning protocol, as persisted + rebound on boot. */
export interface StoredProtocolBinding extends ProtocolBinding {
  /** Which driver owns this binding, e.g. "knx" | "modbus" | "mqtt". */
  protocol: string;
}

/**
 * Persistence seam for protocol bindings (§3, §4). Commissioned bus devices must
 * survive a hub restart and be re-bound onto their drivers on boot. Default = none
 * (in-memory only); the Postgres-backed store persists them.
 */
export interface IProtocolBindingStore {
  list(): Promise<StoredProtocolBinding[]>;
  put(binding: StoredProtocolBinding): Promise<void>;
  remove(deviceId: DeviceId, capability: CapabilityKind): Promise<void>;
}

/** In-memory binding store (dev / non-persistent hubs). */
export class InMemoryProtocolBindingStore implements IProtocolBindingStore {
  private readonly bindings = new Map<string, StoredProtocolBinding>();
  async list(): Promise<StoredProtocolBinding[]> {
    return [...this.bindings.values()];
  }
  async put(binding: StoredProtocolBinding): Promise<void> {
    this.bindings.set(bindingKey(binding.deviceId, binding.capability), binding);
  }
  async remove(deviceId: DeviceId, capability: CapabilityKind): Promise<void> {
    this.bindings.delete(bindingKey(deviceId, capability));
  }
}

/** Compose key for a device+capability binding. */
export function bindingKey(deviceId: DeviceId, capability: CapabilityKind): string {
  return `${deviceId}:${capability}`;
}

import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
} from "@supreme/domain-model";
import type { DiscoveredDevice, DriverDiagnosticsSnapshot, DriverTraceEntry, MediaArtwork, MediaQueueItem, StateListener } from "../adapter.js";

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

/** § ADR 0101 Part 1 — Scene Runtime. A scene a driver found in its own external system
 * (an ETS project's DPT 17/18 scene group addresses, a synchronized cloud API's scene list,
 * …), described entirely in protocol-agnostic terms so `SceneService` never needs to know
 * which driver produced it. `steps` are already Supreme capability commands — a driver is the
 * ONLY place that may translate protocol-native scene actions into them. */
export interface DiscoveredScene {
  /** Stable id in the SOURCE system (e.g. a KNX scene number) — used for duplicate-safe
   * re-import/re-sync, never regenerated per scan. */
  sourceSceneId: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  /** Room/area hint from the source system's own metadata, when it has one (an ETS
   * `<Function>`'s enclosing `<Space>`, a Casambi group's room mapping, …) — resolved to a
   * real Supreme room the same way device discovery already does; never guessed here. */
  roomHint?: string | null;
  steps: { deviceId: DeviceId; capability: CapabilityKind; command: Record<string, unknown> }[];
}

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

  /** Optional: this device's owning link's recent raw protocol trace (§ Universal AVR
   * SDK — "capture and log the raw protocol responses for every discovery, capability,
   * command, and event operation"). `null` when this driver doesn't manage the device.
   * Synchronous, same reasoning as {@link getDiagnostics} — reads an in-memory ring
   * buffer, never a network round-trip. */
  getTrace?(deviceId: DeviceId): DriverTraceEntry[] | null;

  /** § RTI Capability Audit, Category C.4 — optional, devMode-only escape hatch: write a
   * literal, installer-supplied token straight to this device's wire connection, bypassing
   * the driver's own typed `commandToAvr()`-style dispatch and its safety net entirely.
   * Legitimate only because the token vocabulary itself is already the same one every typed
   * command in this driver already sends — this adds no new protocol surface, only a
   * generic pass-through for a command this driver's typed surface hasn't caught up to yet.
   * Absent for any driver that doesn't offer one (most won't). MUST reject/throw for a
   * device it doesn't manage rather than silently no-op. */
  sendRaw?(deviceId: DeviceId, token: string): Promise<void>;

  /** § AVR Diagnostic Mode — optional: append one more stage to an in-flight event's
   * correlation-ID trace (see `BackendStateEvent.traceId`). Called by gateway-layer
   * code (never by another driver) once it's done its own part of handling an event
   * that carried a `traceId` — e.g. `{ published: true }` after a bus publish,
   * `{ sent: true, subscribedRooms: 2 }` after a WebSocket send. A no-op for any driver
   * that doesn't implement diagnostics (i.e. everything but AVR-with-diagnostics-on). */
  recordDiagnosticStage?(traceId: string, stage: string, fields: Record<string, unknown>): void;

  /** § AVR Diagnostic Mode — optional: the complete, human-readable trace log this
   * driver has buffered since diagnostics was enabled, ending with a session summary
   * (counters + top unknown commands). `null` when diagnostics isn't enabled/supported.
   * Synchronous — reads an in-memory buffer, never a network round-trip. */
  exportDiagnosticsLog?(): string | null;

  /** § ADR 0101 Part 1 — Optional: scenes this driver's source system genuinely defines
   * (an ETS project's scene DPTs, a synchronized API's scene list). Absent entirely for any
   * driver whose protocol has no real scene concept to discover — never implemented with a
   * stub that returns []  to "complete the interface." Called after `discover()` on
   * install/commission/refresh, same lifecycle points, so scene import always sees the
   * devices it needs to map steps onto. */
  discoverScenes?(): Promise<DiscoveredScene[]>;

  /** Optional: force an on-demand, in-place re-query of this device's real
   * capabilities (§ Capability Refresh) — never recreates the device, never touches
   * its room assignment/automations/history, only refreshes whatever THIS driver can
   * genuinely re-discover over the wire. What "refresh" honestly means is protocol-
   * specific and MUST NOT be embellished: a driver with a genuine feature-query
   * command (e.g. Yamaha's `/system/getFeatures`) re-fetches and replaces its cached
   * capability data; a driver with NO such command (e.g. Denon/Marantz Telnet, which
   * has no feature-query command at all — verified against the spec) has nothing new
   * to discover, so this is a no-op or, at most, a reconnect that re-syncs live STATE
   * — it must never fabricate a "new" capability that didn't come off the wire.
   * Callers should still re-read `getCapabilityConfig()` afterward — that's what
   * actually reflects whatever this call did or didn't change. */
  refreshCapabilities?(deviceId: DeviceId): Promise<void>;
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

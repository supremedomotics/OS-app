import type { CapabilityKind, CapabilityState, DeviceId } from "@supreme/domain-model";

/**
 * SupremeOS Core Event Bus (§ Casambi Driver Refactor — PR-2 "Core Architecture Enhancement").
 *
 * The ONE transport-independent event system every native driver publishes to and subscribes
 * through. Nothing above this seam — automations, the Universal Keypad Framework, a future
 * cross-driver automation ("Casambi keypad → KNX light"), diagnostics — should ever need to know
 * whether an event originated from a Casambi UDP packet, a KNX telegram, a Lutron LIP frame, or
 * an MQTT message. Every driver normalizes into the SAME 13-category taxonomy below before
 * anything else observes it.
 *
 * This supersedes the Casambi-only `event-engine.ts` shipped in the Foundation PR — same
 * publish/subscribe shape, generalized so any driver can use it, not renamed for Casambi alone.
 *
 * Honesty note: every event type here is a real, permanent part of the taxonomy (the brief's own
 * 13 categories), but not every type has a real emitter TODAY. Each interface's doc comment states
 * plainly which drivers actually publish it right now versus which are reserved for a protocol
 * that hasn't been wired onto the bus yet — never a fabricated signal, exactly the same "visibly
 * incomplete, never silently faked" discipline the rest of this codebase already holds itself to.
 */

interface CoreEventBase {
  /** Protocol identifier of the driver that published this event, e.g. "casambi", "knx". */
  driver: string;
  ts: string;
}

/** A bound device/capability's normalized state changed. Emitted by: Casambi (Cloud + Local). */
export interface DeviceEvent extends CoreEventBase {
  type: "device";
  deviceId: DeviceId;
  capability: CapabilityKind;
  state: CapabilityState;
}

/** A physical button/keypad press. Emitted by: Casambi Local (firmware ≥ 39.50, opcode 0x51
 * NotifyButtonEvent). NOT emitted by Casambi Cloud today — the Cloud REST/WebSocket API this
 * driver speaks has no documented button-press notification. */
export interface ButtonEvent extends CoreEventBase {
  type: "button";
  deviceId?: DeviceId;
  /** Driver-native unit/device identifier, present even when no Supreme device is bound yet. */
  nativeId: string;
  /** 0-based button/channel number. */
  button: number;
  action: "press" | "release" | "short_press" | "long_press_start" | "long_press_end";
}

/** A read-only sensor reported a new reading. Emitted by: Casambi (Cloud + Local) — a typed
 * republish of the same data a `sensor`-capability `DeviceEvent` already carries, for consumers
 * that key off sensor semantics directly rather than filtering every device event by capability. */
export interface SensorEvent extends CoreEventBase {
  type: "sensor";
  deviceId: DeviceId;
  measure: string;
  value: number;
  unit: string;
}

/** A lighting-specific state change (onoff/brightness/color). Reserved for drivers that want a
 * more specific event than the generic `DeviceEvent` for lighting entities — e.g. a future KNX/
 * DALI adoption. NOT emitted by any driver today; Casambi publishes lighting state as `DeviceEvent`
 * (capability onoff/brightness/color), which already carries the same information. */
export interface LightingEvent extends CoreEventBase {
  type: "lighting";
  deviceId: DeviceId;
  capability: Extract<CapabilityKind, "onoff" | "brightness" | "color">;
  state: CapabilityState;
}

/** A media transport/volume/source change. Reserved for the AV SDK (AVR/HEOS/Yamaha) to adopt in
 * a future pass. NOT emitted by any driver today — the AV SDK still only reports through its own
 * `onState`/diagnostics surface, not yet migrated onto this bus. */
export interface MediaEvent extends CoreEventBase {
  type: "media";
  deviceId: DeviceId;
  state: CapabilityState;
}

/** A climate/setpoint change. Reserved for KNX/CoolMaster to adopt in a future pass. NOT emitted
 * by any driver today. */
export interface ClimateEvent extends CoreEventBase {
  type: "climate";
  deviceId: DeviceId;
  state: CapabilityState;
}

/** An automation/scene-trigger fired as a result of this driver's own logic (not a Supreme-side
 * automation, which already has its own `AutomationRun` trace). Reserved — no driver has an
 * automation concept of its own to report yet. */
export interface AutomationEvent extends CoreEventBase {
  type: "automation";
  automationId: string;
  detail?: string;
}

/** A scene was called/activated, or its status changed. Emitted by: Casambi Cloud (a unit's
 * `activeSceneId` changing, from the network model) and Casambi Local (opcode 0x0D "Scene
 * called" and 0x45 "Scene Status"). */
export interface SceneEvent extends CoreEventBase {
  type: "scene";
  sceneId: string;
  active?: boolean;
  level?: number;
}

/** A group's aggregate status changed. Emitted by: Casambi Local only (opcode 0x46 "Target
 * Status" queried with Target_Type=2, a real per-group signal the UDP protocol reports). Casambi
 * Cloud has no equivalent group-level status push today — only per-device state. */
export interface GroupEvent extends CoreEventBase {
  type: "group";
  groupId: string;
  level?: number;
}

/** A free-form, driver-internal diagnostic occurrence (useful for the Diagnostics/Packet Recorder
 * modules). Emitted by: Casambi (Cloud + Local). */
export interface DiagnosticEvent extends CoreEventBase {
  type: "diagnostic";
  kind: "error" | "warning" | "info";
  detail?: string;
}

/** A driver connection-lifecycle transition. Emitted by: Casambi (Cloud + Local). */
export interface DriverEvent extends CoreEventBase {
  type: "driver";
  kind: "connected" | "disconnected" | "reconnect_scheduled" | "reconnect_succeeded";
  detail?: string;
}

/** A transport/network-level occurrence (wire status, socket loss, configuration refresh).
 * Emitted by: Casambi (Cloud + Local). */
export interface NetworkEvent extends CoreEventBase {
  type: "network";
  kind: "networkUpdated" | "wireStatus" | "disconnected";
  detail?: string;
}

/** The Driver Health Engine's computed verdict changed. Emitted by: Casambi (Cloud + Local), via
 * `core/driver-health-engine.ts`. */
export interface HealthEvent extends CoreEventBase {
  type: "health";
  healthScore: number;
  verdict: "healthy" | "degraded" | "error" | "not_implemented";
}

export type CoreDriverEvent =
  | DeviceEvent
  | ButtonEvent
  | SensorEvent
  | LightingEvent
  | MediaEvent
  | ClimateEvent
  | AutomationEvent
  | SceneEvent
  | GroupEvent
  | DiagnosticEvent
  | DriverEvent
  | NetworkEvent
  | HealthEvent;

export type CoreEventListener = (event: CoreDriverEvent) => void;

/** Minimal pub/sub, deliberately no filtering/replay/persistence — a driver-instance-scoped bus
 * mirrors the simplicity of the existing `onState` listener set every driver already has. A
 * process-wide bus (multiple driver instances publishing to one shared subscriber set) is
 * exactly this same class shared across driver constructions; nothing here assumes singleton
 * scope. */
export class CoreEventBus {
  private readonly listeners = new Set<CoreEventListener>();

  on(listener: CoreEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: CoreDriverEvent): void {
    for (const l of this.listeners) l(event);
  }
}

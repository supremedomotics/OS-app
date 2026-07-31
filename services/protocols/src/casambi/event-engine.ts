import type { CapabilityKind, CapabilityState, DeviceId } from "@supreme/domain-model";

/**
 * Casambi Event Bus (§ Casambi Driver Refactor — Foundation "Event Bus": a transport-independent
 * event system). Nothing above this seam should know whether an event originated from the Cloud
 * WebSocket wire, a future Local UDP packet, or any other future transport — every raw signal is
 * normalized into one of the six event kinds below before anything else observes it. This is
 * ADDITIVE: the driver's existing `onState`/`StateListener` contract (required by
 * `INativeProtocolDriver`) is untouched — this bus exists alongside it for consumers that want the
 * richer, transport-independent taxonomy (diagnostics, future automations/keypad integrations).
 *
 * Only events genuinely observable on the wire today are ever published — a `ButtonEvent` type
 * exists for a future Casambi keypad/button unit, but nothing emits one yet (no such unit type is
 * decoded by the Entity Mapper today); that is honest scaffolding, not a fabricated signal.
 */

interface CasambiEventBase {
  ts: string;
}

/** A bound device/capability's state changed (mirrors what `onState` already reports, in the
 * transport-independent taxonomy). */
export interface DeviceEvent extends CasambiEventBase {
  type: "device";
  unitId: number;
  deviceId: DeviceId;
  capability: CapabilityKind;
  state: CapabilityState;
}

/** A physical Casambi keypad/button press. Reserved for a future button-capable unit type —
 * nothing publishes this yet. */
export interface ButtonEvent extends CasambiEventBase {
  type: "button";
  unitId: number;
  action: string;
}

/** A Casambi unit's active scene changed (`activeSceneId`) — a real field the network model
 * already reports today. */
export interface SceneEvent extends CasambiEventBase {
  type: "scene";
  unitId: number;
  sceneId: number;
}

/** A sensor unit reported a new reading — the same data `DeviceEvent`'s `sensor` capability
 * carries, republished under its own typed event for consumers that key off sensor semantics
 * specifically rather than filtering every device event by capability. */
export interface SensorEvent extends CasambiEventBase {
  type: "sensor";
  unitId: number;
  deviceId: DeviceId;
  measure: string;
  value: number;
  unit: string;
}

/** Network/connection-level occurrence (wire status, network model refresh, socket loss). */
export interface NetworkEvent extends CasambiEventBase {
  type: "network";
  kind: "networkUpdated" | "wireStatus" | "disconnected" | "connected";
  detail?: string;
}

/** Driver-internal lifecycle occurrence useful for the Diagnostics/Health Monitor modules. */
export interface DiagnosticEvent extends CasambiEventBase {
  type: "diagnostic";
  kind: "reconnect_scheduled" | "reconnect_succeeded" | "error";
  detail?: string;
}

export type CasambiDriverEvent =
  | DeviceEvent
  | ButtonEvent
  | SceneEvent
  | SensorEvent
  | NetworkEvent
  | DiagnosticEvent;

export type CasambiEventListener = (event: CasambiDriverEvent) => void;

/** Minimal pub/sub — no filtering/replay, mirrors the simplicity of the existing `onState`
 * listener set. */
export class CasambiEventBus {
  private readonly listeners = new Set<CasambiEventListener>();

  on(listener: CasambiEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: CasambiDriverEvent): void {
    for (const l of this.listeners) l(event);
  }
}

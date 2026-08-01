import type { CapabilityKind, CapabilityState, DeviceId } from "@supreme/domain-model";
import type { CasambiEvent } from "./cloud-transport.js";
import type { CasambiUnit } from "./entity-mapper.js";
import { updateUnitFromControlValues } from "./local-discovery.js";
import {
  encodeNotifyButtonEvent,
  parseButtonEvent,
  parseNodeRemoved,
  parseNotifyControlValues,
  parseSceneCalled,
  type CasambiPacket,
  type CasambiUdpEngine,
} from "./local-transport/index.js";

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

// -------------------------------------------------------------------------------------------
// Event Engine normalization (§ Architecture Validation — mandatory pre-implementation audit).
//
// Before this existed, `casambi-driver.ts` had TWO separate private methods — `onEvent` (Cloud)
// and `onLocalPacket` (Local) — each independently deciding, from raw transport-specific data,
// what a signal meant and what the driver should do about it (merge a unit, publish a network
// event, trigger a reconnect...). That is real, confirmed protocol-specific event handling
// duplicated per transport, a direct violation of "every incoming event passes through ONE Event
// Engine... no protocol-specific event handling" (see the architecture audit doc for the full
// finding). `CasambiSignal` is the ONE normalized shape both transports reduce to; the two
// `normalizeXxx` functions below are the ONLY place that still knows a Cloud `CasambiEvent` looks
// different from a Local `CasambiPacket` — the driver's own reaction to a `CasambiSignal` (in
// `casambi-driver.ts`'s `applySignal`) is a single, transport-agnostic switch, reused for both.
//
// This does NOT eliminate all per-transport code — the wire formats are genuinely different, so
// something has to parse each one. What it eliminates is the DUPLICATED DECISION of "what does
// this raw signal mean and what normalized event does it become" living twice, once per
// transport, inside the driver itself.
// -------------------------------------------------------------------------------------------

export type CasambiSignal =
  | { kind: "pong" }
  | { kind: "wireStatus"; status: string }
  | { kind: "unit"; unit: CasambiUnit }
  | { kind: "unitRemoved"; unitId: number }
  | { kind: "networkUpdated" }
  | { kind: "button"; unitId: number; action: string }
  /** Local-only 0x0D "Scene called" — an 8-bit, installer-app-configured code with no
   * unitId/sceneId equivalent to `SceneEvent`. Carried through as raw data rather than forced
   * into a shape it doesn't fit; see TODO.md for the open question of what a real typed event
   * for this should look like. */
  | { kind: "sceneRaw"; bits: number[] };

/**
 * Normalize a Cloud WebSocket `CasambiEvent` into a `CasambiSignal`, or `null` when the event
 * needs no reaction (`peerChanged`, any other unrecognized `method`). Pure — no driver state is
 * read or mutated here; `eventToUnit` only reshapes the event's own fields.
 */
export function normalizeCloudEvent(event: CasambiEvent): CasambiSignal | null {
  if (event.response === "pong") return { kind: "pong" };
  if (typeof event.wireStatus === "string") return { kind: "wireStatus", status: event.wireStatus };
  switch (event.method) {
    case "unitChanged":
      return { kind: "unit", unit: eventToUnit(event) };
    case "networkUpdated":
      return { kind: "networkUpdated" };
    case "peerChanged":
    default:
      // Peer/gateway presence — no device action required.
      return null;
  }
}

/** A `unitChanged` event carries the same field set as a REST unit — read it as one. */
function eventToUnit(event: CasambiEvent): CasambiUnit {
  return {
    id: Number(event.id),
    name: typeof event.name === "string" ? event.name : undefined,
    type: typeof event.type === "string" ? event.type : undefined,
    fixtureId: typeof event.fixtureId === "number" ? event.fixtureId : undefined,
    groupId: typeof event.groupId === "number" ? event.groupId : undefined,
    address: typeof event.address === "string" ? event.address : undefined,
    online: typeof event.online === "boolean" ? event.online : undefined,
    on: typeof event.on === "boolean" ? event.on : undefined,
    dimLevel: typeof event.dimLevel === "number" ? event.dimLevel : undefined,
    status: typeof event.status === "string" ? event.status : undefined,
    condition: typeof event.condition === "number" ? event.condition : undefined,
    activeSceneId: typeof event.activeSceneId === "number" ? event.activeSceneId : undefined,
    controls: Array.isArray(event.controls) ? (event.controls as CasambiUnit["controls"]) : undefined,
    sensors: event.sensors && typeof event.sensors === "object" ? (event.sensors as Record<string, unknown>) : undefined,
    image: typeof event.image === "string" ? event.image : undefined,
  };
}

/**
 * Normalize a Local UDP `CasambiPacket` into a `CasambiSignal`, or `null` for a packet this
 * driver doesn't react to (an empty NotifyControlValues response, or any of the real-but-unused
 * opcodes — 0x1A/0x1B parameter responses, 0x28 time, 0x39 node status, 0x45 scene status, 0x46
 * target status, 0x49 target color — decodable via `local-transport/udp-codec.ts` but nothing
 * queries them proactively yet, see TODO.md).
 *
 * `getPrevUnit` is a lookup callback rather than a plain value: a 0x4B response's Target_ID isn't
 * known until the packet is partially parsed, so the caller can't pre-fetch the previous unit
 * before calling this function. Passing a callback keeps this function pure (same output for the
 * same packet + the same callback's answers) without requiring the caller to duplicate the
 * NotifyControlValues parse just to know which unit to look up.
 */
export function normalizeLocalPacket(
  packet: CasambiPacket,
  getPrevUnit: (unitId: number) => CasambiUnit | undefined,
): CasambiSignal | null {
  switch (packet.opcode) {
    case 0x4b: {
      const notify = parseNotifyControlValues(packet);
      if (notify.values.length === 0) return null; // "no data available" empty response (p.315)
      const unit = updateUnitFromControlValues(notify.targetId, notify.values, getPrevUnit(notify.targetId));
      return { kind: "unit", unit };
    }
    case 0x51: {
      const btn = parseButtonEvent(packet);
      return { kind: "button", unitId: btn.unitId, action: btn.eventLabel ?? `type_${btn.event}` };
    }
    case 0x3a: {
      const removed = parseNodeRemoved(packet);
      return { kind: "unitRemoved", unitId: removed.unitId };
    }
    case 0x0d: {
      const scene = parseSceneCalled(packet);
      return { kind: "sceneRaw", bits: scene.bits };
    }
    default:
      return null;
  }
}

/**
 * Enable/disable Local's realtime button-press notification stream (opcode 0x50). This is an
 * event-DELIVERY concern (which events the gateway bothers sending), not a discovery concern
 * (which units exist) — kept here rather than in `discovery-engine.ts`'s Local bootstrap for that
 * reason, even though both fire from the same `connectLocal()`/`disconnectLocal()` moment today.
 */
export async function enableLocalButtonEvents(udp: Pick<CasambiUdpEngine, "send">, netId: number): Promise<void> {
  await udp.send(encodeNotifyButtonEvent(netId, true));
}

export async function disableLocalButtonEvents(udp: Pick<CasambiUdpEngine, "send">, netId: number): Promise<void> {
  await udp.send(encodeNotifyButtonEvent(netId, false));
}

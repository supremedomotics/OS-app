import { CapabilityCommand, CapabilityState } from "@supreme/domain-model";
import { z } from "zod";

/**
 * Realtime contract for WSS `/v1/stream` (§6, §3.2).
 *
 * The stream is bidirectional:
 *   - client → server: subscribe to room scopes, issue commands, heartbeat
 *   - server → client: state deltas, notifications, command acks, errors
 *
 * Subjects mirror the event-bus naming `home.<id>.room.<id>.device.<id>.state`
 * so gateway fan-out is permission-filtered and room-scoped.
 */

// ── Client → server frames ───────────────────────────────────────────────────

export const SubscribeFrame = z.object({
  type: z.literal("subscribe"),
  /** Room ids to subscribe to; "*" subscribes to all permitted rooms. */
  rooms: z.array(z.string()),
});

export const UnsubscribeFrame = z.object({
  type: z.literal("unsubscribe"),
  rooms: z.array(z.string()),
});

export const CommandFrame = z.object({
  type: z.literal("command"),
  /** Client-generated id echoed back in the ack for optimistic reconciliation. */
  requestId: z.string(),
  deviceId: z.string(),
  command: CapabilityCommand,
});

export const PingFrame = z.object({ type: z.literal("ping") });

export const ClientFrame = z.discriminatedUnion("type", [
  SubscribeFrame,
  UnsubscribeFrame,
  CommandFrame,
  PingFrame,
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

// ── Server → client frames ───────────────────────────────────────────────────

export const StateDeltaFrame = z.object({
  type: z.literal("state"),
  homeId: z.string(),
  roomId: z.string().nullable(),
  deviceId: z.string(),
  state: CapabilityState,
  /** Monotonic per-device sequence so clients drop stale/out-of-order deltas. */
  seq: z.number().int().nonnegative(),
  ts: z.string().datetime(),
});

export const CommandAckFrame = z.object({
  type: z.literal("ack"),
  requestId: z.string(),
  accepted: z.boolean(),
  error: z.string().optional(),
});

export const NotificationFrame = z.object({
  type: z.literal("notification"),
  level: z.enum(["info", "warning", "critical"]),
  title: z.string(),
  body: z.string(),
  ts: z.string().datetime(),
});

export const PongFrame = z.object({ type: z.literal("pong"), ts: z.string().datetime() });

export const ErrorFrame = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

/** § Realtime State Architecture — a driver's CONNECTION lifecycle (is the live link up),
 * distinct from `StateDeltaFrame` (a device's capability values). "connecting"/
 * "disconnecting" are request-in-flight states the gateway publishes the instant a
 * connect/disconnect is accepted, so the UI never has to treat a request as equivalent to
 * successful execution — "connected"/"disconnected"/"error" only follow real confirmation.
 * Driver-agnostic: any current or future native driver going through the installer's
 * generic connect/disconnect + lifecycle pipeline gets this for free.
 *
 * § Realtime State Hardening — considered expanding to a 9-state model (unknown,
 * discovering, connecting, connected, degraded, reconnecting, disconnecting,
 * disconnected, error) and deliberately did NOT: this 5-state enum is already threaded
 * through the wire contract (this file), the gateway (installer-context.ts,
 * DriverStateEvent in context.ts), and the frontend (LiveContext/drivers.tsx) — widening
 * it is a real migration, not a free addition. More importantly, the backend has no
 * actual signal to back "degraded" (partial health short of a hard error) or
 * "discovering"/"unknown" (states no driver lifecycle stage or connection status
 * currently distinguishes — see installer-context.ts's DriverLifecycleStage) — adding
 * them now would mean fabricating a state the UI shows without a real capability behind
 * it, which this codebase's own "never fabricate data or capabilities" rule forbids.
 * "reconnecting" is deliberately covered by the existing "connecting" value (the
 * lifecycle pipeline's "registering" stage runs identically for a first connect or an
 * autonomous reconnect — see LIFECYCLE_STAGE_TO_CONNECTION_STATE) rather than a distinct
 * enum member with no different meaning. Revisit if/when a driver actually reports a
 * genuine intermediate health signal worth its own state. */
export const DriverConnectionState = z.enum([
  "disconnected", "connecting", "connected", "disconnecting", "error",
]);
export type DriverConnectionState = z.infer<typeof DriverConnectionState>;

export const DriverStateFrame = z.object({
  type: z.literal("driver"),
  driverId: z.string(),
  state: DriverConnectionState,
  error: z.string().nullable().optional(),
  ts: z.string().datetime(),
});

export const ServerFrame = z.discriminatedUnion("type", [
  StateDeltaFrame,
  CommandAckFrame,
  NotificationFrame,
  PongFrame,
  ErrorFrame,
  DriverStateFrame,
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

/** Build the canonical event-bus subject for a device state change (§3.2). */
export function stateSubject(homeId: string, roomId: string | null, deviceId: string): string {
  return `home.${homeId}.room.${roomId ?? "none"}.device.${deviceId}.state`;
}

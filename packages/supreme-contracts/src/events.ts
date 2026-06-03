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

export const ServerFrame = z.discriminatedUnion("type", [
  StateDeltaFrame,
  CommandAckFrame,
  NotificationFrame,
  PongFrame,
  ErrorFrame,
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

/** Build the canonical event-bus subject for a device state change (§3.2). */
export function stateSubject(homeId: string, roomId: string | null, deviceId: string): string {
  return `home.${homeId}.room.${roomId ?? "none"}.device.${deviceId}.state`;
}

import { ClientFrame, SupremeError, type ServerFrame } from "@supreme/contracts";
import type { DeviceId, User } from "@supreme/domain-model";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { can, enforce } from "./auth.js";
import type { AppContext } from "./context.js";

/**
 * WSS `/v1/stream` (§3.2, §6, §13). Bidirectional realtime: clients subscribe to
 * room scopes and issue commands; the gateway pushes permission-filtered,
 * room-scoped state deltas and the user's notifications. Per-device monotonic
 * sequence numbers let clients drop stale or out-of-order frames.
 *
 * Auth: the access token is passed as `?access_token=` because browsers cannot set
 * Authorization headers on a WebSocket handshake. It is validated once at connect.
 */
export function attachStream(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/stream", { websocket: true }, (socket, req) => {
    void handleConnection(ctx, socket as unknown as WebSocket, req.url ?? "");
  });
}

async function handleConnection(ctx: AppContext, socket: WebSocket, url: string): Promise<void> {
  const token = new URLSearchParams(url.split("?")[1] ?? "").get("access_token") ?? "";
  let user: User;
  try {
    user = await ctx.identity.authenticate(token);
  } catch {
    send(socket, { type: "error", code: "unauthorized", message: "invalid stream token" });
    socket.close(1008, "unauthorized");
    return;
  }

  const subscribedRooms = new Set<string>();
  const seqByDevice = new Map<string, number>();

  // Presence: this user now has a live connection (shared across processes via Redis
  // in prod). Refreshed on each connect; expires by TTL if a process dies.
  const homeForPresence = await ctx.home.getHome();
  const presenceHomeId = homeForPresence?.id ?? ctx.homeId;
  void ctx.presence.markOnline(presenceHomeId, user.id);

  const unsubState = ctx.onState((event) => {
    void (async () => {
      const roomId = await ctx.roomOf(event.deviceId);
      const scoped = subscribedRooms.has("*") || (roomId !== null && subscribedRooms.has(roomId));
      if (!scoped) return;
      if (!(await can(ctx, user, "device", event.deviceId, "view"))) return;

      const seq = (seqByDevice.get(event.deviceId) ?? 0) + 1;
      seqByDevice.set(event.deviceId, seq);
      const home = await ctx.home.getHome();
      send(socket, {
        type: "state",
        homeId: home?.id ?? "",
        roomId,
        deviceId: event.deviceId,
        state: event.state,
        seq,
        ts: event.ts,
      });
    })();
  });

  const unsubNotify = ctx.onNotification((n) => {
    if (n.userId !== null && n.userId !== user.id) return;
    send(socket, {
      type: "notification",
      level: n.level,
      title: n.title,
      body: n.body,
      ts: n.createdAt,
    });
  });

  socket.on("message", (raw: Buffer) => {
    void handleFrame(ctx, socket, user, subscribedRooms, raw);
  });
  socket.on("close", () => {
    unsubState();
    unsubNotify();
    // Best-effort presence drop; the TTL is the real safety net if this never runs.
    void ctx.presence.markOffline(presenceHomeId, user.id);
  });
}

async function handleFrame(
  ctx: AppContext,
  socket: WebSocket,
  user: User,
  subscribedRooms: Set<string>,
  raw: Buffer,
): Promise<void> {
  let frame;
  try {
    frame = ClientFrame.parse(JSON.parse(raw.toString()));
  } catch {
    send(socket, { type: "error", code: "validation_failed", message: "malformed frame" });
    return;
  }

  switch (frame.type) {
    case "subscribe":
      for (const r of frame.rooms) subscribedRooms.add(r);
      return;
    case "unsubscribe":
      for (const r of frame.rooms) subscribedRooms.delete(r);
      return;
    case "ping":
      send(socket, { type: "pong", ts: new Date().toISOString() });
      return;
    case "command": {
      const deviceId = frame.deviceId as DeviceId;
      try {
        if (!(await ctx.home.getDevice(deviceId))) {
          throw new SupremeError("not_found", "device not found");
        }
        await enforce(ctx, user, "device", deviceId, "control");
        await ctx.sil.command(deviceId, frame.command);
        send(socket, { type: "ack", requestId: frame.requestId, accepted: true });
      } catch (err) {
        send(socket, {
          type: "ack",
          requestId: frame.requestId,
          accepted: false,
          error: err instanceof SupremeError ? err.message : "command failed",
        });
      }
      return;
    }
  }
}

function send(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

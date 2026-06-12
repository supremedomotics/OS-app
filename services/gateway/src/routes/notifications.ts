import {
  MarkReadRequest,
  RegisterPushTokenRequest,
  type NotificationList,
  type PushTokenResponse,
} from "@supreme/contracts";
import { newId } from "@supreme/domain-model";
import type { FastifyInstance } from "fastify";
import { authenticate } from "../auth.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";

/** Notification history + read receipts (§13). Live delivery is over WSS; push reaches
 * backgrounded devices via registered tokens. */
export function registerNotificationRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/notifications", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const body: NotificationList = { notifications: await ctx.notifications.list(user.id) };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/notifications/read", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const body = MarkReadRequest.parse(req.body);
      await ctx.notifications.markRead(user.id, body.ids);
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Register this client's push token (FCM/APNs/WebPush) for background delivery.
  app.post("/v1/push/tokens", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const { platform, token } = RegisterPushTokenRequest.parse(req.body);
      const now = new Date().toISOString();
      await ctx.pushTokens.register({
        id: newId("session"),
        userId: user.id,
        platform,
        token,
        createdAt: now,
        lastSeenAt: now,
      });
      reply.code(201).send({ registered: true, pushEnabled: ctx.push.enabled } satisfies PushTokenResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.delete<{ Params: { token: string } }>("/v1/push/tokens/:token", async (req, reply) => {
    try {
      await authenticate(ctx, req);
      await ctx.pushTokens.remove(decodeURIComponent(req.params.token));
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });
}

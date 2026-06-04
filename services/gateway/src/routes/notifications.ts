import { MarkReadRequest, type NotificationList } from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import { authenticate } from "../auth.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";

/** Notification history + read receipts (§13). Live delivery is over WSS. */
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
}

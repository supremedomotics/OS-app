import {
  ArmRequest,
  DisarmRequest,
  type CameraList,
  type SecurityStateResponse,
} from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import { authenticate, enforce } from "../auth.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";

/** Security panel (arm/disarm) + camera registry (§16, §11.1). */
export function registerSecurityRoutes(app: FastifyInstance, ctx: AppContext): void {
  const view = (): SecurityStateResponse => {
    const s = ctx.security.getState(ctx.homeId);
    return { mode: s.mode, triggered: s.triggered, lastChangedBy: s.lastChangedBy, lastChangedAt: s.lastChangedAt };
  };

  app.get("/v1/security", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      reply.send(view());
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/security/arm", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "control");
      const { mode, pin } = ArmRequest.parse(req.body);
      ctx.security.arm(ctx.homeId, mode, user.id, pin);
      reply.send(view());
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/security/disarm", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "control");
      const { pin } = DisarmRequest.parse(req.body ?? {});
      ctx.security.disarm(ctx.homeId, user.id, pin);
      reply.send(view());
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get("/v1/cameras", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "camera", null, "view");
      const cameras = (await ctx.home.listDevices())
        .filter((d) => d.supremeType === "camera")
        .map((d) => ({
          id: d.id,
          name: d.name,
          roomId: d.roomId,
          snapshotUrl: (d.metadata.snapshotUrl as string | undefined) ?? null,
        }));
      reply.send({ cameras } satisfies CameraList);
    } catch (err) {
      sendError(reply, err);
    }
  });
}

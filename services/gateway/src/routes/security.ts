import {
  ArmRequest,
  DisarmRequest,
  RegisterCameraRequest,
  SetCameraStreamRequest,
  type CameraList,
  type CameraResponse,
  type CameraStreamResponse,
  type SecurityStateResponse,
} from "@supreme/contracts";
import type { DeviceId } from "@supreme/domain-model";
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
      reply.send({ cameras: await ctx.cameras.list() } satisfies CameraList);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Register a view-only camera with its RTSP/snapshot sources (installer action).
  app.post("/v1/cameras", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "camera", null, "create");
      const input = RegisterCameraRequest.parse(req.body);
      const camera = await ctx.cameras.register(input);
      reply.code(201).send({ camera } satisfies CameraResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Update a camera's source URLs.
  app.put<{ Params: { id: string } }>("/v1/cameras/:id/source", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "camera", null, "control");
      const input = SetCameraStreamRequest.parse(req.body ?? {});
      const camera = await ctx.cameras.setSource(req.params.id as DeviceId, input);
      reply.send({ camera } satisfies CameraResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Resolve a camera's RTSP source into client-playable HLS/WebRTC streams.
  app.get<{ Params: { id: string } }>("/v1/cameras/:id/stream", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "camera", null, "view");
      const streams = await ctx.cameras.stream(req.params.id as DeviceId);
      reply.send({ cameraId: req.params.id, streams } satisfies CameraStreamResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });
}

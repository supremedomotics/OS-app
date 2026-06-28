import {
  ArmRequest,
  DisarmRequest,
  RegisterCameraRequest,
  SetCameraStreamRequest,
  SupremeError,
  type CameraList,
  type CameraResponse,
  type CameraStreamResponse,
  type SecurityStateResponse,
} from "@supreme/contracts";
import type { DeviceId, RoomId } from "@supreme/domain-model";
import { planOccupancy } from "@supreme/security";
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

  // ── Occupancy (vacation) simulation ──────────────────────────────────────────
  app.get("/v1/security/occupancy", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      reply.send({ running: ctx.occupancy.running, plan: ctx.occupancy.preview() });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Enable: build a believable lighting plan from the home's switchable lights and run it.
  app.post<{ Body: { seed?: number; startMinute?: number; endMinute?: number; roomId?: string } }>(
    "/v1/security/occupancy/enable",
    async (req, reply) => {
      try {
        const user = await authenticate(ctx, req);
        await enforce(ctx, user, "home", null, "control");
        const b = req.body ?? {};
        const devices = b.roomId ? await ctx.home.listDevicesInRoom(b.roomId as RoomId) : await ctx.home.listDevices();
        const deviceIds = devices.filter((d) => d.capabilities.some((c) => c.kind === "onoff")).map((d) => d.id);
        if (deviceIds.length === 0) throw new SupremeError("conflict", "no switchable lights to simulate");
        const plan = planOccupancy({
          deviceIds,
          startMinute: b.startMinute ?? 18 * 60,
          endMinute: b.endMinute ?? 23 * 60,
          seed: b.seed ?? Math.floor((Date.now() / 60_000) % 1_000_000),
        });
        ctx.occupancy.start(plan);
        await ctx.audit?.record({ homeId: ctx.homeId, actorUserId: user.id, action: "occupancy.enable", resourceType: "home", resourceId: ctx.homeId, metadata: { lights: deviceIds.length, events: plan.length } });
        reply.send({ running: true, plan });
      } catch (err) {
        sendError(reply, err);
      }
    },
  );

  app.post("/v1/security/occupancy/disable", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "control");
      ctx.occupancy.stop();
      await ctx.audit?.record({ homeId: ctx.homeId, actorUserId: user.id, action: "occupancy.disable", resourceType: "home", resourceId: ctx.homeId });
      reply.send({ running: false });
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

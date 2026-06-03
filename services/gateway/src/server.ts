import fastifyWebsocket from "@fastify/websocket";
import {
  CommandRequest,
  LoginRequest,
  RefreshRequest,
  SupremeError,
  type CommandResponse,
  type CurrentUser,
  type DeviceList,
  type HomeView,
} from "@supreme/contracts";
import type { Device, DeviceId, RoomId, User } from "@supreme/domain-model";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { AppContext } from "./context.js";
import { sendError } from "./http-errors.js";
import { attachStream } from "./stream.js";

/**
 * The Supreme API Gateway / BFF (§6). The ONLY client-facing surface. Every route
 * speaks pure Supreme contracts — there is zero HA leakage by construction because
 * the gateway never imports anything HA-specific; it only talks to the SIL facade.
 */
export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: ctx.config.logLevel } });
  await app.register(fastifyWebsocket);

  app.get("/healthz", async () => ({
    status: "ok",
    backend: ctx.sil.backendKind,
    backendHealthy: ctx.sil.isHealthy(),
  }));

  // ── Auth ───────────────────────────────────────────────────────────────────
  app.post("/v1/auth/login", async (req, reply) => {
    try {
      const body = LoginRequest.parse(req.body);
      reply.send(await ctx.identity.login(body.email, body.password));
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/auth/refresh", async (req, reply) => {
    try {
      const body = RefreshRequest.parse(req.body);
      reply.send(await ctx.identity.refresh(body.refreshToken));
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Current user ─────────────────────────────────────────────────────────────
  app.get("/v1/me", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const body: CurrentUser = { user };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Home topology ────────────────────────────────────────────────────────────
  app.get("/v1/home", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      ctx.policy.enforce(
        { user, resourceType: "home", resourceId: null, action: "view" },
        ctx.grantsFor(user.id),
      );
      const home = ctx.home.getHome();
      if (!home) throw new SupremeError("not_found", "home not commissioned");
      const body: HomeView = { home, rooms: ctx.home.listRooms() };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/v1/rooms/:id/devices", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const roomId = req.params.id as RoomId;
      if (!ctx.home.getRoom(roomId)) throw new SupremeError("not_found", "room not found");
      ctx.policy.enforce(
        { user, resourceType: "room", resourceId: roomId, action: "view" },
        ctx.grantsFor(user.id),
      );
      const devices = ctx.home
        .listDevicesInRoom(roomId)
        .filter((d) => canViewDevice(ctx, user, d));
      const body: DeviceList = { devices };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── The core control verb ────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/v1/devices/:id/command", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const deviceId = req.params.id as DeviceId;
      const device = ctx.home.getDevice(deviceId);
      if (!device) throw new SupremeError("not_found", "device not found");

      ctx.policy.enforce(
        { user, resourceType: "device", resourceId: deviceId, action: "control" },
        ctx.grantsFor(user.id),
      );

      const { command } = CommandRequest.parse(req.body);
      await ctx.sil.command(deviceId, command);
      const body: CommandResponse = {
        accepted: true,
        device: ctx.home.getDevice(deviceId) ?? undefined,
      };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Realtime stream ──────────────────────────────────────────────────────────
  attachStream(app, ctx);

  return app;
}

/** Extract and validate the Bearer access token; returns the live user. */
export async function authenticate(ctx: AppContext, req: FastifyRequest): Promise<User> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new SupremeError("unauthorized", "missing bearer token");
  }
  return ctx.identity.authenticate(header.slice("Bearer ".length));
}

/** Device-level view check used to filter room device lists. */
export function canViewDevice(ctx: AppContext, user: User, device: Device): boolean {
  return ctx.policy.decide(
    { user, resourceType: "device", resourceId: device.id, action: "view" },
    ctx.grantsFor(user.id),
  ).allowed;
}

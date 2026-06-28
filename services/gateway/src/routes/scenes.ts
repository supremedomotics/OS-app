import {
  CreateSceneRequest,
  SupremeError,
  UpdateSceneRequest,
  type ActivateSceneResponse,
  type SceneList,
  type SceneResponse,
} from "@supreme/contracts";
import type { SceneId } from "@supreme/domain-model";
import { validateSchedule, ScheduleError } from "@supreme/scenes";
import type { FastifyInstance } from "fastify";
import { authenticate, can, enforce } from "../auth.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";

/** Scene CRUD + activation (§10). */
export function registerSceneRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/scenes", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const all = await ctx.scenes.list();
      const visible = [];
      for (const s of all) if (await can(ctx, user, "scene", s.id, "view")) visible.push(s);
      const body: SceneList = { scenes: visible };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/scenes", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "scene", null, "create");
      const home = await ctx.home.getHome();
      if (!home) throw new SupremeError("conflict", "home not commissioned");
      const input = CreateSceneRequest.parse(req.body);
      const scene = await ctx.scenes.create({ homeId: home.id, ownerUserId: user.id, ...input });
      const body: SceneResponse = { scene };
      reply.code(201).send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>("/v1/scenes/:id", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const id = req.params.id as SceneId;
      await ctx.scenes.get(id); // 404 if missing
      await enforce(ctx, user, "scene", id, "update");
      const patch = UpdateSceneRequest.parse(req.body);
      const scene = await ctx.scenes.update(id, patch);
      const body: SceneResponse = { scene };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/v1/scenes/:id", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const id = req.params.id as SceneId;
      await enforce(ctx, user, "scene", id, "delete");
      await ctx.scenes.remove(id);
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/v1/scenes/:id/activate", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const id = req.params.id as SceneId;
      await ctx.scenes.get(id);
      await enforce(ctx, user, "scene", id, "control");
      const steps = await ctx.scenes.activate(id);
      const body: ActivateSceneResponse = { activated: true, steps };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Scene schedules (time / sunrise / sunset) ────────────────────────────────
  app.get("/v1/scenes/schedules", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "scene", null, "view");
      const schedules = (await ctx.homeConfig.get(ctx.homeId, "scene_schedules")) ?? [];
      reply.send({ schedules });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Replace the home's scene schedules (each validated). Solar triggers use the home's location.
  app.put("/v1/scenes/schedules", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "scene", null, "update");
      const body = (req.body ?? {}) as { schedules?: unknown[] };
      if (!Array.isArray(body.schedules)) throw new SupremeError("validation_failed", "schedules must be an array");
      let validated;
      try {
        validated = body.schedules.map(validateSchedule);
      } catch (err) {
        if (err instanceof ScheduleError) throw new SupremeError("validation_failed", err.message);
        throw err;
      }
      await ctx.homeConfig.set(ctx.homeId, "scene_schedules", validated);
      reply.send({ schedules: validated });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // The home's geographic location — required for sunrise/sunset-anchored schedules.
  app.put("/v1/home/location", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "admin");
      const b = (req.body ?? {}) as { lat?: number; lon?: number };
      if (!Number.isFinite(b.lat) || !Number.isFinite(b.lon) || Math.abs(b.lat!) > 90 || Math.abs(b.lon!) > 180) {
        throw new SupremeError("validation_failed", "valid lat (-90..90) and lon (-180..180) are required");
      }
      await ctx.homeConfig.set(ctx.homeId, "location", { lat: b.lat, lon: b.lon });
      reply.send({ location: { lat: b.lat, lon: b.lon } });
    } catch (err) {
      sendError(reply, err);
    }
  });
}

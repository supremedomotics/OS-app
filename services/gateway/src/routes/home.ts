import {
  SetFavoriteRequest,
  SupremeError,
  type DeviceList,
  type FavoriteList,
  type HomeView,
} from "@supreme/contracts";
import { FavoriteRef, type RoomId } from "@supreme/domain-model";
import type { FastifyInstance } from "fastify";
import { authenticate, canViewDevice, enforce } from "../auth.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";

/** Home topology, room devices, and favorites (§11.3). */
export function registerHomeRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/home", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const home = await ctx.home.getHome();
      if (!home) throw new SupremeError("not_found", "home not commissioned");
      const body: HomeView = { home, rooms: await ctx.home.listRooms() };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/v1/rooms/:id/devices", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const roomId = req.params.id as RoomId;
      await ctx.home.requireRoom(roomId);
      await enforce(ctx, user, "room", roomId, "view");
      const all = await ctx.home.listDevicesInRoom(roomId);
      const visible = [];
      for (const d of all) if (await canViewDevice(ctx, user, d)) visible.push(d);
      const body: DeviceList = { devices: visible };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Favorites ──────────────────────────────────────────────────────────────
  app.get("/v1/favorites", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const body: FavoriteList = { favorites: await ctx.home.listFavorites(user.id) };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.put("/v1/favorites", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const body = SetFavoriteRequest.parse(req.body);
      // The referenced resource must exist and be viewable.
      const ref = FavoriteRef.parse(body.ref);
      if (ref.type === "device") {
        const device = await ctx.home.getDevice(ref.deviceId);
        if (!device) throw new SupremeError("not_found", "device not found");
        await enforce(ctx, user, "device", ref.deviceId, "view");
      } else {
        await ctx.scenes.get(ref.sceneId); // 404 if missing
        await enforce(ctx, user, "scene", ref.sceneId, "view");
      }
      await ctx.home.setFavorite(user.id, ref, body.favorite);
      reply.send({ favorites: await ctx.home.listFavorites(user.id) });
    } catch (err) {
      sendError(reply, err);
    }
  });
}

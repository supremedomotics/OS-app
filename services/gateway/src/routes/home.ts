import {
  SetFavoriteRequest,
  SupremeError,
  type DeviceList,
  type FavoriteList,
  type HomeView,
} from "@supreme/contracts";
import { FavoriteRef, newId, Room, type RoomId } from "@supreme/domain-model";
import type { FastifyInstance } from "fastify";
import { authenticate, canViewDevice, enforce } from "../auth.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";

/** Validate a room create/update payload, filling nullable defaults and trimming the name. */
function parseRoom(input: Record<string, unknown>): Room {
  return Room.parse({
    icon: null,
    heroImageUrl: null,
    parentRoomId: null,
    ...input,
    ...(typeof input.name === "string" ? { name: input.name.trim() } : {}),
  });
}

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

  // Flat, permission-filtered device list for the whole home (§6). Cloud Voice Discovery/SYNC
  // enumerates the home in one call; clients that want room grouping use /v1/rooms/:id/devices.
  app.get("/v1/devices", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const all = await ctx.home.listDevices();
      const visible = [];
      for (const d of all) if (await canViewDevice(ctx, user, d)) visible.push(d);
      const body: DeviceList = { devices: visible };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Create a room (§8). Allowed for master/admin/installer and the homeowner (their own home).
  app.post<{ Body: Record<string, unknown> }>("/v1/rooms", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "room", null, "create");
      const home = await ctx.home.getHome();
      if (!home) throw new SupremeError("not_found", "home not commissioned");
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.name !== "string" || !b.name.trim()) throw new SupremeError("validation_failed", "room name is required");
      const room = parseRoom({ ...b, id: newId("room"), homeId: ctx.homeId });
      await ctx.home.addRoom(room);
      reply.code(201).send({ room });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Rename / move / restyle a room.
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/v1/rooms/:id", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const roomId = req.params.id as RoomId;
      const existing = await ctx.home.requireRoom(roomId);
      await enforce(ctx, user, "room", roomId, "update");
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (b.name !== undefined && (typeof b.name !== "string" || !b.name.trim())) throw new SupremeError("validation_failed", "room name cannot be empty");
      // putRoom is an upsert, so updating = re-storing the validated, merged record.
      const room = parseRoom({ ...existing, ...b, id: existing.id, homeId: existing.homeId });
      await ctx.home.addRoom(room);
      reply.send({ room });
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

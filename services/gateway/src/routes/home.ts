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
import {
  downloadHeroImage,
  heroImageFromUpload,
  heroImageKey,
  heroImagePath,
  HeroImageError,
  type StoredHeroImage,
} from "../room-hero.js";

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

  // ── Room hero imagery (§11) ──────────────────────────────────────────────────
  // The hub downloads ONE stock photo per room (by name) and stores the bytes locally, so every
  // client shows the identical image offline. Owners can replace it with a live photo (PUT).

  // Serve the stored bytes. `<img>` can't send an Authorization header, so this also accepts the
  // access token as a query param (?access_token=) — the same pattern the WSS upgrade uses.
  app.get<{ Params: { id: string }; Querystring: { access_token?: string } }>(
    "/v1/rooms/:id/hero-image",
    async (req, reply) => {
      try {
        const header = req.headers.authorization;
        const token = header?.startsWith("Bearer ") ? header.slice(7) : req.query.access_token;
        if (!token) throw new SupremeError("unauthorized", "missing token");
        const user = await ctx.identity.authenticate(token);
        const roomId = req.params.id as RoomId;
        await ctx.home.requireRoom(roomId);
        await enforce(ctx, user, "room", roomId, "view");
        const stored = (await ctx.homeConfig.get(ctx.homeId, heroImageKey(roomId))) as StoredHeroImage | undefined;
        if (!stored) throw new SupremeError("not_found", "no hero image for room");
        reply
          .header("content-type", stored.contentType)
          .header("cache-control", "private, max-age=86400")
          // The homeowner web app / cloud may be a different origin than the hub; allow the image
          // to be embedded cross-origin (an <img>/background load) — without this a strict CORP
          // policy blocks it (ERR_BLOCKED_BY_RESPONSE.NotSameOrigin).
          .header("cross-origin-resource-policy", "cross-origin")
          .send(Buffer.from(stored.dataBase64, "base64"));
      } catch (err) {
        sendError(reply, err);
      }
    },
  );

  // Auto-pin: download a stock photo by room name and store it locally. Idempotent — skips if one is
  // already stored unless `?force=1`. Best-effort: a fetch failure leaves the hero unset (200 with
  // pinned:false) rather than erroring, so imagery never blocks the UI.
  app.post<{ Params: { id: string }; Querystring: { force?: string } }>(
    "/v1/rooms/:id/hero-image/auto",
    async (req, reply) => {
      try {
        const user = await authenticate(ctx, req);
        const roomId = req.params.id as RoomId;
        const room = await ctx.home.requireRoom(roomId);
        await enforce(ctx, user, "room", roomId, "update");
        const existing = await ctx.homeConfig.get(ctx.homeId, heroImageKey(roomId));
        if (existing && req.query.force !== "1") {
          reply.send({ pinned: true, room });
          return;
        }
        try {
          const image = await downloadHeroImage(room);
          await ctx.homeConfig.set(ctx.homeId, heroImageKey(roomId), image);
          const updated = parseRoom({ ...room, heroImageUrl: heroImagePath(roomId) });
          await ctx.home.addRoom(updated);
          reply.send({ pinned: true, room: updated });
        } catch (imgErr) {
          if (!(imgErr instanceof HeroImageError)) throw imgErr;
          reply.send({ pinned: false, reason: imgErr.message, room });
        }
      } catch (err) {
        sendError(reply, err);
      }
    },
  );

  // Owner replaces the hero with a live photo (base64 body or a data: URL).
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/v1/rooms/:id/hero-image",
    { bodyLimit: 8_000_000 }, // a 5 MB image is ~6.7 MB base64; default 1 MB is too small.
    async (req, reply) => {
      try {
        const user = await authenticate(ctx, req);
        const roomId = req.params.id as RoomId;
        const room = await ctx.home.requireRoom(roomId);
        await enforce(ctx, user, "room", roomId, "update");
        const image = heroImageFromUpload((req.body ?? {}) as Record<string, unknown>);
        await ctx.homeConfig.set(ctx.homeId, heroImageKey(roomId), image);
        const updated = parseRoom({ ...room, heroImageUrl: heroImagePath(roomId) });
        await ctx.home.addRoom(updated);
        reply.send({ room: updated });
      } catch (err) {
        sendError(reply, err);
      }
    },
  );

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

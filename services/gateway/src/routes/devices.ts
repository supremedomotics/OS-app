import {
  BulkDeviceRequest,
  CommandRequest,
  SupremeError,
  UpdateDeviceRequest,
  type CommandResponse,
  type DeviceDiagnosticsResponse,
  type DeviceResponse,
  type MediaQueueResponse,
} from "@supreme/contracts";
import type { DeviceId, RoomId } from "@supreme/domain-model";
import type { FastifyInstance } from "fastify";
import { authenticate, enforce } from "../auth.js";
import { ArtworkCache } from "../artwork-cache.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";

/** The core control verb (§6): POST /v1/devices/:id/command. */
export function registerDeviceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const artworkCache = new ArtworkCache();
  app.post<{ Params: { id: string } }>("/v1/devices/:id/command", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const deviceId = req.params.id as DeviceId;
      const device = await ctx.home.getDevice(deviceId);
      if (!device) throw new SupremeError("not_found", "device not found");

      await enforce(ctx, user, "device", deviceId, "control");

      const { command } = CommandRequest.parse(req.body);
      const source = `Device: ${device.name}`;
      try {
        await ctx.sil.command(deviceId, command);
      } catch (err) {
        // A native driver command that never reached the device (not connected, wire error,
        // unsupported for this unit, …) must be visible — the Settings → Logs page is the
        // one place to see "did my command actually work" across every device/protocol.
        ctx.installer.logEvent(source, "error", `${command.capability} command failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
      ctx.installer.logEvent(source, "info", `${command.capability} command sent`);
      await ctx.audit?.record({
        homeId: ctx.homeId,
        actorUserId: user.id,
        action: "device.command",
        resourceType: "device",
        resourceId: deviceId,
        metadata: { capability: command.capability },
      });
      const body: CommandResponse = {
        accepted: true,
        device: (await ctx.home.getDevice(deviceId)) ?? undefined,
      };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Move and/or rename a device (§4): PATCH /v1/devices/:id. Any device can be reassigned to
  // any existing room. Owner/admin/installer only (device:update).
  app.patch<{ Params: { id: string } }>("/v1/devices/:id", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const deviceId = req.params.id as DeviceId;
      if (!(await ctx.home.getDevice(deviceId))) throw new SupremeError("not_found", "device not found");
      await enforce(ctx, user, "device", deviceId, "update");

      const patch = UpdateDeviceRequest.parse(req.body);
      const device = await ctx.home.updateDevice(deviceId, {
        name: patch.name,
        roomId: patch.roomId as RoomId | undefined,
        metadata: patch.metadata,
      });
      await ctx.audit?.record({
        homeId: ctx.homeId,
        actorUserId: user.id,
        action: "device.update",
        resourceType: "device",
        resourceId: deviceId,
        metadata: { name: patch.name, roomId: patch.roomId, metadataKeys: patch.metadata ? Object.keys(patch.metadata) : undefined },
      });
      reply.send({ device } satisfies DeviceResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Delete a device (§4): DELETE /v1/devices/:id. Drops its backend bindings too.
  // Owner/admin/installer only (device:delete).
  app.delete<{ Params: { id: string } }>("/v1/devices/:id", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const deviceId = req.params.id as DeviceId;
      if (!(await ctx.home.getDevice(deviceId))) throw new SupremeError("not_found", "device not found");
      await enforce(ctx, user, "device", deviceId, "delete");

      await ctx.home.removeDevice(deviceId);
      await ctx.audit?.record({
        homeId: ctx.homeId,
        actorUserId: user.id,
        action: "device.delete",
        resourceType: "device",
        resourceId: deviceId,
      });
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Clone a device's configuration into a new device (§ Device Platform). device:create.
  app.post<{ Params: { id: string } }>("/v1/devices/:id/clone", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const deviceId = req.params.id as DeviceId;
      if (!(await ctx.home.getDevice(deviceId))) throw new SupremeError("not_found", "device not found");
      await enforce(ctx, user, "device", null, "create");
      const device = await ctx.home.cloneDevice(deviceId);
      await ctx.audit?.record({ homeId: ctx.homeId, actorUserId: user.id, action: "device.clone", resourceType: "device", resourceId: device.id, metadata: { from: deviceId } });
      reply.code(201).send({ device } satisfies DeviceResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Bulk operations over a device selection (§ Device Platform): move to a room, or remove.
  app.post("/v1/devices/bulk", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const body = BulkDeviceRequest.parse(req.body);
      const ids = body.ids as DeviceId[];
      if (body.action === "move") {
        if (!body.roomId) throw new SupremeError("validation_failed", "roomId is required to move");
        await enforce(ctx, user, "device", null, "update");
        const moved = await ctx.home.moveDevices(ids, body.roomId as RoomId);
        await ctx.audit?.record({ homeId: ctx.homeId, actorUserId: user.id, action: "device.bulk_move", resourceType: "device", resourceId: null, metadata: { count: moved, roomId: body.roomId } });
        reply.send({ affected: moved });
      } else {
        await enforce(ctx, user, "device", null, "delete");
        const removed = await ctx.home.removeDevices(ids);
        await ctx.audit?.record({ homeId: ctx.homeId, actorUserId: user.id, action: "device.bulk_remove", resourceType: "device", resourceId: null, metadata: { count: removed } });
        reply.send({ affected: removed });
      }
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Cover art proxy (§11 media): streams a media device's current artwork bytes from
  // the backend (e.g. the Apple TV bridge, or a Yamaha unit's device-local album-art
  // path) so clients render it without reaching any internal service. The media
  // state's `artworkUrl` points here. Fronted by an in-process cache (artwork-cache.ts)
  // so now-playing polling doesn't re-fetch the same bytes on every refresh.
  app.get<{ Params: { id: string } }>("/v1/devices/:id/media/artwork", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const deviceId = req.params.id as DeviceId;
      const device = await ctx.home.getDevice(deviceId);
      if (!device) throw new SupremeError("not_found", "device not found");
      await enforce(ctx, user, "device", deviceId, "view");
      const art = await artworkCache.get(deviceId, () => ctx.sil.getArtwork(deviceId));
      if (!art) throw new SupremeError("not_found", "no artwork");
      reply.header("content-type", art.contentType);
      reply.header("cache-control", "private, max-age=60");
      reply.send(Buffer.from(art.data));
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Play-queue pull (§ Universal AVR Framework — media integration): GET
  // /v1/devices/:id/media/queue. Only meaningful for protocols with a real queue
  // concept on the wire (HEOS today); other media devices return an empty list rather
  // than a fabricated one — the response shape stays uniform either way.
  app.get<{ Params: { id: string } }>("/v1/devices/:id/media/queue", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const deviceId = req.params.id as DeviceId;
      const device = await ctx.home.getDevice(deviceId);
      if (!device) throw new SupremeError("not_found", "device not found");
      await enforce(ctx, user, "device", deviceId, "view");
      const items = (await ctx.sil.getQueue(deviceId)) ?? [];
      reply.send({ items } satisfies MediaQueueResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Diagnostics Console (§ Universal AV Driver SDK): GET /v1/devices/:id/diagnostics —
  // real connection/traffic diagnostics (RX/TX counts, last command/response, response
  // time, reconnect count, last error) from the device's owning driver. `null` when
  // unsupported (HA-backed device, or a protocol with no diagnostics tracker) rather
  // than a fabricated all-zero shape. Same "device"/"view" permission as artwork/queue
  // — this is only ever rendered behind the client's own devMode gate.
  app.get<{ Params: { id: string } }>("/v1/devices/:id/diagnostics", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const deviceId = req.params.id as DeviceId;
      const device = await ctx.home.getDevice(deviceId);
      if (!device) throw new SupremeError("not_found", "device not found");
      await enforce(ctx, user, "device", deviceId, "view");
      const diagnostics = await ctx.sil.getDiagnostics(deviceId);
      reply.send({ diagnostics } satisfies DeviceDiagnosticsResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });
}

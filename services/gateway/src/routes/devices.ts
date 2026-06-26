import { CommandRequest, SupremeError, type CommandResponse } from "@supreme/contracts";
import type { DeviceId } from "@supreme/domain-model";
import type { FastifyInstance } from "fastify";
import { authenticate, enforce } from "../auth.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";

/** The core control verb (§6): POST /v1/devices/:id/command. */
export function registerDeviceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Params: { id: string } }>("/v1/devices/:id/command", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const deviceId = req.params.id as DeviceId;
      const device = await ctx.home.getDevice(deviceId);
      if (!device) throw new SupremeError("not_found", "device not found");

      await enforce(ctx, user, "device", deviceId, "control");

      const { command } = CommandRequest.parse(req.body);
      await ctx.sil.command(deviceId, command);
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

  // Cover art proxy (§11 media): streams a media device's current artwork bytes from
  // the backend (e.g. the Apple TV bridge) so clients render it without reaching any
  // internal service. The media state's `artworkUrl` points here.
  app.get<{ Params: { id: string } }>("/v1/devices/:id/media/artwork", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const deviceId = req.params.id as DeviceId;
      const device = await ctx.home.getDevice(deviceId);
      if (!device) throw new SupremeError("not_found", "device not found");
      await enforce(ctx, user, "device", deviceId, "view");
      const art = await ctx.sil.getArtwork(deviceId);
      if (!art) throw new SupremeError("not_found", "no artwork");
      reply.header("content-type", art.contentType);
      reply.header("cache-control", "private, max-age=60");
      reply.send(Buffer.from(art.data));
    } catch (err) {
      sendError(reply, err);
    }
  });
}

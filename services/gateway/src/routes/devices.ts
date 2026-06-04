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
      const body: CommandResponse = {
        accepted: true,
        device: (await ctx.home.getDevice(deviceId)) ?? undefined,
      };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });
}

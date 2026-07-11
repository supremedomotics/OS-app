import { SupremeError } from "@supreme/contracts";
import { ClimateScheduleError, validateClimateScheduleEvent } from "@supreme/automations";
import type { FastifyInstance } from "fastify";
import { authenticate, enforce } from "../auth.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";

/**
 * Per-device HVAC schedule (§ HVAC Detail Page "Schedule" — "These schedules are
 * executed by SupremeOS, not CoolMaster") + holiday mode. Mirrors the scene-schedules
 * routes exactly: whole-home GET/replace-PUT, validated on write, no separate wire
 * schema in @supreme/contracts (the same minimal pattern scene schedules already use).
 */
export function registerClimateRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/climate/schedule", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "view");
      const events = (await ctx.homeConfig.get(ctx.homeId, "climate_schedule_events")) ?? [];
      const holidayDeviceIds = (await ctx.homeConfig.get(ctx.homeId, "climate_holiday_device_ids")) ?? [];
      reply.send({ events, holidayDeviceIds });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Replace the home's full HVAC schedule event list (each validated) + holiday-mode device set.
  app.put("/v1/climate/schedule", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "update");
      const body = (req.body ?? {}) as { events?: unknown[]; holidayDeviceIds?: unknown[] };
      if (!Array.isArray(body.events)) throw new SupremeError("validation_failed", "events must be an array");
      let validated;
      try {
        validated = body.events.map(validateClimateScheduleEvent);
      } catch (err) {
        if (err instanceof ClimateScheduleError) throw new SupremeError("validation_failed", err.message);
        throw err;
      }
      const holidayDeviceIds = Array.isArray(body.holidayDeviceIds) ? body.holidayDeviceIds.filter((id): id is string => typeof id === "string") : [];
      await ctx.homeConfig.set(ctx.homeId, "climate_schedule_events", validated);
      await ctx.homeConfig.set(ctx.homeId, "climate_holiday_device_ids", holidayDeviceIds);
      reply.send({ events: validated, holidayDeviceIds });
    } catch (err) {
      sendError(reply, err);
    }
  });
}

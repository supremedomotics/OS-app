import { SupremeError } from "@supreme/contracts";
import { AUTO_PILOT_MODES, type AutoPilotMode, type AutoPilotSettings, buildIntelligenceReport, DeviceIntelError, REPORT_PERIODS, type ReportPeriod, reportToCsv, type SuggestionAction, validateDeviceIntelMap, type Zone } from "@supreme/intelligence";
import type { FastifyInstance } from "fastify";
import { authenticate, enforce } from "../auth.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";

const ACTIONS: readonly SuggestionAction[] = ["turn_off", "keep_on", "ignore_today", "always_ignore", "enable_auto_pilot"];

/**
 * Supreme Intelligence Engine routes (ADR 0013): the live presence map + zone/house occupancy,
 * pending suggestions and how the user responds to them, the Auto Pilot settings, the per-device
 * ownership metadata, zone topology, and the local learning/history + a dashboard roll-up. All
 * behavioural config writes use home/update (homeowner-accessible); reads use home/view.
 */
export function registerIntelligenceRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ── Presence map + occupancy ───────────────────────────────────────────────
  app.get("/v1/intelligence/presence", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      reply.send({ presence: ctx.sie.presence, house: ctx.sie.house });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Pending suggestions ────────────────────────────────────────────────────
  app.get("/v1/intelligence/suggestions", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      reply.send({ suggestions: ctx.sie.suggestions, moduleErrors: ctx.sie.moduleErrors });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { key: string }; Body: { action?: string } }>("/v1/intelligence/suggestions/:key/respond", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "update");
      const action = req.body?.action as SuggestionAction | undefined;
      if (!action || !ACTIONS.includes(action)) throw new SupremeError("validation_failed", `action must be one of ${ACTIONS.join("|")}`);
      const result = await ctx.sie.respond(decodeURIComponent(req.params.key), action);
      reply.send(result);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Auto Pilot settings ────────────────────────────────────────────────────
  app.get("/v1/intelligence/settings", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const settings = ((await ctx.homeConfig.get(ctx.homeId, "sie_autopilot")) as AutoPilotSettings | undefined) ?? { mode: "notify_only" };
      reply.send({ settings });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.put<{ Body: { mode?: string; threshold?: number; reminderMinutes?: number } }>("/v1/intelligence/settings", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "update");
      const b = req.body ?? {};
      if (!b.mode || !AUTO_PILOT_MODES.includes(b.mode as AutoPilotMode)) throw new SupremeError("validation_failed", `mode must be one of ${AUTO_PILOT_MODES.join("|")}`);
      if (b.threshold !== undefined && (typeof b.threshold !== "number" || b.threshold < 0 || b.threshold > 1)) throw new SupremeError("validation_failed", "threshold must be 0..1");
      if (b.reminderMinutes !== undefined && (typeof b.reminderMinutes !== "number" || b.reminderMinutes <= 0 || b.reminderMinutes > 1440)) throw new SupremeError("validation_failed", "reminderMinutes must be 1..1440");
      const settings: AutoPilotSettings = { mode: b.mode as AutoPilotMode, ...(b.threshold !== undefined ? { threshold: b.threshold } : {}), ...(b.reminderMinutes !== undefined ? { reminderMinutes: b.reminderMinutes } : {}) };
      await ctx.homeConfig.set(ctx.homeId, "sie_autopilot", settings);
      reply.send({ settings });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Zones ──────────────────────────────────────────────────────────────────
  app.get("/v1/intelligence/zones", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      reply.send({ zones: (await ctx.homeConfig.get(ctx.homeId, "sie_zones")) ?? [] });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.put<{ Body: { zones?: unknown } }>("/v1/intelligence/zones", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "update");
      const zones = validateZones(req.body?.zones);
      await ctx.homeConfig.set(ctx.homeId, "sie_zones", zones);
      reply.send({ zones });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Device ownership / intelligence metadata ───────────────────────────────
  app.get("/v1/intelligence/device-intel", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      reply.send({ devices: (await ctx.homeConfig.get(ctx.homeId, "device_intel")) ?? {} });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.put<{ Body: { devices?: unknown } }>("/v1/intelligence/device-intel", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "update");
      let map;
      try {
        map = validateDeviceIntelMap(req.body?.devices ?? {});
      } catch (err) {
        if (err instanceof DeviceIntelError) throw new SupremeError("validation_failed", err.message);
        throw err;
      }
      await ctx.homeConfig.set(ctx.homeId, "device_intel", map);
      reply.send({ devices: map });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Learning / action history ──────────────────────────────────────────────
  app.get<{ Querystring: { from?: string; to?: string; deviceId?: string; limit?: string } }>("/v1/intelligence/history", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const repo = requireIntelligence(ctx);
      const limit = req.query.limit ? Math.min(1000, Math.max(1, Number(req.query.limit))) : 200;
      const history = await repo.list(ctx.homeId, { from: req.query.from, to: req.query.to, deviceId: req.query.deviceId, limit });
      reply.send({ history });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Reports (daily / weekly / monthly / yearly / lifetime) ─────────────────
  app.get<{ Querystring: { period?: string } }>("/v1/intelligence/reports", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const repo = requireIntelligence(ctx);
      const period = (REPORT_PERIODS.includes(req.query.period as ReportPeriod) ? req.query.period : "month") as ReportPeriod;
      const from = periodStart(period);
      const provider = (await ctx.homeConfig.get(ctx.homeId, "energy_provider")) as { currency: string } | undefined;
      const agg = await repo.aggregate(ctx.homeId, from);
      reply.send({ report: buildIntelligenceReport(period, agg, { currency: provider?.currency ?? null }) });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get<{ Querystring: { period?: string } }>("/v1/intelligence/reports.csv", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const repo = requireIntelligence(ctx);
      const period = (REPORT_PERIODS.includes(req.query.period as ReportPeriod) ? req.query.period : "month") as ReportPeriod;
      const provider = (await ctx.homeConfig.get(ctx.homeId, "energy_provider")) as { currency: string } | undefined;
      const agg = await repo.aggregate(ctx.homeId, periodStart(period));
      const csv = reportToCsv(buildIntelligenceReport(period, agg, { currency: provider?.currency ?? null }));
      reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="intelligence-report-${period}.csv"`).send(csv);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Dashboard roll-up ──────────────────────────────────────────────────────
  app.get("/v1/intelligence/dashboard", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const repo = requireIntelligence(ctx);
      const now = new Date();
      const todayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
      const monthStart = `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
      const provider = (await ctx.homeConfig.get(ctx.homeId, "energy_provider")) as { currency: string } | undefined;
      const [today, month, topDevices] = await Promise.all([
        repo.aggregate(ctx.homeId, todayStart),
        repo.aggregate(ctx.homeId, monthStart),
        repo.topDevices(ctx.homeId, monthStart),
      ]);
      const house = ctx.sie.house;
      reply.send({
        currency: provider?.currency ?? null,
        today,
        month,
        topDevices,
        pendingSuggestions: ctx.sie.suggestions.length,
        activeDevices: ctx.sie.suggestions.filter((s) => s.deviceId).length,
        occupancy: house ? { occupied: house.occupied, present: house.present, vacantForMs: house.vacantForMs, zones: house.zones } : null,
      });
    } catch (err) {
      sendError(reply, err);
    }
  });
}

function validateZones(v: unknown): Zone[] {
  if (!Array.isArray(v)) throw new SupremeError("validation_failed", "zones must be an array");
  return v.map((z, i) => {
    const o = z as Partial<Zone>;
    if (!o || typeof o.id !== "string" || !o.id) throw new SupremeError("validation_failed", `zone ${i} needs an id`);
    if (typeof o.name !== "string" || !o.name) throw new SupremeError("validation_failed", `zone ${i} needs a name`);
    if (!Array.isArray(o.roomIds) || o.roomIds.some((r) => typeof r !== "string")) throw new SupremeError("validation_failed", `zone ${i} roomIds must be strings`);
    return { id: o.id, name: o.name, roomIds: o.roomIds as string[] };
  });
}

/** ISO start of the report window for a period (undefined = lifetime / all time). */
function periodStart(period: ReportPeriod): string | undefined {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  switch (period) {
    case "day":
      return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    case "week":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    case "month":
      return new Date(Date.UTC(y, m, 1)).toISOString();
    case "year":
      return new Date(Date.UTC(y, 0, 1)).toISOString();
    case "lifetime":
      return undefined;
  }
}

function requireIntelligence(ctx: AppContext) {
  if (!ctx.intelligence) throw new SupremeError("conflict", "intelligence history requires the Postgres persistence layer (set DATABASE_URL)");
  return ctx.intelligence;
}

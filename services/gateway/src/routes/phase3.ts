import {
  AiAssistRequest,
  CreateAutomationRequest,
  SetAutomationEnabledRequest,
  SupremeError,
  UpdateAutomationRequest,
  type AuditList,
  type AuditVerifyResponse,
  type AutomationList,
  type AutomationRunList,
  type AutomationResponse,
  type DeviceEnergyResponse,
  type EnergySummaryResponse,
} from "@supreme/contracts";
import type { AutomationId, DeviceId, RoomId } from "@supreme/domain-model";
import { applyGroupCost, bucketCostHistory, budgetStatus, compareGroupCost, computeEnergyCost, costHistoryToCsv, loadShiftDecision, RateError, resolveRateAsync, TariffError } from "@supreme/analytics";
import { BudgetError, validateBudget, type EnergyBudget } from "../budget-monitor.js";
import { circadianAt, circadianColorCommand, ClimateProgramError, defaultCircadianProfile, sunTimes, validateClimateProgram } from "@supreme/automations";
import { validateVentilationConfig, VentilationError } from "../ventilation-runner.js";
import type { FastifyInstance } from "fastify";
import { authenticate, enforce } from "../auth.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";

/**
 * Phase-3 routes (§16): automations (visual Builder DSL), energy analytics, the
 * advanced audit log, and the AI assistant. All Supreme; backend-agnostic.
 */
export function registerPhase3Routes(app: FastifyInstance, ctx: AppContext): void {
  // ── Automations ──────────────────────────────────────────────────────────────
  app.get("/v1/automations", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "automation", null, "view");
      reply.send({ automations: await ctx.automations.list() } satisfies AutomationList);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/automations", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "automation", null, "create");
      const input = CreateAutomationRequest.parse(req.body);
      const automation = await ctx.automations.create({ homeId: ctx.homeId, ...input });
      await ctx.audit?.record({ homeId: ctx.homeId, actorUserId: user.id, action: "automation.create", resourceType: "automation", resourceId: automation.id });
      reply.code(201).send({ automation } satisfies AutomationResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>("/v1/automations/:id", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const id = req.params.id as AutomationId;
      await ctx.automations.get(id);
      await enforce(ctx, user, "automation", id, "update");
      const automation = await ctx.automations.update(id, UpdateAutomationRequest.parse(req.body));
      reply.send({ automation } satisfies AutomationResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/v1/automations/:id/enabled", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const id = req.params.id as AutomationId;
      await enforce(ctx, user, "automation", id, "update");
      const { enabled } = SetAutomationEnabledRequest.parse(req.body);
      const automation = await ctx.automations.setEnabled(id, enabled);
      reply.send({ automation } satisfies AutomationResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/v1/automations/:id/run", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const id = req.params.id as AutomationId;
      await enforce(ctx, user, "automation", id, "control");
      await ctx.automations.testRun(id);
      reply.send({ ran: true });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Automation Debugger (§ Automation Debugger): recent execution traces — trigger, condition
  // result, per-action outcome + timing, failure reason. All runs, or scoped to one automation.
  app.get("/v1/automations/runs", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "automation", null, "view");
      reply.send({ runs: ctx.automations.recentRuns(undefined, 100) } satisfies AutomationRunList);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/v1/automations/:id/runs", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const id = req.params.id as AutomationId;
      await enforce(ctx, user, "automation", id, "view");
      reply.send({ runs: ctx.automations.recentRuns(id, 100) } satisfies AutomationRunList);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/v1/automations/:id", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const id = req.params.id as AutomationId;
      await enforce(ctx, user, "automation", id, "delete");
      await ctx.automations.remove(id);
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Energy / analytics ───────────────────────────────────────────────────────
  app.get("/v1/energy/summary", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const analytics = requireAnalytics(ctx);
      const [summary, topConsumers] = await Promise.all([
        analytics.summary(ctx.homeId),
        analytics.topConsumers(ctx.homeId, "energy"),
      ]);
      reply.send({ summary, topConsumers } satisfies EnergySummaryResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { measure?: string } }>(
    "/v1/devices/:id/energy",
    async (req, reply) => {
      try {
        const user = await authenticate(ctx, req);
        await enforce(ctx, user, "device", req.params.id, "view");
        const analytics = requireAnalytics(ctx);
        const series = await analytics.hourlySeries(req.params.id as DeviceId, req.query.measure ?? "energy");
        reply.send({ series } satisfies DeviceEnergyResponse);
      } catch (err) {
        sendError(reply, err);
      }
    },
  );

  // Read/write the home's durable energy tariff (the rate plan the cost engine bills against).
  app.get("/v1/energy/tariff", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const tariff = await ctx.homeConfig.get(ctx.homeId, "tariff");
      reply.send({ tariff: tariff ?? null });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.put("/v1/energy/tariff", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "admin");
      const tariff = (req.body ?? {}) as { tariff?: Parameters<typeof computeEnergyCost>[0] };
      const t = tariff.tariff;
      if (!t || !Array.isArray(t.periods) || t.periods.length === 0 || typeof t.currency !== "string") {
        throw new SupremeError("validation_failed", "a tariff with a currency and periods is required");
      }
      await ctx.homeConfig.set(ctx.homeId, "tariff", t);
      reply.send({ tariff: t });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Electricity provider + flat-rate costing (per-room / per-device / history) ─
  // Set the home's country/city/provider; resolves a per-kWh rate (manual > live provider lookup >
  // curated country default) and stores it for the cost views.
  app.get("/v1/energy/provider", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      reply.send({ provider: (await ctx.homeConfig.get(ctx.homeId, "energy_provider")) ?? null });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.put("/v1/energy/provider", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "update");
      const b = (req.body ?? {}) as { country?: string; city?: string; provider?: string; ratePerKwh?: number; currency?: string };
      let resolved;
      try {
        resolved = await resolveRateAsync({ country: b.country ?? "", city: b.city, provider: b.provider, ratePerKwh: b.ratePerKwh, currency: b.currency }, ctx.rateFetcher ?? undefined);
      } catch (err) {
        if (err instanceof RateError) throw new SupremeError("validation_failed", err.message);
        throw err;
      }
      await ctx.homeConfig.set(ctx.homeId, "energy_provider", resolved);
      reply.send({ provider: resolved });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Cost breakdown grouped per device or per room over a range.
  app.get<{ Querystring: { groupBy?: string; from?: string; to?: string } }>("/v1/energy/breakdown", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const analytics = requireAnalytics(ctx);
      const provider = (await ctx.homeConfig.get(ctx.homeId, "energy_provider")) as { ratePerKwh: number; currency: string } | undefined;
      if (!provider) throw new SupremeError("conflict", "configure your electricity provider first (PUT /v1/energy/provider)");
      const groupBy = req.query.groupBy === "room" ? "room" : "device";
      const groups = await analytics.energyByGroup(ctx.homeId, groupBy, req.query.from, req.query.to);
      reply.send({ currency: provider.currency, groupBy, groups: applyGroupCost(groups, provider.ratePerKwh) });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // This-month-vs-last-month per device/room, so the app can show what's trending up or down.
  app.get<{ Querystring: { groupBy?: string } }>("/v1/energy/compare", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const analytics = requireAnalytics(ctx);
      const provider = (await ctx.homeConfig.get(ctx.homeId, "energy_provider")) as { ratePerKwh: number; currency: string } | undefined;
      if (!provider) throw new SupremeError("conflict", "configure your electricity provider first (PUT /v1/energy/provider)");
      const groupBy = req.query.groupBy === "room" ? "room" : "device";
      const now = new Date();
      const y = now.getUTCFullYear();
      const m = now.getUTCMonth();
      const pad = (n: number) => String(n).padStart(2, "0");
      const thisMonth = `${y}-${pad(m + 1)}-01`;
      const lastMonth = `${m === 0 ? y - 1 : y}-${pad(m === 0 ? 12 : m)}-01`;
      const [current, previous] = await Promise.all([
        analytics.energyByGroup(ctx.homeId, groupBy, thisMonth),
        analytics.energyByGroup(ctx.homeId, groupBy, lastMonth, thisMonth),
      ]);
      reply.send({ currency: provider.currency, groupBy, groups: compareGroupCost(current, previous, provider.ratePerKwh) });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Cost history bucketed by day / week / month / year (optionally for a single device).
  app.get<{ Querystring: { bucket?: string; from?: string; to?: string; deviceId?: string } }>("/v1/energy/history", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const analytics = requireAnalytics(ctx);
      const provider = (await ctx.homeConfig.get(ctx.homeId, "energy_provider")) as { ratePerKwh: number; currency: string } | undefined;
      if (!provider) throw new SupremeError("conflict", "configure your electricity provider first (PUT /v1/energy/provider)");
      const bucket = (["day", "week", "month", "year"].includes(req.query.bucket ?? "") ? req.query.bucket : "day") as Parameters<typeof bucketCostHistory>[1];
      const days = await analytics.energyDailySeries(ctx.homeId, req.query.from, req.query.to, req.query.deviceId);
      reply.send({ currency: provider.currency, bucket, history: bucketCostHistory(days, bucket, provider.ratePerKwh) });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Rated wattage per device, so the hub can estimate energy for non-metered devices.
  app.get("/v1/energy/device-watts", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      reply.send({ watts: (await ctx.homeConfig.get(ctx.homeId, "device_watts")) ?? {} });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.put("/v1/energy/device-watts", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "update");
      const body = (req.body ?? {}) as { watts?: unknown };
      const w = body.watts;
      if (!w || typeof w !== "object" || Array.isArray(w)) throw new SupremeError("validation_failed", "watts must be an object of deviceId → watts");
      const cleaned: Record<string, number> = {};
      for (const [id, val] of Object.entries(w as Record<string, unknown>)) {
        if (typeof val !== "number" || !Number.isFinite(val) || val < 0 || val > 100000) throw new SupremeError("validation_failed", `watts for ${id} must be 0..100000`);
        if (val > 0) cleaned[id] = val;
      }
      await ctx.homeConfig.set(ctx.homeId, "device_watts", cleaned);
      reply.send({ watts: cleaned });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Monthly energy budget + live month-to-date projection. GET returns the set budget plus a
  // projection (when a provider rate is configured) so the app can show "on track / over budget".
  app.get("/v1/energy/budget", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const budget = (await ctx.homeConfig.get(ctx.homeId, "energy_budget")) as EnergyBudget | undefined;
      const provider = (await ctx.homeConfig.get(ctx.homeId, "energy_provider")) as { ratePerKwh: number; currency: string } | undefined;
      let status: ReturnType<typeof budgetStatus> | undefined;
      if (budget && provider) {
        const now = new Date();
        const y = now.getUTCFullYear();
        const m = now.getUTCMonth();
        const monthStart = `${y}-${String(m + 1).padStart(2, "0")}-01`;
        const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        const days = await requireAnalytics(ctx).energyDailySeries(ctx.homeId, monthStart);
        const kwh = days.reduce((s, d) => s + d.kwh, 0);
        status = budgetStatus({ monthlyBudget: budget.monthlyBudget, spentSoFar: kwh * provider.ratePerKwh, dayOfMonth: now.getUTCDate(), daysInMonth });
      }
      reply.send({ budget: budget ?? null, currency: provider?.currency ?? null, status: status ?? null });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.put("/v1/energy/budget", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "update");
      const body = (req.body ?? {}) as { monthlyBudget?: unknown };
      if (body.monthlyBudget === null) {
        await ctx.homeConfig.set(ctx.homeId, "energy_budget", null);
        reply.send({ budget: null });
        return;
      }
      let budget;
      try {
        budget = validateBudget(body);
      } catch (err) {
        if (err instanceof BudgetError) throw new SupremeError("validation_failed", err.message);
        throw err;
      }
      await ctx.homeConfig.set(ctx.homeId, "energy_budget", budget);
      reply.send({ budget });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Download the cost history as CSV (for the homeowner's records / their accountant).
  app.get<{ Querystring: { bucket?: string; from?: string; to?: string; deviceId?: string } }>("/v1/energy/history.csv", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const analytics = requireAnalytics(ctx);
      const provider = (await ctx.homeConfig.get(ctx.homeId, "energy_provider")) as { ratePerKwh: number; currency: string } | undefined;
      if (!provider) throw new SupremeError("conflict", "configure your electricity provider first (PUT /v1/energy/provider)");
      const bucket = (["day", "week", "month", "year"].includes(req.query.bucket ?? "") ? req.query.bucket : "month") as Parameters<typeof bucketCostHistory>[1];
      const days = await analytics.energyDailySeries(ctx.homeId, req.query.from, req.query.to, req.query.deviceId);
      const csv = costHistoryToCsv(bucketCostHistory(days, bucket, provider.ratePerKwh), provider.currency);
      reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="energy-cost-${bucket}.csv"`)
        .send(csv);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Tariff-aware energy cost: compute the bill for a time range. Uses the tariff in the request if
  // given, else the home's stored tariff. Returns a cost breakdown + optional budget projection.
  app.post("/v1/energy/cost", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const analytics = requireAnalytics(ctx);
      const body = (req.body ?? {}) as { tariff?: Parameters<typeof computeEnergyCost>[0]; from?: string; to?: string; budget?: Parameters<typeof budgetStatus>[0] };
      const tariff = body.tariff ?? ((await ctx.homeConfig.get(ctx.homeId, "tariff")) as Parameters<typeof computeEnergyCost>[0] | undefined);
      if (!tariff || !Array.isArray(tariff.periods)) {
        throw new SupremeError("validation_failed", "no tariff configured — set one via PUT /v1/energy/tariff or pass it in the body");
      }
      body.tariff = tariff;
      const samples = await analytics.hourlyEnergy(ctx.homeId, body.from, body.to);
      let cost;
      try {
        cost = computeEnergyCost(body.tariff, samples);
      } catch (err) {
        if (err instanceof TariffError) throw new SupremeError("validation_failed", err.message);
        throw err;
      }
      const budget = body.budget ? budgetStatus(body.budget) : undefined;
      reply.send({ cost, ...(budget ? { budget } : {}) });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Sun times (sunrise/sunset/solar-noon) for the home's location + a date — anchors "at sunset"
  // automations and circadian. lat/lon are required query params (the app passes the home location).
  app.get<{ Querystring: { lat?: string; lon?: string; date?: string } }>("/v1/solar", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const lat = Number(req.query.lat);
      const lon = Number(req.query.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        throw new SupremeError("validation_failed", "valid lat (-90..90) and lon (-180..180) query params are required");
      }
      const d = req.query.date ? new Date(`${req.query.date}T00:00:00Z`) : new Date();
      if (Number.isNaN(d.getTime())) throw new SupremeError("validation_failed", "invalid date");
      reply.send(sunTimes({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), latitude: lat, longitude: lon }));
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Peak-aware load shifting ──────────────────────────────────────────────────
  // The deferrable loads (device ids) the hub may pause during peak-rate hours.
  app.get("/v1/energy/deferrable-loads", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const deviceIds = (await ctx.homeConfig.get(ctx.homeId, "deferrable_loads")) ?? [];
      reply.send({ deviceIds, pausedNow: ctx.loadShiftRunner.pausedDevices });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.put("/v1/energy/deferrable-loads", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "update");
      const body = (req.body ?? {}) as { deviceIds?: unknown; ceiling?: number };
      if (!Array.isArray(body.deviceIds) || body.deviceIds.some((d) => typeof d !== "string")) {
        throw new SupremeError("validation_failed", "deviceIds must be an array of device ids");
      }
      if (body.ceiling !== undefined && (!Number.isFinite(body.ceiling) || body.ceiling < 0)) {
        throw new SupremeError("validation_failed", "ceiling must be a non-negative number (per-kWh rate)");
      }
      await ctx.homeConfig.set(ctx.homeId, "deferrable_loads", body.deviceIds);
      if (body.ceiling !== undefined) await ctx.homeConfig.set(ctx.homeId, "load_shift_ceiling", body.ceiling);
      reply.send({ deviceIds: body.deviceIds });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Preview the current load-shift decision under the stored tariff.
  app.get("/v1/energy/load-shift", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const tariff = (await ctx.homeConfig.get(ctx.homeId, "tariff")) as Parameters<typeof loadShiftDecision>[0] | undefined;
      if (!tariff) {
        reply.send({ decision: null });
        return;
      }
      const now = new Date();
      const weekend = now.getDay() === 0 || now.getDay() === 6;
      const ceiling = (await ctx.homeConfig.get(ctx.homeId, "load_shift_ceiling")) as number | undefined;
      const decision = loadShiftDecision(tariff, now.getHours() * 60 + now.getMinutes(), weekend, ceiling !== undefined ? { maxRunRatePerKwh: ceiling } : {});
      reply.send({ decision, pausedNow: ctx.loadShiftRunner.pausedDevices });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Adaptive ventilation (air-quality-driven fan) ────────────────────────────
  app.get("/v1/ventilation/config", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const config = await ctx.homeConfig.get(ctx.homeId, "ventilation");
      reply.send({ config: config ?? null, fanOn: ctx.ventilationRunner.currentFanState });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.put("/v1/ventilation/config", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "update");
      const body = (req.body ?? {}) as { config?: unknown };
      let config;
      try {
        config = validateVentilationConfig(body.config);
      } catch (err) {
        if (err instanceof VentilationError) throw new SupremeError("validation_failed", err.message);
        throw err;
      }
      await ctx.homeConfig.set(ctx.homeId, "ventilation", config);
      reply.send({ config });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Climate program (programmable thermostat) ────────────────────────────────
  app.get("/v1/climate/program", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const program = await ctx.homeConfig.get(ctx.homeId, "climate_program");
      reply.send({ program: program ?? null });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.put("/v1/climate/program", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "update");
      const body = (req.body ?? {}) as { program?: unknown };
      let program;
      try {
        program = validateClimateProgram(body.program);
      } catch (err) {
        if (err instanceof ClimateProgramError) throw new SupremeError("validation_failed", err.message);
        throw err;
      }
      await ctx.homeConfig.set(ctx.homeId, "climate_program", program);
      reply.send({ program });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Circadian (human-centric) lighting ───────────────────────────────────────
  // Preview the circadian target (color temperature + brightness) for the hub's current local time.
  app.get("/v1/lighting/circadian", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const now = new Date();
      const target = circadianAt(defaultCircadianProfile, now.getHours() * 60 + now.getMinutes());
      reply.send({ target, atLocalMinute: now.getHours() * 60 + now.getMinutes() });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Apply the current circadian target to every tunable-white (color-capable) light, optionally
  // scoped to a room. Drives them through the SIL like any command.
  app.post<{ Body: { roomId?: string } }>("/v1/lighting/circadian/apply", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "control");
      const roomId = (req.body ?? {}).roomId;
      const all = roomId ? await ctx.home.listDevicesInRoom(roomId as RoomId) : await ctx.home.listDevices();
      const now = new Date();
      const target = circadianAt(defaultCircadianProfile, now.getHours() * 60 + now.getMinutes());
      const command = circadianColorCommand(target);
      const applied: string[] = [];
      for (const d of all) {
        if (!d.capabilities.some((c) => c.kind === "color")) continue;
        await ctx.sil.command(d.id, command);
        applied.push(d.id);
      }
      await ctx.audit?.record({ homeId: ctx.homeId, actorUserId: user.id, action: "lighting.circadian", resourceType: "home", resourceId: ctx.homeId, metadata: { count: applied.length, ...target } });
      reply.send({ target, applied });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Advanced audit ───────────────────────────────────────────────────────────
  app.get("/v1/audit", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "admin");
      const audit = requireAudit(ctx);
      const entries = (await audit.list(ctx.homeId)).map((e) => ({
        id: e.id,
        seq: e.seq,
        actorUserId: e.actorUserId,
        action: e.action,
        resourceType: e.resourceType,
        resourceId: e.resourceId,
        metadata: e.metadata,
        createdAt: e.createdAt,
        entryHash: e.entryHash,
      }));
      reply.send({ entries } satisfies AuditList);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get("/v1/audit/verify", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "admin");
      const result = await requireAudit(ctx).verify(ctx.homeId);
      reply.send(result satisfies AuditVerifyResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── AI assistant ─────────────────────────────────────────────────────────────
  app.post("/v1/ai/assistant", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const { utterance } = AiAssistRequest.parse(req.body);

      // Build the assistant's home context from the Supreme domain (no HA).
      const rooms = (await ctx.home.listRooms()).map((r) => ({ id: r.id, name: r.name }));
      const devices = (await ctx.home.listDevices()).map((d) => ({
        id: d.id,
        name: d.name,
        roomId: d.roomId,
        supremeType: d.supremeType,
        capabilities: d.capabilities.map((c) => c.kind),
      }));
      const result = await ctx.ai.assist({ utterance, context: { rooms, devices } });
      reply.send({ result });
    } catch (err) {
      sendError(reply, err);
    }
  });
}

function requireAnalytics(ctx: AppContext) {
  if (!ctx.analytics) {
    throw new SupremeError("conflict", "energy analytics requires the Postgres persistence layer (set DATABASE_URL)");
  }
  return ctx.analytics;
}
function requireAudit(ctx: AppContext) {
  if (!ctx.audit) {
    throw new SupremeError("conflict", "audit log requires the Postgres persistence layer (set DATABASE_URL)");
  }
  return ctx.audit;
}

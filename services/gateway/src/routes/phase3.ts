import {
  AiAssistRequest,
  CreateAutomationRequest,
  SetAutomationEnabledRequest,
  SupremeError,
  UpdateAutomationRequest,
  type AuditList,
  type AuditVerifyResponse,
  type AutomationList,
  type AutomationResponse,
  type DeviceEnergyResponse,
  type EnergySummaryResponse,
} from "@supreme/contracts";
import type { AutomationId, DeviceId, RoomId } from "@supreme/domain-model";
import { budgetStatus, computeEnergyCost, TariffError } from "@supreme/analytics";
import { circadianAt, circadianColorCommand, defaultCircadianProfile } from "@supreme/automations";
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

  // Tariff-aware energy cost: compute the bill for a time range under the homeowner's tariff
  // (passed in the request; the app stores the rate plan). Returns a cost breakdown + optional
  // budget projection. The tariff/budget shapes mirror @supreme/analytics' cost engine.
  app.post("/v1/energy/cost", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const analytics = requireAnalytics(ctx);
      const body = (req.body ?? {}) as { tariff?: Parameters<typeof computeEnergyCost>[0]; from?: string; to?: string; budget?: Parameters<typeof budgetStatus>[0] };
      if (!body.tariff || !Array.isArray(body.tariff.periods)) {
        throw new SupremeError("validation_failed", "a tariff with periods is required");
      }
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

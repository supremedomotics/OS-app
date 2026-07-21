import {
  CreateKeypadMappingRequest,
  CreateKeypadSubscriptionRequest,
  SetKeypadMappingEnabledRequest,
  SupremeError,
  UpdateKeypadMappingRequest,
  type KeypadCapabilitiesResponse,
  type KeypadMappingList,
  type KeypadMappingResponse,
  type KeypadMappingRunList,
  type KeypadSubscriptionList,
  type KeypadSubscriptionResponse,
} from "@supreme/contracts";
import type { DeviceId, KeypadMappingId, KeypadSubscriptionId } from "@supreme/domain-model";
import type { FastifyInstance } from "fastify";
import { authenticate, enforce } from "../auth.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";

/**
 * Universal Keypad Framework routes (§ Universal Keypad Framework, Phase 1 —
 * backend APIs only; the visual Universal Keypad Editor is future work). Mirrors
 * `registerPhase3Routes`' automation CRUD shape exactly. Every mapping/subscription
 * write is gated by the `"keypad_mapping"` resource type (§ ADR 0016) — distinct
 * from `"automation"` on purpose, since this is installer commissioning work tied to
 * physical bus wiring, not a homeowner-authored automation.
 */
export function registerKeypadRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ── Keypad capability introspection ─────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/v1/devices/:id/keypad-capabilities", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const deviceId = req.params.id as DeviceId;
      const device = await ctx.home.getDevice(deviceId);
      if (!device) throw new SupremeError("not_found", "device not found");
      await enforce(ctx, user, "device", deviceId, "view");
      const capabilities = await ctx.sil.getKeypadCapabilities(deviceId);
      reply.send({ capabilities } satisfies KeypadCapabilitiesResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Mappings ─────────────────────────────────────────────────────────────────
  app.get("/v1/keypad/mappings", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "keypad_mapping", null, "view");
      reply.send({ mappings: await ctx.keypadMappings.list() } satisfies KeypadMappingList);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/keypad/mappings", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "keypad_mapping", null, "create");
      const input = CreateKeypadMappingRequest.parse(req.body);
      const mapping = await ctx.keypadMappings.create({ homeId: ctx.homeId, ...input });
      await ctx.audit?.record({ homeId: ctx.homeId, actorUserId: user.id, action: "keypad_mapping.create", resourceType: "keypad_mapping", resourceId: mapping.id });
      reply.code(201).send({ mapping } satisfies KeypadMappingResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>("/v1/keypad/mappings/:id", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const id = req.params.id as KeypadMappingId;
      await ctx.keypadMappings.get(id);
      await enforce(ctx, user, "keypad_mapping", id, "update");
      const mapping = await ctx.keypadMappings.update(id, UpdateKeypadMappingRequest.parse(req.body));
      await ctx.audit?.record({ homeId: ctx.homeId, actorUserId: user.id, action: "keypad_mapping.update", resourceType: "keypad_mapping", resourceId: id });
      reply.send({ mapping } satisfies KeypadMappingResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/v1/keypad/mappings/:id/enabled", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const id = req.params.id as KeypadMappingId;
      await ctx.keypadMappings.get(id);
      await enforce(ctx, user, "keypad_mapping", id, "update");
      const { enabled } = SetKeypadMappingEnabledRequest.parse(req.body);
      const mapping = await ctx.keypadMappings.setEnabled(id, enabled);
      reply.send({ mapping } satisfies KeypadMappingResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/v1/keypad/mappings/:id/run", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const id = req.params.id as KeypadMappingId;
      await ctx.keypadMappings.get(id);
      await enforce(ctx, user, "keypad_mapping", id, "control");
      await ctx.keypadMappings.testRun(id);
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get("/v1/keypad/mappings/runs", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "keypad_mapping", null, "view");
      reply.send({ runs: ctx.keypadMappings.recentRuns(undefined, 100) } satisfies KeypadMappingRunList);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/v1/keypad/mappings/:id/runs", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const id = req.params.id as KeypadMappingId;
      await enforce(ctx, user, "keypad_mapping", id, "view");
      reply.send({ runs: ctx.keypadMappings.recentRuns(id, 100) } satisfies KeypadMappingRunList);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/v1/keypad/mappings/:id", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const id = req.params.id as KeypadMappingId;
      await enforce(ctx, user, "keypad_mapping", id, "delete");
      await ctx.keypadMappings.remove(id);
      await ctx.audit?.record({ homeId: ctx.homeId, actorUserId: user.id, action: "keypad_mapping.delete", resourceType: "keypad_mapping", resourceId: id });
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Feedback subscriptions (§ Subscription Manager) ─────────────────────────
  app.get("/v1/keypad/subscriptions", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "keypad_mapping", null, "view");
      reply.send({ subscriptions: ctx.keypadSubscriptions.list() } satisfies KeypadSubscriptionList);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/keypad/subscriptions", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "keypad_mapping", null, "create");
      const input = CreateKeypadSubscriptionRequest.parse(req.body);
      const device = await ctx.home.getDevice(input.deviceId);
      if (!device) throw new SupremeError("not_found", "device not found");
      const subscription = await ctx.keypadSubscriptions.subscribe({ homeId: ctx.homeId, ...input });
      reply.code(201).send({ subscription } satisfies KeypadSubscriptionResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/v1/keypad/subscriptions/:id", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "keypad_mapping", null, "delete");
      await ctx.keypadSubscriptions.unsubscribe(req.params.id as KeypadSubscriptionId);
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });
}

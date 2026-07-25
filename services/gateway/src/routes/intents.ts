import {
  RunIntentRequest,
  SupremeError,
  type IntentDefinitionList,
  type IntentDefinitionResponse,
  type IntentRunList,
  type RunIntentResponse,
} from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import { authenticate, enforce } from "../auth.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";

/**
 * Universal Intent & Capability Engine routes (§ Phase 2, ADR 0017). The Intent
 * Registry's public catalog + direct invocation — the same mechanism a future
 * Universal Keypad Editor, AI assistant, or Automation Editor "test" button calls.
 * Gated by the `"intent"` resource type (view the catalog/runs, control to invoke).
 */
export function registerIntentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/intents", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "intent", null, "view");
      reply.send({ intents: ctx.intentRegistry.list() } satisfies IntentDefinitionList);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/v1/intents/:id", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "intent", req.params.id, "view");
      const registration = ctx.intentRegistry.get(req.params.id);
      if (!registration) throw new SupremeError("not_found", `intent "${req.params.id}" is not registered`);
      reply.send({ intent: registration.definition } satisfies IntentDefinitionResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/v1/intents/:id/run", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "intent", req.params.id, "control");
      const input = RunIntentRequest.parse(req.body);
      const run = await ctx.intentEngine.run(req.params.id, input.target, input.params);
      await ctx.audit?.record({ homeId: ctx.homeId, actorUserId: user.id, action: "intent.run", resourceType: "intent", resourceId: req.params.id });
      reply.send({ run } satisfies RunIntentResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get("/v1/intents/runs", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "intent", null, "view");
      reply.send({ runs: ctx.intentEngine.recentRuns(undefined, 100) } satisfies IntentRunList);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/v1/intents/:id/runs", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "intent", req.params.id, "view");
      reply.send({ runs: ctx.intentEngine.recentRuns(req.params.id, 100) } satisfies IntentRunList);
    } catch (err) {
      sendError(reply, err);
    }
  });
}

import { AureonConverseRequest, SupremeError } from "@supreme/contracts";
import type { AureonTransactionId } from "@supreme/domain-model";
import type { FastifyInstance } from "fastify";
import { authenticate, enforce } from "../auth.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";

/**
 * Aureon routes, MVP slice (§ docs/architecture/aureon/AUREON-ARCHITECTURE.md §9,
 * brief Step 18). Additive alongside `/v1/ai/assistant` in phase3.ts — that route is
 * untouched. The baseline `home:view` gate here mirrors the existing assistant
 * route's own gate exactly; the real per-action authorization (RBAC+ABAC via the
 * EXISTING `PolicyEngine`, resource type "intent") happens inside `AureonService`,
 * not here — this route never decides whether an action is allowed itself.
 */
export function registerAureonRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/v1/aureon/converse", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const { utterance, confirm } = AureonConverseRequest.parse(req.body);
      const result = await ctx.aureon.converse({ user, utterance, confirm });
      reply.send({ result });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get("/v1/aureon/transactions/:id", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "view");
      const { id } = req.params as { id: string };
      const tx = ctx.aureon.getTransaction(id as AureonTransactionId);
      if (!tx) throw new SupremeError("not_found", "unknown or expired Aureon transaction");
      reply.send({ transaction: tx });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/aureon/transactions/:id/undo", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "home", null, "control");
      const { id } = req.params as { id: string };
      const result = await ctx.aureon.undo(id as AureonTransactionId, user);
      reply.send({ result });
    } catch (err) {
      sendError(reply, err);
    }
  });
}

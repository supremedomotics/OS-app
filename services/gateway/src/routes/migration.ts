import {
  MigrateDomainRequest,
  type MigrateDomainResponse,
  type MigrationStatus,
} from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import { authenticate, enforce } from "../auth.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";

/**
 * Native-migration controls (§16 Phase 4). Installer/admin surface to move backend
 * domains from Home Assistant onto the Supreme-native engine — the visible API and
 * every client are unaffected by the change (the migration guarantee). Disabled
 * gracefully when the hub isn't backed by a routing adapter.
 */
export function registerMigrationRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/migration", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      const domains = ctx.sil.migrationStatus();
      const body: MigrationStatus = {
        enabled: ctx.sil.migrationEnabled,
        domains,
        fullyMigrated: domains.length > 0 && domains.every((d) => d.engine === "native"),
      };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { domain: string } }>("/v1/migration/:domain", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "admin");
      const { engine } = MigrateDomainRequest.parse(req.body);
      const moved = await ctx.sil.migrateDomain(req.params.domain, engine);
      await ctx.audit?.record({
        homeId: ctx.homeId,
        actorUserId: user.id,
        action: `migration.${engine}`,
        resourceType: "integration",
        resourceId: req.params.domain,
        metadata: { moved },
      });
      const body: MigrateDomainResponse = { domain: req.params.domain, engine, moved };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });
}

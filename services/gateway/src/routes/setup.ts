import { SupremeError, type LoginResponse } from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";

/**
 * First-run Setup Wizard (§ provisioning). These are the ONLY unauthenticated write
 * endpoints, and only while no administrator exists:
 *   GET  /v1/setup/status  — is the wizard required? (drives the client's onboarding)
 *   POST /v1/setup         — create the Supreme OS administrator + home, then auto-login
 *
 * Supreme-only: no Home Assistant user is ever created. Once an admin exists, POST is a
 * 409 so the wizard can't be replayed.
 */
export function registerSetupRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/setup/status", async (_req, reply) => {
    reply.send({ setupRequired: ctx.setupRequired, systemName: ctx.config.systemName });
  });

  app.post("/v1/setup", async (req, reply) => {
    try {
      if (!ctx.setupRequired) {
        throw new SupremeError("conflict", "Supreme OS is already set up");
      }
      const b = (req.body ?? {}) as Record<string, unknown>;
      const username = String(b.username ?? "").trim();
      const password = String(b.password ?? "");
      const confirm = b.confirmPassword === undefined ? password : String(b.confirmPassword);
      const systemName = String(b.systemName ?? "").trim();
      if (username.length < 3) {
        throw new SupremeError("validation_failed", "username must be at least 3 characters");
      }
      if (password.length < 8) {
        throw new SupremeError("validation_failed", "password must be at least 8 characters");
      }
      if (password !== confirm) {
        throw new SupremeError("validation_failed", "passwords do not match");
      }
      const { login, loginEmail } = await ctx.completeSetup({
        username,
        password,
        displayName: b.displayName ? String(b.displayName) : undefined,
        systemName,
        location: b.location ? String(b.location) : null,
        timeZone: b.timeZone ? String(b.timeZone) : null,
      });
      reply.code(201).send({ ...(login as LoginResponse), loginEmail });
    } catch (err) {
      sendError(reply, err);
    }
  });
}

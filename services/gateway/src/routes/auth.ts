import {
  LoginRequest,
  MfaCodeRequest,
  MfaVerifyRequest,
  RefreshRequest,
  type MfaEnrollResponse,
} from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { authenticate } from "../auth.js";
import { sendError } from "../http-errors.js";

/** Auth + current-user routes (§6, §12). Supreme-branded; no HA login surface. */
export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Credential endpoints get a stricter per-IP rate limit to blunt brute force.
  const authLimit = { config: { rateLimit: { max: ctx.config.authRateMax, timeWindow: "1 minute" } } };

  app.post("/v1/auth/login", authLimit, async (req, reply) => {
    try {
      const body = LoginRequest.parse(req.body);
      reply.send(await ctx.identity.login(body.email, body.password));
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/auth/refresh", authLimit, async (req, reply) => {
    try {
      const body = RefreshRequest.parse(req.body);
      reply.send(await ctx.identity.refresh(body.refreshToken));
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Complete an MFA-gated login (login returned status "mfa_required").
  app.post("/v1/auth/mfa/verify", authLimit, async (req, reply) => {
    try {
      const body = MfaVerifyRequest.parse(req.body);
      reply.send({ status: "ok", ...(await ctx.identity.verifyMfaLogin(body.mfaToken, body.code)) });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── MFA enrollment (current user) ─────────────────────────────────────────────
  app.post("/v1/me/mfa/enroll", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      reply.send((await ctx.identity.startMfaEnrollment(user.id)) satisfies MfaEnrollResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/me/mfa/confirm", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const { code } = MfaCodeRequest.parse(req.body);
      await ctx.identity.confirmMfaEnrollment(user.id, code);
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/me/mfa/disable", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const { code } = MfaCodeRequest.parse(req.body);
      await ctx.identity.disableMfa(user.id, code);
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get("/v1/me", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      reply.send({ user });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Revoke the current session (logout). Idempotent — always 204.
  app.post("/v1/auth/logout", async (req, reply) => {
    try {
      const header = req.headers.authorization;
      const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
      if (token) await ctx.identity.logout(token);
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });
}

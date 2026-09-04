import {
  ChangeEmailRequest,
  CreateApiTokenRequest,
  DeleteAccountRequest,
  LoginRequest,
  MfaCodeRequest,
  MfaVerifyRequest,
  RefreshRequest,
  SupremeError,
  type ApiTokenList,
  type CreateApiTokenResponse,
  type MfaEnrollResponse,
  type RevokeOthersResponse,
  type SessionList,
  type SessionView,
  type UserResponse,
} from "@supreme/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context.js";
import { authenticate } from "../auth.js";
import { sendError } from "../http-errors.js";

/** Auth + current-user routes (§6, §12). Supreme-branded; no HA login surface. */
export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Credential endpoints get a stricter per-IP rate limit to blunt brute force.
  const authLimit = { config: { rateLimit: { max: ctx.config.authRateMax, timeWindow: "1 minute" } } };

  // Extract the Bearer access token (throws unauthorized when absent) for session routes.
  const bearer = (req: FastifyRequest): string => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new SupremeError("unauthorized", "missing bearer token");
    return header.slice("Bearer ".length);
  };

  // Capture where a login came from (Security Center). `req.ip` respects the configured trust proxy.
  const loginContext = (req: FastifyRequest) => ({
    ip: req.ip || null,
    userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
  });

  // Password policy so clients can show the rules + a strength meter (§ password policies).
  app.get("/v1/auth/password-policy", async (_req, reply) => {
    const p = ctx.identity.passwordPolicy;
    reply.send({ minLength: p.minLength, requireLetter: p.requireLetter, requireNumber: p.requireNumber });
  });

  app.post("/v1/auth/login", authLimit, async (req, reply) => {
    try {
      const body = LoginRequest.parse(req.body);
      // § Real username login — identity.login() itself tries email first, then username (see
      // its own doc comment); this route no longer needs to guess which one `body.email` is or
      // synthesize a fake address for it.
      reply.send(await ctx.identity.login(body.email, body.password, loginContext(req)));
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
      reply.send({ status: "ok", ...(await ctx.identity.verifyMfaLogin(body.mfaToken, body.code, loginContext(req))) });
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

  // MFA recovery codes (§ Security Center). Status is safe to read; regeneration returns the
  // plaintext codes ONCE (only hashes are stored) and requires MFA to be enabled.
  app.get("/v1/me/mfa/recovery-codes", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      reply.send(await ctx.identity.recoveryCodeStatus(user.id));
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/me/mfa/recovery-codes", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const codes = await ctx.identity.regenerateRecoveryCodes(user.id);
      reply.send({ codes, remaining: codes.length });
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

  // ── Forgot / reset password (§ user management) — Supreme-only, never touches HA ─
  // Always 200 (anti-enumeration). On a local hub with no email transport, the reset
  // token is returned in non-production so LAN self-service works; production omits it
  // and delivers out-of-band (email/SMS integration point).
  app.post("/v1/auth/forgot-password", authLimit, async (req, reply) => {
    try {
      const email = String((req.body as { email?: unknown })?.email ?? "").trim();
      const reset = email ? await ctx.identity.requestPasswordReset(email) : null;
      const expose = ctx.config.nodeEnv !== "production" && reset ? { resetToken: reset.token } : {};
      reply.send({ ok: true, ...expose });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/auth/reset-password", authLimit, async (req, reply) => {
    try {
      const b = (req.body ?? {}) as { token?: unknown; newPassword?: unknown };
      await ctx.identity.resetPassword(String(b.token ?? ""), String(b.newPassword ?? ""));
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Change the password of the signed-in user (requires the current password).
  app.post("/v1/me/password", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const b = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
      await ctx.identity.changePassword(user.id, String(b.currentPassword ?? ""), String(b.newPassword ?? ""));
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Email verification (§ Authentication). Request/resend a token; in non-production the token is
  // returned so LAN self-service works (production delivers it by email — the integration point).
  app.post("/v1/me/email/verify/request", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const res = await ctx.identity.requestEmailVerification(user.id);
      const expose = ctx.config.nodeEnv !== "production" && res ? { token: res.token } : {};
      reply.send({ sent: res !== null, alreadyVerified: res === null, ...expose });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Complete verification with the token (public — the token proves possession of the mailbox).
  app.post("/v1/auth/verify-email", async (req, reply) => {
    try {
      const token = String((req.body as { token?: unknown })?.token ?? "");
      const user = await ctx.identity.verifyEmail(token);
      reply.send({ user } satisfies UserResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Change the signed-in user's email/username (re-auth with the current password).
  app.post("/v1/me/email", async (req, reply) => {
    try {
      const actor = await authenticate(ctx, req);
      const body = ChangeEmailRequest.parse(req.body);
      const user = await ctx.identity.changeEmail(actor.id, body.newEmail, body.currentPassword);
      reply.send({ user } satisfies UserResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Delete the signed-in user's own account (re-auth with the current password). The master (owner)
  // account cannot be self-deleted — that would orphan the home.
  app.delete("/v1/me", async (req, reply) => {
    try {
      const actor = await authenticate(ctx, req);
      const body = DeleteAccountRequest.parse(req.body);
      await ctx.identity.deleteOwnAccount(actor.id, body.currentPassword);
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Security Center: active sessions / login history + remote logout ─────────────
  app.get("/v1/me/sessions", async (req, reply) => {
    try {
      const { user, sid } = await ctx.identity.authenticateSession(bearer(req));
      const sessions = await ctx.identity.listSessions(user.id);
      const body: SessionList = {
        sessions: sessions.map(
          (s): SessionView => ({
            id: s.id,
            createdAt: s.createdAt,
            lastSeenAt: s.lastSeenAt ?? null,
            ip: s.ip ?? null,
            userAgent: s.userAgent ?? null,
            revoked: s.revoked,
            current: s.id === sid,
          }),
        ),
      };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Remotely sign out one of your sessions. Blocks revoking the current one via this route —
  // use /v1/auth/logout for that, so the UI intent stays clear.
  app.delete<{ Params: { id: string } }>("/v1/me/sessions/:id", async (req, reply) => {
    try {
      const { user, sid } = await ctx.identity.authenticateSession(bearer(req));
      if (req.params.id === sid) {
        throw new SupremeError("validation_failed", "use logout to end the current session");
      }
      await ctx.identity.revokeSession(user.id, req.params.id);
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Sign out everywhere except this device.
  app.post("/v1/me/sessions/revoke-others", async (req, reply) => {
    try {
      const { user, sid } = await ctx.identity.authenticateSession(bearer(req));
      const revoked = await ctx.identity.revokeOtherSessions(user.id, sid ?? "");
      reply.send({ revoked } satisfies RevokeOthersResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Passkeys / WebAuthn (§ Security Center) ──────────────────────────────────
  app.get("/v1/me/passkeys", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      reply.send({ passkeys: await ctx.identity.listPasskeys(user.id) });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/me/passkeys/register/begin", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      reply.send(await ctx.identity.beginPasskeyRegistration(user.id));
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/me/passkeys/register/finish", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const b = (req.body ?? {}) as { name?: string; clientDataJSON?: string; attestationObject?: string };
      const meta = await ctx.identity.finishPasskeyRegistration(user.id, {
        name: b.name,
        clientDataJSON: String(b.clientDataJSON ?? ""),
        attestationObject: String(b.attestationObject ?? ""),
      });
      reply.code(201).send({ passkey: meta });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/v1/me/passkeys/:id", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await ctx.identity.removePasskey(user.id, req.params.id);
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Passwordless passkey login.
  app.post("/v1/auth/passkey/begin", authLimit, async (_req, reply) => {
    reply.send(ctx.identity.beginPasskeyAuthentication());
  });

  app.post("/v1/auth/passkey/finish", authLimit, async (req, reply) => {
    try {
      const b = (req.body ?? {}) as { credentialId?: string; clientDataJSON?: string; authenticatorData?: string; signature?: string };
      const pair = await ctx.identity.finishPasskeyAuthentication(
        {
          credentialId: String(b.credentialId ?? ""),
          clientDataJSON: String(b.clientDataJSON ?? ""),
          authenticatorData: String(b.authenticatorData ?? ""),
          signature: String(b.signature ?? ""),
        },
        loginContext(req),
      );
      reply.send({ status: "ok", ...pair });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Personal API tokens (§ Security Center) ──────────────────────────────────
  const toView = (m: { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; revoked: boolean }) =>
    ({ id: m.id, name: m.name, prefix: m.prefix, createdAt: m.createdAt, lastUsedAt: m.lastUsedAt, revoked: m.revoked });

  app.get("/v1/me/api-tokens", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      reply.send({ tokens: (await ctx.identity.listApiTokens(user.id)).map(toView) } satisfies ApiTokenList);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/me/api-tokens", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const { name } = CreateApiTokenRequest.parse(req.body ?? {});
      const { token, meta } = await ctx.identity.createApiToken(user.id, name);
      reply.code(201).send({ token, meta: toView(meta) } satisfies CreateApiTokenResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/v1/me/api-tokens/:id", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await ctx.identity.revokeApiToken(user.id, req.params.id);
      reply.code(204).send();
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

import type { FastifyInstance } from "fastify";
import { SupremeError } from "@supreme/contracts";
import type { AppContext } from "../context.js";
import { authenticate } from "../auth.js";
import { sendError } from "../http-errors.js";
import {
  issueMobileAuthorizationToken,
  verifyMobileSignature,
  type MobileAuthorizationRecord,
} from "../mobile-pairing.js";

/**
 * Real server-side half of the Mobile pairing protocol (§Phase12) whose client half shipped
 * in Phase 11 (`apps/new/shared/lib/src/identity/pairing.dart`'s `PairingClient`/
 * `PairingTransport`). Closes the "SERVER-SIDE REQUIRED" gap that phase's doc comments named
 * explicitly — this is the literal contract `PairingTransport` describes, implemented for
 * real: pairing-code → signed challenge → Ed25519-verified response → issued authorization.
 */
export function registerMobilePairingRoutes(app: FastifyInstance, ctx: AppContext): void {
  const hubId = ctx.hubIdentity.hubUuid;
  const projectId = ctx.homeId;

  // Admin/installer action: mint a short-lived pairing code to read aloud/display/QR-encode
  // for the homeowner to enter on a new Mobile device (§8 — never a static/MAC-based secret).
  app.post("/v1/pairing/codes", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      if (!user) throw new SupremeError("unauthorized", "sign in required");
      const code = ctx.pairingCodes.generate(hubId, projectId);
      reply.send({ code, hubId, projectId, expiresInMs: 10 * 60_000 });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Step 1: Mobile presents a pairing code + its Ed25519 public key, receives a fresh,
  // single-use challenge scoped to this Hub/project (never the credential itself).
  app.post("/v1/pairing/challenge", async (req, reply) => {
    const body = req.body as { pairingCode?: string; mobilePublicKeyBase64?: string } | undefined;
    if (!body?.pairingCode || !body.mobilePublicKeyBase64) {
      return sendError(reply, new SupremeError("validation_failed", "pairingCode and mobilePublicKeyBase64 are required"));
    }
    const entry = ctx.pairingCodes.consume(body.pairingCode);
    if (!entry || entry.hubId !== hubId || entry.projectId !== projectId) {
      return sendError(reply, new SupremeError("unauthorized", "invalid or expired pairing code"));
    }
    const challenge = ctx.pairingChallenges.issue({
      mobilePublicKeyBase64: body.mobilePublicKeyBase64,
      hubId,
      projectId,
    });
    reply.send({
      challengeId: challenge.challengeId,
      challengeBytes: challenge.challengeBytes.toString("base64"),
      hubId,
      projectId,
    });
  });

  // Step 2: Mobile proves possession of the private key by signing the exact challenge
  // bytes. Real Ed25519 verification (§6) — never string/MAC equality. The challenge is
  // consumed unconditionally (§7): a second submission for the same challengeId always
  // fails, success or not.
  app.post("/v1/pairing/verify", async (req, reply) => {
    const body = req.body as { challengeId?: string; signatureBase64?: string } | undefined;
    if (!body?.challengeId || !body.signatureBase64) {
      return sendError(reply, new SupremeError("validation_failed", "challengeId and signatureBase64 are required"));
    }
    const pending = ctx.pairingChallenges.consume(body.challengeId);
    if (!pending) {
      return sendError(reply, new SupremeError("unauthorized", "unknown, expired, or already-used challenge"));
    }
    const valid = verifyMobileSignature(pending.challengeBytes, body.signatureBase64, pending.mobilePublicKeyBase64);
    if (!valid) {
      return sendError(reply, new SupremeError("unauthorized", "signature does not match challenge"));
    }

    const now = new Date();
    const existing = ctx.mobileAuthorizations
      .list()
      .find((r) => r.publicKeyBase64 === pending.mobilePublicKeyBase64);
    const mobileId = existing?.mobileId ?? `mobile-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const record: MobileAuthorizationRecord = {
      mobileId,
      publicKeyBase64: pending.mobilePublicKeyBase64,
      hubId: pending.hubId,
      projectId: pending.projectId,
      label: existing?.label ?? "Mobile device",
      pairedAt: existing?.pairedAt ?? now.toISOString(),
      lastSeenAt: now.toISOString(),
      revoked: false,
      revokedAt: null,
    };
    ctx.mobileAuthorizations.upsert(record);

    const token = issueMobileAuthorizationToken(ctx.hubIdentity, { mobileId, hubId: pending.hubId, projectId: pending.projectId });
    reply.send({
      mobileId,
      hubId: pending.hubId,
      projectId: pending.projectId,
      token,
      issuedAt: now.toISOString(),
    });
  });

  // Renewal: called by the Mobile (over LAN, or via the broker's `/v1/route/:hubId/*` forward
  // — same route, reached either way) before its short-lived token expires. A revoked Mobile
  // is refused here, which is what actually stops it once its last-issued token expires
  // (§14/§17 — bounded revocation latency, documented, not silently open-ended).
  app.post("/v1/pairing/refresh", async (req, reply) => {
    const body = req.body as { mobileId?: string } | undefined;
    if (!body?.mobileId) {
      return sendError(reply, new SupremeError("validation_failed", "mobileId is required"));
    }
    if (!ctx.mobileAuthorizations.isAuthorized(body.mobileId, hubId, projectId)) {
      return sendError(reply, new SupremeError("unauthorized", "this Mobile is not authorized (revoked, unknown, or wrong Hub/project)"));
    }
    const now = new Date();
    ctx.mobileAuthorizations.touchLastSeen(body.mobileId, now.toISOString());
    const token = issueMobileAuthorizationToken(ctx.hubIdentity, { mobileId: body.mobileId, hubId, projectId });
    reply.send({ mobileId: body.mobileId, hubId, projectId, token, issuedAt: now.toISOString() });
  });

  // Admin action: list paired Mobiles (§26 — a Hub authorizes many, not one).
  app.get("/v1/pairing/mobiles", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      if (!user) throw new SupremeError("unauthorized", "sign in required");
      reply.send({ mobiles: ctx.mobileAuthorizations.list() });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Admin action: authoritative revocation (§9/§17) — the Hub is the system of record;
  // this is what makes a lost/compromised/uninstalled Mobile actually stop working, not just
  // locally forget its own token.
  app.post<{ Params: { mobileId: string } }>("/v1/pairing/mobiles/:mobileId/revoke", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      if (!user) throw new SupremeError("unauthorized", "sign in required");
      const ok = ctx.mobileAuthorizations.revoke(req.params.mobileId, new Date().toISOString());
      if (!ok) throw new SupremeError("not_found", "no such Mobile authorization");
      reply.send({ revoked: true });
    } catch (err) {
      sendError(reply, err);
    }
  });
}

import { verifyMobileAuthorizationToken } from "@supreme/hub-identity";
import { SupremeError } from "@supreme/contracts";
import type { User } from "@supreme/domain-model";
import type { FastifyRequest } from "fastify";
import type { AppContext } from "./context.js";
import { authenticate } from "./auth.js";

/**
 * §Phase12.4 — bridges Phase 11/12's Mobile pairing authorization to the EXISTING homeowner
 * REST surface (`/v1/home`, `/v1/devices`, `/v1/scenes`, …), instead of building a second API.
 *
 * The gap this closes: `authenticate()` (`auth.ts`) only recognizes a Supreme user SESSION
 * token (from `/v1/auth/login`). A paired Mobile's bearer token is a completely different,
 * unrelated credential — an Ed25519-signed `MobileAuthorizationToken` (`mobile-pairing.ts`,
 * `@supreme/hub-identity`) scoped to `(mobileId, hubId, projectId)`, not a user account. There
 * was previously no path from "this Mobile is authorized" to "this request may call the real
 * homeowner API," which is exactly why Phase 12.3's `HubHomeStateRepository` was
 * BACKEND CONTRACT MISSING.
 *
 * The bridge: try the existing session path FIRST (zero behavior change for every existing
 * caller — web-homeowner, web-installer, anything using a real login session); only on failure,
 * verify the bearer as a Mobile-authorization token against THIS Hub's own device public key
 * (the same key ADR 0009's tunnel handshake and Phase 12's pairing already use), check it is
 * scoped to this exact Hub+project, and check the Hub's own authoritative registry has not
 * revoked it (§Phase12 §9/§17 — revocation must actually stop use here too, not just at the
 * broker). A verified Mobile then acts as the home's own master/owner account for `enforce()`
 * purposes — this Hub has exactly one home and (in the current identity model) one master user
 * per home, so "a Mobile SupremeOS paired with this residence" and "the homeowner account for
 * this residence" are the same real-world entity; this is the smallest correct mapping, not a
 * new authorization concept.
 *
 * HONEST STATUS: a Hub with MULTIPLE non-master users (a family member with their own Supreme
 * login) would have every paired Mobile map to the SAME master account regardless of which
 * family member's phone it is — Phase 12 pairing has no concept of "pair as this specific
 * Supreme user," only "this Mobile is authorized for this Hub." Distinguishing which household
 * member a Mobile belongs to is real, unbuilt scope (§Phase12.4 doesn't ask for it, and
 * building it would be a user-identity-model change well beyond "smallest correct fix").
 */
export async function authenticateMobileOrUser(ctx: AppContext, req: FastifyRequest): Promise<User> {
  try {
    return await authenticate(ctx, req);
  } catch (sessionErr) {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw sessionErr;
    return resolveMobileOrSessionToken(ctx, header.slice("Bearer ".length), sessionErr);
  }
}

/**
 * §Phase12.6 — the token-level core of the bridge, factored out so `/v1/stream` (a WebSocket
 * upgrade, which carries its credential as `?access_token=` — browsers cannot set an
 * Authorization header on a WS handshake, same reason the existing session path already uses a
 * query param there) can reuse the EXACT SAME Mobile-token verification/authorization/
 * revocation logic as every REST route this bridge already covers, rather than a second,
 * subtly-different implementation.
 */
export async function resolveMobileOrSessionToken(
  ctx: AppContext,
  token: string,
  sessionErr?: unknown,
): Promise<User> {
  const payload = verifyMobileAuthorizationToken(token, ctx.hubIdentity.publicKey);
  if (!payload) {
    if (sessionErr) throw sessionErr;
    throw new SupremeError("unauthorized", "invalid or expired Mobile authorization");
  }
  if (payload.hubId !== ctx.hubIdentity.hubUuid || payload.projectId !== ctx.homeId) {
    throw new SupremeError("unauthorized", "token is not authorized for this Hub/project");
  }
  if (!ctx.mobileAuthorizations.isAuthorized(payload.mobileId, payload.hubId, payload.projectId)) {
    throw new SupremeError("unauthorized", "this Mobile is not authorized (never paired, or revoked)");
  }
  ctx.mobileAuthorizations.touchLastSeen(payload.mobileId, new Date().toISOString());

  const master = (await ctx.identity.listUsers()).find((u) => u.userType === "master");
  if (!master) throw new SupremeError("conflict", "home has no master account yet");
  return master;
}

/**
 * §Phase12.6 — tries a Supreme session token FIRST (via [tryUser]), falling back to a Mobile
 * authorization token — the same precedence `authenticateMobileOrUser` uses for REST, adapted
 * for a caller (like `/v1/stream`) that already has the raw token string rather than a
 * `FastifyRequest`.
 */
export async function resolveMobileOrSessionUser(
  ctx: AppContext,
  token: string,
  tryUser: (token: string) => Promise<User>,
): Promise<User> {
  try {
    return await tryUser(token);
  } catch (sessionErr) {
    return resolveMobileOrSessionToken(ctx, token, sessionErr);
  }
}

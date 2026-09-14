import { signString, verifyString } from "@supreme/crypto";
import type { HubIdentity } from "./index.js";

/**
 * Mobile-authorization tokens (§Phase12) — issued by a Hub for a paired Mobile identity,
 * verifiable by the Tunnel Broker WITHOUT a synchronous call back to the (often CGNAT-hidden)
 * Hub. Shared between `services/gateway` (issues, after real Ed25519 pairing verification —
 * see `services/gateway/src/mobile-pairing.ts`) and `cloud/tunnel-broker` (verifies, in
 * `authorizeClient`) because both already depend on this package and both already trust the
 * same Hub device Ed25519 key (`HubIdentity`) — the exact key ADR 0009's tunnel handshake
 * uses. No second, separately-trusted keypair is introduced; the Hub remains sole issuer.
 */
export interface MobileAuthorizationTokenPayload {
  mobileId: string;
  hubId: string;
  projectId: string;
  iat: number;
  exp: number;
}

/** Deliberately short — bounds (does not eliminate) revocation latency: a revoked Mobile's
 * already-issued token still works until it expires, but the Hub simply refuses to renew it. */
export const MOBILE_TOKEN_TTL_MS = 5 * 60_000;

export function issueMobileAuthorizationToken(
  identity: HubIdentity,
  claim: { mobileId: string; hubId: string; projectId: string },
  now: number = Date.now(),
): string {
  const payload: MobileAuthorizationTokenPayload = { ...claim, iat: now, exp: now + MOBILE_TOKEN_TTL_MS };
  const json = JSON.stringify(payload);
  const payloadB64 = Buffer.from(json, "utf8").toString("base64url");
  const signature = signString(json, identity.privateKey);
  return `${payloadB64}.${signature}`;
}

/** Verifies signature + freshness against a known Hub public key. Returns null on ANY
 * failure — callers (the broker's `authorizeClient`, most importantly) must fail closed. */
export function verifyMobileAuthorizationToken(
  token: string,
  hubPublicKeyPem: string,
  now: number = Date.now(),
): MobileAuthorizationTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payloadB64, signature] = parts as [string, string];
  let json: string;
  try {
    json = Buffer.from(payloadB64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!verifyString(json, signature, hubPublicKeyPem)) return null;
  let payload: MobileAuthorizationTokenPayload;
  try {
    payload = JSON.parse(json) as MobileAuthorizationTokenPayload;
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp < now) return null;
  if (payload.hubId !== undefined && typeof payload.hubId !== "string") return null;
  return payload;
}

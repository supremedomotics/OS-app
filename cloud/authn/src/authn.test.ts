import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuthnError, AuthnService, InMemoryAuthnStore } from "./index.js";

function fixedClock(start = 1_750_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function makeService(now: () => number) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return new AuthnService({ privateKey, publicKey, store: new InMemoryAuthnStore(), now });
}

describe("AuthnService — session + access tokens", () => {
  it("starts a session and issues a verifiable EdDSA access token", async () => {
    const clock = fixedClock();
    const svc = makeService(clock.now);
    const t = await svc.startSession({ accountId: "acct-1", deviceId: "dev-1", amr: ["passkey"] });
    const claims = await svc.verifyAccess(t.accessToken);
    expect(claims.sub).toBe("acct-1");
    expect(claims.amr).toEqual(["passkey"]);
    expect(claims.sid).toBe(t.sessionId);
  });

  it("scopes the access token audience to a hub when requested", async () => {
    const clock = fixedClock();
    const svc = makeService(clock.now);
    const t = await svc.startSession({
      accountId: "acct-1",
      deviceId: "dev-1",
      amr: ["pwd", "otp"],
      audience: "supreme-hub",
      scope: { hub: "hub-xyz" },
    });
    const claims = await svc.verifyAccess(t.accessToken, "supreme-hub");
    expect(claims.hub).toBe("hub-xyz");
    // Wrong audience must fail (a cloud-scoped verifier rejects a hub token).
    await expect(svc.verifyAccess(t.accessToken, "supreme-cloud")).rejects.toBeTruthy();
  });

  it("publishes a JWKS with the public signing key", async () => {
    const svc = makeService(fixedClock().now);
    const jwks = await svc.jwks();
    expect(jwks.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", use: "sig", alg: "EdDSA" });
  });
});

describe("AuthnService — refresh rotation", () => {
  it("rotates the refresh token on every use (one-time-use)", async () => {
    const clock = fixedClock();
    const svc = makeService(clock.now);
    const a = await svc.startSession({ accountId: "acct-1", deviceId: "dev-1", amr: ["pwd"] });
    clock.advance(1000);
    const b = await svc.refresh({ refreshToken: a.refreshToken });
    expect(b.refreshToken).not.toBe(a.refreshToken);
    expect(b.sessionId).toBe(a.sessionId);
    expect(b.familyId).toBe(a.familyId);

    // The new refresh works…
    clock.advance(1000);
    const c = await svc.refresh({ refreshToken: b.refreshToken });
    expect(c.accessToken).toBeTruthy();
  });

  it("DETECTS REUSE: re-presenting a rotated token revokes the whole family", async () => {
    const clock = fixedClock();
    const svc = makeService(clock.now);
    const a = await svc.startSession({ accountId: "acct-1", deviceId: "dev-1", amr: ["pwd"] });
    clock.advance(1000);
    const b = await svc.refresh({ refreshToken: a.refreshToken }); // a is now consumed

    // Attacker replays the already-used token `a` → reuse detected, family burned.
    await expect(svc.refresh({ refreshToken: a.refreshToken })).rejects.toMatchObject({
      code: "reuse_detected",
    });
    // …and the legitimately-rotated token `b` is now dead too (family revoked).
    await expect(svc.refresh({ refreshToken: b.refreshToken })).rejects.toMatchObject({
      code: "revoked",
    });
  });

  it("rejects an unknown refresh token", async () => {
    const svc = makeService(fixedClock().now);
    await expect(svc.refresh({ refreshToken: "not-a-real-token" })).rejects.toBeInstanceOf(AuthnError);
  });

  it("rejects an expired refresh token", async () => {
    const clock = fixedClock();
    const svc = new AuthnService({
      ...keys(),
      store: new InMemoryAuthnStore(),
      now: clock.now,
      refreshTtlSeconds: 10,
    });
    const a = await svc.startSession({ accountId: "acct-1", deviceId: "dev-1", amr: ["pwd"] });
    clock.advance(11_000);
    await expect(svc.refresh({ refreshToken: a.refreshToken })).rejects.toMatchObject({ code: "expired" });
  });
});

describe("AuthnService — remote logout", () => {
  it("revokes a session so its tokens stop working immediately", async () => {
    const clock = fixedClock();
    const svc = makeService(clock.now);
    const a = await svc.startSession({ accountId: "acct-1", deviceId: "dev-1", amr: ["pwd"] });

    svc.revokeSession(a.sessionId);
    // Access token verification fails (session revoked) and refresh is dead.
    await expect(svc.verifyAccess(a.accessToken)).rejects.toMatchObject({ code: "revoked" });
    await expect(svc.refresh({ refreshToken: a.refreshToken })).rejects.toMatchObject({ code: "revoked" });
  });
});

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey, privateKey };
}

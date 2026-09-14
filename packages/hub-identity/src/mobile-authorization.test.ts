import { describe, expect, it } from "vitest";
import { generateHubIdentity } from "./index.js";
import { issueMobileAuthorizationToken, verifyMobileAuthorizationToken } from "./mobile-authorization.js";

describe("Mobile authorization tokens (§Phase12) — real Ed25519, Hub-issued, broker-verifiable", () => {
  it("a token issued by the Hub verifies against the SAME Hub's own public key", () => {
    const hub = generateHubIdentity();
    const token = issueMobileAuthorizationToken(hub, { mobileId: "m1", hubId: hub.hubUuid, projectId: "p1" });

    const payload = verifyMobileAuthorizationToken(token, hub.publicKey);

    expect(payload).not.toBeNull();
    expect(payload?.mobileId).toBe("m1");
    expect(payload?.hubId).toBe(hub.hubUuid);
  });

  it("rejects a token verified against a DIFFERENT hub's public key (wrong hub, §10)", () => {
    const hubA = generateHubIdentity();
    const hubB = generateHubIdentity();
    const token = issueMobileAuthorizationToken(hubA, { mobileId: "m1", hubId: hubA.hubUuid, projectId: "p1" });

    expect(verifyMobileAuthorizationToken(token, hubB.publicKey)).toBeNull();
  });

  it("rejects an expired token even with a valid signature", () => {
    const hub = generateHubIdentity();
    const now = 1_000_000;
    const token = issueMobileAuthorizationToken(hub, { mobileId: "m1", hubId: hub.hubUuid, projectId: "p1" }, now);

    // TTL is 5 minutes — well past it, signature still verifies but exp check must fail closed.
    expect(verifyMobileAuthorizationToken(token, hub.publicKey, now + 10 * 60_000)).toBeNull();
  });

  it("rejects a tampered payload (payload/signature mismatch — not string equality)", () => {
    const hub = generateHubIdentity();
    const token = issueMobileAuthorizationToken(hub, { mobileId: "m1", hubId: hub.hubUuid, projectId: "p1" });
    const [payloadB64, signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ mobileId: "attacker", hubId: hub.hubUuid, projectId: "p1", iat: Date.now(), exp: Date.now() + 999_999 }),
      "utf8",
    ).toString("base64url");

    expect(verifyMobileAuthorizationToken(`${tamperedPayload}.${signature}`, hub.publicKey)).toBeNull();
    void payloadB64;
  });

  it("rejects a malformed token shape", () => {
    const hub = generateHubIdentity();
    expect(verifyMobileAuthorizationToken("not-a-real-token", hub.publicKey)).toBeNull();
    expect(verifyMobileAuthorizationToken("", hub.publicKey)).toBeNull();
  });
});

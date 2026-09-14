import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MobileAuthorizationRegistry,
  PairingChallengeStore,
  PairingCodeStore,
  verifyMobileSignature,
} from "./mobile-pairing.js";

function realMobileKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = (publicKey.export({ format: "jwk" }).x as string).replace(/-/g, "+").replace(/_/g, "/");
  const publicKeyBase64 = raw + "=".repeat((4 - (raw.length % 4)) % 4);
  const sign = (message: Buffer) => nodeSign(null, message, privateKey).toString("base64");
  return { publicKeyBase64, sign };
}

class MemorySecretStore {
  private map = new Map<string, string>();
  get(name: string): string | null {
    return this.map.get(name) ?? null;
  }
  set(name: string, value: string): void {
    this.map.set(name, value);
  }
}

describe("verifyMobileSignature — real Ed25519, not string equality", () => {
  it("accepts a real signature over the exact message", () => {
    const mobile = realMobileKeypair();
    const message = Buffer.from("hello");
    const sig = mobile.sign(message);
    expect(verifyMobileSignature(message, sig, mobile.publicKeyBase64)).toBe(true);
  });

  it("rejects a signature over a different message", () => {
    const mobile = realMobileKeypair();
    const sig = mobile.sign(Buffer.from("hello"));
    expect(verifyMobileSignature(Buffer.from("goodbye"), sig, mobile.publicKeyBase64)).toBe(false);
  });

  it("rejects a malformed public key without throwing", () => {
    expect(verifyMobileSignature(Buffer.from("x"), "AAAA", "not-a-real-key")).toBe(false);
  });
});

describe("PairingChallengeStore — single-use, replay-proof (§7)", () => {
  it("a challenge succeeds once and is rejected on a second attempt", () => {
    const store = new PairingChallengeStore();
    const c = store.issue({ mobilePublicKeyBase64: "pk", hubId: "h1", projectId: "p1" });
    expect(store.consume(c.challengeId)).toBeTruthy();
    expect(store.consume(c.challengeId)).toBeUndefined();
  });

  it("an expired challenge is rejected", () => {
    let now = 1000;
    const store = new PairingChallengeStore(() => now, 500);
    const c = store.issue({ mobilePublicKeyBase64: "pk", hubId: "h1", projectId: "p1" });
    now += 10_000;
    expect(store.consume(c.challengeId)).toBeUndefined();
  });

  it("an unknown challenge id is rejected", () => {
    const store = new PairingChallengeStore();
    expect(store.consume("nonexistent")).toBeUndefined();
  });
});

describe("PairingCodeStore — single-use, short-lived", () => {
  it("consumes a code once; a second use fails even before expiry", () => {
    const store = new PairingCodeStore();
    const code = store.generate("hub1", "proj1");
    expect(store.consume(code)).toEqual({ hubId: "hub1", projectId: "proj1", expiresAt: expect.any(Number) });
    expect(store.consume(code)).toBeUndefined();
  });

  it("an expired code is rejected", () => {
    let now = 0;
    const store = new PairingCodeStore(() => now, 1000);
    const code = store.generate("hub1", "proj1");
    now += 5000;
    expect(store.consume(code)).toBeUndefined();
  });
});

describe("MobileAuthorizationRegistry — authoritative, project/Hub-scoped (§4/§9/§10)", () => {
  it("isAuthorized is true only for the exact (mobileId, hubId, projectId) tuple", () => {
    const registry = new MobileAuthorizationRegistry(new MemorySecretStore());
    registry.upsert({
      mobileId: "m1",
      publicKeyBase64: "pk",
      hubId: "hubA",
      projectId: "projA",
      label: "iPhone",
      pairedAt: new Date().toISOString(),
      lastSeenAt: null,
      revoked: false,
      revokedAt: null,
    });

    expect(registry.isAuthorized("m1", "hubA", "projA")).toBe(true);
    expect(registry.isAuthorized("m1", "hubB", "projA")).toBe(false);
    expect(registry.isAuthorized("m1", "hubA", "projB")).toBe(false);
    expect(registry.isAuthorized("unknown", "hubA", "projA")).toBe(false);
  });

  it("revoke() is authoritative: a revoked Mobile is never authorized again", () => {
    const registry = new MobileAuthorizationRegistry(new MemorySecretStore());
    registry.upsert({
      mobileId: "m1",
      publicKeyBase64: "pk",
      hubId: "hubA",
      projectId: "projA",
      label: "iPhone",
      pairedAt: new Date().toISOString(),
      lastSeenAt: null,
      revoked: false,
      revokedAt: null,
    });
    expect(registry.isAuthorized("m1", "hubA", "projA")).toBe(true);

    expect(registry.revoke("m1", new Date().toISOString())).toBe(true);
    expect(registry.isAuthorized("m1", "hubA", "projA")).toBe(false);
    expect(registry.find("m1")?.revoked).toBe(true);
  });

  it("revoking one Mobile never revokes another (§26 multi-device)", () => {
    const registry = new MobileAuthorizationRegistry(new MemorySecretStore());
    for (const mobileId of ["m1", "m2"]) {
      registry.upsert({
        mobileId,
        publicKeyBase64: `pk-${mobileId}`,
        hubId: "hubA",
        projectId: "projA",
        label: "Device",
        pairedAt: new Date().toISOString(),
        lastSeenAt: null,
        revoked: false,
        revokedAt: null,
      });
    }
    registry.revoke("m1", new Date().toISOString());
    expect(registry.isAuthorized("m1", "hubA", "projA")).toBe(false);
    expect(registry.isAuthorized("m2", "hubA", "projA")).toBe(true);
  });

  it("persists across a fresh registry instance over the SAME store (survives restart)", () => {
    const store = new MemorySecretStore();
    const first = new MobileAuthorizationRegistry(store);
    first.upsert({
      mobileId: "m1",
      publicKeyBase64: "pk",
      hubId: "hubA",
      projectId: "projA",
      label: "iPhone",
      pairedAt: new Date().toISOString(),
      lastSeenAt: null,
      revoked: false,
      revokedAt: null,
    });

    const second = new MobileAuthorizationRegistry(store);
    expect(second.isAuthorized("m1", "hubA", "projA")).toBe(true);
  });

  it("revoke() on an unknown mobileId returns false, not a throw", () => {
    const registry = new MobileAuthorizationRegistry(new MemorySecretStore());
    expect(registry.revoke("nonexistent", new Date().toISOString())).toBe(false);
  });
});

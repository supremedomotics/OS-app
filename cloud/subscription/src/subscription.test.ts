import { generateSigningKeyPair } from "@supreme/crypto";
import { describe, expect, it } from "vitest";
import { SubscriptionService } from "./index.js";

function svc(now = () => 1_750_000_000_000) {
  const kp = generateSigningKeyPair();
  return new SubscriptionService({ signingPrivateKey: kp.privateKey, signingPublicKey: kp.publicKey, now });
}

describe("SubscriptionService — plans & entitlements", () => {
  it("derives entitlements from the plan", () => {
    const s = svc();
    s.subscribe("a1", "estate");
    expect(s.hasEntitlement("a1", "heavy_ai")).toBe(true);
    expect(s.hasEntitlement("a1", "fleet")).toBe(true);

    s.subscribe("a2", "free");
    expect(s.hasEntitlement("a2", "remote_access")).toBe(true); // free still gets remote access
    expect(s.hasEntitlement("a2", "heavy_ai")).toBe(false);
  });

  it("revokes entitlements on cancel", () => {
    const s = svc();
    s.subscribe("a1", "pro");
    expect(s.hasEntitlement("a1", "cloud_backup")).toBe(true);
    s.cancel("a1");
    expect(s.hasEntitlement("a1", "cloud_backup")).toBe(false);
  });

  it("an unknown account holds no entitlements", () => {
    expect(svc().hasEntitlement("nobody", "push")).toBe(false);
  });
});

describe("SubscriptionService — signed offline licenses", () => {
  it("issues a license the hub can verify offline", () => {
    const s = svc();
    s.subscribe("a1", "pro");
    const signed = s.issueLicense({ accountId: "a1", homeId: "h1", hubId: "hub1" });
    expect(signed.license.sku).toBe("pro");
    expect(s.verifyLicense(signed).valid).toBe(true);
  });

  it("rejects a tampered license", () => {
    const s = svc();
    s.subscribe("a1", "pro");
    const signed = s.issueLicense({ accountId: "a1", homeId: "h1", hubId: "hub1" });
    signed.license.sku = "estate"; // forge an upgrade
    expect(s.verifyLicense(signed).valid).toBe(false);
  });

  it("rejects an expired license", () => {
    const s = svc();
    s.subscribe("a1", "essential");
    const signed = s.issueLicense({ accountId: "a1", homeId: "h1", hubId: "hub1" });
    expect(s.verifyLicense(signed, signed.license.expiresAt + 1).valid).toBe(false);
  });

  it("defaults to a free license for an account with no subscription", () => {
    const s = svc();
    const signed = s.issueLicense({ accountId: "new", homeId: "h", hubId: "hub" });
    expect(signed.license.sku).toBe("free");
    expect(s.verifyLicense(signed).valid).toBe(true);
  });
});

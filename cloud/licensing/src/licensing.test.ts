import { generateSigningKeyPair } from "@supreme/crypto";
import { newId, type HomeId } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import { hasFeature, issueLicense, validateLicense } from "./index.js";

const homeId = newId("home") as HomeId;

describe("licensing", () => {
  it("issues and validates a license offline", () => {
    const { publicKey, privateKey } = generateSigningKeyPair();
    const license = issueLicense(
      { homeId, sku: "estate", seats: 25, features: ["energy", "cameras"] },
      privateKey,
    );
    const res = validateLicense(license, publicKey, { homeId });
    expect(res.valid).toBe(true);
    if (res.valid) expect(hasFeature(res.license, "energy")).toBe(true);
  });

  it("rejects a token for a different home", () => {
    const { publicKey, privateKey } = generateSigningKeyPair();
    const license = issueLicense({ homeId, sku: "pro", seats: 5 }, privateKey);
    const res = validateLicense(license, publicKey, { homeId: newId("home") as HomeId });
    expect(res).toEqual({ valid: false, reason: "wrong_home" });
  });

  it("rejects an expired token and a forged signature", () => {
    const { publicKey, privateKey } = generateSigningKeyPair();
    const expired = issueLicense(
      { homeId, sku: "pro", seats: 5, expiresAt: new Date(Date.now() - 1000).toISOString() },
      privateKey,
    );
    expect(validateLicense(expired, publicKey, { homeId })).toEqual({ valid: false, reason: "expired" });

    const other = generateSigningKeyPair();
    const good = issueLicense({ homeId, sku: "pro", seats: 5 }, privateKey);
    expect(validateLicense(good, other.publicKey, { homeId })).toEqual({ valid: false, reason: "bad_signature" });
  });
});

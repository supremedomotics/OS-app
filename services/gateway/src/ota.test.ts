import { generateSigningKeyPair, signPayload } from "@supreme/crypto";
import { describe, expect, it, vi } from "vitest";
import {
  OtaChecker,
  isNewerVersion,
  verifyReleaseManifest,
  type ReleaseManifest,
  type SignedReleaseManifest,
} from "./ota.js";

const manifest = (version: string): ReleaseManifest => ({
  channel: "stable",
  version,
  url: "https://cdn.supreme/releases/hub-" + version + ".img",
  sha256: "abc123",
  releasedAt: "2026-01-01T00:00:00.000Z",
});

function sign(m: ReleaseManifest, key: string): SignedReleaseManifest {
  return { manifest: m, signature: signPayload(m, key) };
}

describe("OTA", () => {
  const keys = generateSigningKeyPair();

  it("compares versions numerically", () => {
    expect(isNewerVersion("0.4.0", "0.3.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
    expect(isNewerVersion("0.3.0", "0.10.0")).toBe(false);
  });

  it("verifies a signed manifest and rejects a forged one", () => {
    const signed = sign(manifest("0.4.0"), keys.privateKey);
    expect(verifyReleaseManifest(signed, keys.publicKey)).toBe(true);
    // Tamper with the version → signature no longer matches.
    const forged = { ...signed, manifest: { ...signed.manifest, version: "9.9.9" } };
    expect(verifyReleaseManifest(forged, keys.publicKey)).toBe(false);
  });

  it("reports an available update from a signed channel manifest", async () => {
    const signed = sign(manifest("0.4.0"), keys.privateKey);
    const checker = new OtaChecker({
      url: "https://cloud/ota/stable.json",
      publicKeyPem: keys.publicKey,
      currentVersion: "0.3.0",
      fetchImpl: (async () => new Response(JSON.stringify(signed))) as unknown as typeof fetch,
    });
    const res = await checker.check();
    expect(res.updateAvailable).toBe(true);
    expect(res.latest?.version).toBe("0.4.0");
  });

  it("refuses a manifest whose signature is invalid", async () => {
    const other = generateSigningKeyPair();
    const signed = sign(manifest("0.4.0"), other.privateKey); // signed by the WRONG key
    const checker = new OtaChecker({
      url: "https://cloud/ota/stable.json",
      publicKeyPem: keys.publicKey,
      currentVersion: "0.3.0",
      fetchImpl: (async () => new Response(JSON.stringify(signed))) as unknown as typeof fetch,
    });
    await expect(checker.check()).rejects.toThrow(/signature invalid/);
  });
});

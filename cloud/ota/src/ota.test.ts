import { generateSigningKeyPair } from "@supreme/crypto";
import { describe, expect, it } from "vitest";
import { compareVersions, OtaService, rolloutBucket } from "./index.js";

function svc() {
  const kp = generateSigningKeyPair();
  return new OtaService({ signingPrivateKey: kp.privateKey, signingPublicKey: kp.publicKey, now: () => 1_750_000_000_000 });
}

describe("version comparison", () => {
  it("orders dotted numeric versions", () => {
    expect(compareVersions("0.4.0", "0.3.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.4.0", "0.4.1")).toBe(-1);
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1); // numeric, not lexical
  });
});

describe("OtaService — availability", () => {
  it("offers a signed, newer release to a hub in the rollout cohort", () => {
    const ota = svc();
    const rel = ota.publish({ version: "0.5.0", channel: "stable", url: "https://cdn/0.5.0", sha256: "abc" }, 100);
    expect(ota.verify(rel)).toBe(true);
    const offered = ota.availableFor("hub-1", "stable", "0.4.0");
    expect(offered?.manifest.version).toBe("0.5.0");
  });

  it("does not offer the same or an older version", () => {
    const ota = svc();
    ota.publish({ version: "0.5.0", channel: "stable", url: "u", sha256: "x" }, 100);
    expect(ota.availableFor("hub-1", "stable", "0.5.0")).toBeNull();
    expect(ota.availableFor("hub-1", "stable", "0.6.0")).toBeNull();
  });

  it("honours minVersion (skip-protection)", () => {
    const ota = svc();
    ota.publish({ version: "0.6.0", channel: "stable", url: "u", sha256: "x", minVersion: "0.5.0" }, 100);
    expect(ota.availableFor("hub-1", "stable", "0.4.0")).toBeNull(); // too old to jump
    expect(ota.availableFor("hub-1", "stable", "0.5.0")?.manifest.version).toBe("0.6.0");
  });

  it("isolates channels (a stable hub is not offered a beta build)", () => {
    const ota = svc();
    ota.publish({ version: "0.7.0", channel: "beta", url: "u", sha256: "x" }, 100);
    expect(ota.availableFor("hub-1", "stable", "0.4.0")).toBeNull();
    expect(ota.availableFor("hub-1", "beta", "0.4.0")?.manifest.version).toBe("0.7.0");
  });
});

describe("OtaService — deterministic staged rollout", () => {
  it("offers to nobody at 0% and everybody at 100%", () => {
    const ota = svc();
    ota.publish({ version: "0.5.0", channel: "stable", url: "u", sha256: "x" }, 0);
    const hubs = Array.from({ length: 200 }, (_, i) => `hub-${i}`);
    expect(hubs.filter((h) => ota.availableFor(h, "stable", "0.4.0")).length).toBe(0);
    ota.setRollout("stable", "0.5.0", 100);
    expect(hubs.filter((h) => ota.availableFor(h, "stable", "0.4.0")).length).toBe(200);
  });

  it("a partial rollout is stable and roughly proportional", () => {
    const ota = svc();
    ota.publish({ version: "0.5.0", channel: "stable", url: "u", sha256: "x" }, 25);
    const hubs = Array.from({ length: 1000 }, (_, i) => `hub-${i}`);
    const eligible = hubs.filter((h) => ota.availableFor(h, "stable", "0.4.0"));
    expect(eligible.length).toBeGreaterThan(150); // ~25% with tolerance
    expect(eligible.length).toBeLessThan(350);
    // Deterministic: the same hub keeps the same answer.
    const h = eligible[0]!;
    expect(ota.availableFor(h, "stable", "0.4.0")).not.toBeNull();
  });

  it("rolloutBucket is stable for the same inputs", () => {
    expect(rolloutBucket("hub-1", "0.5.0")).toBe(rolloutBucket("hub-1", "0.5.0"));
  });
});

import { describe, expect, it } from "vitest";
import { DeveloperProvider, StaticGrantProvider, makeGrant } from "./providers.js";
import { LicenseService, mergeGrants } from "./service.js";

const NOW = Date.UTC(2026, 5, 29, 12, 0, 0);
const at = () => NOW;

describe("Developer Mode", () => {
  it("unlocks every SKU + feature and flags the watermark", async () => {
    const svc = new LicenseService([new DeveloperProvider(() => true)], { now: at });
    await svc.refresh();
    expect(svc.devMode).toBe(true);
    expect(svc.hasSku("pro")).toBe(true);
    expect(svc.hasSku("anything-at-all")).toBe(true);
    expect(svc.hasFeature("ai")).toBe(true);
    expect(svc.canInstallDriver({ key: "supreme-knx", requiresSku: "pro" })).toEqual({ allowed: true });
    expect(svc.status().devMode).toBe(true);
    expect(svc.status().licenseType).toBe("developer");
  });

  it("is inactive when SUPREME_DEV_MODE is off → community, KNX blocked", async () => {
    const svc = new LicenseService([new DeveloperProvider(() => false)], { now: at });
    await svc.refresh();
    expect(svc.devMode).toBe(false);
    expect(svc.current().active).toBe(false);
    expect(svc.canInstallDriver({ key: "supreme-knx", requiresSku: "pro" })).toEqual({
      allowed: false,
      reason: "requires the 'pro' license",
    });
  });
});

describe("offline grant", () => {
  it("licenses exactly the granted SKUs + features", async () => {
    const grant = makeGrant({ source: "offline", licenseType: "professional", tier: "professional", skus: ["pro"], features: ["ai", "remote_access"] });
    const svc = new LicenseService([new StaticGrantProvider("offline", grant)], { now: at });
    await svc.refresh();
    expect(svc.hasSku("pro")).toBe(true);
    expect(svc.hasSku("oem")).toBe(false);
    expect(svc.hasFeature("ai")).toBe(true);
    expect(svc.hasFeature("dealer_portal")).toBe(false);
    expect(svc.meetsTier("home")).toBe(true);
    expect(svc.meetsTier("enterprise")).toBe(false);
    expect(svc.canInstallDriver({ key: "supreme-knx", requiresSku: "pro" }).allowed).toBe(true);
  });

  it("ignores an expired grant", async () => {
    const expired = makeGrant({ source: "offline", licenseType: "trial", tier: "home", skus: ["pro"], expiresAt: new Date(NOW - 1000).toISOString() });
    const svc = new LicenseService([new StaticGrantProvider("offline", expired)], { now: at });
    await svc.refresh();
    expect(svc.current().active).toBe(false);
    expect(svc.hasSku("pro")).toBe(false);
  });
});

describe("mergeGrants", () => {
  it("takes the union of SKUs/features, the highest tier, and the earliest expiry", () => {
    const merged = mergeGrants([
      makeGrant({ source: "offline", licenseType: "home", tier: "home", skus: ["pro"], features: ["ai"], expiresAt: new Date(NOW + 86_400_000).toISOString() }),
      makeGrant({ source: "cloud", licenseType: "professional", tier: "professional", skus: ["oem"], features: ["voice"], expiresAt: new Date(NOW + 10_000).toISOString() }),
    ]);
    expect(merged.skus).not.toBe("all");
    expect([...(merged.skus as Set<string>)].sort()).toEqual(["oem", "pro"]);
    expect(merged.tier).toBe("professional");
    expect(merged.expiresAt).toBe(new Date(NOW + 10_000).toISOString()); // earliest wins
  });

  it("developer 'all' dominates the merge", () => {
    const merged = mergeGrants([
      makeGrant({ source: "offline", licenseType: "home", tier: "home", skus: ["pro"] }),
      { source: "developer", licenseType: "developer", tier: "enterprise", skus: "all", features: "all", expiresAt: null, devMode: true },
    ]);
    expect(merged.skus).toBe("all");
    expect(merged.features).toBe("all");
    expect(merged.devMode).toBe(true);
    expect(merged.source).toBe("developer"); // highest precedence
  });
});

describe("licensedSkuSet (DriverManager bridge)", () => {
  it("expands 'all' to the known SKU list so the DriverManager Set check passes", async () => {
    const svc = new LicenseService([new DeveloperProvider(() => true)], { now: at });
    await svc.refresh();
    expect(svc.licensedSkuSet().has("pro")).toBe(true);
  });
});

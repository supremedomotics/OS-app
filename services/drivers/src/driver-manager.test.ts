import { generateSigningKeyPair } from "@supreme/crypto";
import { newId, type DriverId, type HomeId } from "@supreme/domain-model";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryCatalog, seedFirstPartyCatalog } from "./catalog.js";
import { DriverManager, isNewerSemver } from "./driver-manager.js";

const homeId = newId("home") as HomeId;

function manager(opts: { licensed?: string[] } = {}) {
  const { publicKey, privateKey } = generateSigningKeyPair();
  const catalog = new InMemoryCatalog(seedFirstPartyCatalog(privateKey, "supreme-store-1"));
  const trustedKeys = new Map([["supreme-store-1", publicKey]]);
  return new DriverManager({
    homeId,
    catalog,
    trustedKeys,
    licensedSkus: () => new Set(opts.licensed ?? []),
  });
}

describe("DriverManager", () => {
  it("browses the signed first-party catalog", async () => {
    const m = manager();
    const catalog = await m.browse();
    expect(catalog.map((e) => e.bundle.manifest.key)).toContain("supreme-knx");
    expect(catalog.map((e) => e.bundle.manifest.key)).toContain("supreme-matter");
  });

  it("lists the Universal AVR Framework extensions (AVR/HEOS/Yamaha) — they must appear in the Extension Center", async () => {
    const m = manager({ licensed: ["pro"] });
    const catalog = await m.browse();
    const keys = catalog.map((e) => e.bundle.manifest.key);
    expect(keys).toContain("supreme-avr");
    expect(keys).toContain("supreme-heos");
    expect(keys).toContain("supreme-yamaha");

    // Each has nothing REQUIRED to configure (per-device host/zone/pid is set later via
    // Bus Binding; the only config field is an optional trace-logging toggle) — install +
    // enable alone must be enough to bring the driver up.
    for (const key of ["supreme-avr", "supreme-heos", "supreme-yamaha"]) {
      const installed = await m.install(key);
      const reg = (await m.registry()).find((r) => r.key === key)!;
      expect(reg.configSchema.every((f) => f.required !== true)).toBe(true);
      expect(reg.installed).toBe(true);
      expect(reg.status).toBe("active"); // installed drivers are enabled by default
      await m.setConfig(installed.id, {});
      const after = (await m.registry()).find((r) => r.key === key)!;
      expect(after.enabled).toBe(true);
    }
  });

  it("exposes a unified registry with config schema, operations and installed state", async () => {
    const m = manager({ licensed: ["pro"] });
    let reg = await m.registry();
    // Every catalog driver appears (auto-discovery), with a config schema + operations.
    expect(reg.length).toBeGreaterThanOrEqual(10);
    const knx = reg.find((r) => r.key === "supreme-knx")!;
    expect(knx.installed).toBe(false);
    expect(knx.status).toBe("not_installed");
    expect(knx.operations).toContain("configure");
    expect(knx.operations).toContain("connect"); // protocol driver
    expect(knx.configSchema.find((f) => f.key === "host")).toBeTruthy();
    expect(knx.requiresSku).toBe("pro");
    // After install, the registry reflects the installed state.
    await m.install("supreme-knx");
    reg = await m.registry();
    const knx2 = reg.find((r) => r.key === "supreme-knx")!;
    expect(knx2.installed).toBe(true);
    expect(knx2.status).toBe("active");
    expect(knx2.installedId).toBeTruthy();
    // Marketplace metadata (§ Extension Center): authored fields surface; freshly installed at the
    // catalog version → no update pending.
    expect(knx2.installedVersion).toBe(knx2.version);
    expect(knx2.updateAvailable).toBe(false);
    expect(knx2.documentationUrl).toContain("http");
    expect(knx2.releaseNotes.length).toBeGreaterThan(0);
    expect(knx2.changelog.length).toBeGreaterThan(0);
  });

  it("flags updateAvailable via semver compare", () => {
    expect(isNewerSemver("1.2.0", "1.1.9")).toBe(true);
    expect(isNewerSemver("1.0.0", "1.0.0")).toBe(false);
    expect(isNewerSemver("1.0.0", "1.0.1")).toBe(false);
    expect(isNewerSemver("2.0.0", "1.9.9")).toBe(true);
  });

  it("installs a free driver and rejects an unlicensed paid driver", async () => {
    const m = manager({ licensed: [] });
    // Zigbee is free (requiresSku null).
    const zigbee = await m.install("supreme-zigbee");
    expect(zigbee.status).toBe("active");
    // KNX requires the 'pro' SKU.
    await expect(m.install("supreme-knx")).rejects.toThrow(/requires the 'pro' license/);
  });

  it("installs a paid driver once licensed", async () => {
    const m = manager({ licensed: ["pro"] });
    const knx = await m.install("supreme-knx");
    expect(knx.key).toBe("supreme-knx");
    expect(knx.enabled).toBe(true);
  });

  it("installs Matter disabled, then enables it on opt-in", async () => {
    const m = manager();
    const matter = await m.install("supreme-matter");
    expect(matter.enabled).toBe(false);
    expect(matter.status).toBe("disabled");
    const enabled = await m.setEnabled(matter.id, true);
    expect(enabled.enabled).toBe(true);
    expect(enabled.status).toBe("active");
  });

  it("rejects a bundle signed by an untrusted key", async () => {
    // Catalog signed with key A, but the manager only trusts key B.
    const a = generateSigningKeyPair();
    const b = generateSigningKeyPair();
    const catalog = new InMemoryCatalog(seedFirstPartyCatalog(a.privateKey, "rogue"));
    const m = new DriverManager({
      homeId,
      catalog,
      trustedKeys: new Map([["supreme-store-1", b.publicKey]]),
      licensedSkus: () => new Set(["pro"]),
    });
    await expect(m.install("supreme-zigbee")).rejects.toThrow(/unknown signing key/);
  });

  it("uninstalls an installed driver", async () => {
    const m = manager();
    const zigbee = await m.install("supreme-zigbee");
    await m.uninstall(zigbee.id);
    expect(await m.listInstalled()).toHaveLength(0);
    await expect(m.uninstall(newId("driver") as DriverId)).rejects.toThrow(/not installed/);
  });
});

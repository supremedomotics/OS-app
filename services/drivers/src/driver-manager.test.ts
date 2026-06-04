import { generateSigningKeyPair } from "@supreme/crypto";
import { newId, type DriverId, type HomeId } from "@supreme/domain-model";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryCatalog, seedFirstPartyCatalog } from "./catalog.js";
import { DriverManager } from "./driver-manager.js";

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

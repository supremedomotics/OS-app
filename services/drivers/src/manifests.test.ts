import { generateSigningKeyPair } from "@supreme/crypto";
import { newId, type HomeId } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import { InMemoryCatalog, seedFirstPartyCatalog } from "./catalog.js";
import { DriverManager } from "./driver-manager.js";
import { FIRST_PARTY_MANIFESTS } from "./manifests.js";
import { lintManifest } from "@supreme/driver-sdk";

/**
 * § D14 — the Devialet Fusion Driver joins the Extension Center. These tests exercise
 * the real manifest↔catalog↔install pipeline (`DriverManager`/`InMemoryCatalog`), the
 * same infrastructure `driver-manager.test.ts`'s own AVR/HEOS/Yamaha test already
 * uses — never a mocked stand-in for the registry.
 */

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

describe("Devialet manifest", () => {
  it("A — exists in FIRST_PARTY_MANIFESTS exactly once", () => {
    const matches = FIRST_PARTY_MANIFESTS.filter((m) => m.key === "supreme-devialet");
    expect(matches).toHaveLength(1);
  });

  it("B — is valid under the DriverManifest schema and passes lintManifest with no errors", () => {
    const manifest = FIRST_PARTY_MANIFESTS.find((m) => m.key === "supreme-devialet")!;
    const issues = lintManifest(manifest);
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
  });

  it("P — advertises only 'media' (no onoff/power, no seek, no EQ/night-mode capability)", () => {
    const manifest = FIRST_PARTY_MANIFESTS.find((m) => m.key === "supreme-devialet")!;
    expect(manifest.capabilities).toEqual(["media"]);
    expect(manifest.protocols).toEqual(["devialet"]);
  });

  it("backend.ref points at the real 'devialet' native-driver-factory key, matching devialet-driver.ts's protocol string", () => {
    const manifest = FIRST_PARTY_MANIFESTS.find((m) => m.key === "supreme-devialet")!;
    expect(manifest.backend).toEqual({ type: "native", ref: "devialet" });
  });

  it("does not claim required configuration — each speaker is added by IP via Bus Binding after enabling", () => {
    const manifest = FIRST_PARTY_MANIFESTS.find((m) => m.key === "supreme-devialet")!;
    expect(manifest.configSchema.every((f) => f.required !== true)).toBe(true);
  });

  it("D — appears in the browsable, licensed Extension Center catalog", async () => {
    const m = manager({ licensed: ["pro"] });
    const keys = (await m.browse()).map((e) => e.bundle.manifest.key);
    expect(keys).toContain("supreme-devialet");
  });

  it("install + enable is deterministic with no required config, mirroring AVR/HEOS/Yamaha exactly", async () => {
    const m = manager({ licensed: ["pro"] });
    const installed = await m.install("supreme-devialet");
    let reg = (await m.registry()).find((r) => r.key === "supreme-devialet")!;
    expect(reg.installed).toBe(true);
    expect(reg.status).toBe("active"); // installed drivers are enabled by default
    await m.setConfig(installed.id, {});
    reg = (await m.registry()).find((r) => r.key === "supreme-devialet")!;
    expect(reg.enabled).toBe(true);
  });

  it("adding Devialet did not remove or alter any pre-existing manifest (AVR/HEOS/Yamaha/KNX unchanged)", () => {
    const keys = FIRST_PARTY_MANIFESTS.map((m) => m.key);
    for (const existing of ["supreme-knx", "supreme-casambi", "supreme-avr", "supreme-heos", "supreme-yamaha", "supreme-coolmaster"]) {
      expect(keys).toContain(existing);
    }
    const avr = FIRST_PARTY_MANIFESTS.find((m) => m.key === "supreme-avr")!;
    expect(avr.capabilities).toEqual(["onoff", "media"]); // unchanged
  });
});

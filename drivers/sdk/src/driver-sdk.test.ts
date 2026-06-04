import { generateSigningKeyPair } from "@supreme/crypto";
import { describe, expect, it } from "vitest";
import { createBundle, defineManifest, lintManifest, signBundle, verifyBundle } from "./index.js";

const knx = {
  key: "supreme-knx",
  name: "Supreme KNX",
  category: "protocol",
  channel: "official",
  publisher: "Supreme Domotics",
  version: "1.0.0",
  capabilities: ["onoff", "brightness", "position"],
  protocols: ["knx"],
  compat: { hubMinVersion: "0.1.0", requiresSku: "pro" },
  backend: { type: "ha-integration", ref: "knx" },
};

describe("driver manifest", () => {
  it("validates and lints a clean official manifest", () => {
    const manifest = defineManifest(knx);
    expect(lintManifest(manifest)).toEqual([]);
  });

  it("flags an official driver from a non-Supreme publisher", () => {
    const manifest = defineManifest({ ...knx, publisher: "Acme" });
    expect(lintManifest(manifest).some((i) => i.level === "error")).toBe(true);
  });

  it("warns when a Matter driver does not ship disabled", () => {
    const manifest = defineManifest({
      ...knx,
      key: "supreme-matter",
      protocols: ["matter"],
      shipsDisabled: false,
    });
    expect(lintManifest(manifest).some((i) => i.message.includes("Matter"))).toBe(true);
  });
});

describe("bundle signing", () => {
  it("signs and verifies a bundle, and detects tampering + payload mismatch", () => {
    const { publicKey, privateKey } = generateSigningKeyPair();
    const manifest = defineManifest(knx);
    const bundle = createBundle({ manifest, payload: "adapter-code", bundleUrl: "local://knx" });
    const signed = signBundle(bundle, privateKey, "key-1");

    expect(verifyBundle(signed, publicKey, "adapter-code")).toBe(true);
    // Wrong payload → content-hash mismatch.
    expect(verifyBundle(signed, publicKey, "tampered-code")).toBe(false);
    // Tampered manifest → signature mismatch.
    const forged = { ...signed, bundle: { ...bundle, manifest: { ...manifest, version: "9.9.9" } } };
    expect(verifyBundle(forged, publicKey)).toBe(false);
  });
});

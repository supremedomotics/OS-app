import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSecretStore } from "./secrets.js";

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("SecretStore", () => {
  it("persists a generated secret to disk and reads it back", () => {
    dir = mkdtempSync(join(tmpdir(), "supreme-secrets-"));
    const store = createSecretStore(dir);
    expect(store.get("ha_token")).toBeNull();
    store.set("ha_token", "llt-generated-xyz");
    // A fresh store over the same dir sees it (survives a "restart").
    expect(createSecretStore(dir).get("ha_token")).toBe("llt-generated-xyz");
  });

  it("degrades to in-memory when no dir is configured", () => {
    const store = createSecretStore(undefined);
    store.set("ha_token", "ephemeral");
    expect(store.get("ha_token")).toBe("ephemeral");
  });

  it("rejects unsafe secret names (no path escapes)", () => {
    dir = mkdtempSync(join(tmpdir(), "supreme-secrets-"));
    const store = createSecretStore(dir);
    expect(() => store.set("../escape", "x")).toThrow(/invalid secret name/);
  });
});

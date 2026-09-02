import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertSecureConfig, DEV_TOKEN_SECRET, loadConfig } from "./config.js";

describe("config secrets + fail-closed", () => {
  it("reads a secret from a *_FILE path in preference to the env var", () => {
    const dir = mkdtempSync(join(tmpdir(), "supreme-secret-"));
    const file = join(dir, "token");
    writeFileSync(file, "  super-strong-secret-from-sealed-store-0123456789  \n");
    const config = loadConfig({
      SUPREME_TOKEN_SECRET: "ignored-env-value",
      SUPREME_TOKEN_SECRET_FILE: file,
    });
    expect(config.tokenSecret).toBe("super-strong-secret-from-sealed-store-0123456789");
  });

  it("falls back to the env var when no *_FILE is set", () => {
    expect(loadConfig({ SUPREME_TOKEN_SECRET: "x".repeat(40) }).tokenSecret).toBe("x".repeat(40));
    expect(loadConfig({}).tokenSecret).toBe(DEV_TOKEN_SECRET);
  });

  it("refuses to boot in production with the insecure default", () => {
    expect(() => assertSecureConfig(loadConfig({ NODE_ENV: "production" }))).toThrow(/refusing to boot/);
  });
});

describe("§ Native Backend Implementation — SUPREME_BACKEND resolution", () => {
  it("defaults to native when SUPREME_BACKEND is unset", () => {
    expect(loadConfig({}).backend).toBe("native");
  });

  it("honors an explicit mock opt-in", () => {
    expect(loadConfig({ SUPREME_BACKEND: "mock" }).backend).toBe("mock");
  });

  it("treats any unrecognized value as native, never as a silent mock fallback", () => {
    expect(loadConfig({ SUPREME_BACKEND: "bogus" }).backend).toBe("native");
  });

  it("refuses to boot in production with SUPREME_BACKEND=mock", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      SUPREME_BACKEND: "mock",
      SUPREME_TOKEN_SECRET: "x".repeat(40),
      SUPREME_CORS_ORIGINS: "https://example.test",
    });
    expect(() => assertSecureConfig(config)).toThrow(/SUPREME_BACKEND=mock is not permitted in production/);
  });

  it("boots in production with the native default (no HA required)", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      SUPREME_TOKEN_SECRET: "x".repeat(40),
      SUPREME_CORS_ORIGINS: "https://example.test",
    });
    expect(config.backend).toBe("native");
    expect(() => assertSecureConfig(config)).not.toThrow();
  });
});

describe("§ live-confirmed fix — Casambi API key falls back to the embedded default on an empty env var", () => {
  it("an explicit, non-empty SUPREME_CASAMBI_API_KEY always overrides the embedded default", () => {
    expect(loadConfig({ SUPREME_CASAMBI_API_KEY: "explicit-deployment-key" }).casambiApiKey).toBe("explicit-deployment-key");
  });

  it("SUPREME_CASAMBI_API_KEY='' (gateway.env's rendered, never-typed-in placeholder) falls back to the embedded default, not to an empty string", () => {
    // gateway.env ALWAYS sets this var (rendered from the template's own placeholder), so an
    // installer who never typed a key gets an empty STRING, not an absent env var — `??` alone
    // would wrongly treat that as "explicitly set to empty" and skip the embedded default. This
    // only proves the fallback triggers, not what it resolves to (that depends on whether a real
    // key is embedded — see casambi-embedded-key.test.ts for that).
    expect(loadConfig({ SUPREME_CASAMBI_API_KEY: "" }).casambiApiKey).toBe(loadConfig({}).casambiApiKey);
  });
});

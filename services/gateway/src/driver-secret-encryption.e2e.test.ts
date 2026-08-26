import type { License } from "@supreme/contracts";
import { createDriverSecretCrypto, InMemoryInstalledDriverStore, type IInstalledDriverStore } from "@supreme/drivers";
import { generateEncryptionKey } from "@supreme/crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * § Production Readiness Audit — Critical Blocker H3 ("driver/integration secrets stored as
 * plaintext JSON at rest"). Proves the encryption-at-rest wiring end-to-end through the real
 * HTTP API + `InstallerServices`/`DriverManager` stack, not just the isolated unit tests in
 * `services/drivers/src/secret-store.test.ts`: a real secret submitted through the driver config
 * route must (a) come back masked over the API, exactly as before, and (b) be genuinely
 * unreadable ciphertext in the underlying store — not just masked on the way out while sitting in
 * the DB as plaintext.
 */
describe("Driver config secret encryption-at-rest (§ Production Readiness Audit H3)", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  let driverStore: IInstalledDriverStore;
  // One key for the whole file, matching production: `resolveDriverSecretEncryptionKey`
  // persists this exact same key across a real restart via the secrets manager — a test that
  // regenerated a fresh key per boot would misrepresent that and break decryption of anything
  // already-encrypted under the previous "boot"'s key.
  const secretKey = generateEncryptionKey();

  beforeAll(async () => {
    driverStore = new InMemoryInstalledDriverStore();
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), {
      driverStore,
      driverSecretCrypto: createDriverSecretCrypto(secretKey),
    });
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const login = (await (
      await fetch(`${baseUrl}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
      })
    ).json()) as { accessToken: string };
    token = login.accessToken;

    const issued = (await (
      await fetch(`${baseUrl}/v1/license/dev-issue`, { method: "POST", headers: auth(), body: JSON.stringify({ sku: "pro", seats: 10 }) })
    ).json()) as { token: License };
    await fetch(`${baseUrl}/v1/license/activate`, { method: "POST", headers: auth(), body: JSON.stringify({ token: issued.token }) });
  });
  afterAll(async () => {
    await app.close();
  });

  function auth() {
    return { "content-type": "application/json", authorization: `Bearer ${token}` };
  }

  it("masks a secret over the API but stores real ciphertext at rest, and the driver stack can still use the real value", async () => {
    const install = (await (
      await fetch(`${baseUrl}/v1/drivers/install`, { method: "POST", headers: auth(), body: JSON.stringify({ key: "supreme-casambi" }) })
    ).json()) as { driver: { id: string } };
    const installedId = install.driver.id;

    // Deliberately fake, structurally-similar test fixtures — never a real credential.
    const REAL_API_KEY = "test-fixture-api-key-not-a-real-secret-0000000000000000000000";
    const REAL_PASSWORD = "test-fixture-password-not-real";
    const putResp = await fetch(`${baseUrl}/v1/drivers/${installedId}/config`, {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({
        config: { connectionType: "cloud", apiKey: REAL_API_KEY, email: "installer@example.com", password: REAL_PASSWORD },
      }),
    });
    expect(putResp.ok).toBe(true);
    const putBody = (await putResp.json()) as { config: Record<string, unknown> };
    // Masked on the way out over the API — unchanged behavior from before this feature existed.
    expect(putBody.config.apiKey).toBe("••••••••");
    expect(putBody.config.password).toBe("••••••••");

    // The RAW store — the exact instance handed to AppContext.create — must hold real ciphertext,
    // never the plaintext secret, never the masked placeholder either.
    const raw = await driverStore.get(installedId as never);
    expect(raw!.config.apiKey).not.toBe(REAL_API_KEY);
    expect(raw!.config.apiKey).not.toBe("••••••••");
    expect(String(raw!.config.apiKey)).toMatch(/^enc:v1:/);
    expect(raw!.config.password).not.toBe(REAL_PASSWORD);
    expect(String(raw!.config.password)).toMatch(/^enc:v1:/);

    // But the runtime driver stack (DriverManager, via InstallerServices) still sees the real
    // plaintext value — encryption is purely an at-rest transformation, transparent above it.
    const runtimeConfig = await ctx.installer.drivers.getConfig(installedId as never);
    expect(runtimeConfig.apiKey).toBe(REAL_API_KEY);
    expect(runtimeConfig.password).toBe(REAL_PASSWORD);
  });

  it("migrates a legacy plaintext secret to ciphertext on the next real boot", async () => {
    // Simulate a driver that was configured BEFORE this encryption layer existed: write a real
    // plaintext secret directly into the raw store, bypassing the encrypting DriverManager path.
    const install = (await (
      await fetch(`${baseUrl}/v1/drivers/install`, { method: "POST", headers: auth(), body: JSON.stringify({ key: "supreme-lutron" }) })
    ).json()) as { driver: { id: string } };
    const legacyId = install.driver.id;
    const before = await driverStore.get(legacyId as never);
    await driverStore.put({ ...before!, config: { ...before!.config, password: "legacy-plaintext-password" } });
    expect((await driverStore.get(legacyId as never))!.config.password).toBe("legacy-plaintext-password");

    // A genuine second boot against the SAME store — the exact scenario this migration exists
    // for (a hub upgraded to a version with this encryption layer, restarted once).
    const rebootCtx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), {
      driverStore,
      driverSecretCrypto: createDriverSecretCrypto(secretKey),
    });

    const after = await driverStore.get(legacyId as never);
    expect(String(after!.config.password)).toMatch(/^enc:v1:/);
    expect(after!.config.password).not.toBe("legacy-plaintext-password");

    // And it's still usable at runtime after migration, through the new boot's own context.
    const runtimeConfig = await rebootCtx.installer.drivers.getConfig(legacyId as never);
    expect(runtimeConfig.password).toBe("legacy-plaintext-password");
  });
});

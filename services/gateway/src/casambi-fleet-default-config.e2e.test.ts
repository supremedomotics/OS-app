import type { License } from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * § Casambi fleet-wide env-var default — proves the deployment-wide
 * SUPREME_CASAMBI_API_KEY/EMAIL/PASSWORD default reaches the actual config-save/health path an
 * installer hits through the Driver Manager UI, not just `native-driver-factory.ts`'s runtime
 * construction (covered separately in `native-driver-factory.test.ts`). Before this test existed,
 * `resolveCasambiCloudCredentials()` only helped once a driver was already running — saving a
 * Cloud-mode Casambi driver with blank apiKey/email/password still failed validation
 * ("API key is required...") even with the fleet default configured, and `isConfigComplete()`
 * still reported it as not configured, so `reconcileManifestDrivers()` would never even start it.
 * This test exercises the real HTTP save + health endpoints with a fleet default configured, to
 * prove an installer genuinely never has to type these fields when one is set.
 */
describe("Casambi fleet-wide env-var default (§ config save + health, not just runtime construction)", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let token = "";

  beforeAll(async () => {
    const ctx = await AppContext.create(
      loadConfig({
        SUPREME_LOG_LEVEL: "silent",
        SUPREME_CASAMBI_API_KEY: "fixture-fleet-api-key-not-a-real-secret",
        SUPREME_CASAMBI_EMAIL: "fleet@example.com",
        SUPREME_CASAMBI_PASSWORD: "fixture-fleet-password-not-real",
      }),
    );
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

  it("saves a Cloud-mode config with apiKey/email/password left blank when a fleet default is configured", async () => {
    const install = (await (
      await fetch(`${baseUrl}/v1/drivers/install`, { method: "POST", headers: auth(), body: JSON.stringify({ key: "supreme-casambi" }) })
    ).json()) as { driver: { id: string } };
    const id = install.driver.id;

    const saveResp = await fetch(`${baseUrl}/v1/drivers/${id}/config`, {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ config: { connectionType: "cloud" } }),
    });
    expect(saveResp.status).toBe(200);

    const health = (await (await fetch(`${baseUrl}/v1/drivers/${id}/health`, { headers: auth() })).json()) as {
      configComplete: boolean;
      missing: string[];
      verdict: string;
    };
    expect(health.configComplete).toBe(true);
    expect(health.missing).toEqual([]);
    expect(health.verdict).not.toBe("not_configured");
  });

  it("never persists the fleet default's real values into the driver's own stored config", async () => {
    const install = (await (
      await fetch(`${baseUrl}/v1/drivers/install`, { method: "POST", headers: auth(), body: JSON.stringify({ key: "supreme-casambi" }) })
    ).json()) as { driver: { id: string } };
    const id = install.driver.id;
    await fetch(`${baseUrl}/v1/drivers/${id}/config`, {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ config: { connectionType: "cloud" } }),
    });

    const stored = (await (await fetch(`${baseUrl}/v1/drivers/${id}/config`, { headers: auth() })).json()) as {
      config: Record<string, unknown>;
    };
    expect(stored.config.apiKey).toBeUndefined();
    expect(stored.config.email).toBeUndefined();
    expect(stored.config.password).toBeUndefined();
  });

  it("still rejects a Cloud-mode save with blank credentials when no fleet default is configured", async () => {
    const bareCtx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }));
    const bareApp = await buildServer(bareCtx);
    await bareApp.listen({ host: "127.0.0.1", port: 0 });
    try {
      const addr = bareApp.server.address();
      const bareUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      const login = (await (
        await fetch(`${bareUrl}/v1/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
        })
      ).json()) as { accessToken: string };
      const bareAuth = { "content-type": "application/json", authorization: `Bearer ${login.accessToken}` };
      const issued = (await (
        await fetch(`${bareUrl}/v1/license/dev-issue`, { method: "POST", headers: bareAuth, body: JSON.stringify({ sku: "pro", seats: 10 }) })
      ).json()) as { token: License };
      await fetch(`${bareUrl}/v1/license/activate`, { method: "POST", headers: bareAuth, body: JSON.stringify({ token: issued.token }) });

      const install = (await (
        await fetch(`${bareUrl}/v1/drivers/install`, { method: "POST", headers: bareAuth, body: JSON.stringify({ key: "supreme-casambi" }) })
      ).json()) as { driver: { id: string } };
      const saveResp = await fetch(`${bareUrl}/v1/drivers/${install.driver.id}/config`, {
        method: "PUT",
        headers: bareAuth,
        body: JSON.stringify({ config: { connectionType: "cloud" } }),
      });
      expect(saveResp.status).toBe(422);
    } finally {
      await bareApp.close();
    }
  });
});

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Licensing Service end-to-end (§9, ADR): Developer Mode unlocks every SKU so a "pro" driver like
 * KNX installs, while a normal (community) hub blocks it with a clear reason. Drivers contain no
 * licensing logic — the Licensing Service decides.
 */
async function boot(env: Record<string, string>) {
  const ctx = await AppContext.create(loadConfig({ SUPREME_PORT: "0", SUPREME_LOG_LEVEL: "silent", ...env }));
  const app = await buildServer(ctx);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  const baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  const login = (await (
    await fetch(`${baseUrl}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }) })
  ).json()) as { accessToken: string };
  return { app, ctx, baseUrl, auth: { authorization: `Bearer ${login.accessToken}`, "content-type": "application/json" } };
}

describe("Developer Mode unlocks every SKU", () => {
  let h: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => {
    h = await boot({ SUPREME_DEV_MODE: "true" });
  });
  afterAll(async () => {
    await h.app.close();
    await h.ctx.shutdown();
  });

  it("reports Developer Mode + a developer license", async () => {
    const status = (await (await fetch(`${h.baseUrl}/v1/license`, { headers: h.auth })).json()) as { service: { devMode: boolean; licenseType: string; skus: string[] | "all" } };
    expect(status.service.devMode).toBe(true);
    expect(status.service.licenseType).toBe("developer");
  });

  it("installs the KNX (pro) driver", async () => {
    const res = await fetch(`${h.baseUrl}/v1/drivers/install`, { method: "POST", headers: h.auth, body: JSON.stringify({ key: "supreme-knx" }) });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { driver: { key: string } }).driver.key).toBe("supreme-knx");
  });

  it("exposes the driver registry + a schema-validated config page", async () => {
    // Registry lists every driver with its config schema (auto-discovery).
    const reg = (await (await fetch(`${h.baseUrl}/v1/drivers/registry`, { headers: h.auth })).json()) as { drivers: { key: string; installedId: string | null; configSchema: { key: string }[] }[] };
    const knx = reg.drivers.find((d) => d.key === "supreme-knx")!;
    expect(knx.configSchema.some((f) => f.key === "host")).toBe(true);
    expect(knx.installedId).toBeTruthy(); // installed by the earlier test

    // Configure it (schema-validated), then read it back.
    const put = await fetch(`${h.baseUrl}/v1/drivers/${knx.installedId}/config`, { method: "PUT", headers: h.auth, body: JSON.stringify({ config: { host: "192.168.1.50", port: 3671 } }) });
    expect(put.status).toBe(200);
    const cfg = (await (await fetch(`${h.baseUrl}/v1/drivers/${knx.installedId}/config`, { headers: h.auth })).json()) as { config: Record<string, unknown>; schema: unknown[] };
    expect(cfg.config.host).toBe("192.168.1.50");
    expect(cfg.config.port).toBe(3671);
    expect(Array.isArray(cfg.schema)).toBe(true);

    // Invalid config (bad port) is rejected.
    const bad = await fetch(`${h.baseUrl}/v1/drivers/${knx.installedId}/config`, { method: "PUT", headers: h.auth, body: JSON.stringify({ config: { host: "x", port: 999999 } }) });
    expect(bad.status).toBe(422);
  });

  it("reports per-driver health, logs, and connect/disconnect", async () => {
    const reg = (await (await fetch(`${h.baseUrl}/v1/drivers/registry`, { headers: h.auth })).json()) as { drivers: { key: string; installedId: string | null }[] };
    const id = reg.drivers.find((d) => d.key === "supreme-knx")!.installedId!;

    const health = (await (await fetch(`${h.baseUrl}/v1/drivers/${id}/health`, { headers: h.auth })).json()) as { verdict: string; configComplete: boolean; enabled: boolean };
    expect(health.enabled).toBe(true);
    expect(["healthy", "not_configured", "error", "disabled"]).toContain(health.verdict);
    expect(typeof health.configComplete).toBe("boolean");

    // Connect (no native KNX gateway in the test → connected:false, logged).
    const conn = (await (await fetch(`${h.baseUrl}/v1/drivers/${id}/connect`, { method: "POST", headers: h.auth })).json()) as { connected: boolean };
    expect(typeof conn.connected).toBe("boolean");

    const logs = (await (await fetch(`${h.baseUrl}/v1/drivers/${id}/logs`, { headers: h.auth })).json()) as { entries: { message: string }[] };
    expect(logs.entries.length).toBeGreaterThan(0); // config update + connect were logged
  });

  it("seeds the default developer account (supreme / supreme@72) as a master", async () => {
    const login = (await (
      await fetch(`${h.baseUrl}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "supreme", password: "supreme@72" }) })
    ).json()) as { status: string; accessToken?: string };
    expect(login.status).toBe("ok");
    const me = (await (await fetch(`${h.baseUrl}/v1/me`, { headers: { authorization: `Bearer ${login.accessToken}` } })).json()) as { user: { userType: string } };
    expect(me.user.userType).toBe("master");
  });
});

describe("Community hub blocks a pro driver", () => {
  let h: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => {
    h = await boot({ SUPREME_DEV_MODE: "false" });
  });
  afterAll(async () => {
    await h.app.close();
    await h.ctx.shutdown();
  });

  it("refuses the KNX (pro) driver with a clear reason", async () => {
    const res = await fetch(`${h.baseUrl}/v1/drivers/install`, { method: "POST", headers: h.auth, body: JSON.stringify({ key: "supreme-knx" }) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toMatch(/pro/);
    const status = (await (await fetch(`${h.baseUrl}/v1/license`, { headers: h.auth })).json()) as { service: { devMode: boolean } };
    expect(status.service.devMode).toBe(false);
  });

  it("unlocks KNX via an ACTIVATED signed license (no Developer Mode)", async () => {
    // Issue a signed Pro license offline, then activate it — the production licensing path.
    const issue = await fetch(`${h.baseUrl}/v1/license/dev-issue`, { method: "POST", headers: h.auth, body: JSON.stringify({ sku: "pro", features: ["ai"] }) });
    expect(issue.status).toBe(201);
    const { token } = (await issue.json()) as { token: unknown };
    const activate = await fetch(`${h.baseUrl}/v1/license/activate`, { method: "POST", headers: h.auth, body: JSON.stringify({ token }) });
    expect(activate.status).toBe(200);
    const status = (await activate.json()) as { licensed: boolean; service: { devMode: boolean; skus: string[] | "all" } };
    expect(status.licensed).toBe(true);
    expect(status.service.devMode).toBe(false); // licensed, NOT via dev mode
    expect(status.service.skus).toContain("pro");
    // KNX now installs with a real license.
    const install = await fetch(`${h.baseUrl}/v1/drivers/install`, { method: "POST", headers: h.auth, body: JSON.stringify({ key: "supreme-knx" }) });
    expect(install.status).toBe(201);
  });

  it("can flip Developer Mode on at runtime, then KNX installs", async () => {
    const toggle = await fetch(`${h.baseUrl}/v1/license/dev-mode`, { method: "POST", headers: h.auth, body: JSON.stringify({ enabled: true }) });
    expect(toggle.status).toBe(200);
    expect(((await toggle.json()) as { service: { devMode: boolean } }).service.devMode).toBe(true);
    const install = await fetch(`${h.baseUrl}/v1/drivers/install`, { method: "POST", headers: h.auth, body: JSON.stringify({ key: "supreme-knx" }) });
    expect(install.status).toBe(201);
  });
});

describe("Developer Mode can be LOCKED for customer/OEM builds", () => {
  let h: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => {
    // A normal hub runs NODE_ENV=production; that alone must NOT block the toggle. Only the explicit
    // lock flag does.
    h = await boot({ NODE_ENV: "production", SUPREME_DEV_MODE_LOCKED: "true" });
  });
  afterAll(async () => {
    await h.app.close();
    await h.ctx.shutdown();
  });

  it("refuses the runtime toggle when the lock flag is set", async () => {
    const res = await fetch(`${h.baseUrl}/v1/license/dev-mode`, { method: "POST", headers: h.auth, body: JSON.stringify({ enabled: true }) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toMatch(/locked/i);
  });
});

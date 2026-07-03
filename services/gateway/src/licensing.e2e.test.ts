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

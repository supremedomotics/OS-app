import type { CatalogList, DiagnosticsReport, HomeView, License } from "@supreme/contracts";
import { buildStores, migrate, PgliteDb } from "@supreme/persistence";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

describe("Phase-2 installer & drivers", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;

  beforeAll(async () => {
    ctx = await AppContext.create(loadConfig({ SUPREME_PORT: "0", SUPREME_LOG_LEVEL: "silent" }));
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });

  let token = "";
  async function login() {
    const res = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    const body = (await res.json()) as { status: string; accessToken?: string };
    token = body.accessToken!;
  }
  function auth() {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }
  beforeAll(login);

  it("browses the signed first-party catalog (KNX, Matter, …)", async () => {
    const res = await fetch(`${baseUrl}/v1/drivers/catalog`, { headers: auth() });
    const body = (await res.json()) as CatalogList;
    const keys = body.catalog.map((c) => c.manifest.key);
    expect(keys).toContain("supreme-knx");
    expect(keys).toContain("supreme-matter");
  });

  it("gates a paid driver on licensing, then installs after activation", async () => {
    // Free driver installs immediately.
    const zig = await fetch(`${baseUrl}/v1/drivers/install`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ key: "supreme-zigbee" }),
    });
    expect(zig.status).toBe(201);

    // KNX requires 'pro' — denied without a license.
    const knxDenied = await fetch(`${baseUrl}/v1/drivers/install`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ key: "supreme-knx" }),
    });
    expect(knxDenied.status).toBe(403);

    // Issue + activate an estate license (dev issuer), then KNX installs.
    const issued = (await (
      await fetch(`${baseUrl}/v1/license/dev-issue`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ sku: "estate", seats: 10 }),
      })
    ).json()) as { token: License };
    const activated = await fetch(`${baseUrl}/v1/license/activate`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ token: issued.token }),
    });
    expect(activated.status).toBe(200);

    const knxOk = await fetch(`${baseUrl}/v1/drivers/install`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ key: "supreme-knx" }),
    });
    expect(knxOk.status).toBe(201);
  });

  it("installs Matter disabled and enables it on opt-in", async () => {
    const installed = (await (
      await fetch(`${baseUrl}/v1/drivers/install`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ key: "supreme-matter" }),
      })
    ).json()) as { driver: { id: string; enabled: boolean } };
    expect(installed.driver.enabled).toBe(false);

    const enabled = (await (
      await fetch(`${baseUrl}/v1/drivers/${installed.driver.id}/enabled`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ enabled: true }),
      })
    ).json()) as { driver: { enabled: boolean } };
    expect(enabled.driver.enabled).toBe(true);
  });

  it("commissions a discovered device into a controllable Supreme device", async () => {
    const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as HomeView;
    const roomId = home.rooms[0]!.id;
    const res = await fetch(`${baseUrl}/v1/commissioning/commission`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        backendId: "light.new_fixture",
        name: "New Fixture",
        roomId,
        capabilities: ["onoff", "brightness"],
      }),
    });
    expect(res.status).toBe(201);
    const { device } = (await res.json()) as { device: { id: string } };

    const cmd = await fetch(`${baseUrl}/v1/devices/${device.id}/command`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ command: { capability: "brightness", action: "set", level: 55 } }),
    });
    expect(cmd.status).toBe(200);
  });

  it("reports diagnostics and a project export", async () => {
    const diag = (await (await fetch(`${baseUrl}/v1/diagnostics`, { headers: auth() })).json()) as DiagnosticsReport;
    expect(diag.backend.kind).toBe("mock");
    expect(diag.counts.devices).toBeGreaterThan(0);
    expect(diag.drivers.some((d) => d.key === "supreme-matter")).toBe(true);

    const proj = (await (await fetch(`${baseUrl}/v1/project/export`, { headers: auth() })).json()) as {
      home: { name: string };
      devices: unknown[];
    };
    expect(proj.home.name).toBe("Supreme Residence");
    expect(proj.devices.length).toBeGreaterThan(0);
  });

  it("requires persistence for backup", async () => {
    const res = await fetch(`${baseUrl}/v1/backup`, { method: "POST", headers: auth() });
    expect(res.status).toBe(409); // no DATABASE_URL in this context
  });
});

describe("Phase-2 backup/restore over persistence", () => {
  it("creates a signed backup and restores it through the API", async () => {
    const db = await PgliteDb.create();
    await migrate(db);
    const s = buildStores(db);
    const config = loadConfig({ SUPREME_LOG_LEVEL: "silent" });
    const ctx = await AppContext.create(config, {
      identityStore: s.identity,
      homeStore: s.home,
      sceneStore: s.scenes,
      grantStore: s.grants,
      notificationStore: s.notifications,
      driverStore: s.drivers,
      db,
    });
    const app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const url = `http://127.0.0.1:${port}`;

    const login = (await (
      await fetch(`${url}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
      })
    ).json()) as { accessToken: string };
    const headers = { authorization: `Bearer ${login.accessToken}`, "content-type": "application/json" };

    const backup = (await (await fetch(`${url}/v1/backup`, { method: "POST", headers })).json()) as {
      meta: { rowCount: number };
      document: string;
    };
    expect(backup.meta.rowCount).toBeGreaterThan(0);

    const restore = await fetch(`${url}/v1/backup/restore`, {
      method: "POST",
      headers,
      body: JSON.stringify({ document: backup.document }),
    });
    expect(restore.status).toBe(200);
    const result = (await restore.json()) as { rows: number };
    expect(result.rows).toBeGreaterThan(0);

    await app.close();
    await ctx.shutdown();
    await db.close();
  });
});

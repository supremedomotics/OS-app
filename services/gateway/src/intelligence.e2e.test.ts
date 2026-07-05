import type { HomeView } from "@supreme/contracts";
import { buildStores, migrate, PgliteDb } from "@supreme/persistence";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Supreme Intelligence Engine REST surface + live runner snapshot (ADR 0013), over a Postgres-backed
 * gateway: configuring zones / device ownership / Auto Pilot, reading the presence map + dashboard,
 * and the local history store.
 */
describe("Supreme Intelligence Engine routes", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let db: PgliteDb;
  let baseUrl: string;
  let token = "";

  beforeAll(async () => {
    db = await PgliteDb.create();
    await migrate(db);
    const s = buildStores(db);
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), {
      identityStore: s.identity,
      homeStore: s.home,
      sceneStore: s.scenes,
      grantStore: s.grants,
      notificationStore: s.notifications,
      driverStore: s.drivers,
      automationStore: s.automations,
      db,
    });
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    const login = (await (
      await fetch(`${baseUrl}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }) })
    ).json()) as { accessToken: string };
    token = login.accessToken;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
    await db.close();
  });

  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
  const get = async (path: string) => await (await fetch(`${baseUrl}${path}`, { headers: auth() })).json();

  it("configures zones, device ownership and Auto Pilot, and reads them back", async () => {
    const home = (await get("/v1/home")) as HomeView;
    const roomId = home.rooms[0]!.id;
    const devs = (await (await fetch(`${baseUrl}/v1/rooms/${roomId}/devices`, { headers: auth() })).json()) as { devices: { id: string }[] };
    const deviceId = devs.devices[0]!.id;

    const zonesRes = await fetch(`${baseUrl}/v1/intelligence/zones`, { method: "PUT", headers: auth(), body: JSON.stringify({ zones: [{ id: "z_ground", name: "Ground Floor", roomIds: [roomId] }] }) });
    expect(zonesRes.status).toBe(200);
    expect(((await get("/v1/intelligence/zones")) as { zones: { id: string }[] }).zones[0]!.id).toBe("z_ground");

    const intelRes = await fetch(`${baseUrl}/v1/intelligence/device-intel`, { method: "PUT", headers: auth(), body: JSON.stringify({ devices: { [deviceId]: { ownerUserId: "usr_owner", priority: "high", estimatedWatts: 75 } } }) });
    expect(intelRes.status).toBe(200);
    expect(((await get("/v1/intelligence/device-intel")) as { devices: Record<string, { estimatedWatts: number }> }).devices[deviceId]!.estimatedWatts).toBe(75);

    const setRes = await fetch(`${baseUrl}/v1/intelligence/settings`, { method: "PUT", headers: auth(), body: JSON.stringify({ mode: "auto_pilot", threshold: 0.7 }) });
    expect(setRes.status).toBe(200);
    expect(((await get("/v1/intelligence/settings")) as { settings: { mode: string } }).settings.mode).toBe("auto_pilot");
  });

  it("rejects an invalid Auto Pilot mode and invalid device intel", async () => {
    const badMode = await fetch(`${baseUrl}/v1/intelligence/settings`, { method: "PUT", headers: auth(), body: JSON.stringify({ mode: "telepathy" }) });
    expect(badMode.status).toBe(422);
    const badIntel = await fetch(`${baseUrl}/v1/intelligence/device-intel`, { method: "PUT", headers: auth(), body: JSON.stringify({ devices: { dev_x: { priority: "urgent" } } }) });
    expect(badIntel.status).toBe(422);
  });

  it("exposes the live presence map + dashboard after a runner tick", async () => {
    await ctx.sie.tick();
    const presence = (await get("/v1/intelligence/presence")) as { presence: unknown[]; house: { occupied: boolean } | null };
    expect(Array.isArray(presence.presence)).toBe(true);
    expect(presence.house).not.toBeNull();
    expect(presence.house!.occupied).toBe(false); // nobody connected in the test

    const dashboard = (await get("/v1/intelligence/dashboard")) as { today: { kwhSaved: number }; month: unknown; pendingSuggestions: number; occupancy: unknown };
    expect(dashboard.today).toHaveProperty("kwhSaved");
    expect(dashboard.occupancy).not.toBeNull();

    const history = (await get("/v1/intelligence/history")) as { history: unknown[] };
    expect(Array.isArray(history.history)).toBe(true);

    const report = (await get("/v1/intelligence/reports?period=month")) as { report: { period: string; co2SavedKg: number; approvalRate: number } };
    expect(report.report.period).toBe("month");
    expect(report.report).toHaveProperty("co2SavedKg");
    const csv = await (await fetch(`${baseUrl}/v1/intelligence/reports.csv?period=year`, { headers: auth() })).text();
    expect(csv).toContain("metric,value");
  });

  it("requires authentication", async () => {
    const res = await fetch(`${baseUrl}/v1/intelligence/presence`);
    expect(res.status).toBe(401);
  });
});

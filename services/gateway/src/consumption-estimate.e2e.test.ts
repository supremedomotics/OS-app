import type { HomeView } from "@supreme/contracts";
import { buildStores, migrate, PgliteDb } from "@supreme/persistence";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Estimated consumption for non-metered devices (§16): the owner gives a device its rated
 * wattage, the hub accrues energy while it is ON, and that estimate flows into the SAME
 * per-device cost breakdown as real meter data — proving per-device costing works even for
 * devices that report no power.
 */
describe("consumption estimator → per-device cost", () => {
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
      await fetch(`${baseUrl}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
      })
    ).json()) as { accessToken: string };
    token = login.accessToken;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
    await db.close();
  });

  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
  async function devices() {
    const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as HomeView;
    const out: { id: string; supremeType: string; roomId: string | null }[] = [];
    for (const r of home.rooms) {
      const d = (await (await fetch(`${baseUrl}/v1/rooms/${r.id}/devices`, { headers: auth() })).json()) as {
        devices: { id: string; supremeType: string; roomId: string | null }[];
      };
      out.push(...d.devices);
    }
    return out;
  }

  it("estimates energy for a non-metered light and surfaces its cost in the breakdown", async () => {
    const light = (await devices()).find((d) => d.supremeType === "light")!;
    expect(light).toBeTruthy();

    // Owner sets the electricity provider (rate) and the light's rated wattage.
    await fetch(`${baseUrl}/v1/energy/provider`, {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ country: "US", city: "Austin", provider: "Austin Energy", ratePerKwh: 0.2, currency: "USD" }),
    });
    const wattsRes = await fetch(`${baseUrl}/v1/energy/device-watts`, {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ watts: { [light.id]: 100 } }),
    });
    expect(((await wattsRes.json()) as { watts: Record<string, number> }).watts[light.id]).toBe(100);

    // Turn the light on, then drive an hour of minute-ticks → one flush of estimated energy.
    await fetch(`${baseUrl}/v1/devices/${light.id}/command`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ command: { capability: "onoff", action: "on" } }),
    });
    for (let i = 0; i < 60; i++) await ctx.consumptionEstimator.tick();
    await new Promise((r) => setTimeout(r, 100)); // let the analytics write settle

    // 100W for 60 min = 0.1 kWh → 0.1 × $0.20 = $0.02 attributed to this device.
    const breakdown = (await (
      await fetch(`${baseUrl}/v1/energy/breakdown?groupBy=device`, { headers: auth() })
    ).json()) as { currency: string; groups: { key: string; kwh: number; cost: number }[] };
    const row = breakdown.groups.find((g) => g.key === light.id);
    expect(breakdown.currency).toBe("USD");
    expect(row).toBeTruthy();
    expect(row!.kwh).toBeCloseTo(0.1, 3);
    expect(row!.cost).toBeCloseTo(0.02, 3);
  });
});

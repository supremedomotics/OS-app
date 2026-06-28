import { buildStores, migrate, PgliteDb } from "@supreme/persistence";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Tariff-aware energy cost end-to-end: seed home-wide hourly energy, then POST /v1/energy/cost with
 * a time-of-use tariff and assert the bill (per-period breakdown + standing charge) plus the budget
 * projection. Exercises the analytics aggregation + the pure cost engine through the gateway.
 */
describe("Energy cost (tariff) route", () => {
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
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

    const login = (await (
      await fetch(`${baseUrl}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }) })
    ).json()) as { accessToken: string };
    token = login.accessToken;

    // Seed hourly energy: 2 kWh off-peak (10:00) + 3 kWh peak (18:00) on a Monday.
    await ctx.analytics!.record({ homeId: ctx.homeId, deviceId: "dev-1", roomId: null, measure: "energy", value: 2, unit: "kWh", ts: "2026-01-05T10:00:00Z" });
    await ctx.analytics!.record({ homeId: ctx.homeId, deviceId: "dev-1", roomId: null, measure: "energy", value: 3, unit: "kWh", ts: "2026-01-05T18:00:00Z" });
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
    await db.close();
  });

  const tariff = {
    currency: "USD",
    standingChargePerDay: 0.5,
    periods: [
      { name: "peak", ratePerKwh: 0.4, hours: [16, 17, 18, 19, 20] },
      { name: "off-peak", ratePerKwh: 0.15, hours: [...Array(24).keys()].filter((h) => h < 16 || h > 20) },
    ],
  };

  it("computes the bill under a time-of-use tariff + a budget projection", async () => {
    const res = await fetch(`${baseUrl}/v1/energy/cost`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tariff, budget: { monthlyBudget: 30, spentSoFar: 2, dayOfMonth: 5, daysInMonth: 31 } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cost: { energyCost: number; standingCharge: number; totalCost: number; byPeriod: { name: string; cost: number }[] }; budget: { projectedMonthEnd: number; overBudget: boolean } };
    // 2*0.15 + 3*0.40 = 1.50 energy; + 0.50 standing (one day) = 2.00 total.
    expect(body.cost.energyCost).toBe(1.5);
    expect(body.cost.standingCharge).toBe(0.5);
    expect(body.cost.totalCost).toBe(2.0);
    expect(body.cost.byPeriod.find((p) => p.name === "peak")?.cost).toBe(1.2);
    expect(body.budget.projectedMonthEnd).toBe(12.4); // 2/5*31
    expect(body.budget.overBudget).toBe(false);
  });

  it("rejects a tariff that doesn't cover an hour with 422", async () => {
    const res = await fetch(`${baseUrl}/v1/energy/cost`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tariff: { currency: "USD", periods: [{ name: "morning", ratePerKwh: 0.2, hours: [9, 10] }] } }),
    });
    expect(res.status).toBe(422);
  });

  it("requires a tariff", async () => {
    const res = await fetch(`${baseUrl}/v1/energy/cost`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });
});

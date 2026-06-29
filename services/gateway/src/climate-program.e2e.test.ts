import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Climate program end-to-end: store a program, then drive the runner and assert the home's
 * thermostats receive the scheduled setpoint. Validation enforced on write.
 */
describe("Climate program routes + runner", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";

  beforeAll(async () => {
    ctx = await AppContext.create(loadConfig({ SUPREME_PORT: "0", SUPREME_LOG_LEVEL: "silent" }));
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const login = (await (
      await fetch(`${baseUrl}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }) })
    ).json()) as { accessToken: string };
    token = login.accessToken;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });
  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  const program = {
    weekday: [{ atMinutes: 0, targetC: 19 }, { atMinutes: 6 * 60, targetC: 21 }],
    weekend: [{ atMinutes: 0, targetC: 20 }],
  };

  it("stores a program and rejects a malformed one (422)", async () => {
    const bad = await fetch(`${baseUrl}/v1/climate/program`, { method: "PUT", headers: auth(), body: JSON.stringify({ program: { weekday: [{ atMinutes: 0, targetC: 99 }], weekend: [] } }) });
    expect(bad.status).toBe(422);

    const ok = await fetch(`${baseUrl}/v1/climate/program`, { method: "PUT", headers: auth(), body: JSON.stringify({ program }) });
    expect(ok.status).toBe(200);
    const got = await (await fetch(`${baseUrl}/v1/climate/program`, { headers: auth() })).json();
    expect(got.program.weekday).toHaveLength(2);
  });

  it("the runner applies the scheduled setpoint to thermostats", async () => {
    // Find a climate (temperature-capable) device in the demo home.
    const all = await ctx.home.listDevices();
    const thermostat = all.find((d) => d.capabilities.some((c) => c.kind === "temperature"))!;
    expect(thermostat).toBeTruthy();

    const { ClimateProgramRunner } = await import("./climate-runner.js");
    const runner = new ClimateProgramRunner({
      getProgram: async () => (await ctx.homeConfig.get(ctx.homeId, "climate_program")) as never,
      applySetpoint: async (t) => {
        for (const d of await ctx.home.listDevices()) {
          if (d.capabilities.some((c) => c.kind === "temperature")) await ctx.sil.command(d.id, { capability: "temperature", targetC: t });
        }
      },
      now: () => new Date(2026, 0, 5, 7, 0, 0), // Monday 07:00 → 21°C block
    });
    await runner.tick();

    const dev = await ctx.home.getDevice(thermostat.id);
    const temp = dev?.state?.temperature as { targetC?: number } | undefined;
    expect(temp?.targetC).toBe(21);
  });
});

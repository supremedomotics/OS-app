import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Peak-aware load shifting end-to-end: nominate a deferrable load, store a tariff, then drive the
 * runner at peak (device paused) and off-peak (device resumed). Preview decision via the route.
 */
describe("Load shifting routes + runner", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  let deviceId = "";

  const tariff = {
    currency: "USD",
    periods: [
      { name: "peak", ratePerKwh: 0.45, hours: [16, 17, 18, 19, 20] },
      { name: "off-peak", ratePerKwh: 0.12, hours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 21, 22, 23] },
    ],
  };

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
    const devices = (await (await fetch(`${baseUrl}/v1/devices`, { headers: auth() })).json()) as { devices: { id: string; capabilities: { kind: string }[] }[] };
    deviceId = devices.devices.find((d) => d.capabilities.some((c) => c.kind === "onoff"))!.id;
    await fetch(`${baseUrl}/v1/energy/tariff`, { method: "PUT", headers: auth(), body: JSON.stringify({ tariff }) });
    await fetch(`${baseUrl}/v1/energy/deferrable-loads`, { method: "PUT", headers: auth(), body: JSON.stringify({ deviceIds: [deviceId] }) });
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });
  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  it("validates the deferrable-loads payload (422)", async () => {
    const res = await fetch(`${baseUrl}/v1/energy/deferrable-loads`, { method: "PUT", headers: auth(), body: JSON.stringify({ deviceIds: "nope" }) });
    expect(res.status).toBe(422);
  });

  it("pauses a deferrable load at peak and resumes it off-peak", async () => {
    // First make sure the device is on.
    await fetch(`${baseUrl}/v1/devices/${deviceId}/command`, { method: "POST", headers: auth(), body: JSON.stringify({ command: { capability: "onoff", action: "on" } }) });
    await new Promise((r) => setTimeout(r, 20));

    const { LoadShiftRunner } = await import("./load-shift-runner.js");
    let clock = new Date(2026, 0, 5, 18, 0, 0); // Monday peak
    const runner = new LoadShiftRunner({
      getTariff: async () => (await ctx.homeConfig.get(ctx.homeId, "tariff")) as never,
      getDeferrableDeviceIds: async () => ((await ctx.homeConfig.get(ctx.homeId, "deferrable_loads")) as string[]) ?? [],
      getCeiling: async () => undefined,
      setDeviceOn: (id, on) => ctx.sil.command(id as never, { capability: "onoff", action: on ? "on" : "off" }),
      now: () => clock,
    });
    await runner.tick(); // peak → paused (off)
    let dev = await ctx.home.getDevice(deviceId as never);
    expect((dev?.state?.onoff as { on?: boolean })?.on).toBe(false);

    clock = new Date(2026, 0, 5, 22, 0, 0); // off-peak
    await runner.tick(); // resume → on
    dev = await ctx.home.getDevice(deviceId as never);
    expect((dev?.state?.onoff as { on?: boolean })?.on).toBe(true);
  });

  it("previews the current load-shift decision", async () => {
    const res = await fetch(`${baseUrl}/v1/energy/load-shift`, { headers: auth() });
    const body = (await res.json()) as { decision: { peakRate: number } | null };
    expect(body.decision?.peakRate).toBe(0.45);
  });
});

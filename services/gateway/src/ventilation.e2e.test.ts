import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Adaptive ventilation end-to-end: store a config, then drive the runner with a stale air-quality
 * reading and confirm the fan (a real onoff device) is switched on.
 */
describe("Ventilation routes + runner", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  let fanId = "";

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
    fanId = devices.devices.find((d) => d.capabilities.some((c) => c.kind === "onoff"))!.id;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });
  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  it("stores config and rejects bad hysteresis (422)", async () => {
    const bad = await fetch(`${baseUrl}/v1/ventilation/config`, { method: "PUT", headers: auth(), body: JSON.stringify({ config: { sensorDeviceId: "co2", fanDeviceId: fanId, highThreshold: 700, lowThreshold: 1000 } }) });
    expect(bad.status).toBe(422);

    const ok = await fetch(`${baseUrl}/v1/ventilation/config`, { method: "PUT", headers: auth(), body: JSON.stringify({ config: { sensorDeviceId: "co2", fanDeviceId: fanId, highThreshold: 1000, lowThreshold: 700 } }) });
    expect(ok.status).toBe(200);
    const got = await (await fetch(`${baseUrl}/v1/ventilation/config`, { headers: auth() })).json();
    expect(got.config.fanDeviceId).toBe(fanId);
  });

  it("the runner switches the fan on when the air is stale", async () => {
    // Make sure the fan starts off.
    await fetch(`${baseUrl}/v1/devices/${fanId}/command`, { method: "POST", headers: auth(), body: JSON.stringify({ command: { capability: "onoff", action: "off" } }) });
    await new Promise((r) => setTimeout(r, 20));

    const { VentilationRunner } = await import("./ventilation-runner.js");
    let reading = 1300; // stale
    const runner = new VentilationRunner({
      getConfig: async () => (await ctx.homeConfig.get(ctx.homeId, "ventilation")) as never,
      readSensor: async () => reading,
      setFan: (id, on) => ctx.sil.command(id as never, { capability: "onoff", action: on ? "on" : "off" }),
    });
    await runner.tick(); // stale → fan on
    let dev = await ctx.home.getDevice(fanId as never);
    expect((dev?.state?.onoff as { on?: boolean })?.on).toBe(true);

    reading = 600; // clear
    await runner.tick(); // → fan off
    dev = await ctx.home.getDevice(fanId as never);
    expect((dev?.state?.onoff as { on?: boolean })?.on).toBe(false);
  });
});

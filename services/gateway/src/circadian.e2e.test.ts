import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Circadian lighting end-to-end: preview the current target and apply it to the demo home's
 * tunable-white lights, asserting they actually receive a color command through the SIL.
 */
describe("Circadian lighting routes", () => {
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

  it("previews a circadian target with a sane color temperature + brightness", async () => {
    const res = await fetch(`${baseUrl}/v1/lighting/circadian`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { target: { kelvin: number; brightness: number } };
    expect(body.target.kelvin).toBeGreaterThanOrEqual(1000);
    expect(body.target.kelvin).toBeLessThanOrEqual(10000);
    expect(body.target.brightness).toBeGreaterThanOrEqual(0);
    expect(body.target.brightness).toBeLessThanOrEqual(100);
  });

  it("applies the circadian target to the home's tunable-white lights", async () => {
    const res = await fetch(`${baseUrl}/v1/lighting/circadian/apply`, { method: "POST", headers: auth(), body: JSON.stringify({}) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: string[]; target: { kelvin: number } };
    expect(body.applied.length).toBeGreaterThan(0); // the demo home has color lights

    // The applied lights now report the circadian kelvin.
    const device = await ctx.home.getDevice(body.applied[0]! as never);
    const color = device?.state?.color as { kelvin?: number } | undefined;
    expect(color?.kelvin).toBe(body.target.kelvin);
  });
});

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/** Solar route: sunrise/sunset/solar-noon for a location + date, with input validation. */
describe("Solar route", () => {
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
  const auth = () => ({ authorization: `Bearer ${token}` });

  it("returns ordered sun times for a location + date", async () => {
    const res = await fetch(`${baseUrl}/v1/solar?lat=40.7&lon=-74&date=2026-06-21`, { headers: auth() });
    expect(res.status).toBe(200);
    const t = (await res.json()) as { sunrise: string; sunset: string; solarNoon: string; daylightMinutes: number };
    expect(new Date(t.sunrise).getTime()).toBeLessThan(new Date(t.solarNoon).getTime());
    expect(new Date(t.solarNoon).getTime()).toBeLessThan(new Date(t.sunset).getTime());
    expect(t.daylightMinutes).toBeGreaterThan(720); // NYC midsummer day > 12h
  });

  it("rejects missing/invalid coordinates with 422", async () => {
    expect((await fetch(`${baseUrl}/v1/solar?lat=999&lon=0`, { headers: auth() })).status).toBe(422);
    expect((await fetch(`${baseUrl}/v1/solar`, { headers: auth() })).status).toBe(422);
  });
});

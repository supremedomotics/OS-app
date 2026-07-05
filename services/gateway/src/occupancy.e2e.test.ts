import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/** Occupancy (vacation) simulation routes: enable builds + runs a plan; status + disable. */
describe("Occupancy simulation routes", () => {
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

  it("is off initially", async () => {
    const res = await fetch(`${baseUrl}/v1/security/occupancy`, { headers: auth() });
    expect((await res.json()).running).toBe(false);
  });

  it("enables a deterministic plan from the home's lights, then disables", async () => {
    const en = await fetch(`${baseUrl}/v1/security/occupancy/enable`, { method: "POST", headers: auth(), body: JSON.stringify({ seed: 123 }) });
    expect(en.status).toBe(200);
    const body = (await en.json()) as { running: boolean; plan: { atMinutes: number; action: string }[] };
    expect(body.running).toBe(true);
    expect(body.plan.length).toBeGreaterThan(0);
    // Plan stays inside the default 18:00–23:00 window.
    expect(body.plan.every((e) => e.atMinutes >= 18 * 60 && e.atMinutes <= 23 * 60)).toBe(true);

    const status = await fetch(`${baseUrl}/v1/security/occupancy`, { headers: auth() });
    expect((await status.json()).running).toBe(true);

    const dis = await fetch(`${baseUrl}/v1/security/occupancy/disable`, { method: "POST", headers: auth(), body: JSON.stringify({}) });
    expect((await dis.json()).running).toBe(false);
  });
});

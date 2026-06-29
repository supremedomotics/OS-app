import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Duration-based alert rules end-to-end: store a "left on > 10 min" rule, leave a light on, drive
 * the alert runner past the duration, and confirm a home alert notification is raised.
 */
describe("Alert rules routes + runner", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  let lightId = "";

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
    lightId = devices.devices.find((d) => d.capabilities.some((c) => c.kind === "onoff"))!.id;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });
  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  it("validates rules on write (422)", async () => {
    const bad = await fetch(`${baseUrl}/v1/alerts/rules`, { method: "PUT", headers: auth(), body: JSON.stringify({ rules: [{ deviceId: lightId, type: "nope", durationMinutes: 10 }] }) });
    expect(bad.status).toBe(422);
  });

  it("raises a notification when a light is left on past the duration", async () => {
    // Store the rule and turn the light on.
    const put = await fetch(`${baseUrl}/v1/alerts/rules`, { method: "PUT", headers: auth(), body: JSON.stringify({ rules: [{ deviceId: lightId, type: "left_on", durationMinutes: 10 }] }) });
    expect(put.status).toBe(200);
    await fetch(`${baseUrl}/v1/devices/${lightId}/command`, { method: "POST", headers: auth(), body: JSON.stringify({ command: { capability: "onoff", action: "on" } }) });
    await new Promise((r) => setTimeout(r, 30)); // let state settle

    // Drive a runner wired to this context with an injected clock past the 10-minute threshold.
    const { AlertRuleRunner } = await import("./alert-runner.js");
    let clock = 0;
    const runner = new AlertRuleRunner({
      getRules: async () => ((await ctx.homeConfig.get(ctx.homeId, "alert_rules")) as never[]) ?? [],
      getDevice: async (id) => {
        const d = await ctx.home.getDevice(id as never);
        return d ? { name: d.name, state: d.state as Record<string, unknown> } : null;
      },
      notify: (m) => ctx.notifications.create({ homeId: ctx.homeId, level: "warning", title: "Home alert", body: m }).then(() => undefined),
      now: () => clock,
    });
    await runner.tick(); // start episode
    clock = 10 * 60_000;
    await runner.tick(); // fire

    const notifications = (await (await fetch(`${baseUrl}/v1/notifications`, { headers: auth() })).json()) as { notifications: { body: string; title: string }[] };
    expect(notifications.notifications.some((n) => n.title === "Home alert" && /left on/.test(n.body))).toBe(true);
  });
});

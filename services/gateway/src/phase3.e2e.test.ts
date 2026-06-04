import type { AutomationResponse, HomeView } from "@supreme/contracts";
import { buildStores, migrate, PgliteDb } from "@supreme/persistence";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Phase-3 (Intelligence & Scale): automations driving devices, energy analytics,
 * tamper-evident audit, and the AI assistant — over a Postgres-backed gateway.
 */
describe("Phase-3 intelligence & scale", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let db: PgliteDb;
  let baseUrl: string;
  let wsBase: string;
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
    wsBase = `ws://127.0.0.1:${port}`;

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

  it("runs an automation: a sensor delta drives a light, observed over WSS", async () => {
    const devs = await devices();
    const dimmer = devs.find((d) => d.supremeType === "dimmer")!;

    // Automation: when the dimmer turns on, set the kitchen light on.
    const kitchen = devs.find((d) => d.supremeType === "light")!;
    const created = (await (
      await fetch(`${baseUrl}/v1/automations`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({
          name: "Kitchen follows dimmer",
          triggers: [{ type: "device_state", deviceId: dimmer.id, capability: "brightness", field: "on", op: "eq", value: true }],
          actions: [{ type: "device_command", deviceId: kitchen.id, command: { capability: "onoff", action: "on" } }],
        }),
      })
    ).json()) as AutomationResponse;
    expect(created.automation.engine).toBe("supreme");

    // Subscribe, then turn the dimmer on → engine should turn the kitchen light on.
    const ws = new WebSocket(`${wsBase}/v1/stream?access_token=${token}`);
    await new Promise((r) => ws.once("open", r));
    const kitchenOn = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("kitchen light never turned on")), 4000);
      ws.on("message", (raw: Buffer) => {
        const f = JSON.parse(raw.toString());
        if (f.type === "state" && f.deviceId === kitchen.id && f.state?.on === true) {
          clearTimeout(t);
          resolve();
        }
      });
    });
    ws.send(JSON.stringify({ type: "subscribe", rooms: ["*"] }));
    await fetch(`${baseUrl}/v1/devices/${dimmer.id}/command`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ command: { capability: "brightness", action: "on" } }),
    });
    await kitchenOn;
    ws.close();
  });

  it("aggregates energy after climate telemetry flows in", async () => {
    const devs = await devices();
    const thermostat = devs.find((d) => d.supremeType === "thermostat")!;
    // A temperature command produces a temperature state delta → analytics ingests it.
    await fetch(`${baseUrl}/v1/devices/${thermostat.id}/command`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ command: { capability: "temperature", targetC: 22 } }),
    });
    await new Promise((r) => setTimeout(r, 100));
    const summary = (await (
      await fetch(`${baseUrl}/v1/energy/summary`, { headers: auth() })
    ).json()) as { summary: { measure: string }[] };
    expect(summary.summary.some((s) => s.measure === "temperature")).toBe(true);
  });

  it("records a tamper-evident audit trail that verifies", async () => {
    // Commands above were audited; verify the chain.
    const verify = (await (await fetch(`${baseUrl}/v1/audit/verify`, { headers: auth() })).json()) as { ok: boolean };
    expect(verify.ok).toBe(true);
    const list = (await (await fetch(`${baseUrl}/v1/audit`, { headers: auth() })).json()) as {
      entries: { action: string }[];
    };
    expect(list.entries.some((e) => e.action === "device.command")).toBe(true);
  });

  it("AI assistant turns natural language into a draft", async () => {
    const res = await fetch(`${baseUrl}/v1/ai/assistant`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ utterance: "turn off all the lights" }),
    });
    const body = (await res.json()) as { result: { kind: string; commands?: unknown[] } };
    expect(body.result.kind).toBe("actions");
    expect((body.result.commands ?? []).length).toBeGreaterThan(0);
  });
});

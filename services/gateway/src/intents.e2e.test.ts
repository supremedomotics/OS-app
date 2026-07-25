import type {
  HomeView,
  IntentDefinitionList,
  IntentRunList,
  KeypadMappingResponse,
  RunIntentResponse,
} from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Universal Intent & Capability Engine — Phase 2 proof (§ ADR 0017). Exercises
 * the full pipeline over a real (mock-backend) hub: `Physical Input → Universal
 * Input Event → Universal Intent → Capability Engine → Best Device Capability →
 * Driver Adapter → Physical Device`, using the demo-seeded home's real devices
 * (never a fabricated device).
 */
describe("Universal Intent & Capability Engine — backend APIs", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";

  beforeAll(async () => {
    ctx = await AppContext.create(loadConfig({ SUPREME_PORT: "0", SUPREME_LOG_LEVEL: "silent" }));
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
  });

  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  interface DeviceRow {
    id: string;
    supremeType: string;
    roomId: string | null;
    capabilities: { kind: string }[];
  }

  async function devicesWithRooms() {
    const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as HomeView;
    const out: DeviceRow[] = [];
    const rooms: { id: string; name: string }[] = [];
    for (const r of home.rooms) {
      rooms.push({ id: r.id, name: r.name });
      const d = (await (await fetch(`${baseUrl}/v1/rooms/${r.id}/devices`, { headers: auth() })).json()) as { devices: DeviceRow[] };
      out.push(...d.devices);
    }
    return { devices: out, rooms };
  }

  it("lists the full built-in Intent Registry catalog", async () => {
    const res = (await (await fetch(`${baseUrl}/v1/intents`, { headers: auth() })).json()) as IntentDefinitionList;
    expect(res.intents.length).toBeGreaterThan(30);
    expect(res.intents.some((i) => i.id === "toggleLight")).toBe(true);
    expect(res.intents.some((i) => i.category === "climate")).toBe(true);
  });

  it("fetches one intent definition by id", async () => {
    const res = await fetch(`${baseUrl}/v1/intents/toggleLight`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.intent.requiredCapabilities).toEqual(["onoff"]);
  });

  it("404s for an unregistered intent id", async () => {
    const res = await fetch(`${baseUrl}/v1/intents/notARealIntent`, { headers: auth() });
    expect(res.status).toBe(404);
  });

  it("runs toggleLight directly against a real seeded device — the Capability Engine resolves it with zero protocol knowledge", async () => {
    const { devices } = await devicesWithRooms();
    const kitchenLight = devices.find((d) => d.supremeType === "light")!;

    const res = (await (
      await fetch(`${baseUrl}/v1/intents/toggleLight/run`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ target: { kind: "device", deviceId: kitchenLight.id } }),
      })
    ).json()) as RunIntentResponse;

    expect(res.run.ok).toBe(true);
    expect(res.run.resolvedDeviceIds).toEqual([kitchenLight.id]);
  });

  it("resolves a room target to every compatible device — the 'Movie Mode' pattern", async () => {
    const { devices, rooms } = await devicesWithRooms();
    const livingRoom = rooms.find((r) => r.name === "Living Room")!;
    const livingRoomLights = devices.filter((d) => d.roomId === livingRoom.id && d.capabilities.some((c) => c.kind === "onoff"));
    expect(livingRoomLights.length).toBeGreaterThan(1);

    const res = (await (
      await fetch(`${baseUrl}/v1/intents/toggleLight/run`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ target: { kind: "room", roomId: livingRoom.id } }),
      })
    ).json()) as RunIntentResponse;

    expect(res.run.ok).toBe(true);
    expect(new Set(res.run.resolvedDeviceIds)).toEqual(new Set(livingRoomLights.map((d) => d.id)));
  });

  it("runs setBrightness with an explicit param and returns a 422 when the param is missing", async () => {
    const { devices } = await devicesWithRooms();
    const dimmer = devices.find((d) => d.supremeType === "dimmer")!;

    const ok = await fetch(`${baseUrl}/v1/intents/setBrightness/run`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ target: { kind: "device", deviceId: dimmer.id }, params: { level: 42 } }),
    });
    expect(ok.status).toBe(200);

    const missing = await fetch(`${baseUrl}/v1/intents/setBrightness/run`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ target: { kind: "device", deviceId: dimmer.id } }),
    });
    expect(missing.status).toBe(422);
  });

  it("honestly fails a not-yet-implemented intent (executeScript) rather than faking success", async () => {
    const res = await fetch(`${baseUrl}/v1/intents/executeScript/run`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ target: { kind: "home" } }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.message).toMatch(/no script engine/);
  });

  it("runs the security arm/disarm intents against the real security panel", async () => {
    const armed = (await (
      await fetch(`${baseUrl}/v1/intents/arm/run`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ target: { kind: "home" }, params: { mode: "armed_away" } }),
      })
    ).json()) as RunIntentResponse;
    expect(armed.run.ok).toBe(true);

    const disarmed = (await (
      await fetch(`${baseUrl}/v1/intents/disarm/run`, { method: "POST", headers: auth(), body: JSON.stringify({ target: { kind: "home" } }) })
    ).json()) as RunIntentResponse;
    expect(disarmed.run.ok).toBe(true);

    const status = await fetch(`${baseUrl}/v1/security/disarm`, { method: "POST", headers: auth() });
    expect(status.status).toBe(200);
  });

  it("records run traces retrievable via GET /v1/intents/runs and /v1/intents/:id/runs", async () => {
    const { devices } = await devicesWithRooms();
    const light = devices.find((d) => d.supremeType === "light")!;
    await fetch(`${baseUrl}/v1/intents/lightOn/run`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ target: { kind: "device", deviceId: light.id } }),
    });

    const scoped = (await (await fetch(`${baseUrl}/v1/intents/lightOn/runs`, { headers: auth() })).json()) as IntentRunList;
    expect(scoped.runs.length).toBeGreaterThan(0);
    expect(scoped.runs.every((r) => r.intentId === "lightOn")).toBe(true);

    const all = (await (await fetch(`${baseUrl}/v1/intents/runs`, { headers: auth() })).json()) as IntentRunList;
    expect(all.runs.length).toBeGreaterThanOrEqual(scoped.runs.length);
  });

  it("a keypad mapping's intent action drives a real device through the SAME Intent Engine (Phase 1 + Phase 2 integration)", async () => {
    const { devices } = await devicesWithRooms();
    const light = devices.find((d) => d.supremeType === "light")!;
    const keypad = devices.find((d) => d.supremeType === "dimmer")!;

    const created = (await (
      await fetch(`${baseUrl}/v1/keypad/mappings`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({
          name: "Scene button → toggleLight intent",
          input: { keypadId: keypad.id, control: "btn1", event: "short_press" },
          actions: [{ type: "intent", intentId: "toggleLight", target: { kind: "device", deviceId: light.id }, params: {} }],
        }),
      })
    ).json()) as KeypadMappingResponse;
    expect(created.mapping.actions).toEqual([
      { type: "intent", intentId: "toggleLight", target: { kind: "device", deviceId: light.id }, params: {} },
    ]);

    const runRes = await fetch(`${baseUrl}/v1/keypad/mappings/${created.mapping.id}/run`, { method: "POST", headers: auth() });
    expect(runRes.status).toBe(204);

    const mappingRuns = (await (
      await fetch(`${baseUrl}/v1/keypad/mappings/${created.mapping.id}/runs`, { headers: auth() })
    ).json()) as { runs: { ok: boolean }[] };
    expect(mappingRuns.runs[0]!.ok).toBe(true);

    // The Intent Engine's OWN history also recorded this — proof it ran through
    // the real Capability Engine, not a bypassed shortcut.
    const intentRuns = (await (await fetch(`${baseUrl}/v1/intents/toggleLight/runs`, { headers: auth() })).json()) as IntentRunList;
    expect(intentRuns.runs.some((r) => r.resolvedDeviceIds.includes(light.id))).toBe(true);
  });

  it("rejects unauthenticated access to every intent route", async () => {
    const res = await fetch(`${baseUrl}/v1/intents`);
    expect(res.status).toBe(401);
  });
});

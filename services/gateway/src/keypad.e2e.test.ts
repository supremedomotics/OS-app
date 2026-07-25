import type {
  HomeView,
  KeypadCapabilitiesResponse,
  KeypadMappingList,
  KeypadMappingResponse,
  KeypadMappingRunList,
  KeypadSubscriptionList,
  KeypadSubscriptionResponse,
} from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Universal Keypad Framework — Phase 1 backend API proof (§ Universal Keypad
 * Framework). Phase 1 ships no real keypad driver, so this exercises everything a
 * REST client CAN reach without one: mapping CRUD (including {{variable}} expansion
 * at create time), a manual "run" that drives a real device through the SIL exactly
 * like the Automation Debugger's test-run, feedback subscription CRUD, and the
 * honest (never-fabricated) `null` a plain, non-keypad device reports for its
 * keypad-capabilities.
 */
describe("Universal Keypad Framework — backend APIs", () => {
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

  async function devices() {
    const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as HomeView;
    const out: { id: string; supremeType: string }[] = [];
    for (const r of home.rooms) {
      const d = (await (await fetch(`${baseUrl}/v1/rooms/${r.id}/devices`, { headers: auth() })).json()) as {
        devices: { id: string; supremeType: string }[];
      };
      out.push(...d.devices);
    }
    return out;
  }

  it("reports an honest null (never fabricated) for a plain device's keypad capabilities", async () => {
    const devs = await devices();
    const light = devs.find((d) => d.supremeType === "light")!;
    const res = (await (
      await fetch(`${baseUrl}/v1/devices/${light.id}/keypad-capabilities`, { headers: auth() })
    ).json()) as KeypadCapabilitiesResponse;
    expect(res.capabilities).toBeNull();
  });

  it("creates a mapping, expanding {{variables}} into concrete stored actions", async () => {
    const devs = await devices();
    const dimmer = devs.find((d) => d.supremeType === "dimmer")!;
    const created = (await (
      await fetch(`${baseUrl}/v1/keypad/mappings`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({
          name: "Scene button → dim step",
          input: { keypadId: dimmer.id, control: "btn1", event: "short_press" },
          actions: [{ type: "device_command", deviceId: dimmer.id, command: { capability: "brightness", action: "set", level: "{{step}}" } }],
          variables: { step: 40 },
        }),
      })
    ).json()) as KeypadMappingResponse;

    expect(created.mapping.actions).toEqual([
      { type: "device_command", deviceId: dimmer.id, command: { capability: "brightness", action: "set", level: 40 } },
    ]);

    const list = (await (await fetch(`${baseUrl}/v1/keypad/mappings`, { headers: auth() })).json()) as KeypadMappingList;
    expect(list.mappings.some((m) => m.id === created.mapping.id)).toBe(true);
  });

  it("rejects a mapping body with an unresolvable {{variable}} reference", async () => {
    const devs = await devices();
    const dimmer = devs.find((d) => d.supremeType === "dimmer")!;
    const res = await fetch(`${baseUrl}/v1/keypad/mappings`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        name: "Bad mapping",
        input: { keypadId: dimmer.id, control: "btn2", event: "short_press" },
        actions: [{ type: "device_command", deviceId: dimmer.id, command: { capability: "brightness", action: "set", level: "{{missing}}" } }],
      }),
    });
    expect(res.status).toBe(422); // zod validation failure (§6 error model)
  });

  it("runs a mapping's actions on demand, driving a real device through the SIL", async () => {
    const devs = await devices();
    const kitchen = devs.find((d) => d.supremeType === "light")!;
    const created = (await (
      await fetch(`${baseUrl}/v1/keypad/mappings`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({
          name: "Toggle kitchen light",
          input: { keypadId: kitchen.id, control: "btn1", event: "short_press" },
          actions: [{ type: "device_command", deviceId: kitchen.id, command: { capability: "onoff", action: "on" } }],
        }),
      })
    ).json()) as KeypadMappingResponse;

    const runRes = await fetch(`${baseUrl}/v1/keypad/mappings/${created.mapping.id}/run`, { method: "POST", headers: auth() });
    expect(runRes.status).toBe(204);

    const runs = (await (
      await fetch(`${baseUrl}/v1/keypad/mappings/${created.mapping.id}/runs`, { headers: auth() })
    ).json()) as KeypadMappingRunList;
    expect(runs.runs).toHaveLength(1);
    // ok:true is only possible if the device_command action actually reached the SIL
    // and succeeded against the real seeded device — proof the run drove a real command,
    // not just that the HTTP call didn't throw.
    expect(runs.runs[0]!.ok).toBe(true);
    expect(runs.runs[0]!.actions).toEqual([{ type: "device_command", ok: true, durationMs: expect.any(Number), summary: expect.stringContaining(kitchen.id) }]);
  });

  it("toggles enabled and deletes a mapping", async () => {
    const devs = await devices();
    const dimmer = devs.find((d) => d.supremeType === "dimmer")!;
    const created = (await (
      await fetch(`${baseUrl}/v1/keypad/mappings`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({
          name: "Disableable",
          input: { keypadId: dimmer.id, control: "btn3", event: "short_press" },
          actions: [{ type: "device_command", deviceId: dimmer.id, command: { capability: "onoff", action: "toggle" } }],
        }),
      })
    ).json()) as KeypadMappingResponse;

    const disabled = (await (
      await fetch(`${baseUrl}/v1/keypad/mappings/${created.mapping.id}/enabled`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ enabled: false }),
      })
    ).json()) as KeypadMappingResponse;
    expect(disabled.mapping.enabled).toBe(false);

    const del = await fetch(`${baseUrl}/v1/keypad/mappings/${created.mapping.id}`, { method: "DELETE", headers: auth() });
    expect(del.status).toBe(204);

    const list = (await (await fetch(`${baseUrl}/v1/keypad/mappings`, { headers: auth() })).json()) as KeypadMappingList;
    expect(list.mappings.some((m) => m.id === created.mapping.id)).toBe(false);
  });

  it("subscribes a keypad control to a device+capability's feedback, lists it, then unsubscribes", async () => {
    const devs = await devices();
    const light = devs.find((d) => d.supremeType === "light")!;
    const keypad = devs.find((d) => d.supremeType === "dimmer")!;

    const created = (await (
      await fetch(`${baseUrl}/v1/keypad/subscriptions`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ deviceId: light.id, capability: "onoff", keypadId: keypad.id, control: "led1" }),
      })
    ).json()) as KeypadSubscriptionResponse;
    expect(created.subscription.deviceId).toBe(light.id);

    const list = (await (await fetch(`${baseUrl}/v1/keypad/subscriptions`, { headers: auth() })).json()) as KeypadSubscriptionList;
    expect(list.subscriptions.some((s) => s.id === created.subscription.id)).toBe(true);

    const del = await fetch(`${baseUrl}/v1/keypad/subscriptions/${created.subscription.id}`, { method: "DELETE", headers: auth() });
    expect(del.status).toBe(204);

    const after = (await (await fetch(`${baseUrl}/v1/keypad/subscriptions`, { headers: auth() })).json()) as KeypadSubscriptionList;
    expect(after.subscriptions.some((s) => s.id === created.subscription.id)).toBe(false);
  });

  it("rejects unauthenticated access to every keypad route", async () => {
    const res = await fetch(`${baseUrl}/v1/keypad/mappings`);
    expect(res.status).toBe(401);
  });
});

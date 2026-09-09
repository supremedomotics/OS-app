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

  // ── § Universal Keypad Framework, Stage 3A — behavior/target through the real gateway API ──
  describe("behavior model (toggle/alternate/cycle/increment/decrement) via /v1/keypad/mappings", () => {
    it("creates a toggle mapping with no actions[], target round-trips exactly", async () => {
      const devs = await devices();
      const light = devs.find((d) => d.supremeType === "light")!;
      const created = (await (
        await fetch(`${baseUrl}/v1/keypad/mappings`, {
          method: "POST",
          headers: auth(),
          body: JSON.stringify({
            name: "Toggle via API",
            input: { keypadId: light.id, control: "btnA", event: "short_press" },
            behavior: "toggle",
            target: { deviceId: light.id, capability: "onoff", step: 10 },
          }),
        })
      ).json()) as KeypadMappingResponse;

      expect(created.mapping.behavior).toBe("toggle");
      expect(created.mapping.actions).toEqual([]);
      expect(created.mapping.target).toEqual({ deviceId: light.id, capability: "onoff", step: 10 });
      expect(created.mapping.behaviorState).toEqual({ lastDirection: null, cycleIndex: 0 });
    });

    it("fires a toggle mapping through the run endpoint and reads live target state, not a cached flag", async () => {
      const devs = await devices();
      const light = devs.find((d) => d.supremeType === "light")!;
      const created = (await (
        await fetch(`${baseUrl}/v1/keypad/mappings`, {
          method: "POST",
          headers: auth(),
          body: JSON.stringify({
            name: "Toggle run",
            input: { keypadId: light.id, control: "btnRun", event: "short_press" },
            behavior: "toggle",
            target: { deviceId: light.id, capability: "onoff", step: 10 },
          }),
        })
      ).json()) as KeypadMappingResponse;

      const runRes = await fetch(`${baseUrl}/v1/keypad/mappings/${created.mapping.id}/run`, { method: "POST", headers: auth() });
      expect(runRes.status).toBe(204);
      const runs = (await (await fetch(`${baseUrl}/v1/keypad/mappings/${created.mapping.id}/runs`, { headers: auth() })).json()) as KeypadMappingRunList;
      expect(runs.runs[0]!.ok).toBe(true);
    });

    it("creates an alternate mapping and its lastDirection advances after each firing", async () => {
      const devs = await devices();
      const dimmer = devs.find((d) => d.supremeType === "dimmer")!;
      const created = (await (
        await fetch(`${baseUrl}/v1/keypad/mappings`, {
          method: "POST",
          headers: auth(),
          body: JSON.stringify({
            name: "Alternate dim via API",
            input: { keypadId: dimmer.id, control: "btnAlt", event: "hold_start" },
            behavior: "alternate",
            target: { deviceId: dimmer.id, capability: "brightness", step: 10 },
          }),
        })
      ).json()) as KeypadMappingResponse;
      expect(created.mapping.behaviorState.lastDirection).toBeNull();

      await fetch(`${baseUrl}/v1/keypad/mappings/${created.mapping.id}/run`, { method: "POST", headers: auth() });

      const list = (await (await fetch(`${baseUrl}/v1/keypad/mappings`, { headers: auth() })).json()) as KeypadMappingList;
      const reloaded = list.mappings.find((m) => m.id === created.mapping.id)!;
      expect(reloaded.behaviorState.lastDirection).toBe("up");
    });

    it("creates a cycle mapping with a real actions[] list to walk through", async () => {
      const devs = await devices();
      const light = devs.find((d) => d.supremeType === "light")!;
      const created = (await (
        await fetch(`${baseUrl}/v1/keypad/mappings`, {
          method: "POST",
          headers: auth(),
          body: JSON.stringify({
            name: "Cycle via API",
            input: { keypadId: light.id, control: "btnCycle", event: "short_press" },
            behavior: "cycle",
            target: { deviceId: light.id, capability: "onoff", step: 10 },
            actions: [
              { type: "device_command", deviceId: light.id, command: { capability: "onoff", action: "on" } },
              { type: "device_command", deviceId: light.id, command: { capability: "onoff", action: "off" } },
            ],
          }),
        })
      ).json()) as KeypadMappingResponse;
      expect(created.mapping.behavior).toBe("cycle");
      expect(created.mapping.actions).toHaveLength(2);
    });

    it("creates increment and decrement mappings against a real dimmer target", async () => {
      const devs = await devices();
      const dimmer = devs.find((d) => d.supremeType === "dimmer")!;
      const inc = (await (
        await fetch(`${baseUrl}/v1/keypad/mappings`, {
          method: "POST",
          headers: auth(),
          body: JSON.stringify({
            name: "Increment via API",
            input: { keypadId: dimmer.id, control: "btnInc", event: "short_press" },
            behavior: "increment",
            target: { deviceId: dimmer.id, capability: "brightness", step: 15 },
          }),
        })
      ).json()) as KeypadMappingResponse;
      expect(inc.mapping.behavior).toBe("increment");
      expect(inc.mapping.target?.step).toBe(15);

      const dec = (await (
        await fetch(`${baseUrl}/v1/keypad/mappings`, {
          method: "POST",
          headers: auth(),
          body: JSON.stringify({
            name: "Decrement via API",
            input: { keypadId: dimmer.id, control: "btnDec", event: "short_press" },
            behavior: "decrement",
            target: { deviceId: dimmer.id, capability: "brightness", step: 15 },
          }),
        })
      ).json()) as KeypadMappingResponse;
      expect(dec.mapping.behavior).toBe("decrement");
    });

    it("update() changes behavior/target without a body field for behaviorState existing at all", async () => {
      const devs = await devices();
      const dimmer = devs.find((d) => d.supremeType === "dimmer")!;
      const created = (await (
        await fetch(`${baseUrl}/v1/keypad/mappings`, {
          method: "POST",
          headers: auth(),
          body: JSON.stringify({
            name: "Updatable",
            input: { keypadId: dimmer.id, control: "btnUpd", event: "short_press" },
            behavior: "toggle",
            target: { deviceId: dimmer.id, capability: "onoff", step: 10 },
          }),
        })
      ).json()) as KeypadMappingResponse;

      const patched = (await (
        await fetch(`${baseUrl}/v1/keypad/mappings/${created.mapping.id}`, {
          method: "PATCH",
          headers: auth(),
          body: JSON.stringify({ behavior: "increment", target: { deviceId: dimmer.id, capability: "brightness", step: 20 } }),
        })
      ).json()) as KeypadMappingResponse;
      expect(patched.mapping.behavior).toBe("increment");
      expect(patched.mapping.target).toEqual({ deviceId: dimmer.id, capability: "brightness", step: 20 });
    });

    it("rejects a non-direct mapping body with no target — 422 (§6 error model)", async () => {
      const devs = await devices();
      const dimmer = devs.find((d) => d.supremeType === "dimmer")!;
      const res = await fetch(`${baseUrl}/v1/keypad/mappings`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({
          name: "Missing target",
          input: { keypadId: dimmer.id, control: "btnBad1", event: "short_press" },
          behavior: "toggle",
        }),
      });
      expect(res.status).toBe(422);
    });

    it("rejects a direct mapping body with empty actions[] — 422, same rule as before Stage 3A", async () => {
      const devs = await devices();
      const dimmer = devs.find((d) => d.supremeType === "dimmer")!;
      const res = await fetch(`${baseUrl}/v1/keypad/mappings`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({
          name: "No actions",
          input: { keypadId: dimmer.id, control: "btnBad2", event: "short_press" },
        }),
      });
      expect(res.status).toBe(422);
    });

    it("legacy request body (actions[] only, no behavior/target keys) still creates a working direct mapping", async () => {
      const devs = await devices();
      const dimmer = devs.find((d) => d.supremeType === "dimmer")!;
      const created = (await (
        await fetch(`${baseUrl}/v1/keypad/mappings`, {
          method: "POST",
          headers: auth(),
          body: JSON.stringify({
            name: "Old-shape body",
            input: { keypadId: dimmer.id, control: "btnLegacy", event: "short_press" },
            actions: [{ type: "device_command", deviceId: dimmer.id, command: { capability: "onoff", action: "toggle" } }],
          }),
        })
      ).json()) as KeypadMappingResponse;
      expect(created.mapping.behavior).toBe("direct");
      expect(created.mapping.target).toBeNull();
    });
  });
});

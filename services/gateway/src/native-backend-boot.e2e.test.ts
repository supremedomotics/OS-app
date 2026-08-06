import { afterEach, describe, expect, it } from "vitest";
import { createHubContext } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import type { AppContext } from "./context.js";

/**
 * § Native Backend Implementation — proves the REAL production boot path
 * (`bootstrap.createHubContext`, what `main.ts` always uses) rather than the
 * bare-MockAdapter standalone slice most other e2e tests use (`AppContext.create`
 * with no injected `sil` — see `buildSil()` in context.ts). Every other gateway e2e
 * test bypasses `bootstrap.ts` entirely, so this is the only place the router +
 * native-by-default wiring + HA-compatibility-plugin slot are exercised end-to-end.
 */
describe("createHubContext — Native Backend is the production default, HA is optional", () => {
  let ctx: AppContext | undefined;

  afterEach(async () => {
    await ctx?.shutdown();
    ctx = undefined;
  });

  it("boots to a healthy hub with no SUPREME_BACKEND set and no Home Assistant reachable", async () => {
    ctx = await createHubContext(loadConfig({ SUPREME_PORT: "0", SUPREME_LOG_LEVEL: "silent" }));
    expect(ctx.sil.migrationEnabled).toBe(true); // real RoutingBackendAdapter, not the bare test slice
    expect(ctx.sil.haCompatBackendKind).toBe("ha-unavailable"); // HA plugin honestly absent, never mock
    expect(ctx.sil.isHealthy()).toBe(true); // native side alone is enough to be "healthy"
  });

  it("defaults every seeded demo device to native ownership and commands it through the native engine", async () => {
    ctx = await createHubContext(loadConfig({ SUPREME_PORT: "0", SUPREME_LOG_LEVEL: "silent" }));
    const devices = await ctx.home.listDevices();
    expect(devices.length).toBeGreaterThan(0);
    for (const device of devices) {
      const owner = ctx.sil.ownership.get(device.id);
      expect(owner?.kind).toBe("native");
    }

    // Pick a real seeded device (Living Room Lights has onoff+brightness+color) and
    // confirm a command actually reaches the native engine's in-process model — the
    // priming loop in bootstrap.ts must have provisioned it, or this would throw
    // backend_unavailable instead of succeeding.
    const light = devices.find((d) => d.capabilities.some((c) => c.kind === "onoff"));
    expect(light).toBeDefined();
    await ctx.sil.command(light!.id, { capability: "onoff", action: "on" });
    expect(await ctx.sil.getState(light!.id, "onoff")).toEqual({ kind: "onoff", on: true });
  });

  it("§ Never fabricate — a device explicitly (mis)owned by 'ha' fails loudly rather than silently succeeding, once HA compatibility is disabled", async () => {
    ctx = await createHubContext(loadConfig({ SUPREME_PORT: "0", SUPREME_LOG_LEVEL: "silent" }));
    const [device] = await ctx.home.listDevices();
    expect(device).toBeDefined();
    await ctx.sil.ownership.set(device!.id, "ha");
    await expect(ctx.sil.command(device!.id, { capability: "onoff", action: "on" })).rejects.toThrow(
      /Home Assistant compatibility plugin is not enabled/,
    );
  });
});

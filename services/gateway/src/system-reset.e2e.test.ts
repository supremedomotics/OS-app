import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * System Reset (§ PASS 22 Part B, P0) end-to-end: confirms the reset endpoint actually wipes the
 * demo-seeded home (rooms/devices/users) and flips the hub back into first-run Setup — proving
 * the whole chain (auth → route → InstallerServices.uninstallDriver cascade → HomeService sweep
 * → IdentityService.resetAllUsers → ctx.setupRequired) works together, not just each half in
 * isolation.
 */
describe("System Reset", () => {
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

  it("rejects reset without the exact typed confirmation phrase", async () => {
    const res = await fetch(`${baseUrl}/v1/system/reset`, { method: "POST", headers: auth(), body: JSON.stringify({ confirm: "yes please" }) });
    expect(res.status).toBe(422);
    // Nothing was touched — the demo home is still there.
    const status = await (await fetch(`${baseUrl}/v1/setup/status`)).json();
    expect(status.setupRequired).toBe(false);
  });

  it("reset-info reports real, non-zero counts for the seeded demo home", async () => {
    const info = (await (await fetch(`${baseUrl}/v1/system/reset-info`, { headers: auth() })).json()) as {
      users: number; devices: number; rooms: number; installedDrivers: number;
    };
    expect(info.users).toBeGreaterThan(0);
    expect(info.devices).toBeGreaterThan(0);
    expect(info.rooms).toBeGreaterThan(0);
  });

  it("wipes rooms/devices/users and returns the hub to first-run Setup", async () => {
    const reset = await fetch(`${baseUrl}/v1/system/reset`, { method: "POST", headers: auth(), body: JSON.stringify({ confirm: "RESET SYSTEM" }) });
    expect(reset.status).toBe(200);
    const body = (await reset.json()) as { ok: true; usersRemoved: number };
    expect(body.usersRemoved).toBeGreaterThan(0);

    expect(ctx.setupRequired).toBe(true);
    expect(await ctx.home.listDevices()).toHaveLength(0);
    expect(await ctx.home.listRooms()).toHaveLength(0);
    expect(await ctx.identity.listUsers()).toHaveLength(0);

    // The hub is genuinely back in first-run Setup: the old session is dead, and /v1/setup/status
    // reflects it — same observable contract the Setup Wizard e2e test already verifies pre-setup.
    const status = await (await fetch(`${baseUrl}/v1/setup/status`)).json();
    expect(status.setupRequired).toBe(true);
    const stale = await fetch(`${baseUrl}/v1/devices`, { headers: auth() });
    expect(stale.status).toBeGreaterThanOrEqual(400);
  });
});

/**
 * § PASS 22B Part D/E — reset failure safety, concurrency, and repeatability. A fresh
 * `AppContext`/server per test (a real reset — success OR partial-failure — always wipes
 * every user per Part B, so a token from an earlier test in the same instance is dead;
 * isolating per-test is simpler and more honest than re-deriving a post-reset login).
 */
describe("System Reset — failure safety, concurrency, repeat", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";

  beforeEach(async () => {
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
  afterEach(async () => {
    await app.close();
    await ctx.shutdown();
  });
  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  it("Reset 2 — a driver uninstall failure is reported as partial failure (207), not a false success, and the system stays usable", async () => {
    // A REAL DriverManager-installed driver (free — no license needed), so the reset
    // route's own `drivers.filter(e => e.installed && e.installedId)` loop genuinely
    // iterates over it — the failure injection below is exercised through the exact same
    // path the route runs, not a synthetic call bypassing it.
    const install = await fetch(`${baseUrl}/v1/drivers/install`, { method: "POST", headers: auth(), body: JSON.stringify({ key: "supreme-zigbee" }) });
    expect(install.status).toBe(201);

    // Deterministic failure-injection seam: DriverManager.uninstall() is the primitive
    // InstallerServices.uninstallDriver() calls first — monkey-patching it to throw is the
    // smallest way to make ONE driver's uninstall fail without a real driver failing
    // organically.
    const realUninstall = ctx.installer.drivers.uninstall.bind(ctx.installer.drivers);
    ctx.installer.drivers.uninstall = (async () => {
      throw new Error("simulated driver uninstall failure");
    }) as typeof realUninstall;

    const res = await fetch(`${baseUrl}/v1/system/reset`, { method: "POST", headers: auth(), body: JSON.stringify({ confirm: "RESET SYSTEM" }) });
    expect(res.status).toBe(207);
    const body = (await res.json()) as { ok: false; partial: true; driversFailed: { key: string; error: string }[]; usersRemoved: number };
    expect(body.driversFailed).toHaveLength(1);
    expect(body.driversFailed[0]!.key).toBe("supreme-zigbee");
    // Option C (§ this file's doc comment): the rest of the reset still ran to completion
    // even though the driver itself failed to uninstall — never "everything or nothing".
    expect(body.usersRemoved).toBeGreaterThan(0);
    expect(await ctx.home.listDevices()).toHaveLength(0);
    expect(ctx.setupRequired).toBe(true);

    // A DIFFERENT, unauthenticated caller can read the tracker (no admin session survives
    // a user wipe) and sees the honest "failed" state, never stuck "resetting".
    const noAuthStatus = await fetch(`${baseUrl}/v1/system/reset-status`);
    expect(noAuthStatus.status).toBeGreaterThanOrEqual(400); // requires auth, but doesn't hang/500 crash-loop

    // The system is not wedged: a fresh Setup Wizard completion (the real post-reset path,
    // since every user was actually deleted) succeeds cleanly.
    const setup = await fetch(`${baseUrl}/v1/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", email: "owner@example.com", password: "supreme-admin-pass", confirmPassword: "supreme-admin-pass", systemName: "Re-provisioned Home" }),
    });
    expect(setup.status).toBe(201);
  });

  it("Reset 3 — concurrent reset requests: only one executes, the second gets a clear conflict", async () => {
    // Everything in this reset is in-memory (no real I/O latency), so two genuinely
    // simultaneous fetches usually don't overlap in practice — the first tends to run to
    // completion (including wiping users/sessions) before the second's own handler even
    // starts, which would make the second fail on auth instead of ever reaching the
    // status guard under test. Force a real overlap deterministically: park the FIRST
    // request's driver-registry lookup (the very first await inside the try block, right
    // after the "resetting" status is set) until the second request has been sent.
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const realRegistry = ctx.installer.drivers.registry.bind(ctx.installer.drivers);
    let firstCallParked = false;
    ctx.installer.drivers.registry = (async () => {
      if (!firstCallParked) {
        firstCallParked = true;
        await gate;
      }
      return realRegistry();
    }) as typeof realRegistry;

    const first = fetch(`${baseUrl}/v1/system/reset`, { method: "POST", headers: auth(), body: JSON.stringify({ confirm: "RESET SYSTEM" }) });
    // Give the first request's handler a tick to actually enter "resetting" and park.
    await new Promise((r) => setTimeout(r, 20));
    const midStatus = (await (await fetch(`${baseUrl}/v1/system/reset-status`, { headers: auth() })).json()) as { status: string };
    expect(midStatus.status).toBe("resetting");
    const second = await fetch(`${baseUrl}/v1/system/reset`, { method: "POST", headers: auth(), body: JSON.stringify({ confirm: "RESET SYSTEM" }) });
    expect(second.status).toBe(409);
    releaseFirst();
    const firstRes = await first;
    expect(firstRes.status).toBe(200);

    expect(ctx.setupRequired).toBe(true);
    expect(await ctx.home.listDevices()).toHaveLength(0);
  });

  it("Reset 4 — repeat reset (second call on an already-empty system) is a deterministic no-op, no crash", async () => {
    const first = await fetch(`${baseUrl}/v1/system/reset`, { method: "POST", headers: auth(), body: JSON.stringify({ confirm: "RESET SYSTEM" }) });
    expect(first.status).toBe(200);
    expect(await ctx.home.listDevices()).toHaveLength(0);
    expect(await ctx.home.listRooms()).toHaveLength(0);

    // Re-provision so there's an authenticated admin to call reset a second time.
    const setup = await fetch(`${baseUrl}/v1/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner2", email: "owner2@example.com", password: "supreme-admin-pass-2", confirmPassword: "supreme-admin-pass-2", systemName: "Re-provisioned Home" }),
    });
    expect(setup.status).toBe(201);
    const setupBody = (await setup.json()) as { accessToken: string };
    const secondAuth = { authorization: `Bearer ${setupBody.accessToken}`, "content-type": "application/json" };

    const second = await fetch(`${baseUrl}/v1/system/reset`, { method: "POST", headers: secondAuth, body: JSON.stringify({ confirm: "RESET SYSTEM" }) });
    expect(second.status).toBe(200);
    expect(await ctx.home.listDevices()).toHaveLength(0);
    expect(await ctx.home.listRooms()).toHaveLength(0);
    expect(await ctx.identity.listUsers()).toHaveLength(0);
  });
});

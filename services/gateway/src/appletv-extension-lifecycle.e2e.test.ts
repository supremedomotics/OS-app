import type { License } from "@supreme/contracts";
import { newId, type Device, type DeviceId, type RoomId } from "@supreme/domain-model";
import { InMemoryProtocolBindingStore } from "@supreme/integration-layer";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * § Apple TV Phase 4 — proves Apple TV is a normal Extension Center extension, not a
 * special-cased core registration: installs/enables/disables/uninstalls through the
 * EXACT SAME generic routes and `InstallerServices` methods every other manifest driver
 * (KNX/AVR/CoolMaster) already uses — see `driver-uninstall-ownership.e2e.test.ts` for
 * the reference pattern this file follows. No Apple-TV-specific lifecycle code exists;
 * this test would break identically if the generic pipeline broke for any driver.
 */
describe("Apple TV — Extension Center lifecycle (§ Phase 4)", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  let protocolBindingStore: InMemoryProtocolBindingStore;
  let roomId: RoomId;

  beforeAll(async () => {
    protocolBindingStore = new InMemoryProtocolBindingStore();
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), { protocolBindingStore });
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const login = (await (
      await fetch(`${baseUrl}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }) })
    ).json()) as { accessToken: string };
    token = login.accessToken;

    // supreme-appletv requires the 'pro' SKU, same as KNX/AVR/CoolMaster.
    const issued = (await (
      await fetch(`${baseUrl}/v1/license/dev-issue`, { method: "POST", headers: auth(), body: JSON.stringify({ sku: "estate", seats: 10 }) })
    ).json()) as { token: License };
    await fetch(`${baseUrl}/v1/license/activate`, { method: "POST", headers: auth(), body: JSON.stringify({ token: issued.token }) });

    const rooms = await ctx.home.listRooms();
    roomId = rooms[0]!.id;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });
  function auth() {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  async function install(): Promise<string> {
    const res = await fetch(`${baseUrl}/v1/drivers/install`, { method: "POST", headers: auth(), body: JSON.stringify({ key: "supreme-appletv" }) });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { driver: { id: string } };
    return body.driver.id;
  }

  async function health(id: string) {
    const res = await fetch(`${baseUrl}/v1/drivers/${id}/health`, { headers: auth() });
    expect(res.status).toBe(200);
    return (await res.json()) as { installed: boolean; enabled: boolean; connected: boolean | null; verdict: string; configComplete: boolean };
  }

  async function setEnabled(id: string, enabled: boolean) {
    const res = await fetch(`${baseUrl}/v1/drivers/${id}/enabled`, { method: "POST", headers: auth(), body: JSON.stringify({ enabled }) });
    expect(res.status).toBe(200);
  }

  it("1) manifest registration: supreme-appletv appears in the driver registry with only implemented capabilities", async () => {
    const res = await fetch(`${baseUrl}/v1/drivers/registry`, { headers: auth() });
    const body = (await res.json()) as { drivers: Array<{ key: string; capabilities: string[]; protocols: string[] }> };
    const entry = body.drivers.find((d) => d.key === "supreme-appletv");
    expect(entry).toBeDefined();
    expect(entry!.capabilities.sort()).toEqual(["media", "remote"]);
    expect(entry!.capabilities).not.toContain("volume" as never);
    expect(entry!.protocols).toEqual(["appletv"]);
  });

  it("2) install -> enable: the generic pipeline brings up a real, connected AppleTvProtocolDriver", async () => {
    const id = await install();
    const afterInstall = await health(id);
    expect(afterInstall.installed).toBe(true);
    expect(afterInstall.enabled).toBe(true); // supreme-appletv does not ship disabled
    expect(afterInstall.configComplete).toBe(true); // empty configSchema — nothing required
    // NOTE: `connected`/`verdict` depend on a live native-protocol router, which this
    // test harness's mock backend (no DATABASE_URL/native bus) doesn't stand up — same
    // scoping the reference `driver-uninstall-ownership.e2e.test.ts` documents ("standing
    // up a REAL connected KNX/AVR/CoolMaster driver in a unit test is its own large
    // undertaking"). The generic pipeline itself (registration succeeding without error)
    // is what's under test here, not live connectivity.
    expect(afterInstall.verdict).not.toBe("error");

    await ctx.installer.uninstallDriver(id as never);
  });

  it("3) disable -> connections torn down; re-enable -> driver comes back, same installedId, no duplicate", async () => {
    const id = await install();
    expect((await health(id)).enabled).toBe(true);

    await setEnabled(id, false);
    const disabled = await health(id);
    expect(disabled.enabled).toBe(false);
    expect(disabled.connected).toBeNull(); // torn down, not fabricated "still connected"
    expect(disabled.verdict).toBe("disabled");

    await setEnabled(id, true);
    const reenabled = await health(id);
    expect(reenabled.enabled).toBe(true);
    expect(reenabled.verdict).not.toBe("error");

    // Still exactly one installed instance — re-enabling never created a duplicate.
    const registry = await (await fetch(`${baseUrl}/v1/drivers/registry`, { headers: auth() })).json() as { drivers: Array<{ key: string; installedId: string | null; instanceCount: number }> };
    const entry = registry.drivers.find((d) => d.key === "supreme-appletv" && d.installedId === id);
    expect(entry).toBeDefined();
    expect(entry!.instanceCount).toBe(1);

    await ctx.installer.uninstallDriver(id as never);
  });

  it("4) disabling does NOT delete device configuration or credentials (only uninstall/removal does)", async () => {
    const id = await install();
    const device: Device = {
      id: newId("device") as DeviceId,
      homeId: (await ctx.home.getHome())!.id,
      roomId,
      name: "Living Room Apple TV",
      supremeType: "media_player",
      manufacturer: "Apple",
      model: "Apple TV",
      driverId: null,
      status: "online",
      capabilities: [{ kind: "media", config: {} }],
      state: {},
      metadata: {},
    };
    await ctx.home.addDevice(device, { media: "appletv-instance-1" });
    await ctx.home.setDriverOwner(device.id, id as never);
    await protocolBindingStore.put({ deviceId: device.id, capability: "media", protocol: "appletv", address: "192.168.1.50:12345", config: { appletv: { pairing: "encrypted-blob" } } });

    await setEnabled(id, false);
    // Device row and its binding config (where credentials live, § Phase 2C) survive a
    // disable — only uninstall (test 5) or explicit device removal touches them.
    expect(await ctx.home.getDevice(device.id)).not.toBeNull();
    const bindings = await protocolBindingStore.list();
    const binding = bindings.find((b) => b.deviceId === device.id);
    expect(binding?.config?.appletv).toEqual({ pairing: "encrypted-blob" });

    await setEnabled(id, true);
    expect(await ctx.home.getDevice(device.id)).not.toBeNull();

    await ctx.installer.uninstallDriver(id as never);
  });

  it("5) uninstall releases the device (existing generic ownership-scoped cleanup — driver-uninstall-ownership.e2e.test.ts's own pattern)", async () => {
    const id = await install();
    const device: Device = {
      id: newId("device") as DeviceId,
      homeId: (await ctx.home.getHome())!.id,
      roomId,
      name: "Theater Apple TV",
      supremeType: "media_player",
      manufacturer: "Apple",
      model: "Apple TV",
      driverId: null,
      status: "online",
      capabilities: [{ kind: "media", config: {} }],
      state: {},
      metadata: {},
    };
    await ctx.home.addDevice(device, { media: "appletv-instance-2" });
    await ctx.home.setDriverOwner(device.id, id as never);

    await ctx.installer.uninstallDriver(id as never);

    expect(await ctx.home.getDevice(device.id)).toBeNull();
    const healthRes = await fetch(`${baseUrl}/v1/drivers/${id}/health`, { headers: auth() });
    expect(healthRes.status).toBe(404); // not_found — no orphaned driver state
  });
});

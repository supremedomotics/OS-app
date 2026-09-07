import type { License } from "@supreme/contracts";
import { newId, type Device, type DeviceId, type RoomId } from "@supreme/domain-model";
import { InMemoryProtocolBindingStore } from "@supreme/integration-layer";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * § PASS 22B Part F — driver ownership + uninstall regression coverage. Prior to this
 * pass, `InstallerServices.uninstallDriver()`'s device-scoping (`dv.driverId === id`) had
 * ZERO direct tests — only the full-system-reset e2e test exercised it indirectly, by
 * uninstalling EVERYTHING at once, which can't prove scoping (a bug that removed every
 * device regardless of owner would still pass that test).
 *
 * These tests install REAL catalog drivers (so `installedId`/`uninstallDriver()` are the
 * genuine production primitives, not a fake), then attach devices to them the same way
 * `bindProtocol()` does at the two points that matter for this pass — `HomeService.
 * setDriverOwner()` (§ Part K) and `IProtocolBindingStore.put()` — without going through a
 * live native-bus connection: standing up a REAL connected KNX/AVR/CoolMaster driver in a
 * unit test is its own large undertaking (each requires either real hardware or a fully
 * faked transport layer) and is explicitly out of scope for this pass (Pass 23 owns the
 * KNX/feedback pipeline). `bindProtocol()`'s own wiring to `setDriverOwner`/
 * `protocolBindingStore` is already covered by `driver-lifecycle-unbind.e2e.test.ts` and
 * `protocol-binding.e2e.test.ts`; this file is specifically about what `uninstallDriver()`
 * does with that ownership once it exists.
 */
describe("Driver uninstall — ownership-scoped device cleanup (§ PASS 22B Part F)", () => {
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

    // KNX/AVR/CoolMaster all require the 'pro' SKU in their manifest — activate a dev
    // license once so every install below just works.
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

  async function install(key: string): Promise<string> {
    const res = await fetch(`${baseUrl}/v1/drivers/install`, { method: "POST", headers: auth(), body: JSON.stringify({ key } ) });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { driver: { id: string } };
    return body.driver.id;
  }

  /** Mirrors exactly what `bindProtocol()` does at commissioning time, minus the live
   * `sil.bindNative()` call itself (§ this file's own doc comment on why): add a device
   * with a real backend-mapped capability (so the SIL entity registry is genuinely
   * populated, not empty), record ownership via the real `setDriverOwner()`, and persist a
   * real protocol binding row. */
  async function attachDevice(name: string, backendId: string, protocol: string, driverId: string | null): Promise<Device> {
    const device: Device = {
      id: newId("device") as DeviceId,
      homeId: (await ctx.home.getHome())!.id,
      roomId,
      name,
      supremeType: "switch",
      manufacturer: "Test",
      model: "Test",
      driverId: null,
      status: "online",
      capabilities: [{ kind: "onoff", config: {} }],
      state: {},
      metadata: {},
    };
    await ctx.home.addDevice(device, { onoff: backendId });
    if (driverId) {
      await ctx.home.setDriverOwner(device.id, driverId as never);
      await protocolBindingStore.put({ deviceId: device.id, capability: "onoff", protocol, address: backendId, config: {} });
    }
    return (await ctx.home.getDevice(device.id))!;
  }

  it("1) uninstalling KNX alone removes only the KNX-owned device", async () => {
    const knxId = await install("supreme-knx");
    const knxDevice = await attachDevice("KNX Light", "knx/1/1/1", "knx", knxId);
    expect(knxDevice.driverId).toBe(knxId);

    await ctx.installer.uninstallDriver(knxId as never);

    expect(await ctx.home.getDevice(knxDevice.id)).toBeNull();
  });

  it("2) KNX + AVR both owned — uninstalling KNX leaves the AVR device untouched", async () => {
    const knxId = await install("supreme-knx");
    const avrId = await install("supreme-avr");
    const knxDevice = await attachDevice("KNX Light 2", "knx/1/1/2", "knx", knxId);
    const avrDevice = await attachDevice("Living Room AVR", "192.168.1.50", "avr", avrId);
    expect(avrDevice.driverId).toBe(avrId);

    await ctx.installer.uninstallDriver(knxId as never);

    expect(await ctx.home.getDevice(knxDevice.id)).toBeNull();
    const survivingAvr = await ctx.home.getDevice(avrDevice.id);
    expect(survivingAvr).not.toBeNull();
    expect(survivingAvr?.driverId).toBe(avrId);
  });

  it("3) KNX + CoolMaster both owned — uninstalling KNX leaves the CoolMaster device untouched", async () => {
    const knxId = await install("supreme-knx");
    const cmId = await install("supreme-coolmaster");
    const knxDevice = await attachDevice("KNX Light 3", "knx/1/1/3", "knx", knxId);
    const cmDevice = await attachDevice("AC Unit", "L1.U1", "coolmaster", cmId);
    expect(cmDevice.driverId).toBe(cmId);

    await ctx.installer.uninstallDriver(knxId as never);

    expect(await ctx.home.getDevice(knxDevice.id)).toBeNull();
    const survivingCm = await ctx.home.getDevice(cmDevice.id);
    expect(survivingCm).not.toBeNull();
    expect(survivingCm?.driverId).toBe(cmId);
  });

  it("4) a manually-created device (no owning driver) survives any driver uninstall", async () => {
    const knxId = await install("supreme-knx");
    const knxDevice = await attachDevice("KNX Light 4", "knx/1/1/4", "knx", knxId);
    // A manual device: added with no driver ownership at all, exactly like a manually
    // paired/demo device — driverId stays null.
    const manual = await attachDevice("Manual Switch", "switch.manual1", "manual", null);
    expect(manual.driverId).toBeNull();

    await ctx.installer.uninstallDriver(knxId as never);

    expect(await ctx.home.getDevice(knxDevice.id)).toBeNull();
    expect(await ctx.home.getDevice(manual.id)).not.toBeNull();
  });

  it("5) the room itself survives, with no dangling reference to the removed device", async () => {
    const knxId = await install("supreme-knx");
    const knxDevice = await attachDevice("KNX Light 5", "knx/1/1/5", "knx", knxId);

    await ctx.installer.uninstallDriver(knxId as never);

    expect(await ctx.home.getRoom(roomId)).not.toBeNull();
    const inRoom = await ctx.home.listDevicesInRoom(roomId);
    expect(inRoom.some((d) => d.id === knxDevice.id)).toBe(false);
  });

  it("6) the SIL entity registry is cleaned — the removed device's capability no longer resolves", async () => {
    const knxId = await install("supreme-knx");
    const knxDevice = await attachDevice("KNX Light 6", "knx/1/1/6", "knx", knxId);
    expect(ctx.sil.registry.resolve(knxDevice.id, "onoff")).toBeDefined();

    await ctx.installer.uninstallDriver(knxId as never);

    expect(ctx.sil.registry.resolve(knxDevice.id, "onoff")).toBeUndefined();
  });

  it("7) protocol bindings are cleaned from the binding store, not left orphaned", async () => {
    const knxId = await install("supreme-knx");
    const knxDevice = await attachDevice("KNX Light 7", "knx/1/1/7", "knx", knxId);
    expect(await protocolBindingStore.list()).toEqual(
      expect.arrayContaining([expect.objectContaining({ deviceId: knxDevice.id })]),
    );

    await ctx.installer.uninstallDriver(knxId as never);

    const remainingBindings = await protocolBindingStore.list();
    expect(remainingBindings.some((b) => b.deviceId === knxDevice.id)).toBe(false);
  });

  it("9) reinstalling KNX after uninstall never resurrects the old device", async () => {
    const knxId1 = await install("supreme-knx");
    const knxDevice = await attachDevice("KNX Light 9", "knx/1/1/9", "knx", knxId1);
    await ctx.installer.uninstallDriver(knxId1 as never);
    expect(await ctx.home.getDevice(knxDevice.id)).toBeNull();

    // Reinstall — a fresh installedId, no discovery/re-commission triggered automatically.
    const knxId2 = await install("supreme-knx");
    expect(knxId2).not.toBe(knxId1);
    expect(await ctx.home.getDevice(knxDevice.id)).toBeNull();
    expect(await ctx.home.listDevices()).not.toContainEqual(expect.objectContaining({ id: knxDevice.id }));
  });
});

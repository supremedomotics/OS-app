import { newId, type DeviceId, type HomeId, type UserId } from "@supreme/domain-model";
import {
  DriverBindingEngine,
  EntityRegistryMirror,
  HaAdapter,
  HomeAssistantProviderDriver,
  MockAdapter,
  ProviderRegistry,
  ProviderRouter,
  SupremeIntegrationLayer,
  SupremeNativeAdapter,
  type HaTransport,
} from "@supreme/integration-layer";
import { describe, expect, it } from "vitest";
import { HomeService, seedDemoHome } from "./home-service.js";

/** Minimal no-socket HA transport (mirrors integration-layer's own ha-adapter.test.ts pattern). */
class FakeHaTransport implements HaTransport {
  opened = false;
  async open(): Promise<void> { this.opened = true; }
  async close(): Promise<void> { this.opened = false; }
  isOpen(): boolean { return this.opened; }
  onEvent(): void {}
  async send(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (message.type === "get_states") return { result: [] };
    return {};
  }
}

async function setup() {
  const adapter = new MockAdapter();
  const sil = new SupremeIntegrationLayer({ adapter });
  await sil.start();
  const home = new HomeService(sil);
  const homeId = newId("home") as HomeId;
  await seedDemoHome(home, {
    id: homeId,
    name: "Demo",
    address: null,
    tier: "signature",
    masterUserId: newId("user") as UserId,
    createdAt: new Date().toISOString(),
  });
  return { sil, home };
}

describe("HomeService", () => {
  it("seeds rooms + devices across lighting/climate/media/cover and binds the SIL", async () => {
    const { sil, home } = await setup();
    const rooms = await home.listRooms();
    expect(rooms.map((r) => r.name)).toContain("Living Room");

    const devices = await home.listDevices();
    const types = new Set(devices.map((d) => d.supremeType));
    expect(types).toContain("dimmer");
    expect(types).toContain("thermostat");
    expect(types).toContain("media_player");
    expect(types).toContain("cover");

    // A seeded device's capability must be bound in the SIL registry.
    const dimmer = devices.find((d) => d.supremeType === "dimmer")!;
    await sil.command(dimmer.id, { capability: "brightness", action: "set", level: 50 });
    const updated = await home.applyState(dimmer.id, {
      kind: "brightness",
      on: true,
      level: 50,
    });
    expect(updated?.state.brightness).toEqual({ kind: "brightness", on: true, level: 50 });
  });

  it("moves any device to any room and renames it, keeping its binding", async () => {
    const { sil, home } = await setup();
    const rooms = await home.listRooms();
    const living = rooms.find((r) => r.name === "Living Room")!;
    const bedroom = rooms.find((r) => r.name === "Bedroom")!;
    const device = (await home.listDevicesInRoom(living.id))[0]!;

    // Move it to a different room + rename it.
    const moved = await home.updateDevice(device.id, { roomId: bedroom.id, name: "Reading Lamp" });
    expect(moved.roomId).toBe(bedroom.id);
    expect(moved.name).toBe("Reading Lamp");

    // It now lists under the new room, not the old one.
    expect((await home.listDevicesInRoom(bedroom.id)).some((d) => d.id === device.id)).toBe(true);
    expect((await home.listDevicesInRoom(living.id)).some((d) => d.id === device.id)).toBe(false);

    // And it's still controllable (binding survived the move).
    if (device.capabilities.some((c) => c.kind === "brightness")) {
      await sil.command(device.id, { capability: "brightness", action: "set", level: 30 });
    }
  });

  it("clones a device's config into a new, unbound device (§ Device Platform)", async () => {
    const { home } = await setup();
    const src = (await home.listDevices()).find((d) => d.capabilities.length > 0)!;
    const clone = await home.cloneDevice(src.id);
    expect(clone.id).not.toBe(src.id);
    expect(clone.name).toBe(`${src.name} (copy)`);
    expect(clone.supremeType).toBe(src.supremeType);
    expect(clone.capabilities).toEqual(src.capabilities);
    expect(clone.roomId).toBe(src.roomId);
    expect((clone.metadata as { clonedFrom?: string }).clonedFrom).toBe(src.id);
    expect(clone.state).toEqual({});
    // Both exist independently.
    expect((await home.listDevices()).filter((d) => d.id === src.id || d.id === clone.id)).toHaveLength(2);
  });

  it("bulk-moves and bulk-removes a device selection (§ Device Platform)", async () => {
    const { home } = await setup();
    const rooms = await home.listRooms();
    const bedroom = rooms.find((r) => r.name === "Bedroom")!;
    const ids = (await home.listDevices()).slice(0, 2).map((d) => d.id);

    const moved = await home.moveDevices(ids, bedroom.id);
    expect(moved).toBe(2);
    const inBedroom = (await home.listDevicesInRoom(bedroom.id)).map((d) => d.id);
    expect(ids.every((id) => inBedroom.includes(id))).toBe(true);

    const removed = await home.removeDevices(ids);
    expect(removed).toBe(2);
    const remaining = (await home.listDevices()).map((d) => d.id);
    expect(ids.some((id) => remaining.includes(id))).toBe(false);
  });

  it("rejects moving a device to a non-existent room", async () => {
    const { home } = await setup();
    const device = (await home.listDevices())[0]!;
    await expect(home.updateDevice(device.id, { roomId: "room-nope" as never })).rejects.toThrow(/room not found/);
  });

  it("deletes a device and drops its SIL binding", async () => {
    const { sil, home } = await setup();
    const device = (await home.listDevices()).find((d) => d.capabilities.some((c) => c.kind === "brightness"))!;
    const before = sil.registry.size;

    await home.removeDevice(device.id);
    expect(await home.getDevice(device.id)).toBeNull();
    expect(await home.listDevices()).not.toContainEqual(expect.objectContaining({ id: device.id }));
    // Its capability mappings are gone from the registry.
    expect(sil.registry.size).toBeLessThan(before);
    expect(sil.registry.resolve(device.id, "brightness")).toBeUndefined();
  });

  it("rejects updating/deleting an unknown device", async () => {
    const { home } = await setup();
    await expect(home.updateDevice("device-nope" as never, { name: "x" })).rejects.toThrow(/not found/);
    await expect(home.removeDevice("device-nope" as never)).rejects.toThrow(/not found/);
  });

  it("toggles favorites per user", async () => {
    const { home } = await setup();
    const userId = newId("user") as UserId;
    const devices = await home.listDevices();
    const ref = { type: "device" as const, deviceId: devices[0]!.id };
    await home.setFavorite(userId, ref, true);
    expect(await home.listFavorites(userId)).toHaveLength(1);
    await home.setFavorite(userId, ref, false);
    expect(await home.listFavorites(userId)).toHaveLength(0);
  });

  describe("ADR-0023 § Commissioning — explicit provider assignment", () => {
    async function setupRouter() {
      const registry = new EntityRegistryMirror();
      const haDriver = new HomeAssistantProviderDriver(new HaAdapter({ transport: new FakeHaTransport(), registry }), registry);
      const engine = new SupremeNativeAdapter({ drivers: [haDriver] });
      const providers = new ProviderRegistry();
      const router = new ProviderRouter({ engine, registry: providers, bindingEngine: new DriverBindingEngine(engine, providers) });
      const sil = new SupremeIntegrationLayer({ adapter: router, registry, providers });
      await sil.start();
      return { sil, providers, home: new HomeService(sil) };
    }

    it("addDevice() with backendIds binds through DriverBindingEngine — no implicit ownership side effect", async () => {
      const { sil, providers, home } = await setupRouter();
      const deviceId = newId("device") as DeviceId;
      await home.addDevice(
        { id: deviceId, roomId: null, name: "Lamp", supremeType: "dimmer", capabilities: [{ kind: "onoff" }], state: {}, metadata: {} },
        { onoff: "light.lamp" },
      );
      // Real lifecycle state, not a fabricated default.
      expect(providers.get(deviceId)).toMatchObject({ provider: "homeassistant", state: "ONLINE" });
      // And it's genuinely commandable through the router (not just recorded as owned).
      await expect(sil.command(deviceId, { capability: "onoff", action: "on" })).resolves.toBeUndefined();
    });

    it("a device with no backendIds stays unassigned — never defaulted to homeassistant", async () => {
      const { providers, home } = await setupRouter();
      const deviceId = newId("device") as DeviceId;
      await home.addDevice(
        { id: deviceId, roomId: null, name: "Unbound thing", supremeType: "dimmer", capabilities: [{ kind: "onoff" }], state: {}, metadata: {} },
        {},
      );
      expect(providers.get(deviceId)).toBeUndefined();
    });
  });
});

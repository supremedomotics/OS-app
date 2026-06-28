import { newId, type HomeId, type UserId } from "@supreme/domain-model";
import { MockAdapter, SupremeIntegrationLayer } from "@supreme/integration-layer";
import { describe, expect, it } from "vitest";
import { HomeService, seedDemoHome } from "./home-service.js";

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
});

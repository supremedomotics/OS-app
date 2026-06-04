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

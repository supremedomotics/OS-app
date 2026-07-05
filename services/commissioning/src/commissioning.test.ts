import { newId, type HomeId, type UserId } from "@supreme/domain-model";
import { MockAdapter, SupremeIntegrationLayer } from "@supreme/integration-layer";
import { HomeService } from "@supreme/home";
import { describe, expect, it } from "vitest";
import { CommissioningService, type IProtocolScanner } from "./index.js";

async function setup(seedDiscovered = true) {
  const seed = seedDiscovered
    ? [
        {
          backendId: "light.studio",
          suggestedName: "Studio Light",
          capabilities: ["onoff", "brightness"] as const,
          raw: {},
        },
      ]
    : [];
  const adapter = new MockAdapter(seed as never);
  const sil = new SupremeIntegrationLayer({ adapter });
  await sil.start();
  const home = new HomeService(sil);

  const homeId = newId("home") as HomeId;
  await home.setHome({
    id: homeId,
    name: "Estate",
    address: null,
    tier: "estate",
    masterUserId: newId("user") as UserId,
    createdAt: new Date().toISOString(),
  });
  const roomId = newId("room") as ReturnType<typeof newId> & string;
  await home.addRoom({
    id: roomId as never,
    homeId,
    name: "Studio",
    building: null,
    floor: 0,
    area: null,
    areaType: "office",
    sortOrder: 0,
    icon: null,
    heroImageUrl: null,
    parentRoomId: null,
  });
  return { sil, home, roomId };
}

const knxScanner: IProtocolScanner = {
  protocol: "knx",
  async scan() {
    return [
      { backendId: "knx.1_1_5", suggestedName: "Hall Dimmer", capabilities: ["onoff", "brightness"], raw: {} },
    ];
  },
};

describe("CommissioningService", () => {
  it("discovers backend devices and protocol-scanned devices together", async () => {
    const { sil, home } = await setup();
    const svc = new CommissioningService(sil, home, [knxScanner]);
    const found = await svc.discover();
    const ids = found.map((f) => f.backendId);
    expect(ids).toContain("light.studio");
    expect(ids).toContain("knx.1_1_5");
    expect(found.find((f) => f.backendId === "knx.1_1_5")?.source).toBe("knx");
  });

  it("commissions a discovered device into a controllable Supreme device", async () => {
    const { sil, home, roomId } = await setup();
    const svc = new CommissioningService(sil, home);
    const device = await svc.commission({
      backendId: "light.studio",
      name: "Studio Light",
      roomId: roomId as never,
      capabilities: ["onoff", "brightness"],
    });
    expect(device.supremeType).toBe("dimmer");

    // Commissioning bound the capability into the SIL → it is now controllable.
    await sil.command(device.id, { capability: "brightness", action: "set", level: 80 });
    const state = await sil.getState(device.id, "brightness");
    expect(state).toEqual({ kind: "brightness", on: true, level: 80 });

    // And it appears in the room.
    expect((await home.listDevicesInRoom(roomId as never)).map((d) => d.id)).toContain(device.id);
  });

  it("filters discovery by protocol", async () => {
    const { sil, home } = await setup();
    const svc = new CommissioningService(sil, home, [knxScanner]);
    const knxOnly = await svc.discover("knx");
    expect(knxOnly.every((f) => f.source === "knx")).toBe(true);
  });
});

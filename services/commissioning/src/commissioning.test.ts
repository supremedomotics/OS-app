import { newId, type HomeId, type UserId } from "@supreme/domain-model";
import { MockAdapter, SupremeIntegrationLayer } from "@supreme/integration-layer";
import { HomeService } from "@supreme/home";
import { describe, expect, it } from "vitest";
import { CommissioningService, extractNetwork, type IProtocolScanner } from "./index.js";

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

  it("stops re-surfacing an already-commissioned device as a new find on a rescan", async () => {
    // Polling discovery sources (CoolMaster indoor units, AVR/HEOS/Yamaha SSDP, mDNS…)
    // report the same stable backendId on every scan — without filtering, a rescan shows
    // the same physical unit again and re-pairing it creates a duplicate Supreme device
    // for the same hardware ("multiple cards for one AC").
    const { sil, home, roomId } = await setup();
    const svc = new CommissioningService(sil, home);
    expect((await svc.discover()).map((f) => f.backendId)).toContain("light.studio");

    await svc.commission({
      backendId: "light.studio",
      name: "Studio Light",
      roomId: roomId as never,
      capabilities: ["onoff", "brightness"],
    });

    const rescan = await svc.discover();
    expect(rescan.map((f) => f.backendId)).not.toContain("light.studio");
  });

  it("survives an AVR rediscovery: a user-renamed device is neither re-surfaced by discover() nor overwritten by a fresh friendlyName (§ Pass 12.2)", async () => {
    // Same exclusion mechanism as the generic test above, exercised end-to-end for the
    // AVR case specifically: an AVR scanner whose suggestedName is UPnP-friendlyName-
    // derived (per avr-driver.ts's discover()) reports a DIFFERENT friendlyName on the
    // second scan (e.g. the installer renamed it in the Denon app) — Device.name must
    // stay whatever the homeowner set, never re-derived from a later scan.
    let avrFriendlyName = "Denon AVR-X3800H";
    const avrScanner: IProtocolScanner = {
      protocol: "avr" as never,
      async scan() {
        return [{ backendId: "avr.192.168.1.60", suggestedName: avrFriendlyName, capabilities: ["onoff", "media"], raw: {} }];
      },
    };
    const { sil, home, roomId } = await setup();
    const svc = new CommissioningService(sil, home, [avrScanner]);
    expect((await svc.discover()).map((f) => f.backendId)).toContain("avr.192.168.1.60");

    const device = await svc.commission({
      backendId: "avr.192.168.1.60",
      name: "Denon AVR-X3800H",
      roomId: roomId as never,
      capabilities: ["onoff", "media"],
    });
    const renamed = await home.updateDevice(device.id, { name: "Living Room Receiver" });
    expect(renamed.name).toBe("Living Room Receiver");

    // Rediscovery reports a different friendlyName for the same physical unit.
    avrFriendlyName = "Denon AVR-X3800H (2)";
    const rescan = await svc.discover();
    expect(rescan.map((f) => f.backendId)).not.toContain("avr.192.168.1.60");

    const stillRenamed = await home.listDevicesInRoom(roomId as never);
    expect(stillRenamed.find((d) => d.id === device.id)?.name).toBe("Living Room Receiver");
  });

  it("filters discovery by protocol", async () => {
    const { sil, home } = await setup();
    const svc = new CommissioningService(sil, home, [knxScanner]);
    const knxOnly = await svc.discover("knx");
    expect(knxOnly.every((f) => f.source === "knx")).toBe(true);
  });

  it("extracts real network coordinates from discovery metadata (and only when present)", () => {
    // mDNS shape: A-record addresses + host + a Shelly-style 12-hex MAC in TXT id.
    expect(extractNetwork({ addresses: ["192.168.1.42"], host: "shelly1.local", txt: { id: "a4cf12ff00aa" } }))
      .toEqual({ ip: "192.168.1.42", mac: "a4cf12ff00aa", host: "shelly1.local" });
    // Direct ip/mac fields with a colon-form MAC.
    expect(extractNetwork({ ip: "10.0.0.5", mac: "AA:BB:CC:DD:EE:FF" }))
      .toEqual({ ip: "10.0.0.5", mac: "AA:BB:CC:DD:EE:FF" });
    // A non-MAC TXT id is not misread as a MAC.
    expect(extractNetwork({ txt: { id: "living-room-lamp" } })).toBeUndefined();
    // A non-IP-bus device (KNX) yields nothing — never fabricated.
    expect(extractNetwork({})).toBeUndefined();
    expect(extractNetwork(undefined)).toBeUndefined();
  });

  it("persists network coordinates onto the commissioned device", async () => {
    const { sil, home, roomId } = await setup();
    const svc = new CommissioningService(sil, home);
    const device = await svc.commission({
      backendId: "light.studio",
      name: "Studio Light",
      roomId: roomId as never,
      capabilities: ["onoff", "brightness"],
      network: { ip: "192.168.1.42", mac: "a4cf12ff00aa" },
    });
    expect((device.metadata as { network?: unknown }).network).toEqual({ ip: "192.168.1.42", mac: "a4cf12ff00aa" });

    // No network → no fabricated field on the device.
    const bare = await svc.commission({
      backendId: "light.studio",
      name: "Studio Light 2",
      roomId: roomId as never,
      capabilities: ["onoff"],
    });
    expect((bare.metadata as { network?: unknown }).network).toBeUndefined();
  });
});

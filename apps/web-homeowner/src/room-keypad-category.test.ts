import { describe, expect, it } from "vitest";
import type { Device, DeviceId, HomeId, RoomId } from "@supreme/domain-model";
import { categorize } from "./screens.js";

/**
 * § Supreme Universal Keypad, Room Integration — regression tests for the Room page's
 * device categorization now that a keypad is a first-class "Keypads" category, classified
 * from `supremeType` (the common Supreme device semantic), never a protocol check. Guards
 * exactly the failure mode a hardcoded `if protocol === "casambi"` would introduce: any
 * keypad, from any protocol, lands in the same category; a genuine onoff/brightness/etc.
 * device is completely unaffected.
 */
function device(overrides: Partial<Omit<Device, "id" | "roomId">> & { id: string; name: string; roomId?: string }): Device {
  return {
    id: overrides.id as DeviceId,
    homeId: "home-1" as HomeId,
    roomId: (overrides.roomId ?? "room-1") as RoomId,
    name: overrides.name,
    supremeType: overrides.supremeType ?? "switch",
    manufacturer: overrides.manufacturer ?? null,
    model: overrides.model ?? null,
    driverId: overrides.driverId ?? null,
    status: overrides.status ?? "online",
    capabilities: overrides.capabilities ?? [],
    state: overrides.state ?? {},
    metadata: overrides.metadata ?? {},
  };
}

function keypad(id: string, name: string, extra: Partial<Omit<Device, "id" | "roomId">> & { roomId?: string } = {}): Device {
  return device({ id, name, supremeType: "keypad", capabilities: [], ...extra });
}

function light(id: string, name: string): Device {
  return device({ id, name, supremeType: "dimmer", capabilities: [{ kind: "brightness", config: {} }, { kind: "onoff", config: {} }] });
}

describe("Room page categorization — Keypads (§ Supreme Universal Keypad, Room Integration)", () => {
  it("1/2/3. a keypad from any protocol lands under Keypads, not Lighting/Other/a protocol-specific bucket", () => {
    const cats = categorize([
      keypad("kp-casambi", "Entrance Keypad"),
      keypad("kp-knx", "KNX Bedside Keypad"),
      keypad("kp-lutron", "Lutron Scene Keypad"),
    ]);
    expect(cats).toHaveLength(1);
    expect(cats[0]!.kind).toBe("keypads");
    expect(cats[0]!.devices.map((d) => d.name).sort()).toEqual([
      "Entrance Keypad", "KNX Bedside Keypad", "Lutron Scene Keypad",
    ]);
  });

  it("5. a genuine Casambi on/off light stays under Lighting, unaffected by the keypad category", () => {
    const cats = categorize([light("light-1", "Ceiling Light"), keypad("kp-1", "Sofa Keypad")]);
    const lighting = cats.find((c) => c.kind === "lighting");
    const keypads = cats.find((c) => c.kind === "keypads");
    expect(lighting?.devices.map((d) => d.id)).toEqual(["light-1"]);
    expect(keypads?.devices.map((d) => d.id)).toEqual(["kp-1"]);
  });

  it("6. a genuine on/off actuator (e.g. a KNX relay) is not swept into Keypads just because it has no dimmer/color", () => {
    const relay = device({ id: "relay-1", name: "KNX Relay", supremeType: "switch", capabilities: [{ kind: "onoff", config: {} }] });
    const cats = categorize([relay, keypad("kp-1", "Bedside Keypad")]);
    expect(cats.find((c) => c.kind === "keypads")?.devices.map((d) => d.id)).toEqual(["kp-1"]);
    expect(cats.find((c) => c.kind === "other")?.devices.map((d) => d.id)).toEqual(["relay-1"]);
  });

  it("7. two Casambi networks each with a keypad sharing the same Unit ID both appear independently, distinct devices", () => {
    // Distinct Supreme device ids (as multi-instance addressing already guarantees — see
    // native-driver-factory.ts's scopeCasambiBackendId) is all categorize() needs to see;
    // it never re-derives protocol identity itself.
    const cats = categorize([
      keypad("dev-net1-unit4", "Bedside Keypad", { metadata: { backendId: "casambi:drv_net1:4" } }),
      keypad("dev-net2-unit4", "Bedside Keypad", { metadata: { backendId: "casambi:drv_net2:4" } }),
    ]);
    const keypads = cats.find((c) => c.kind === "keypads");
    expect(keypads?.devices).toHaveLength(2);
    expect(new Set(keypads?.devices.map((d) => d.id)).size).toBe(2);
  });

  it("8. categorization uses supremeType, not a protocol/display-label heuristic — a device named like a light but typed as a keypad still goes to Keypads", () => {
    const trickyName = keypad("kp-tricky", "Living Room Dimmer Panel");
    const cats = categorize([trickyName]);
    expect(cats).toEqual([expect.objectContaining({ kind: "keypads", devices: [trickyName] })]);
  });

  it("4. moving a keypad between rooms is a plain roomId change — categorize() itself is room-scoped by the caller, not by device.roomId filtering internally", () => {
    // The Room page fetches devices already scoped to one room (client.devicesInRoom), so
    // "moving rooms" is exercised at that fetch boundary, not inside categorize(). This proves
    // categorize() itself carries no room-specific state that could leak a keypad into the
    // wrong room's list once its roomId changes.
    const inLiving = keypad("kp-1", "Bedside Keypad", { roomId: "living-room" });
    const inBedroom = { ...inLiving, roomId: "master-bedroom" as RoomId };
    expect(categorize([inLiving])[0]!.devices[0]!.roomId).toBe("living-room");
    expect(categorize([inBedroom])[0]!.devices[0]!.roomId).toBe("master-bedroom");
  });
});

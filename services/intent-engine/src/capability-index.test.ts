import type { Device, DeviceId, RoomId } from "@supreme/domain-model";
import { newId } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import { CapabilityIndex } from "./capability-index.js";

function device(overrides: Partial<Device> & { capabilities: Device["capabilities"] }): Device {
  return {
    id: newId("device") as DeviceId,
    homeId: newId("home") as never,
    roomId: null,
    name: "Device",
    supremeType: "light",
    manufacturer: null,
    model: null,
    driverId: null,
    status: "online",
    state: {},
    metadata: {},
    ...overrides,
  };
}

describe("CapabilityIndex", () => {
  it("finds every device exposing a capability, home-wide", () => {
    const idx = new CapabilityIndex();
    const light = device({ capabilities: [{ kind: "onoff", config: {} }] });
    const blind = device({ capabilities: [{ kind: "position", config: {} }] });
    idx.hydrate([light, blind]);

    expect(idx.devicesWithCapability("onoff").map((d) => d.id)).toEqual([light.id]);
    expect(idx.devicesWithCapability("position").map((d) => d.id)).toEqual([blind.id]);
    expect(idx.devicesWithCapability("media")).toEqual([]);
  });

  it("scopes a capability lookup to one room", () => {
    const idx = new CapabilityIndex();
    const livingRoom = newId("room") as RoomId;
    const kitchen = newId("room") as RoomId;
    const livingLight = device({ roomId: livingRoom, capabilities: [{ kind: "onoff", config: {} }] });
    const kitchenLight = device({ roomId: kitchen, capabilities: [{ kind: "onoff", config: {} }] });
    idx.hydrate([livingLight, kitchenLight]);

    expect(idx.devicesWithCapabilityInRoom("onoff", livingRoom).map((d) => d.id)).toEqual([livingLight.id]);
  });

  it("upsert re-indexes a device whose capabilities changed, dropping stale membership", () => {
    const idx = new CapabilityIndex();
    const dev = device({ capabilities: [{ kind: "onoff", config: {} }] });
    idx.hydrate([dev]);
    expect(idx.devicesWithCapability("onoff")).toHaveLength(1);

    const updated = { ...dev, capabilities: [{ kind: "brightness" as const, config: {} }] };
    idx.upsert(updated);

    expect(idx.devicesWithCapability("onoff")).toEqual([]);
    expect(idx.devicesWithCapability("brightness").map((d) => d.id)).toEqual([dev.id]);
  });

  it("remove drops a device from every capability index", () => {
    const idx = new CapabilityIndex();
    const dev = device({ capabilities: [{ kind: "onoff", config: {} }, { kind: "brightness", config: {} }] });
    idx.hydrate([dev]);

    idx.remove(dev.id);

    expect(idx.devicesWithCapability("onoff")).toEqual([]);
    expect(idx.devicesWithCapability("brightness")).toEqual([]);
    expect(idx.get(dev.id)).toBeNull();
  });

  it("get() returns null for an unindexed device", () => {
    const idx = new CapabilityIndex();
    expect(idx.get(newId("device") as DeviceId)).toBeNull();
  });

  it("size() reports the indexed device count", () => {
    const idx = new CapabilityIndex();
    idx.hydrate([device({ capabilities: [{ kind: "onoff", config: {} }] }), device({ capabilities: [{ kind: "lock", config: {} }] })]);
    expect(idx.size()).toBe(2);
  });
});

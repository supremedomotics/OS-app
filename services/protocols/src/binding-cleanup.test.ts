import type { DeviceId } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import { removeDeviceBindings, removeDeviceStates } from "./binding-cleanup.js";

describe("removeDeviceBindings", () => {
  it("removes only the target device's bindings, preserving the rest in order", () => {
    const a = "device-a" as DeviceId;
    const b = "device-b" as DeviceId;
    const bindings = [
      { deviceId: a, capability: "onoff" },
      { deviceId: b, capability: "onoff" },
      { deviceId: a, capability: "media" },
      { deviceId: b, capability: "media" },
    ];
    removeDeviceBindings(bindings, a);
    expect(bindings).toEqual([
      { deviceId: b, capability: "onoff" },
      { deviceId: b, capability: "media" },
    ]);
  });

  it("is a safe no-op for a device with no bindings", () => {
    const bindings = [{ deviceId: "device-x" as DeviceId, capability: "onoff" }];
    removeDeviceBindings(bindings, "device-never-bound" as DeviceId);
    expect(bindings).toHaveLength(1);
  });
});

describe("removeDeviceStates", () => {
  it("removes only the target device's bindingKey-prefixed entries", () => {
    const states = new Map<string, unknown>([
      ["device-a:onoff", { on: true }],
      ["device-b:onoff", { on: false }],
      ["device-a:media", { volume: 50 }],
    ]);
    removeDeviceStates(states, "device-a" as DeviceId);
    expect([...states.keys()]).toEqual(["device-b:onoff"]);
  });

  it("does not false-positive on a device id that's a prefix of another (e.g. 'device-1' vs 'device-10')", () => {
    const states = new Map<string, unknown>([
      ["device-1:onoff", { on: true }],
      ["device-10:onoff", { on: false }],
    ]);
    removeDeviceStates(states, "device-1" as DeviceId);
    expect([...states.keys()]).toEqual(["device-10:onoff"]);
  });
});

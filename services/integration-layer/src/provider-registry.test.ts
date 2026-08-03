import { describe, expect, it } from "vitest";
import { ProviderRegistry, InMemoryDeviceProviderStore } from "./provider-registry.js";
import { canTransition } from "./device-lifecycle.js";
import type { DeviceId } from "@supreme/domain-model";

describe("device-lifecycle transitions", () => {
  it("allows the documented forward path", () => {
    expect(canTransition("DISCOVERED", "REGISTERED")).toBe(true);
    expect(canTransition("REGISTERED", "UNBOUND")).toBe(true);
    expect(canTransition("UNBOUND", "BINDING")).toBe(true);
    expect(canTransition("BINDING", "BOUND")).toBe(true);
    expect(canTransition("BOUND", "ONLINE")).toBe(true);
    expect(canTransition("ONLINE", "OFFLINE")).toBe(true);
  });

  it("rejects skipping BINDING (no UNBOUND -> ONLINE)", () => {
    expect(canTransition("UNBOUND", "ONLINE")).toBe(false);
  });

  it("REMOVED is terminal", () => {
    expect(canTransition("REMOVED", "DISCOVERED")).toBe(false);
    expect(canTransition("REMOVED", "UNBOUND")).toBe(false);
  });
});

describe("ProviderRegistry", () => {
  it("assign() puts a device in UNBOUND with no fabricated state", async () => {
    const registry = new ProviderRegistry();
    const deviceId = "dev-1" as DeviceId;
    await registry.assign(deviceId, "casambi");
    expect(registry.get(deviceId)).toMatchObject({ provider: "casambi", state: "UNBOUND" });
  });

  it("transition() rejects an invalid jump", async () => {
    const registry = new ProviderRegistry();
    const deviceId = "dev-1" as DeviceId;
    await registry.assign(deviceId, "knx");
    await expect(registry.transition(deviceId, "ONLINE")).rejects.toThrow(/cannot transition/);
  });

  it("transition() follows the real path to ONLINE", async () => {
    const registry = new ProviderRegistry();
    const deviceId = "dev-1" as DeviceId;
    await registry.assign(deviceId, "knx");
    await registry.transition(deviceId, "BINDING");
    await registry.transition(deviceId, "BOUND");
    await registry.transition(deviceId, "ONLINE");
    expect(registry.get(deviceId)?.state).toBe("ONLINE");
  });

  it("transition() without assign() throws", async () => {
    const registry = new ProviderRegistry();
    await expect(registry.transition("dev-x" as DeviceId, "BINDING")).rejects.toThrow(/assign\(\) first/);
  });

  it("persists via store and survives hydrate()", async () => {
    const store = new InMemoryDeviceProviderStore();
    const registry = new ProviderRegistry(store);
    const deviceId = "dev-2" as DeviceId;
    await registry.assign(deviceId, "matter");
    await registry.transition(deviceId, "BINDING");

    const rehydrated = new ProviderRegistry(store);
    await rehydrated.hydrate();
    expect(rehydrated.get(deviceId)).toMatchObject({ provider: "matter", state: "BINDING" });
  });

  it("devicesByProvider() filters correctly", async () => {
    const registry = new ProviderRegistry();
    await registry.assign("a" as DeviceId, "casambi");
    await registry.assign("b" as DeviceId, "knx");
    await registry.assign("c" as DeviceId, "casambi");
    expect(registry.devicesByProvider("casambi").sort()).toEqual(["a", "c"]);
  });

  it("countsByState() reflects assignments and transitions", async () => {
    const registry = new ProviderRegistry();
    await registry.assign("a" as DeviceId, "casambi");
    await registry.assign("b" as DeviceId, "knx");
    await registry.transition("b" as DeviceId, "BINDING");
    const counts = registry.countsByState();
    expect(counts.UNBOUND).toBe(1);
    expect(counts.BINDING).toBe(1);
  });

  it("remove() clears the device", async () => {
    const registry = new ProviderRegistry();
    const deviceId = "dev-1" as DeviceId;
    await registry.assign(deviceId, "casambi");
    await registry.remove(deviceId);
    expect(registry.get(deviceId)).toBeUndefined();
  });
});

import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
} from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import type { BackendStateEvent, DiscoveredDevice, StateListener } from "./adapter.js";
import { SupremeNativeAdapter } from "./native-adapter.js";
import { bindingKey, type INativeProtocolDriver, type ProtocolBinding } from "./protocols/driver.js";

/** A minimal fake protocol driver that records writes and can push bus state up. */
class FakeDriver implements INativeProtocolDriver {
  readonly protocol = "fake";
  connected = false;
  readonly writes: Array<{ deviceId: DeviceId; command: CapabilityCommand }> = [];
  private readonly bound = new Set<string>();
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();

  async connect() {
    this.connected = true;
  }
  async disconnect() {
    this.connected = false;
  }
  isConnected() {
    return this.connected;
  }
  async bind(b: ProtocolBinding) {
    this.bound.add(bindingKey(b.deviceId, b.capability));
    this.devices.add(b.deviceId);
  }
  manages(deviceId: DeviceId) {
    return this.devices.has(deviceId);
  }
  async command(deviceId: DeviceId, command: CapabilityCommand) {
    this.writes.push({ deviceId, command });
  }
  getState(deviceId: DeviceId, capability: CapabilityKind) {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }
  async discover(): Promise<DiscoveredDevice[]> {
    return [{ backendId: "fake.1", suggestedName: "Fake Lamp", capabilities: ["onoff"], raw: {} }];
  }
  onState(listener: StateListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Simulate an inbound bus state report. */
  pushState(deviceId: DeviceId, capability: CapabilityKind, state: CapabilityState) {
    this.states.set(bindingKey(deviceId, capability), state);
    const event: BackendStateEvent = { deviceId, capability, state, ts: new Date().toISOString() };
    for (const l of this.listeners) l(event);
  }
}

describe("SupremeNativeAdapter with protocol drivers", () => {
  it("routes bound-device commands to the driver and surfaces its bus state", async () => {
    const driver = new FakeDriver();
    const adapter = new SupremeNativeAdapter({ drivers: [driver] });
    const events: BackendStateEvent[] = [];
    adapter.onState((e) => events.push(e));
    await adapter.connect();
    expect(driver.isConnected()).toBe(true);

    const dev = "device-knx-1" as DeviceId;
    await adapter.bind({ deviceId: dev, capability: "onoff", address: "fake/lamp" }, "fake");
    expect(adapter.manages(dev)).toBe(true);

    // Command goes out over the driver (no synchronous in-process state echo).
    await adapter.command(dev, { capability: "onoff", action: "on" });
    expect(driver.writes).toHaveLength(1);
    expect(events).toHaveLength(0);

    // The bus reports the new state → it bubbles up as a normalized event + cache.
    driver.pushState(dev, "onoff", { kind: "onoff", on: true });
    expect(events).toHaveLength(1);
    expect(await adapter.getState(dev, "onoff")).toEqual({ kind: "onoff", on: true });
  });

  it("still serves unbound devices from the in-process model", async () => {
    const adapter = new SupremeNativeAdapter({ drivers: [new FakeDriver()] });
    const events: BackendStateEvent[] = [];
    adapter.onState((e) => events.push(e));
    await adapter.connect();

    const dev = "device-virtual-1" as DeviceId;
    await adapter.command(dev, { capability: "onoff", action: "on" });
    // In-process model echoes immediately.
    expect(events).toHaveLength(1);
    expect(await adapter.getState(dev, "onoff")).toEqual({ kind: "onoff", on: true });
  });

  it("aggregates discovery across drivers", async () => {
    const adapter = new SupremeNativeAdapter({ drivers: [new FakeDriver()] });
    await adapter.connect();
    const found = await adapter.discover();
    expect(found.map((d) => d.backendId)).toContain("fake.1");
  });
});

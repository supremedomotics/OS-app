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

  // A driver's manifest can be installed (no license required) without its native protocol
  // actually being wired up at boot — e.g. MQTT needs SUPREME_MQTT_URL configured. Binding a
  // device to that protocol must fail with a clear, client-visible reason, not a bare Error
  // that http-errors.ts's sendError() would otherwise flatten into an opaque "internal error".
  it("fails to bind a device to an unconfigured protocol with a clear, typed error", async () => {
    const adapter = new SupremeNativeAdapter({ drivers: [new FakeDriver()] });
    await adapter.connect();
    await expect(
      adapter.bind({ deviceId: "device-1" as DeviceId, capability: "onoff", address: "z2m/lamp" }, "mqtt"),
    ).rejects.toMatchObject({ code: "backend_unavailable", message: expect.stringContaining("mqtt") });
  });
});

describe("runtime driver registration (manifest↔runtime bridge)", () => {
  it("registers, connects, surfaces state, then unregisters a driver at runtime", async () => {
    const adapter = new SupremeNativeAdapter();
    await adapter.connect();
    expect(adapter.registeredProtocols()).toEqual([]);

    const events: BackendStateEvent[] = [];
    adapter.onState((e) => events.push(e));

    const driver = new FakeDriver();
    await adapter.registerDriver(driver);
    expect(driver.isConnected()).toBe(true);
    expect(adapter.registeredProtocols()).toEqual(["fake"]);
    expect(adapter.protocolStatus()).toEqual([{ protocol: "fake", connected: true, error: null }]);

    // State from the newly-registered driver flows upward.
    const dev = "device-fake-1" as DeviceId;
    driver.pushState(dev, "onoff", { kind: "onoff", on: true });
    expect(events.some((e) => e.deviceId === dev)).toBe(true);

    // Unregister disconnects it and stops state flow.
    await adapter.unregisterProtocol("fake");
    expect(driver.isConnected()).toBe(false);
    expect(adapter.registeredProtocols()).toEqual([]);
    const before = events.length;
    driver.pushState(dev, "onoff", { kind: "onoff", on: false });
    expect(events.length).toBe(before); // no longer wired
  });

  it("replaces an existing driver for the same protocol", async () => {
    const adapter = new SupremeNativeAdapter();
    await adapter.connect();
    const d1 = new FakeDriver();
    const d2 = new FakeDriver();
    await adapter.registerDriver(d1);
    await adapter.registerDriver(d2);
    expect(d1.isConnected()).toBe(false); // replaced → disconnected
    expect(d2.isConnected()).toBe(true);
    expect(adapter.registeredProtocols()).toEqual(["fake"]);
  });
});

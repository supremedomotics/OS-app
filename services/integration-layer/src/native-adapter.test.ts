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
  readonly unbindCalls: DeviceId[] = [];
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
  async unbind(deviceId: DeviceId) {
    this.unbindCalls.push(deviceId);
    this.devices.delete(deviceId);
    for (const k of [...this.bound]) if (k.startsWith(`${deviceId}:`)) this.bound.delete(k);
    for (const k of [...this.states.keys()]) if (k.startsWith(`${deviceId}:`)) this.states.delete(k);
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

describe("SupremeNativeAdapter — unbindDevice (§ Driver Lifecycle Completion)", () => {
  it("calls the owning driver's unbind(), then stops managing/remembering the device", async () => {
    const driver = new FakeDriver();
    const adapter = new SupremeNativeAdapter({ drivers: [driver] });
    await adapter.connect();
    const dev = "device-teardown-1" as DeviceId;
    await adapter.bind({ deviceId: dev, capability: "onoff", address: "fake/lamp" }, "fake");
    driver.pushState(dev, "onoff", { kind: "onoff", on: true });
    expect(adapter.manages(dev)).toBe(true);
    expect(await adapter.getState(dev, "onoff")).not.toBeNull();

    await adapter.unbindDevice(dev);

    expect(driver.unbindCalls).toEqual([dev]);
    expect(adapter.manages(dev)).toBe(false);
    expect(await adapter.getState(dev, "onoff")).toBeNull();
  });

  it("is a safe no-op for a device with no native owner (never bound, or already unbound)", async () => {
    const driver = new FakeDriver();
    const adapter = new SupremeNativeAdapter({ drivers: [driver] });
    await adapter.connect();
    await expect(adapter.unbindDevice("device-never-bound" as DeviceId)).resolves.toBeUndefined();
    expect(driver.unbindCalls).toEqual([]);
  });

  it("is idempotent — calling it twice for the same device never throws and never double-calls the driver", async () => {
    const driver = new FakeDriver();
    const adapter = new SupremeNativeAdapter({ drivers: [driver] });
    await adapter.connect();
    const dev = "device-teardown-2" as DeviceId;
    await adapter.bind({ deviceId: dev, capability: "onoff", address: "fake/lamp" }, "fake");
    await adapter.unbindDevice(dev);
    await expect(adapter.unbindDevice(dev)).resolves.toBeUndefined();
    // The driver itself is only asked once — the adapter already forgot the owner
    // after the first call, so the second call has nothing to delegate to.
    expect(driver.unbindCalls).toEqual([dev]);
  });

  it("tolerates a driver with no unbind() implementation at all (not every driver is migrated yet)", async () => {
    const driver = new FakeDriver();
    // Simulate a driver that hasn't implemented the optional unbind() method yet —
    // override the instance's own property to undefined, shadowing the class method.
    (driver as unknown as { unbind?: unknown }).unbind = undefined;
    const adapter = new SupremeNativeAdapter({ drivers: [driver] });
    await adapter.connect();
    const dev = "device-legacy-1" as DeviceId;
    await adapter.bind({ deviceId: dev, capability: "onoff", address: "fake/lamp" }, "fake");
    await expect(adapter.unbindDevice(dev)).resolves.toBeUndefined();
    expect(adapter.manages(dev)).toBe(false); // still forgets it at the adapter level
  });
});

describe("SupremeNativeAdapter — repeated bind/unbind and rebind (§ Driver Lifecycle Completion)", () => {
  it("50 bind→unbind cycles on the SAME driver instance never accumulate bindings or state", async () => {
    const driver = new FakeDriver();
    const adapter = new SupremeNativeAdapter({ drivers: [driver] });
    await adapter.connect();
    const dev = "device-cycle-1" as DeviceId;

    for (let i = 0; i < 50; i++) {
      await adapter.bind({ deviceId: dev, capability: "onoff", address: "fake/lamp" }, "fake");
      driver.pushState(dev, "onoff", { kind: "onoff", on: true });
      expect(adapter.manages(dev)).toBe(true);
      await adapter.unbindDevice(dev);
      expect(adapter.manages(dev)).toBe(false);
      expect(await adapter.getState(dev, "onoff")).toBeNull();
    }
    // Every cycle's unbind reached the driver exactly once — none skipped, none doubled.
    expect(driver.unbindCalls).toHaveLength(50);
  });

  it("supports Rebind (Unbind → Bind → Reconnect → Continue) without recreating the driver object", async () => {
    const driver = new FakeDriver();
    const adapter = new SupremeNativeAdapter({ drivers: [driver] });
    await adapter.connect();
    const dev = "device-rebind-1" as DeviceId;

    await adapter.bind({ deviceId: dev, capability: "onoff", address: "fake/lamp" }, "fake");
    driver.pushState(dev, "onoff", { kind: "onoff", on: true });
    expect(await adapter.getState(dev, "onoff")).toEqual({ kind: "onoff", on: true });

    await adapter.unbindDevice(dev);
    expect(adapter.manages(dev)).toBe(false);

    // Rebind the SAME device to the SAME driver instance (never a new FakeDriver()).
    await adapter.bind({ deviceId: dev, capability: "onoff", address: "fake/lamp" }, "fake");
    expect(adapter.manages(dev)).toBe(true);
    expect(driver.isConnected()).toBe(true); // still the original connection, never torn down

    // Continue: commands and state flow normally post-rebind.
    await adapter.command(dev, { capability: "onoff", action: "off" });
    expect(driver.writes.at(-1)).toEqual({ deviceId: dev, command: { capability: "onoff", action: "off" } });
    driver.pushState(dev, "onoff", { kind: "onoff", on: false });
    expect(await adapter.getState(dev, "onoff")).toEqual({ kind: "onoff", on: false });
  });

  it("a reconnect storm (rapid repeated connect() calls) never accumulates duplicate state listeners", async () => {
    const driver = new FakeDriver();
    const adapter = new SupremeNativeAdapter({ drivers: [driver] });
    const events: BackendStateEvent[] = [];
    adapter.onState((e) => events.push(e));

    // Simulate a reconnect storm hitting the SIL boundary: connect() called many times in
    // quick succession (e.g. flapping boot/reconnect signals) with no intervening disconnect().
    for (let i = 0; i < 20; i++) await adapter.connect();

    const dev = "device-storm-1" as DeviceId;
    await adapter.bind({ deviceId: dev, capability: "onoff", address: "fake/lamp" }, "fake");
    driver.pushState(dev, "onoff", { kind: "onoff", on: true });
    // Exactly one event per push — no listener duplication from the repeated connect() calls.
    expect(events.filter((e) => e.deviceId === dev)).toHaveLength(1);
  });

  it("connect() → disconnect() → connect() cleanly re-wires exactly once each time (no duplication across a real reconnect)", async () => {
    const driver = new FakeDriver();
    const adapter = new SupremeNativeAdapter({ drivers: [driver] });
    const events: BackendStateEvent[] = [];
    adapter.onState((e) => events.push(e));

    for (let i = 0; i < 5; i++) {
      await adapter.connect();
      await adapter.disconnect();
    }
    await adapter.connect();
    expect(driver.isConnected()).toBe(true);

    const dev = "device-storm-2" as DeviceId;
    await adapter.bind({ deviceId: dev, capability: "onoff", address: "fake/lamp" }, "fake");
    driver.pushState(dev, "onoff", { kind: "onoff", on: true });
    expect(events.filter((e) => e.deviceId === dev)).toHaveLength(1);
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

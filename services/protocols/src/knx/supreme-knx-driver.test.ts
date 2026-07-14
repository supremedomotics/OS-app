import { newId, type DeviceId } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import { SupremeKnxDriver } from "./supreme-knx-driver.js";
import { KnxTaskRouter } from "./task-router.js";
import type { IKnxProvider, KnxTask, ProviderDiagnostics, ProviderHealth } from "./provider.js";
import type { DiscoveredDevice } from "@supreme/integration-layer";

/** A fake provider standing in for KnxUltimateProvider — proves the driver/router
 * delegate correctly without a real KNX bus. */
class FakeKnxProvider implements IKnxProvider {
  readonly name = "fake";
  connected = false;
  writes: KnxTask[] = [];
  private observers = new Map<string, (value: unknown) => void>();

  async initialize(): Promise<void> {}
  async discover(): Promise<DiscoveredDevice[]> { return []; }
  async connect(): Promise<void> { this.connected = true; }
  async disconnect(): Promise<void> { this.connected = false; }
  async shutdown(): Promise<void> { this.connected = false; }
  async execute(task: KnxTask): Promise<unknown> {
    if (task.kind === "bus.group_write") { this.writes.push(task); return undefined; }
    throw new Error(`unsupported: ${task.kind}`);
  }
  subscribe(ga: string, _dpt: string, handler: (value: unknown) => void): void { this.observers.set(ga, handler); }
  unsubscribe(ga: string): void { this.observers.delete(ga); }
  health(): ProviderHealth { return { connected: this.connected, lastError: null }; }
  diagnostics(): ProviderDiagnostics {
    return { provider: this.name, connected: this.connected, packetsSent: this.writes.length, packetsReceived: 0, lastTelegramAt: null, lastCommandAt: null, lastError: null, reconnectAttempts: 0 };
  }
  /** Test helper: simulate a status telegram arriving on the bus. */
  emit(ga: string, value: unknown): void { this.observers.get(ga)?.(value); }
}

describe("KnxTaskRouter", () => {
  it("routes a task to the provider registered for its kind", async () => {
    const router = new KnxTaskRouter();
    const provider = new FakeKnxProvider();
    router.register("bus.group_write", provider);
    await router.execute({ kind: "bus.group_write", groupAddress: "1/1/1", dpt: "1.001", value: true });
    expect(provider.writes).toHaveLength(1);
  });

  it("throws for an unregistered task kind rather than silently no-op'ing", async () => {
    const router = new KnxTaskRouter();
    await expect(router.execute({ kind: "bus.group_read", groupAddress: "1/1/1", dpt: "1.001" })).rejects.toThrow(/no provider registered/);
  });
});

describe("SupremeKnxDriver", () => {
  it("owns devices itself — manages() reflects the driver's bindings, not the provider", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    const deviceId = newId("device") as DeviceId;
    expect(driver.manages(deviceId)).toBe(false);
    await driver.bind({ deviceId, capability: "onoff", address: "1/1/1" });
    expect(driver.manages(deviceId)).toBe(true);
  });

  it("writes commands through the task router to the provider, never directly", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    await driver.connect();
    const deviceId = newId("device") as DeviceId;
    await driver.bind({ deviceId, capability: "onoff", address: "1/1/1" });
    await driver.command(deviceId, { capability: "onoff", action: "on" });
    expect(provider.writes).toHaveLength(1);
    expect(provider.writes[0]).toMatchObject({ kind: "bus.group_write", groupAddress: "1/1/1" });
  });

  it("reflects a real status telegram from the provider as Supreme state", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    const deviceId = newId("device") as DeviceId;
    await driver.bind({ deviceId, capability: "onoff", address: "1/1/1" });
    await driver.connect();
    const events: unknown[] = [];
    driver.onState((e) => events.push(e));
    provider.emit("1/1/1", true);
    expect(events).toHaveLength(1);
    expect(driver.getState(deviceId, "onoff")).toMatchObject({ on: true });
  });

  it("diagnostics aggregates real provider counters, never fabricated numbers", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    await driver.connect();
    const deviceId = newId("device") as DeviceId;
    await driver.bind({ deviceId, capability: "onoff", address: "1/1/1" });
    await driver.command(deviceId, { capability: "onoff", action: "on" });
    const diag = driver.diagnostics();
    expect(diag.deviceCount).toBe(1);
    expect(diag.bindingCount).toBe(1);
    expect(diag.providers[0]?.packetsSent).toBe(1);
  });
});

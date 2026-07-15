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
  reads: string[] = [];
  failReads = false;
  private observers = new Map<string, (value: unknown) => void>();
  private stateListeners = new Set<(state: string, previous: string) => void>();

  async initialize(): Promise<void> {}
  async discover(): Promise<DiscoveredDevice[]> { return []; }
  async connect(): Promise<void> { this.connected = true; }
  async disconnect(): Promise<void> { this.connected = false; }
  async shutdown(): Promise<void> { this.connected = false; }
  async execute(task: KnxTask): Promise<unknown> {
    if (task.kind === "bus.group_write") { this.writes.push(task); return undefined; }
    if (task.kind === "bus.group_read") {
      if (this.failReads) throw new Error("read failed");
      this.reads.push(task.groupAddress);
      return undefined;
    }
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

  /** Present on this fake to test SupremeKnxDriver's feature-detected sync-on-reconnect
   * wiring (§ Phase 7 State Synchronization). */
  onConnectionStateChange(listener: (state: string, previous: string) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
  /** Test helper: simulate the Connection Manager reporting a (re)connect. */
  fireConnectionState(state: string, previous: string): void {
    for (const l of this.stateListeners) l(state, previous);
  }
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
    expect(diag.unifiedDeviceCount).toBeNull(); // discoverUnified() never ran this test
  });
});

/** A fake KNX IoT provider — proves discoverUnified() runs the full pipeline (KNX IoT
 * discovery → functional blocks → grouping → capability detection → merged device)
 * through the driver, without a real CoAP network. */
class FakeKnxIotProvider implements IKnxProvider {
  readonly name = "fake-knx-iot";
  async initialize(): Promise<void> {}
  async discover(): Promise<DiscoveredDevice[]> {
    return [{ backendId: "knx-iot:10.0.0.42", suggestedName: "10.0.0.42", capabilities: [], raw: { host: "10.0.0.42", linkFormat: '</dev>;title="Kitchen Light"', source: "knx-iot" } }];
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async shutdown(): Promise<void> {}
  async execute(task: KnxTask): Promise<unknown> {
    if (task.kind === "discovery.functional_blocks") {
      return '</fb/1/sw>;rt="urn:knx:fb.onoff";if="if.a";title="Kitchen Light",</fb/1/dim>;rt="urn:knx:fb.dim";if="if.a";title="Kitchen Light Dim"';
    }
    throw new Error(`unsupported: ${task.kind}`);
  }
  subscribe(): void { throw new Error("not applicable"); }
  unsubscribe(): void {}
  health(): ProviderHealth { return { connected: true, lastError: null }; }
  diagnostics(): ProviderDiagnostics {
    return { provider: this.name, connected: true, packetsSent: 0, packetsReceived: 0, lastTelegramAt: null, lastCommandAt: null, lastError: null, reconnectAttempts: 0 };
  }
}

describe("SupremeKnxDriver.discoverUnified", () => {
  it("runs the full Unified Device Pipeline: KNX IoT discovery + functional blocks + ETS + grouping → one merged Supreme device", async () => {
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: new FakeKnxProvider(), iotProvider: new FakeKnxIotProvider() });
    const devices = await driver.discoverUnified([{ id: "10.0.0.42", name: "Kitchen Light SW", room: "Kitchen" }]);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.suggestedName).toBe("Kitchen Light");
    expect(devices[0]?.capabilities).toEqual(expect.arrayContaining(["onoff", "brightness"]));
    expect(devices[0]?.raw.metadata.room).toBe("Kitchen");

    const diag = driver.diagnostics();
    expect(diag.transportProvider).toBe("fake"); // KnxUltimateProvider's name (§ diagnostics)
    expect(diag.metadataProvider).toBe("fake-knx-iot");
    expect(diag.unifiedDeviceCount).toBe(1);
    expect(diag.unifiedCapabilityCount).toBeGreaterThan(0);
    expect(diag.lastFunctionalBlockUpdate).not.toBeNull();
    expect(diag.lastMetadataSync).not.toBeNull();
  });
});

describe("SupremeKnxDriver.syncAll (§ Phase 7 State Synchronization)", () => {
  it("issues a real group-read for every bound device's status address, never waiting for a spontaneous telegram", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    await driver.connect();
    const d1 = newId("device") as DeviceId;
    const d2 = newId("device") as DeviceId;
    await driver.bind({ deviceId: d1, capability: "onoff", address: "1/1/1" });
    await driver.bind({ deviceId: d2, capability: "brightness", address: "1/1/2", config: { statusAddress: "1/1/3" } });

    const result = await driver.syncAll();
    expect(result).toEqual({ requested: 2, failed: 0 });
    expect(provider.reads.sort()).toEqual(["1/1/1", "1/1/3"]);

    const diag = driver.diagnostics();
    expect(diag.lastSyncCount).toBe(2);
    expect(diag.lastSyncErrorCount).toBe(0);
    expect(diag.lastSyncAt).not.toBeNull();
  });

  it("one binding's read failure never blocks the rest from syncing", async () => {
    const provider = new FakeKnxProvider();
    provider.failReads = true;
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    await driver.connect();
    await driver.bind({ deviceId: newId("device") as DeviceId, capability: "onoff", address: "1/1/1" });
    await driver.bind({ deviceId: newId("device") as DeviceId, capability: "onoff", address: "1/1/2" });
    const result = await driver.syncAll();
    expect(result).toEqual({ requested: 2, failed: 2 });
  });

  it("automatically syncs whenever the transport provider reports a (re)connect, without being told to", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    await driver.connect();
    await driver.bind({ deviceId: newId("device") as DeviceId, capability: "onoff", address: "1/1/1" });

    expect(driver.diagnostics().lastSyncAt).toBeNull(); // nothing triggered a sync yet
    provider.fireConnectionState("connected", "recovering"); // simulate the Connection Manager's real reconnect event
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget syncAll() settle
    expect(driver.diagnostics().lastSyncAt).not.toBeNull();
    expect(provider.reads).toEqual(["1/1/1"]);
  });
});

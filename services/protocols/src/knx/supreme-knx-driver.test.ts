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
  isSubscribed(ga: string): boolean { return this.observers.has(ga); }
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

  it("§ PASS 20 diagnostic (Part D) — diagnostics().lastRecordedState reflects real feedback that changed state", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    const deviceId = newId("device") as DeviceId;
    await driver.bind({ deviceId, capability: "onoff", address: "1/1/1", config: { statusAddress: "1/1/2" } });
    await driver.connect();
    expect(driver.diagnostics().lastRecordedState).toBeNull(); // nothing recorded yet
    provider.emit("1/1/2", true); // real feedback on the status GA
    const snap = driver.diagnostics().lastRecordedState;
    expect(snap?.deviceId).toBe(deviceId);
    expect(snap?.capability).toBe("onoff");
    expect(snap?.kind).toBe("onoff");
  });

  it("§ PASS 20 diagnostic (Part D) — feedback that doesn't change state (dedup) does not update lastRecordedState", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    const deviceId = newId("device") as DeviceId;
    await driver.bind({ deviceId, capability: "onoff", address: "1/1/1", config: { statusAddress: "1/1/2" } });
    await driver.connect();
    provider.emit("1/1/2", true);
    const first = driver.diagnostics().lastRecordedState;
    provider.emit("1/1/2", true); // identical value — deduped by record()'s own existing guard
    expect(driver.diagnostics().lastRecordedState?.ts).toBe(first?.ts); // unchanged, not a new record
  });

  it("§ Live Feedback Diagnostic Pass — knxFeedbackDiagnostics() composes provider counters, binding, subscription, and last matched/recorded state for one device", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    const deviceId = newId("device") as DeviceId;
    await driver.bind({ deviceId, capability: "onoff", address: "1/1/1", config: { statusAddress: "1/1/2" } });
    await driver.connect();

    // Nothing has arrived yet.
    const before = driver.knxFeedbackDiagnostics(deviceId);
    expect(before?.connected).toBe(true);
    expect(before?.binding).toEqual({ writeGa: "1/1/1", statusGa: "1/1/2", extraStatusGas: [], dpt: expect.any(String) });
    expect(before?.isSubscribed).toBe(true); // observe() subscribed the status GA on connect()
    expect(before?.lastMatchedFeedback).toBeNull();
    expect(before?.lastRecordedState).toBeNull();

    provider.emit("1/1/2", true);
    const after = driver.knxFeedbackDiagnostics(deviceId);
    expect(after?.lastMatchedFeedback).toMatchObject({ deviceId, capability: "onoff", destination: "1/1/2", value: true });
    expect(after?.lastRecordedState).toMatchObject({ deviceId, capability: "onoff", kind: "onoff" });
  });

  it("§ Live Feedback Diagnostic Pass — knxFeedbackDiagnostics() is null for a device this driver doesn't manage", () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    expect(driver.knxFeedbackDiagnostics(newId("device") as DeviceId)).toBeNull();
  });

  it("§ Live Feedback Diagnostic Pass — isSubscribedToGa() and getBindingInfo()/getRuntimeBinding() report the real, resolved runtime binding, not guessed", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    const deviceId = newId("device") as DeviceId;
    expect(driver.isSubscribedToGa("1/1/2")).toBe(false);
    await driver.bind({ deviceId, capability: "onoff", address: "1/1/1", config: { statusAddress: "1/1/2" } });
    await driver.connect();
    expect(driver.isSubscribedToGa("1/1/2")).toBe(true);
    expect(driver.isSubscribedToGa("9/9/9")).toBe(false); // an unrelated, unbound GA
    expect(driver.getRuntimeBinding(deviceId, "onoff")).toEqual({ writeGa: "1/1/1", statusGa: "1/1/2", extraStatusGas: [], dpt: expect.any(String) });
    expect(driver.getBindingInfo(deviceId)).toEqual([
      { capability: "onoff", writeGa: "1/1/1", statusGa: "1/1/2", extraStatusGas: [], dpt: expect.any(String) },
    ]);
    expect(driver.getBindingInfo(newId("device") as DeviceId)).toEqual([]); // unbound device — empty, never fabricated
  });
});

describe("SupremeKnxDriver.getCapabilityConfig (§ PASS 17 — structural colorModes from the real DPT)", () => {
  it("a color binding with DPT7.600 (absolute Kelvin) reports cct-only, never RGB", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    const deviceId = newId("device") as DeviceId;
    await driver.bind({ deviceId, capability: "color", address: "5/3/5", config: { dpt: "DPT7.600" } });
    expect(driver.getCapabilityConfig?.(deviceId, "color")).toEqual({ colorModes: { rgb: false, cct: true } });
  });

  it("a color binding with DPT232.600 (RGB) reports rgb-only, never CCT", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    const deviceId = newId("device") as DeviceId;
    await driver.bind({ deviceId, capability: "color", address: "2/1/1", config: { dpt: "DPT232.600" } });
    expect(driver.getCapabilityConfig?.(deviceId, "color")).toEqual({ colorModes: { rgb: true, cct: false } });
  });

  it("a color binding with DPT251.600 (RGBW) reports rgb-only (Supreme's ColorState has no white channel)", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    const deviceId = newId("device") as DeviceId;
    await driver.bind({ deviceId, capability: "color", address: "2/1/2", config: { dpt: "DPT251.600" } });
    expect(driver.getCapabilityConfig?.(deviceId, "color")).toEqual({ colorModes: { rgb: true, cct: false } });
  });

  // § Live-reproduced bug fix — a real "Conference Hanging" fixture with a genuine 2-byte
  // Kelvin colour-temperature object (DPST-9-22 / DPT9.022) fell through this switch
  // entirely (only DPT7 was recognized as CCT), returning null and leaving the frontend's
  // live-state fallback stuck on "unknown" — showing neither a CCT slider nor an RGB wheel.
  it("a color binding with DPT9.022 (2-byte Kelvin) reports cct-only, never RGB", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    const deviceId = newId("device") as DeviceId;
    await driver.bind({ deviceId, capability: "color", address: "5/3/6", config: { dpt: "DPT9.022" } });
    expect(driver.getCapabilityConfig?.(deviceId, "color")).toEqual({ colorModes: { rgb: false, cct: true } });
  });

  it("a color binding with DPT233.600 (RGB, 3x1-byte) reports rgb-only, never CCT", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    const deviceId = newId("device") as DeviceId;
    await driver.bind({ deviceId, capability: "color", address: "2/1/3", config: { dpt: "DPT233.600" } });
    expect(driver.getCapabilityConfig?.(deviceId, "color")).toEqual({ colorModes: { rgb: true, cct: false } });
  });

  it("returns null for a non-color capability", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    const deviceId = newId("device") as DeviceId;
    await driver.bind({ deviceId, capability: "onoff", address: "1/1/1" });
    expect(driver.getCapabilityConfig?.(deviceId, "onoff")).toBeNull();
  });

  it("returns null for an unmanaged device — never fabricated", () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    expect(driver.getCapabilityConfig?.(newId("device") as DeviceId, "color")).toBeNull();
  });
});

describe("SupremeKnxDriver.unbind (§ Driver Lifecycle Completion)", () => {
  it("unsubscribes the status GA — a later telegram no longer resurrects state for the unbound device", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    await driver.connect();
    const deviceId = newId("device") as DeviceId;
    await driver.bind({ deviceId, capability: "onoff", address: "1/1/1" });
    provider.emit("1/1/1", true);
    expect(driver.getState(deviceId, "onoff")).toMatchObject({ on: true });

    await driver.unbind(deviceId);
    expect(driver.manages(deviceId)).toBe(false);
    expect(driver.getState(deviceId, "onoff")).toBeNull();

    const events: unknown[] = [];
    driver.onState((e) => events.push(e));
    provider.emit("1/1/1", false);
    expect(events).toEqual([]);
    expect(driver.getState(deviceId, "onoff")).toBeNull();
  });

  it("does not unsubscribe a status GA still shared by another bound device/capability", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    await driver.connect();
    const devA = newId("device") as DeviceId;
    const devB = newId("device") as DeviceId;
    // Both devices bound to the same status GA (unusual but possible — a shared sensor GA).
    await driver.bind({ deviceId: devA, capability: "onoff", address: "1/1/1" });
    await driver.bind({ deviceId: devB, capability: "onoff", address: "1/1/1" });

    await driver.unbind(devA);
    expect(driver.manages(devA)).toBe(false);

    const events: unknown[] = [];
    driver.onState((e) => events.push(e));
    provider.emit("1/1/1", true);
    expect(events).toHaveLength(1); // devB's binding is still live
    expect(driver.getState(devB, "onoff")).toMatchObject({ on: true });
  });

  it("evicts this device's still-queued offline commands, leaving another device's queue intact", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    // Deliberately never connected — both commands queue offline.
    const devA = newId("device") as DeviceId;
    const devB = newId("device") as DeviceId;
    await driver.bind({ deviceId: devA, capability: "onoff", address: "1/1/1" });
    await driver.bind({ deviceId: devB, capability: "onoff", address: "1/1/2" });
    await driver.command(devA, { capability: "onoff", action: "on" });
    await driver.command(devB, { capability: "onoff", action: "on" });
    expect(driver.diagnostics().queuedCommandCount).toBe(2);

    await driver.unbind(devA);
    expect(driver.diagnostics().queuedCommandCount).toBe(1);

    await driver.connect();
    const result = await driver.drainOfflineQueue();
    expect(result).toEqual({ executed: 1, expired: 0 });
    expect(provider.writes).toHaveLength(1);
    expect(provider.writes[0]).toMatchObject({ groupAddress: "1/1/2" });
  });

  it("is idempotent — a second unbind of an already-unbound device is a safe no-op", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    await driver.connect();
    const deviceId = newId("device") as DeviceId;
    await driver.bind({ deviceId, capability: "onoff", address: "1/1/1" });
    await driver.unbind(deviceId);
    await expect(driver.unbind(deviceId)).resolves.toBeUndefined();
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

describe("SupremeKnxDriver offline command queue (§ Enterprise Reliability — Queue Recovery)", () => {
  it("queues a command issued while disconnected instead of throwing, and reflects it optimistically", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    // Deliberately never connected.
    const deviceId = newId("device") as DeviceId;
    await driver.bind({ deviceId, capability: "onoff", address: "1/1/1" });
    await driver.command(deviceId, { capability: "onoff", action: "on" });
    expect(provider.writes).toEqual([]); // nothing sent to the bus yet — offline
    expect(driver.diagnostics().queuedCommandCount).toBe(1);
    expect(driver.getState(deviceId, "onoff")).toMatchObject({ on: true }); // optimistic UI reflection
  });

  it("MERGE: turning a light on then off while offline only ever applies OFF once reconnected", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    const deviceId = newId("device") as DeviceId;
    await driver.bind({ deviceId, capability: "onoff", address: "1/1/1" });
    await driver.command(deviceId, { capability: "onoff", action: "on" });
    await driver.command(deviceId, { capability: "onoff", action: "off" });
    expect(driver.diagnostics().queuedCommandCount).toBe(1); // superseded, not appended

    const result = await driver.drainOfflineQueue();
    expect(result).toEqual({ executed: 1, expired: 0 });
    expect(provider.writes).toHaveLength(1);
    expect(provider.writes[0]).toMatchObject({ value: false }); // OFF won — ON was superseded, never sent
  });

  it("drainOfflineQueue() runs every queued command through the real write path exactly once", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    const d1 = newId("device") as DeviceId;
    const d2 = newId("device") as DeviceId;
    await driver.bind({ deviceId: d1, capability: "onoff", address: "1/1/1" });
    await driver.bind({ deviceId: d2, capability: "onoff", address: "1/1/2" });
    await driver.command(d1, { capability: "onoff", action: "on" });
    await driver.command(d2, { capability: "onoff", action: "off" });

    await driver.connect(); // now actually connected
    const result = await driver.drainOfflineQueue();
    expect(result).toEqual({ executed: 2, expired: 0 });
    expect(provider.writes).toHaveLength(2);
    expect(driver.diagnostics().queuedCommandCount).toBe(0);
    expect(driver.diagnostics().lastQueueDrainResult).toEqual({ executed: 2, expired: 0 });
  });

  it("automatically drains the queue whenever the transport provider reports a (re)connect", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    const deviceId = newId("device") as DeviceId;
    await driver.bind({ deviceId, capability: "onoff", address: "1/1/1" });
    await driver.command(deviceId, { capability: "onoff", action: "on" });
    expect(driver.diagnostics().queuedCommandCount).toBe(1);

    await driver.connect();
    provider.fireConnectionState("connected", "recovering");
    await new Promise((r) => setTimeout(r, 0));
    expect(driver.diagnostics().queuedCommandCount).toBe(0);
    expect(provider.writes).toHaveLength(1);
  });
});

import { describe, it, expect } from "vitest";
import type { CapabilityCommand, CapabilityState, DeviceCapability, DeviceId } from "@supreme/domain-model";
import { MatterBridgeDriver } from "./matter-bridge-driver.js";
import { InMemoryMatterEndpointStore, MatterEndpointRegistry } from "./endpoint-registry.js";
import type { MatterBridgeServer, MatterBridgeEndpointSpec } from "./server.js";
import type { MatterBridgeCapabilityPort } from "./capability-port.js";

const ONOFF_CAPS: DeviceCapability[] = [{ kind: "onoff", config: {} }];

/** § Matter Bridge Phase 1.1 — same fake as the other driver-level test files, but this one
 * also tracks calls to `removeEndpoint` so a test can assert the real Matter endpoint was
 * genuinely torn down (not merely dropped from a higher-level index). */
class FakeMatterBridgeServer implements MatterBridgeServer {
  started = false;
  endpoints = new Map<number, { name: string; on: boolean }>();
  removedEndpointNumbers: number[] = [];
  private commandListeners = new Set<(endpointNumber: number, command: CapabilityCommand) => void>();

  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.started = false;
  }
  async addEndpoint(spec: MatterBridgeEndpointSpec): Promise<void> {
    const on = spec.initialState && "on" in spec.initialState ? spec.initialState.on : false;
    this.endpoints.set(spec.endpointNumber, { name: spec.name, on });
  }
  async removeEndpoint(endpointNumber: number): Promise<void> {
    this.endpoints.delete(endpointNumber);
    this.removedEndpointNumbers.push(endpointNumber);
  }
  async setCapabilityState(endpointNumber: number, state: CapabilityState): Promise<void> {
    const e = this.endpoints.get(endpointNumber);
    if (e && "on" in state) e.on = state.on;
  }
  async updateEndpointName(endpointNumber: number, name: string): Promise<void> {
    const e = this.endpoints.get(endpointNumber);
    if (e) e.name = name;
  }
  onCommand(listener: (endpointNumber: number, command: CapabilityCommand) => void): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }
  getCommissioningState() {
    return { commissioned: false, fabricCount: 0, commissioningWindowOpen: true, fabrics: [], pairing: { manualPairingCode: "34970112332", qrPairingCode: "MT:FAKE", discriminator: 3840 } };
  }
  async factoryReset() {
    this.endpoints.clear();
  }
}

class FakeCapabilityPort implements MatterBridgeCapabilityPort {
  states = new Map<DeviceId, CapabilityState>();
  async command(): Promise<void> {}
  async getState(): Promise<CapabilityState | null> {
    return null;
  }
  onState(): () => void {
    return () => {};
  }
}

function device(id: string, name: string): { id: DeviceId; name: string; capabilities: DeviceCapability[] } {
  return { id: id as DeviceId, name, capabilities: ONOFF_CAPS };
}

describe("MatterBridgeDriver.reconcile — § Matter Bridge Phase 1.1 (the reported ghost-device bug)", () => {
  it("§ the exact reported bug — a device removed from SupremeOS is withdrawn from the live Matter endpoint, not left bridged forever", async () => {
    const server = new FakeMatterBridgeServer();
    const registry = new MatterEndpointRegistry(new InMemoryMatterEndpointStore());
    const driver = new MatterBridgeDriver({ server, registry, capabilities: new FakeCapabilityPort() });
    await driver.start();

    // 1. Add device A, reconcile, assert endpoint A exists.
    let result = await driver.reconcile([device("device-a", "Device A")]);
    expect(result.added).toEqual(["device-a"]);
    expect(server.endpoints.size).toBe(1);
    const endpointA = registry.resolve("device-a" as DeviceId).endpointNumber;
    expect(server.endpoints.has(endpointA)).toBe(true);

    // 4. Remove device A from SupremeOS (simply stop passing it), reconcile.
    result = await driver.reconcile([]);
    // 6. Assert endpoint A no longer exists on the live Matter server.
    expect(result.removed).toEqual(["device-a"]);
    expect(server.endpoints.has(endpointA)).toBe(false);
    expect(server.removedEndpointNumbers).toContain(endpointA);
    // 7. Assert endpoint A is removed from persistence.
    expect(registry.all().find((m) => m.deviceId === "device-a")).toBeUndefined();
    // 8/9. Assert endpoint A is absent from the API-facing exposure list (what the Bridged
    // Devices UI's data ultimately comes from).
    expect(driver.listExposedDevices().find((e) => e.deviceId === "device-a")).toBeUndefined();
  });

  it("removing B out of A+B+C leaves A and C exposed at their SAME endpoint identity — reconciliation never rebuilds unchanged endpoints", async () => {
    const server = new FakeMatterBridgeServer();
    const registry = new MatterEndpointRegistry(new InMemoryMatterEndpointStore());
    const driver = new MatterBridgeDriver({ server, registry, capabilities: new FakeCapabilityPort() });
    await driver.start();

    await driver.reconcile([device("a", "A"), device("b", "B"), device("c", "C")]);
    const endpointA = registry.resolve("a" as DeviceId).endpointNumber;
    const endpointB = registry.resolve("b" as DeviceId).endpointNumber;
    const endpointC = registry.resolve("c" as DeviceId).endpointNumber;
    server.removedEndpointNumbers = []; // only care about what THIS reconcile pass removes

    const result = await driver.reconcile([device("a", "A"), device("c", "C")]);

    expect(result.removed).toEqual(["b"]);
    expect(result.added).toEqual([]);
    // A and C are reconciled again (already-exposed devices are idempotently re-confirmed,
    // not skipped) but never REBUILT — `addEndpoint` on the real server is itself idempotent
    // for an unchanged endpoint number (`if (this.endpoints.has(...)) return;`), and the proof
    // that follows is what actually matters: neither A's nor C's endpoint was ever passed to
    // `removeEndpoint`, and both keep their exact same endpoint number.
    expect(result.updated.slice().sort()).toEqual(["a", "c"]);
    // ONLY B's endpoint was torn down on the live server — A and C were never touched.
    expect(server.removedEndpointNumbers).toEqual([endpointB]);
    // A and C endpoint identity unchanged.
    expect(registry.resolve("a" as DeviceId).endpointNumber).toBe(endpointA);
    expect(registry.resolve("c" as DeviceId).endpointNumber).toBe(endpointC);
    expect(server.endpoints.has(endpointA)).toBe(true);
    expect(server.endpoints.has(endpointC)).toBe(true);
    // B's endpoint genuinely removed and forgotten.
    expect(registry.all().find((m) => m.deviceId === "b")).toBeUndefined();
  });

  it("§ restart safety — a device removed while the bridge is running, then the gateway restarts (fresh driver over the SAME persisted registry), never resurrects", async () => {
    const store = new InMemoryMatterEndpointStore();
    const server = new FakeMatterBridgeServer();
    const capabilities = new FakeCapabilityPort();

    const driver1 = new MatterBridgeDriver({ server, registry: new MatterEndpointRegistry(store), capabilities });
    await driver1.start();
    await driver1.reconcile([device("a", "A"), device("b", "B"), device("c", "C")]);
    await driver1.reconcile([device("a", "A"), device("c", "C")]); // B removed while running
    await driver1.stop();

    // Fresh driver instance over the SAME store — a real gateway restart.
    const driver2 = new MatterBridgeDriver({ server, registry: new MatterEndpointRegistry(store), capabilities });
    await driver2.start(); // re-exposes from the (already-pruned) persisted registry
    // start()'s own re-expose loop only knows about the registry — B's record is gone, so it
    // can never come back purely from restart.
    expect(driver2.listExposedDevices().find((e) => e.deviceId === "b")).toBeUndefined();

    // The gateway's own boot sequence also reconciles immediately after start() — confirm that
    // pass, given the CURRENT device list (A + C only, matching what SupremeOS actually has),
    // keeps it that way and never re-adds B.
    await driver2.reconcile([device("a", "A"), device("c", "C")]);
    const ids = driver2.listExposedDevices().map((e) => e.deviceId).sort();
    expect(ids).toEqual(["a", "c"]);
  });

  it("a device still present in SupremeOS but no longer resolving to a supported Matter type is un-bridged live, but its registry identity is preserved (UNSUPPORTED, not REMOVED)", async () => {
    const server = new FakeMatterBridgeServer();
    const registry = new MatterEndpointRegistry(new InMemoryMatterEndpointStore());
    const driver = new MatterBridgeDriver({ server, registry, capabilities: new FakeCapabilityPort() });
    await driver.start();

    await driver.reconcile([device("a", "A")]);
    const endpointA = registry.resolve("a" as DeviceId).endpointNumber;
    expect(server.endpoints.has(endpointA)).toBe(true);

    // Device A still exists in SupremeOS, but its capabilities no longer resolve to anything
    // Phase 1 supports (e.g. a lock).
    const result = await driver.reconcile([{ id: "a" as DeviceId, name: "A", capabilities: [{ kind: "lock", config: {} }] }]);

    expect(result.unsupported.map((u) => u.deviceId)).toEqual(["a"]);
    expect(server.endpoints.has(endpointA)).toBe(false); // live endpoint torn down
    // But the registry STILL remembers device "a" -> endpoint number (identity preserved for
    // a future capability change to reclaim), unlike a genuinely removed device.
    expect(registry.all().find((m) => m.deviceId === "a")).toBeDefined();
  });
});

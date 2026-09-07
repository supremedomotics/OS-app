import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityCommand, CapabilityState, DeviceId } from "@supreme/domain-model";
import { MatterBridgeDriver } from "./matter-bridge-driver.js";
import {
  InMemoryMatterEndpointStore,
  FileMatterEndpointStore,
  MatterEndpointRegistry,
} from "./endpoint-registry.js";
import type { MatterBridgeServer } from "./server.js";
import type { MatterBridgeCapabilityPort } from "./capability-port.js";

/** § Phase 2 — same fakes as matter-bridge-driver.test.ts, plus failure injection for the
 * recovery scenarios this phase requires (server startup failure, partial endpoint creation). */
class FakeMatterBridgeServer implements MatterBridgeServer {
  started = false;
  endpoints = new Map<number, { name: string; on: boolean }>();
  private commandListeners = new Set<(endpointNumber: number, on: boolean) => void>();
  startError: Error | null = null;
  failEndpointNumbers = new Set<number>();

  async start(): Promise<void> {
    if (this.startError) throw this.startError;
    this.started = true;
  }
  async stop(): Promise<void> {
    this.started = false;
  }
  async addOnOffLight(args: { endpointNumber: number; name: string; initialOn: boolean }): Promise<void> {
    if (this.failEndpointNumbers.has(args.endpointNumber)) {
      throw new Error(`simulated Matter internal failure adding endpoint ${args.endpointNumber}`);
    }
    this.endpoints.set(args.endpointNumber, { name: args.name, on: args.initialOn });
  }
  async removeEndpoint(endpointNumber: number): Promise<void> {
    this.endpoints.delete(endpointNumber);
  }
  async setOnOffState(endpointNumber: number, on: boolean): Promise<void> {
    const e = this.endpoints.get(endpointNumber);
    if (e) e.on = on;
  }
  onCommand(listener: (endpointNumber: number, on: boolean) => void): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }
  getCommissioningState() {
    return { commissioned: false, fabrics: [], pairing: { manualPairingCode: "34970112332", qrPairingCode: "MT:FAKE", discriminator: 3840 } };
  }
  async factoryReset() {
    this.endpoints.clear();
  }
}

class FakeCapabilityPort implements MatterBridgeCapabilityPort {
  states = new Map<DeviceId, CapabilityState>();
  commands: { deviceId: DeviceId; command: CapabilityCommand }[] = [];
  throwOnGetStateFor = new Set<DeviceId>();
  private listeners = new Set<(e: { deviceId: DeviceId; capability: string; state: CapabilityState }) => void>();

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    this.commands.push({ deviceId, command });
  }
  async getState(deviceId: DeviceId): Promise<CapabilityState | null> {
    if (this.throwOnGetStateFor.has(deviceId)) {
      throw new Error(`simulated: SupremeOS capability unavailable for ${deviceId}`);
    }
    return this.states.get(deviceId) ?? null;
  }
  onState(listener: (e: { deviceId: DeviceId; capability: string; state: CapabilityState }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  setState(deviceId: DeviceId, on: boolean): void {
    const state = { kind: "onoff", on } as CapabilityState;
    this.states.set(deviceId, state);
    for (const l of this.listeners) l({ deviceId, capability: "onoff", state });
  }
}

function tempFile(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "matter-bridge-phase2-"));
  return { dir, file: join(dir, "endpoints.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("Phase 2 — multi-device identity across restart", () => {
  it("Light A/B/C keep distinct, stable endpoint numbers across a full restart", async () => {
    const { file, cleanup } = tempFile();
    try {
      const server = new FakeMatterBridgeServer();
      const store = new FileMatterEndpointStore(file);
      const capabilities = new FakeCapabilityPort();

      const driver1 = new MatterBridgeDriver({ server, registry: new MatterEndpointRegistry(store), capabilities });
      await driver1.start();
      await driver1.exposeLight("light-a" as DeviceId, "Light A");
      await driver1.exposeLight("light-b" as DeviceId, "Light B");
      await driver1.exposeLight("light-c" as DeviceId, "Light C");
      const before = new Map(new MatterEndpointRegistry(store).all().map((m) => [m.deviceId, m.endpointNumber]));
      await driver1.stop();

      // Fresh store instance from the same file = process restart.
      const store2 = new FileMatterEndpointStore(file);
      const driver2 = new MatterBridgeDriver({ server, registry: new MatterEndpointRegistry(store2), capabilities });
      await driver2.start();

      const after = new Map(store2.list().map((m) => [m.deviceId, m.endpointNumber]));
      expect(after).toEqual(before);
      expect(server.endpoints.has(before.get("light-a" as DeviceId)!)).toBe(true);
      expect(server.endpoints.has(before.get("light-b" as DeviceId)!)).toBe(true);
      expect(server.endpoints.has(before.get("light-c" as DeviceId)!)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("removing a device and adding a new one does not renumber survivors", async () => {
    const store = new InMemoryMatterEndpointStore();
    const registry = new MatterEndpointRegistry(store);
    const server = new FakeMatterBridgeServer();
    const capabilities = new FakeCapabilityPort();
    const driver = new MatterBridgeDriver({ server, registry, capabilities });
    await driver.start();

    await driver.exposeLight("light-a" as DeviceId, "Light A"); // -> 1
    await driver.exposeLight("light-b" as DeviceId, "Light B"); // -> 2
    await driver.exposeLight("light-c" as DeviceId, "Light C"); // -> 3
    const aNumber = registry.resolve("light-a" as DeviceId).endpointNumber;
    const cNumber = registry.resolve("light-c" as DeviceId).endpointNumber;

    await driver.removeLight("light-b" as DeviceId);
    await driver.exposeLight("light-d" as DeviceId, "Light D");

    // A and C keep their original numbers — untouched by B's removal.
    expect(registry.resolve("light-a" as DeviceId).endpointNumber).toBe(aNumber);
    expect(registry.resolve("light-c" as DeviceId).endpointNumber).toBe(cNumber);
    // D is not required to reuse B's freed number (§ "do not require reuse unless proven
    // safe") — this implementation deliberately never reuses a freed number at all.
    expect(registry.resolve("light-d" as DeviceId).endpointNumber).toBe(4);
    expect(server.endpoints.has(2)).toBe(false); // B genuinely removed from Matter
  });
});

describe("Phase 2 — upgrade simulation (v1 -> v2, same storage)", () => {
  it("a normal driver-version bump does not destroy endpoint identity or Matter state", async () => {
    const { file, cleanup } = tempFile();
    try {
      const server = new FakeMatterBridgeServer(); // stands in for the SAME @matter/main storage dir surviving an upgrade
      const store = new FileMatterEndpointStore(file);
      const capabilities = new FakeCapabilityPort();

      // "v1" of the driver.
      const v1 = new MatterBridgeDriver({ server, registry: new MatterEndpointRegistry(store), capabilities });
      await v1.start();
      await v1.exposeLight("living-room-light" as DeviceId, "Living Room Light");
      const endpointBefore = new MatterEndpointRegistry(store).resolve("living-room-light" as DeviceId).endpointNumber;
      await v1.stop();

      // "v2" — a new MatterBridgeDriver instance (simulating a Driver Manager staged
      // install/activate), reading the SAME persisted registry file and the SAME (fake)
      // Matter storage. A real upgrade never deletes either.
      const v2 = new MatterBridgeDriver({
        server,
        registry: new MatterEndpointRegistry(new FileMatterEndpointStore(file)),
        capabilities,
      });
      await v2.start();

      expect(new MatterEndpointRegistry(new FileMatterEndpointStore(file)).resolve("living-room-light" as DeviceId).endpointNumber).toBe(
        endpointBefore,
      );
      expect(server.endpoints.has(endpointBefore)).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("Phase 2 — recovery: corrupted or invalid endpoint registry", () => {
  it("refuses to start clean on a corrupt (non-JSON) registry file — fails loud, never silently renumbers", () => {
    const { file, dir, cleanup } = tempFile();
    try {
      writeFileSync(file, "{ not valid json", "utf8");
      expect(() => new FileMatterEndpointStore(file)).toThrow(/corrupt/i);
    } finally {
      cleanup();
    }
  });

  it("rejects a registry file with a duplicate endpoint number", () => {
    const { file, cleanup } = tempFile();
    try {
      writeFileSync(
        file,
        JSON.stringify([
          { deviceId: "light-a", endpointNumber: 1, deviceType: "onOffLight" },
          { deviceId: "light-b", endpointNumber: 1, deviceType: "onOffLight" },
        ]),
        "utf8",
      );
      expect(() => new FileMatterEndpointStore(file)).toThrow(/same endpoint number/i);
    } finally {
      cleanup();
    }
  });

  it("rejects a registry file with an invalid (non-positive) endpoint number", () => {
    const { file, cleanup } = tempFile();
    try {
      writeFileSync(file, JSON.stringify([{ deviceId: "light-a", endpointNumber: 0, deviceType: "onOffLight" }]), "utf8");
      expect(() => new FileMatterEndpointStore(file)).toThrow(/invalid endpoint number/i);
    } finally {
      cleanup();
    }
  });

  it("persists the registry file with owner-only permissions (0600)", () => {
    const { file, cleanup } = tempFile();
    try {
      const store = new FileMatterEndpointStore(file);
      store.put({ deviceId: "light-a" as DeviceId, endpointNumber: 1, deviceType: "onOffLight" });
      const mode = statSync(file).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      cleanup();
    }
  });
});

describe("Phase 2 — recovery: server and capability failures", () => {
  it("a Matter server startup failure propagates and leaves the driver NOT started", async () => {
    const server = new FakeMatterBridgeServer();
    server.startError = new Error("simulated: could not bind Matter operational port");
    const driver = new MatterBridgeDriver({
      server,
      registry: new MatterEndpointRegistry(new InMemoryMatterEndpointStore()),
      capabilities: new FakeCapabilityPort(),
    });
    await expect(driver.start()).rejects.toThrow(/could not bind/);

    // Recovery: clearing the fault and retrying start() must succeed cleanly.
    server.startError = null;
    await driver.start();
    expect(server.started).toBe(true);
  });

  it("one device's unavailable SupremeOS capability during restart does not block re-exposing the others", async () => {
    const store = new InMemoryMatterEndpointStore();
    const capabilities = new FakeCapabilityPort();
    const server = new FakeMatterBridgeServer();
    const driver1 = new MatterBridgeDriver({ server, registry: new MatterEndpointRegistry(store), capabilities });
    await driver1.start();
    await driver1.exposeLight("light-a" as DeviceId, "Light A");
    await driver1.exposeLight("light-b" as DeviceId, "Light B");
    await driver1.stop();

    capabilities.throwOnGetStateFor.add("light-a" as DeviceId);
    const onLog = vi.fn();
    const driver2 = new MatterBridgeDriver({ server, registry: new MatterEndpointRegistry(store), capabilities, onLog });
    await driver2.start();

    expect(server.endpoints.has(2)).toBe(true); // light-b recovered fine
    expect(onLog).toHaveBeenCalledWith("error", expect.stringContaining("light-a"));
    // light-a's persisted endpoint number is untouched, not reissued.
    expect(new MatterEndpointRegistry(store).resolve("light-a" as DeviceId).endpointNumber).toBe(1);
  });

  it("a partial endpoint-creation failure does not mark the device as exposed", async () => {
    const server = new FakeMatterBridgeServer();
    const registry = new MatterEndpointRegistry(new InMemoryMatterEndpointStore());
    const driver = new MatterBridgeDriver({ server, registry, capabilities: new FakeCapabilityPort() });
    await driver.start();

    const mapping = registry.resolve("light-a" as DeviceId);
    server.failEndpointNumbers.add(mapping.endpointNumber);
    await expect(driver.exposeLight("light-a" as DeviceId, "Light A")).rejects.toThrow(/simulated Matter internal failure/);

    // The endpoint number allocation itself is NOT rolled back (safe to retry at the same
    // identity), but the device is not treated as live-bridged.
    expect(registry.resolve("light-a" as DeviceId).endpointNumber).toBe(mapping.endpointNumber);
    expect(server.endpoints.has(mapping.endpointNumber)).toBe(false);

    server.failEndpointNumbers.clear();
    await driver.exposeLight("light-a" as DeviceId, "Light A"); // retry succeeds at the SAME number
    expect(server.endpoints.has(mapping.endpointNumber)).toBe(true);
  });

  it("exposing the same device twice (duplicate entity id) is idempotent, not a second endpoint", async () => {
    const server = new FakeMatterBridgeServer();
    const registry = new MatterEndpointRegistry(new InMemoryMatterEndpointStore());
    const driver = new MatterBridgeDriver({ server, registry, capabilities: new FakeCapabilityPort() });
    await driver.start();

    await driver.exposeLight("light-a" as DeviceId, "Light A");
    await driver.exposeLight("light-a" as DeviceId, "Light A (renamed)");

    expect(server.endpoints.size).toBe(1);
    expect(registry.all()).toHaveLength(1);
  });
});

describe("Phase 4 — factory reset is separate from restart", () => {
  it("stop()/start() (restart) never calls factoryReset — endpoint mapping and Matter state both survive", async () => {
    const store = new InMemoryMatterEndpointStore();
    const server = new FakeMatterBridgeServer();
    const factoryResetSpy = vi.spyOn(server, "factoryReset");
    const driver = new MatterBridgeDriver({ server, registry: new MatterEndpointRegistry(store), capabilities: new FakeCapabilityPort() });

    await driver.start();
    await driver.exposeLight("light-a" as DeviceId, "Light A");
    await driver.stop();
    await driver.start();

    expect(factoryResetSpy).not.toHaveBeenCalled();
    expect(server.endpoints.has(1)).toBe(true);
  });

  it("factoryReset() clears live Matter exposure but PRESERVES the SupremeOS endpoint-registry mapping", async () => {
    const store = new InMemoryMatterEndpointStore();
    const registry = new MatterEndpointRegistry(store);
    const server = new FakeMatterBridgeServer();
    const driver = new MatterBridgeDriver({ server, registry, capabilities: new FakeCapabilityPort() });

    await driver.start();
    await driver.exposeLight("light-a" as DeviceId, "Light A");
    expect(server.endpoints.has(1)).toBe(true);

    await driver.factoryReset();

    expect(server.endpoints.has(1)).toBe(false); // Matter-side identity genuinely wiped
    // SupremeOS still remembers device -> endpoint 1, so re-commissioning re-uses it rather
    // than renumbering (§ endpoint-registry.ts's "never reissue" rule, unaffected by a
    // Matter-level reset — only explicit SupremeOS-side device removal frees a number).
    expect(registry.resolve("light-a" as DeviceId).endpointNumber).toBe(1);
  });
});

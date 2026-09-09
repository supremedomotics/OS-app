import { describe, it, expect } from "vitest";
import type { CapabilityCommand, CapabilityState, DeviceCapability, DeviceId } from "@supreme/domain-model";
import { MatterBridgeDriver } from "./matter-bridge-driver.js";
import { InMemoryMatterEndpointStore, MatterEndpointRegistry } from "./endpoint-registry.js";
import type { MatterBridgeServer, MatterBridgeEndpointSpec } from "./server.js";
import type { MatterBridgeCapabilityPort } from "./capability-port.js";

/** § Matter Bridge Phase 1.2 — same fake convention as the other driver-level test files;
 * tracks `updateEndpointName` calls separately so a test can distinguish "named correctly at
 * construction" from "renamed live after construction". */
class FakeMatterBridgeServer implements MatterBridgeServer {
  started = false;
  endpoints = new Map<number, { name: string; on: boolean }>();
  nameUpdates: { endpointNumber: number; name: string }[] = [];
  private commandListeners = new Set<(endpointNumber: number, command: CapabilityCommand) => void>();

  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.started = false;
  }
  async addEndpoint(spec: MatterBridgeEndpointSpec): Promise<void> {
    if (this.endpoints.has(spec.endpointNumber)) return; // real-server's own idempotency
    const on = spec.initialState && "on" in spec.initialState ? spec.initialState.on : false;
    this.endpoints.set(spec.endpointNumber, { name: spec.name, on });
  }
  async removeEndpoint(endpointNumber: number): Promise<void> {
    this.endpoints.delete(endpointNumber);
  }
  async setCapabilityState(endpointNumber: number, state: CapabilityState): Promise<void> {
    const e = this.endpoints.get(endpointNumber);
    if (e && "on" in state) e.on = state.on;
  }
  async updateEndpointName(endpointNumber: number, name: string): Promise<void> {
    this.nameUpdates.push({ endpointNumber, name });
    const e = this.endpoints.get(endpointNumber);
    if (e) e.name = name;
  }
  async reportKeypadPress(): Promise<void> {}
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
  async command(): Promise<void> {}
  async getState(): Promise<CapabilityState | null> {
    return null;
  }
  onState(): () => void {
    return () => {};
  }
  async getKeypadCapabilities() {
    return null;
  }
  onKeypadInput(): () => void {
    return () => {};
  }
}

function build() {
  const server = new FakeMatterBridgeServer();
  const registry = new MatterEndpointRegistry(new InMemoryMatterEndpointStore());
  const driver = new MatterBridgeDriver({ server, registry, capabilities: new FakeCapabilityPort() });
  return { server, registry, driver };
}

const ONOFF: DeviceCapability[] = [{ kind: "onoff", config: {} }];
const POSITION: DeviceCapability[] = [{ kind: "position", config: {} }];
const BRIGHTNESS: DeviceCapability[] = [{ kind: "brightness", config: {} }];
const CCT: DeviceCapability[] = [{ kind: "color", config: { colorModes: { rgb: false, cct: true } } }];
const RGB: DeviceCapability[] = [{ kind: "color", config: { colorModes: { rgb: true, cct: true } } }];

describe("Matter Bridge user-facing naming — § Matter Bridge Phase 1.2 (the reported Apple Home ID-instead-of-name bug)", () => {
  it('§ the exact reported case — "Pantry DL-2" becomes the Matter endpoint\'s user-facing name, never the SupremeOS device id', async () => {
    const { server, driver } = build();
    await driver.start();
    await driver.exposeDevice("dev_01M1YC0RA8XYZ" as DeviceId, "Pantry DL-2", CCT);
    const [entry] = [...server.endpoints.values()];
    expect(entry!.name).toBe("Pantry DL-2");
    expect(entry!.name).not.toBe("dev_01M1YC0RA8XYZ");
  });

  it('"Curtain motor" becomes the Matter endpoint\'s user-facing name', async () => {
    const { server, driver } = build();
    await driver.start();
    await driver.exposeDevice("dev_01M1YAC8WJXYZ" as DeviceId, "Curtain motor", POSITION);
    const [entry] = [...server.endpoints.values()];
    expect(entry!.name).toBe("Curtain motor");
  });

  it("device.id is never selected as the friendly name when device.name exists — every Phase 1 device type follows the same naming path", async () => {
    const { server, driver } = build();
    await driver.start();
    const cases: [string, string, DeviceCapability[]][] = [
      ["dev_a", "Living Room Lamp", ONOFF],
      ["dev_b", "Study Lamp", BRIGHTNESS],
      ["dev_c", "Pantry DL-1", CCT],
      ["dev_d", "Pantry Strip", RGB],
      ["dev_e", "Study Blinds", POSITION],
    ];
    for (const [id, name, caps] of cases) {
      await driver.exposeDevice(id as DeviceId, name, caps);
    }
    for (const [id, name] of cases) {
      const endpointNumber = [...server.endpoints.entries()].find(([, e]) => e.name === name)?.[0];
      expect(endpointNumber, `no endpoint named "${name}" for device ${id}`).toBeDefined();
    }
    // No endpoint anywhere carries a raw deviceId as its name.
    for (const e of server.endpoints.values()) {
      expect(cases.some(([id]) => id === e.name)).toBe(false);
    }
  });

  it("the STABLE endpoint/device identity remains unchanged when only the name is set at construction", async () => {
    const { server, registry, driver } = build();
    await driver.start();
    await driver.exposeDevice("dev_stable" as DeviceId, "Pantry DL-2", CCT);
    const mapping = registry.resolve("dev_stable" as DeviceId);
    expect(mapping.deviceId).toBe("dev_stable");
    expect(server.endpoints.has(mapping.endpointNumber)).toBe(true);
  });

  it('renaming "Pantry DL-2" -> "Pantry Ceiling DL-2" changes ONLY the friendly name, never the endpoint number or device type', async () => {
    const { server, registry, driver } = build();
    await driver.start();
    await driver.exposeDevice("dev_rename" as DeviceId, "Pantry DL-2", CCT);
    const before = registry.resolve("dev_rename" as DeviceId);
    const beforeDeviceType = server.endpoints.get(before.endpointNumber)!;
    expect(beforeDeviceType.name).toBe("Pantry DL-2");

    await driver.exposeDevice("dev_rename" as DeviceId, "Pantry Ceiling DL-2", CCT);
    const after = registry.resolve("dev_rename" as DeviceId);

    expect(after.endpointNumber).toBe(before.endpointNumber); // identity unchanged
    expect(after.deviceTypeId).toBe(before.deviceTypeId); // device type unchanged
    expect(server.endpoints.get(after.endpointNumber)!.name).toBe("Pantry Ceiling DL-2"); // name DID change
    // The rename reached the live server via updateEndpointName, not merely the registry —
    // proves it propagates even though addEndpoint itself is a no-op for an existing endpoint.
    expect(server.nameUpdates.some((u) => u.endpointNumber === before.endpointNumber && u.name === "Pantry Ceiling DL-2")).toBe(true);
  });

  it("a persisted registry rename is what start()'s restart re-expose loop reads — the exact root cause of the live bug", async () => {
    const store = new InMemoryMatterEndpointStore();
    const server = new FakeMatterBridgeServer();
    const capabilities = new FakeCapabilityPort();

    const driver1 = new MatterBridgeDriver({ server, registry: new MatterEndpointRegistry(store), capabilities });
    await driver1.start();
    await driver1.exposeDevice("dev_restart" as DeviceId, "Living Room Lights", ONOFF);
    await driver1.stop();

    // Fresh driver instance over the SAME persisted store — a real gateway restart. Before the
    // fix, start()'s re-expose loop passed `mapping.deviceId` here, which is exactly what
    // leaked into Apple Home as "dev_restart" instead of "Living Room Lights".
    const driver2 = new MatterBridgeDriver({ server, registry: new MatterEndpointRegistry(store), capabilities });
    await driver2.start();
    const [entry] = [...server.endpoints.values()];
    expect(entry!.name).toBe("Living Room Lights");
    expect(entry!.name).not.toBe("dev_restart");
  });

  it("removing a device and adding a DIFFERENT one afterward never inherits the removed device's friendly name (§ requirement 5)", async () => {
    const { server, registry, driver } = build();
    await driver.start();
    // A survivor present throughout, so the freed endpoint number is NOT simply reissued to
    // the new device by coincidence of the store being empty — this isolates the actual claim
    // (names never leak across devices) from endpoint-number allocation, which is a separate,
    // already-covered concern (matter-bridge-reconciliation.test.ts).
    await driver.exposeDevice("dev_survivor" as DeviceId, "Survivor", ONOFF);
    await driver.exposeDevice("dev_old" as DeviceId, "Old Name", ONOFF);
    await driver.removeLight("dev_old" as DeviceId);
    registry.remove("dev_old" as DeviceId); // full forget, mirrors MatterBridgeDriver.forgetDevice

    await driver.exposeDevice("dev_new" as DeviceId, "New Name", ONOFF);
    const newMapping = registry.resolve("dev_new" as DeviceId);
    expect(server.endpoints.get(newMapping.endpointNumber)!.name).toBe("New Name");
    expect(server.endpoints.get(newMapping.endpointNumber)!.name).not.toBe("Old Name");
    // Confirm no endpoint anywhere still carries the removed device's old name.
    expect([...server.endpoints.values()].some((e) => e.name === "Old Name")).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import type { CapabilityCommand, CapabilityState, DeviceId, KeypadCapabilityDeclaration, KeypadInputEvent } from "@supreme/domain-model";
import { MatterBridgeDriver } from "./matter-bridge-driver.js";
import { InMemoryMatterEndpointStore, MatterEndpointRegistry } from "./endpoint-registry.js";
import type { MatterBridgeServer, MatterBridgeEndpointSpec } from "./server.js";
import type { MatterBridgeCapabilityPort } from "./capability-port.js";

/**
 * § Matter Bridge Phase 2B — driver-level keypad/button tests (identity, naming, rename,
 * reconciliation, restart, removal — Tests I/J/K/L/M/N). Real-SDK event-generation tests
 * (Tests C/D/F/G/H/O) live in `real-server.command-dispatch.test.ts`; the Device Type Registry
 * and Resolver tests (A/B) live alongside the existing suites in `device-types/`.
 */
class FakeMatterBridgeServer implements MatterBridgeServer {
  endpoints = new Map<number, { name: string; deviceTypeId: number }>();
  removedEndpointNumbers: number[] = [];
  reportedPresses: { endpointNumber: number; press: string }[] = [];
  private commandListeners = new Set<(endpointNumber: number, command: CapabilityCommand) => void>();
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async addEndpoint(spec: MatterBridgeEndpointSpec): Promise<void> {
    this.endpoints.set(spec.endpointNumber, { name: spec.name, deviceTypeId: spec.deviceTypeId });
  }
  async removeEndpoint(endpointNumber: number): Promise<void> {
    this.endpoints.delete(endpointNumber);
    this.removedEndpointNumbers.push(endpointNumber);
  }
  async updateEndpointName(endpointNumber: number, name: string): Promise<void> {
    const e = this.endpoints.get(endpointNumber);
    if (e) e.name = name;
  }
  async setCapabilityState(): Promise<void> {}
  async reportKeypadPress(endpointNumber: number, press: "short" | "long" | "double" | "triple"): Promise<void> {
    this.reportedPresses.push({ endpointNumber, press });
  }
  onCommand(listener: (endpointNumber: number, command: CapabilityCommand) => void): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }
  getCommissioningState() {
    return { commissioned: false, fabricCount: 0, commissioningWindowOpen: true, fabrics: [], pairing: { manualPairingCode: "34970112332", qrPairingCode: "MT:FAKE", discriminator: 3840 } };
  }
  async factoryReset() {}
}

class FakeCapabilityPort implements MatterBridgeCapabilityPort {
  private keypadListeners = new Set<(event: KeypadInputEvent) => void>();
  async command(): Promise<void> {}
  async getState(): Promise<CapabilityState | null> {
    return null;
  }
  onState(): () => void {
    return () => {};
  }
  async getKeypadCapabilities(): Promise<KeypadCapabilityDeclaration | null> {
    return null; // driver-level tests drive reconcileKeypads() directly, never through this
  }
  onKeypadInput(listener: (event: KeypadInputEvent) => void): () => void {
    this.keypadListeners.add(listener);
    return () => this.keypadListeners.delete(listener);
  }
  /** Test helper: simulate a real Universal Input Event arriving from a keypad driver. */
  emitKeypadInput(event: KeypadInputEvent): void {
    for (const l of this.keypadListeners) l(event);
  }
}

function keypad(id: string, name: string, controlIds: string[]): { id: DeviceId; name: string; declaration: KeypadCapabilityDeclaration } {
  return {
    id: id as DeviceId,
    name,
    declaration: {
      keypadId: id as DeviceId,
      protocol: "knx",
      controls: controlIds.map((cid) => ({ id: cid, kind: "button", label: null, input: ["buttons"], feedback: [] })),
    },
  };
}

describe("MatterBridgeDriver — § Matter Bridge Phase 2B keypad buttons", () => {
  it("§ Test H, multi-button test — a keypad with 4 buttons produces 4 SEPARATE Generic Switch endpoints, each with its own stable identity", async () => {
    const server = new FakeMatterBridgeServer();
    const registry = new MatterEndpointRegistry(new InMemoryMatterEndpointStore());
    const driver = new MatterBridgeDriver({ server, registry, capabilities: new FakeCapabilityPort() });
    await driver.start();

    const result = await driver.reconcileKeypads([keypad("keypad-a", "Living Room Keypad", ["btn1", "btn2", "btn3", "btn4"])]);
    expect(result.added).toHaveLength(4);
    const exposed = driver.listExposedButtons();
    expect(exposed).toHaveLength(4);
    // § Test I — stable, DISTINCT endpoint numbers, one per button.
    const endpointNumbers = new Set(exposed.map((e) => e.endpointNumber));
    expect(endpointNumbers.size).toBe(4);
    for (const btn of ["btn1", "btn2", "btn3", "btn4"]) {
      expect(exposed.some((e) => e.keypadId === "keypad-a" && e.controlId === btn)).toBe(true);
    }
  });

  it("§ Test J — friendly naming: a button's configured label is used; falling back to '<keypad name> — <button id>' when absent, never the raw control id alone", async () => {
    const server = new FakeMatterBridgeServer();
    const registry = new MatterEndpointRegistry(new InMemoryMatterEndpointStore());
    const driver = new MatterBridgeDriver({ server, registry, capabilities: new FakeCapabilityPort() });
    await driver.start();

    await driver.exposeKeypadButton("keypad-a" as DeviceId, "Living Room Keypad", { id: "btn1", kind: "button", label: "Scene: Welcome" });
    await driver.exposeKeypadButton("keypad-a" as DeviceId, "Living Room Keypad", { id: "btn2", kind: "button", label: null });

    const exposed = driver.listExposedButtons();
    const btn1Endpoint = exposed.find((e) => e.controlId === "btn1")!.endpointNumber;
    const btn2Endpoint = exposed.find((e) => e.controlId === "btn2")!.endpointNumber;
    expect(server.endpoints.get(btn1Endpoint)?.name).toBe("Scene: Welcome");
    expect(server.endpoints.get(btn2Endpoint)?.name).toBe("Living Room Keypad — btn2");
  });

  it("§ Test K — renaming a keypad (or a button's label) propagates to the Matter-visible name WITHOUT creating a new endpoint identity", async () => {
    const server = new FakeMatterBridgeServer();
    const registry = new MatterEndpointRegistry(new InMemoryMatterEndpointStore());
    const driver = new MatterBridgeDriver({ server, registry, capabilities: new FakeCapabilityPort() });
    await driver.start();

    await driver.exposeKeypadButton("keypad-a" as DeviceId, "Living Room Keypad", { id: "btn1", kind: "button", label: null });
    const before = driver.listExposedButtons().find((e) => e.controlId === "btn1")!.endpointNumber;

    // Keypad renamed.
    await driver.exposeKeypadButton("keypad-a" as DeviceId, "Great Room Keypad", { id: "btn1", kind: "button", label: null });
    const after = driver.listExposedButtons().find((e) => e.controlId === "btn1")!.endpointNumber;

    expect(after).toBe(before); // SAME endpoint identity
    expect(server.endpoints.get(after)?.name).toBe("Great Room Keypad — btn1");
  });

  it("§ Test L — reconciliation: a button removed from the keypad's declaration is withdrawn from the live Matter endpoint; a keypad removed entirely withdraws ALL its buttons", async () => {
    const server = new FakeMatterBridgeServer();
    const registry = new MatterEndpointRegistry(new InMemoryMatterEndpointStore());
    const driver = new MatterBridgeDriver({ server, registry, capabilities: new FakeCapabilityPort() });
    await driver.start();

    await driver.reconcileKeypads([keypad("keypad-a", "Keypad A", ["btn1", "btn2"])]);
    expect(driver.listExposedButtons()).toHaveLength(2);

    // btn2 removed from the keypad's own declaration (SupremeOS-side reconfiguration).
    let result = await driver.reconcileKeypads([keypad("keypad-a", "Keypad A", ["btn1"])]);
    expect(result.removed).toEqual([{ keypadId: "keypad-a", controlId: "btn2" }]);
    expect(driver.listExposedButtons()).toHaveLength(1);

    // § Test N — the keypad device itself is removed entirely.
    result = await driver.reconcileKeypads([]);
    expect(result.removed).toEqual([{ keypadId: "keypad-a", controlId: "btn1" }]);
    expect(driver.listExposedButtons()).toHaveLength(0);
    // The persisted registry record is genuinely freed, not just un-bridged live.
    expect(registry.all().find((m) => m.deviceId === "keypad-a")).toBeUndefined();
  });

  it("§ Test M — restart safety: buttons re-expose at their SAME endpoint numbers across a fresh driver instance over the SAME persisted registry, and never resurrect a removed button", async () => {
    const store = new InMemoryMatterEndpointStore();
    const server = new FakeMatterBridgeServer();
    const capabilities = new FakeCapabilityPort();

    const driver1 = new MatterBridgeDriver({ server, registry: new MatterEndpointRegistry(store), capabilities });
    await driver1.start();
    await driver1.reconcileKeypads([keypad("keypad-a", "Keypad A", ["btn1", "btn2"])]);
    await driver1.reconcileKeypads([keypad("keypad-a", "Keypad A", ["btn1"])]); // btn2 removed while running
    const btn1Before = driver1.listExposedButtons().find((e) => e.controlId === "btn1")!.endpointNumber;
    await driver1.stop();

    const driver2 = new MatterBridgeDriver({ server, registry: new MatterEndpointRegistry(store), capabilities });
    await driver2.start(); // re-exposes from the (already-pruned) persisted registry
    const exposedAfterRestart = driver2.listExposedButtons();
    expect(exposedAfterRestart.find((e) => e.controlId === "btn2")).toBeUndefined(); // never resurrected
    expect(exposedAfterRestart.find((e) => e.controlId === "btn1")?.endpointNumber).toBe(btn1Before); // SAME identity
  });

  it("§ Test E/F — a real Universal Input Event for a bridged button reaches `server.reportKeypadPress` with the correctly translated press type, routed to the RIGHT button when a keypad has several", async () => {
    const server = new FakeMatterBridgeServer();
    const registry = new MatterEndpointRegistry(new InMemoryMatterEndpointStore());
    const capabilities = new FakeCapabilityPort();
    const driver = new MatterBridgeDriver({ server, registry, capabilities });
    await driver.start();

    await driver.reconcileKeypads([keypad("keypad-a", "Keypad A", ["btn1", "btn2"])]);
    const btn1 = driver.listExposedButtons().find((e) => e.controlId === "btn1")!.endpointNumber;
    const btn2 = driver.listExposedButtons().find((e) => e.controlId === "btn2")!.endpointNumber;

    capabilities.emitKeypadInput({ keypadId: "keypad-a" as DeviceId, control: "btn1", type: "short_press", ts: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 0));

    expect(server.reportedPresses).toContainEqual({ endpointNumber: btn1, press: "short" });
    expect(server.reportedPresses.some((p) => p.endpointNumber === btn2)).toBe(false); // NOT btn2

    capabilities.emitKeypadInput({ keypadId: "keypad-a" as DeviceId, control: "btn2", type: "long_press", holdMs: 900, ts: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 0));
    expect(server.reportedPresses).toContainEqual({ endpointNumber: btn2, press: "long" });
  });

  it("§ Test O — unsupported/unknown event handling: a raw primitive/gesture event, and an event for a keypad/control this driver never bridged, are both silently ignored — never a crash, never a fabricated command", async () => {
    const server = new FakeMatterBridgeServer();
    const registry = new MatterEndpointRegistry(new InMemoryMatterEndpointStore());
    const capabilities = new FakeCapabilityPort();
    const driver = new MatterBridgeDriver({ server, registry, capabilities });
    await driver.start();
    await driver.reconcileKeypads([keypad("keypad-a", "Keypad A", ["btn1"])]);

    // Raw primitive — deliberately NOT translated (§ TRANSLATED_KEYPAD_EVENT_TYPES's own doc).
    capabilities.emitKeypadInput({ keypadId: "keypad-a" as DeviceId, control: "btn1", type: "button_pressed", ts: new Date().toISOString() });
    // A gesture — no Generic Switch equivalent.
    capabilities.emitKeypadInput({ keypadId: "keypad-a" as DeviceId, control: "btn1", type: "gesture", gesture: "double-tap-hold", ts: new Date().toISOString() });
    // An event for a control this driver never bridged at all.
    capabilities.emitKeypadInput({ keypadId: "keypad-unknown" as DeviceId, control: "btnX", type: "short_press", ts: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 0));

    expect(server.reportedPresses).toEqual([]);
  });

  it("a control kind with no Matter mapping yet (e.g. 'rotary_encoder') is reported UNSUPPORTED for that control alone, never blocking the keypad's other, supported buttons", async () => {
    const server = new FakeMatterBridgeServer();
    const registry = new MatterEndpointRegistry(new InMemoryMatterEndpointStore());
    const driver = new MatterBridgeDriver({ server, registry, capabilities: new FakeCapabilityPort() });
    await driver.start();

    const declaration: KeypadCapabilityDeclaration = {
      keypadId: "keypad-a" as DeviceId,
      protocol: "knx",
      controls: [
        { id: "btn1", kind: "button", label: null, input: ["buttons"], feedback: [] },
        { id: "encoder1", kind: "rotary_encoder", label: null, input: ["rotary_encoder"], feedback: [] },
      ],
    };
    const result = await driver.reconcileKeypads([{ id: "keypad-a" as DeviceId, name: "Keypad A", declaration }]);

    expect(result.added).toEqual([{ keypadId: "keypad-a", controlId: "btn1" }]);
    expect(result.unsupported).toEqual([{ keypadId: "keypad-a", controlId: "encoder1", reason: expect.stringContaining("rotary_encoder") }]);
    expect(driver.listExposedButtons()).toHaveLength(1);
  });
});

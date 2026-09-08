import { describe, it, expect } from "vitest";
import type { CapabilityCommand, CapabilityState, DeviceCapability, DeviceId } from "@supreme/domain-model";
import { resolveOnOffTarget, resolveLevelTarget } from "./real-server.js";
import { MatterBridgeDriver } from "./matter-bridge-driver.js";
import { InMemoryMatterEndpointStore, MatterEndpointRegistry } from "./endpoint-registry.js";
import type { MatterBridgeServer, MatterBridgeEndpointSpec } from "./server.js";
import type { MatterBridgeCapabilityPort } from "./capability-port.js";

/**
 * § Matter Bridge Phase 1.2 — "Fix command routing and bidirectional state synchronization".
 *
 * Root causes this suite locks in as regressions, confirmed against real device reports:
 *   A. KNX brightness/dimming failure — LevelControl used to always emit `{capability:"color",
 *      level}`, which KNX's `color` command handler doesn't honor as a level-only update.
 *   B. Common OnOff failure (both KNX and Casambi CCT lights) — Color Temperature/Extended Color
 *      Light endpoints used `LocalOnlyOnOffServer`, which NEVER routed the Matter OnOff command
 *      to SupremeOS at all.
 *   C. Live feedback failure — `handleSupremeStateChange` only forwarded a state event whose
 *      capability matched the device type's single `primaryCapability` ("color"), silently
 *      dropping a separately-declared `onoff`/`brightness` capability's own state events (real
 *      for KNX, which addresses onoff/brightness/color as three separate group addresses).
 *
 * The fix is architectural, not protocol-specific: `resolveOnOffTarget`/`resolveLevelTarget`
 * decide a target purely from the device's OWN declared capability set (§ confirmed exact
 * difference — KNX: `["onoff","brightness","color"]`, Casambi: `["brightness","color"]`), and
 * `MatterBridgeDriver` now mirrors ANY of an endpoint's declared capabilities' state changes, not
 * only the primary one.
 */
describe("Matter Bridge Phase 1.2 — command routing (root causes A & B)", () => {
  it("KNX shape (onoff+brightness+color) routes OnOff/LevelControl through 'brightness', matching the frontend's own preference", () => {
    const knxCapabilities = ["onoff", "brightness", "color"];
    expect(resolveOnOffTarget(knxCapabilities)).toBe("brightness");
    expect(resolveLevelTarget(knxCapabilities)).toBe("brightness");
  });

  it("Casambi shape (brightness+color, no separate onoff) routes OnOff/LevelControl through 'brightness' too — the SAME target as KNX", () => {
    const casambiCapabilities = ["brightness", "color"];
    expect(resolveOnOffTarget(casambiCapabilities)).toBe("brightness");
    expect(resolveLevelTarget(casambiCapabilities)).toBe("brightness");
  });

  it("§ Part 8 — automated KNX-vs-Casambi capability-parity check: despite KNX declaring a separate 'onoff' capability that Casambi doesn't, both resolve to an IDENTICAL command-routing target — proof there is no protocol-specific branching", () => {
    const knx = ["onoff", "brightness", "color"];
    const casambi = ["brightness", "color"];
    expect(resolveOnOffTarget(knx)).toBe(resolveOnOffTarget(casambi));
    expect(resolveLevelTarget(knx)).toBe(resolveLevelTarget(casambi));
  });

  it("a device declaring ONLY 'onoff' + 'color' (no brightness) routes OnOff through 'onoff', but LevelControl has no valid target (stays the disclosed color-level fallback) — 'onoff' capability's command schema has no level field", () => {
    const onlyOnOff = ["onoff", "color"];
    expect(resolveOnOffTarget(onlyOnOff)).toBe("onoff");
    expect(resolveLevelTarget(onlyOnOff)).toBeNull();
  });

  it("a device declaring ONLY 'color' (no onoff, no brightness) has no valid OnOff/Level target at all — the one honest, disclosed gap left (§ LocalOnlyOnOffServer's narrowed doc)", () => {
    const colorOnly = ["color"];
    expect(resolveOnOffTarget(colorOnly)).toBeNull();
    expect(resolveLevelTarget(colorOnly)).toBeNull();
  });
});

const ONOFF_CAPS: DeviceCapability[] = [{ kind: "onoff", config: {} }];

class FakeMatterBridgeServer implements MatterBridgeServer {
  endpoints = new Map<number, { name: string; on: boolean }>();
  private commandListeners = new Set<(endpointNumber: number, command: CapabilityCommand) => void>();
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async addEndpoint(spec: MatterBridgeEndpointSpec): Promise<void> {
    const on = spec.initialState && "on" in spec.initialState ? spec.initialState.on : false;
    this.endpoints.set(spec.endpointNumber, { name: spec.name, on });
  }
  async removeEndpoint(endpointNumber: number): Promise<void> {
    this.endpoints.delete(endpointNumber);
  }
  states: { endpointNumber: number; state: CapabilityState }[] = [];
  async setCapabilityState(endpointNumber: number, state: CapabilityState): Promise<void> {
    this.states.push({ endpointNumber, state });
  }
  async updateEndpointName(): Promise<void> {}
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
  private listeners = new Set<(e: { deviceId: DeviceId; capability: string; state: CapabilityState }) => void>();
  async command(): Promise<void> {}
  async getState(): Promise<CapabilityState | null> {
    return null;
  }
  onState(listener: (e: { deviceId: DeviceId; capability: string; state: CapabilityState }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(deviceId: DeviceId, capability: string, state: CapabilityState): void {
    for (const l of this.listeners) l({ deviceId, capability, state });
  }
}

describe("MatterBridgeDriver.handleSupremeStateChange — root cause C (live feedback failure)", () => {
  it("a KNX-shaped device's 'onoff'-only state event (a physical wall-switch flip) now reaches the Matter attribute, even though the device type's primaryCapability is 'color'", async () => {
    const server = new FakeMatterBridgeServer();
    const registry = new MatterEndpointRegistry(new InMemoryMatterEndpointStore());
    const capabilities = new FakeCapabilityPort();
    const driver = new MatterBridgeDriver({ server, registry, capabilities });
    await driver.start();

    // A KNX tunable/CCT light — onoff, brightness, and color are all separately declared.
    const knxCaps: DeviceCapability[] = [
      { kind: "onoff", config: {} },
      { kind: "brightness", config: {} },
      { kind: "color", config: {} },
    ];
    await driver.exposeDevice("conference-hanging" as DeviceId, "Conference Hanging", knxCaps);
    const endpointNumber = registry.resolve("conference-hanging" as DeviceId).endpointNumber;

    // Simulate KNX reporting a real onoff-only state change (e.g. a physical switch) — NOT a
    // "color" event, which is what the OLD `primaryCapability`-only filter required.
    capabilities.emit("conference-hanging" as DeviceId, "onoff", { kind: "onoff", on: true });

    // Allow the async event handler to run.
    await new Promise((r) => setTimeout(r, 0));

    expect(server.states.some((s) => s.endpointNumber === endpointNumber && "on" in s.state && s.state.on === true)).toBe(true);
  });

  it("an unrelated capability the device never declared is still ignored (no false-positive forwarding)", async () => {
    const server = new FakeMatterBridgeServer();
    const registry = new MatterEndpointRegistry(new InMemoryMatterEndpointStore());
    const capabilities = new FakeCapabilityPort();
    const driver = new MatterBridgeDriver({ server, registry, capabilities });
    await driver.start();

    await driver.exposeDevice("light-a" as DeviceId, "Light A", ONOFF_CAPS);
    server.states = [];

    capabilities.emit("light-a" as DeviceId, "lock", { kind: "lock", locked: true } as unknown as CapabilityState);
    await new Promise((r) => setTimeout(r, 0));

    expect(server.states).toEqual([]);
  });
});

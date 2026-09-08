import { describe, it, expect, vi } from "vitest";
import type { CapabilityCommand, CapabilityState, DeviceCapability, DeviceId } from "@supreme/domain-model";
import { MatterBridgeDriver } from "./matter-bridge-driver.js";
import { InMemoryMatterEndpointStore, MatterEndpointRegistry } from "./endpoint-registry.js";
import type { MatterBridgeServer, MatterBridgeEndpointSpec } from "./server.js";
import type { MatterBridgeCapabilityPort } from "./capability-port.js";

/** A plain onoff device's capability list — the overwhelmingly common Phase 1 case this file's
 * pre-existing tests already covered; kept as a shared constant so every `exposeDevice` call
 * site reads the same as it did when the driver had a dedicated `exposeLight` shortcut. */
const ONOFF_CAPS: DeviceCapability[] = [{ kind: "onoff", config: {} }];

/** In-memory fake of the real `@matter/main`-backed server — this is what makes the driver's
 * routing/loop-prevention logic verifiable without a real LAN or ecosystem (§29). */
class FakeMatterBridgeServer implements MatterBridgeServer {
  started = false;
  endpoints = new Map<number, { name: string; on: boolean }>();
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
    return { commissioned: false, fabrics: [], pairing: { manualPairingCode: "34970112332", qrPairingCode: "MT:FAKE", discriminator: 3840 } };
  }
  async factoryReset() {
    this.endpoints.clear();
  }
  /** Test helper: simulate a real ecosystem (Apple/Google/Alexa/a reference controller)
   * issuing a genuine On/Off cluster command. */
  simulateEcosystemCommand(endpointNumber: number, on: boolean): void {
    for (const l of this.commandListeners) l(endpointNumber, { capability: "onoff", action: on ? "on" : "off" });
  }
}

/** Fake of the SIL seam (`MatterBridgeCapabilityPort`) — a tiny in-memory device registry
 * standing in for `SupremeIntegrationLayer.command()/getState()/onState()`. */
class FakeCapabilityPort implements MatterBridgeCapabilityPort {
  states = new Map<DeviceId, CapabilityState>();
  commands: { deviceId: DeviceId; command: CapabilityCommand }[] = [];
  private listeners = new Set<(e: { deviceId: DeviceId; capability: string; state: CapabilityState }) => void>();

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    this.commands.push({ deviceId, command });
    if (command.capability === "onoff" && (command.action === "on" || command.action === "off")) {
      // Simulate the native driver executing the command and reporting real feedback —
      // exactly the "do not fake feedback" path (§11): a SEPARATE event, not assumed.
      this.setState(deviceId, command.action === "on");
    }
  }
  async getState(deviceId: DeviceId): Promise<CapabilityState | null> {
    return this.states.get(deviceId) ?? null;
  }
  onState(listener: (e: { deviceId: DeviceId; capability: string; state: CapabilityState }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Test helper: simulate real physical/automation feedback arriving from the native driver. */
  setState(deviceId: DeviceId, on: boolean): void {
    const state = { kind: "onoff", on } as CapabilityState;
    this.states.set(deviceId, state);
    for (const l of this.listeners) l({ deviceId, capability: "onoff", state });
  }
}

function build() {
  const server = new FakeMatterBridgeServer();
  const registry = new MatterEndpointRegistry(new InMemoryMatterEndpointStore());
  const capabilities = new FakeCapabilityPort();
  const driver = new MatterBridgeDriver({ server, registry, capabilities });
  return { server, registry, capabilities, driver };
}

describe("MatterBridgeDriver — startup + endpoint creation", () => {
  it("starts the server and exposes a light as one bridged On/Off endpoint", async () => {
    const { server, driver } = build();
    await driver.start();
    expect(server.started).toBe(true);

    await driver.exposeDevice("living-room-light" as DeviceId, "Living Room Light", ONOFF_CAPS);
    expect(server.endpoints.size).toBe(1);
    const [[endpointNumber, endpoint]] = [...server.endpoints.entries()];
    expect(endpointNumber).toBe(1);
    expect(endpoint.name).toBe("Living Room Light");
  });
});

describe("MatterBridgeDriver — Matter → SupremeOS (direction 1)", () => {
  it("routes a real ecosystem On command through the SAME capability port every other caller uses", async () => {
    const { server, capabilities, driver } = build();
    await driver.start();
    await driver.exposeDevice("living-room-light" as DeviceId, "Living Room Light", ONOFF_CAPS);

    server.simulateEcosystemCommand(1, true);
    await vi.waitFor(() => expect(capabilities.commands).toHaveLength(1));
    expect(capabilities.commands[0]).toEqual({
      deviceId: "living-room-light",
      command: { capability: "onoff", action: "on" },
    });
  });

  it("ignores a command for an endpoint that was never bridged", async () => {
    const { server, capabilities, driver } = build();
    await driver.start();
    server.simulateEcosystemCommand(99, true);
    await new Promise((r) => setTimeout(r, 10));
    expect(capabilities.commands).toHaveLength(0);
  });
});

describe("MatterBridgeDriver — SupremeOS → Matter (direction 2)", () => {
  it("mirrors real physical/automation feedback onto the Matter attribute", async () => {
    const { server, capabilities, driver } = build();
    await driver.start();
    await driver.exposeDevice("living-room-light" as DeviceId, "Living Room Light", ONOFF_CAPS);

    capabilities.setState("living-room-light" as DeviceId, true);
    await vi.waitFor(() => expect(server.endpoints.get(1)?.on).toBe(true));
  });

  it("does not touch Matter state for a device that was never bridged", async () => {
    const { server, capabilities, driver } = build();
    await driver.start();
    capabilities.setState("some-other-device" as DeviceId, true);
    await new Promise((r) => setTimeout(r, 10));
    expect(server.endpoints.size).toBe(0);
  });
});

describe("MatterBridgeDriver — full bidirectional round trip + feedback-loop prevention", () => {
  it("Matter command → SupremeOS → native driver → physical state → feedback → Matter, with no re-entrant command", async () => {
    const { server, capabilities, driver } = build();
    await driver.start();
    await driver.exposeDevice("living-room-light" as DeviceId, "Living Room Light", ONOFF_CAPS);
    expect(server.endpoints.get(1)?.on).toBe(false);

    server.simulateEcosystemCommand(1, true);
    // capabilities.command() synchronously simulates the native driver's real feedback via
    // setState(), which the driver mirrors back onto the Matter attribute.
    await vi.waitFor(() => expect(server.endpoints.get(1)?.on).toBe(true));

    // Exactly one command was issued — the state-report write did not re-trigger a command.
    expect(capabilities.commands).toHaveLength(1);
  });

  it("does not re-issue setOnOffState for a redundant, unchanged state report", async () => {
    const { server, capabilities, driver } = build();
    await driver.start();
    await driver.exposeDevice("living-room-light" as DeviceId, "Living Room Light", ONOFF_CAPS);
    const spy = vi.spyOn(server, "setCapabilityState");

    capabilities.setState("living-room-light" as DeviceId, true);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    capabilities.setState("living-room-light" as DeviceId, true); // identical — no real change
    await new Promise((r) => setTimeout(r, 10));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("MatterBridgeDriver — endpoint identity persistence across restart", () => {
  it("re-exposes a previously-bridged device at its SAME endpoint number after stop/start", async () => {
    const server = new FakeMatterBridgeServer();
    const store = new InMemoryMatterEndpointStore();
    const registry = new MatterEndpointRegistry(store);
    const capabilities = new FakeCapabilityPort();

    const driver1 = new MatterBridgeDriver({ server, registry, capabilities });
    await driver1.start();
    await driver1.exposeDevice("living-room-light" as DeviceId, "Living Room Light", ONOFF_CAPS);
    await driver1.stop();
    expect(server.started).toBe(false);

    // A fresh driver instance (process restart) reusing the SAME persisted registry — this is
    // exactly what a real gateway restart looks like: new process, same `endpoints.json`.
    const driver2 = new MatterBridgeDriver({
      server,
      registry: new MatterEndpointRegistry(store),
      capabilities,
    });
    await driver2.start();
    expect(server.endpoints.has(1)).toBe(true);
    // § live-confirmed fix (Matter Bridge Phase 1.2) — this used to assert the raw device ID
    // ("living-room-light"), which is EXACTLY the bug reported live: Apple Home displaying
    // "dev01M1YC0RA8..." instead of the real device name, because start()'s restart re-expose
    // loop had nothing but the deviceId to fall back to. The registry now persists the real
    // name and start() uses it.
    expect(server.endpoints.get(1)?.name).toBe("Living Room Light");
  });
});

describe("MatterBridgeDriver — Phase 5 §10 controlled commissioning logging", () => {
  it("logs the pairing code exactly once at start, while genuinely uncommissioned", async () => {
    // FakeMatterBridgeServer.getCommissioningState() -> commissioned: false (see class above)
    const onLog = vi.fn();
    const server = new FakeMatterBridgeServer();
    const registry = new MatterEndpointRegistry(new InMemoryMatterEndpointStore());
    const capabilities = new FakeCapabilityPort();
    const driver = new MatterBridgeDriver({ server, registry, capabilities, onLog });

    await driver.start();

    expect(onLog).toHaveBeenCalledWith("warn", expect.stringContaining("34970112332"));
    expect(onLog).toHaveBeenCalledWith("warn", expect.stringContaining("SENSITIVE"));
  });

  it("does NOT log the pairing code once the node is already commissioned", async () => {
    class CommissionedFakeServer extends FakeMatterBridgeServer {
      getCommissioningState() {
        return { commissioned: true, fabrics: [{ fabricIndex: 1, label: "Apple Home", rootVendorId: 0x1234 }], pairing: { manualPairingCode: "34970112332", qrPairingCode: "MT:FAKE", discriminator: 3840 } };
      }
    }
    const server = new CommissionedFakeServer();
    const onLog = vi.fn();
    const registry = new MatterEndpointRegistry(new InMemoryMatterEndpointStore());
    const capabilities = new FakeCapabilityPort();
    const driver = new MatterBridgeDriver({ server, registry, capabilities, onLog });

    await driver.start();

    for (const call of onLog.mock.calls) {
      expect(call[1]).not.toContain("34970112332");
    }
  });
});

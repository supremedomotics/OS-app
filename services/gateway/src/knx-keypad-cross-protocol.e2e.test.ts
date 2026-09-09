import { newId, type DeviceId, type HomeId, type KeypadInputEvent } from "@supreme/domain-model";
import { Automation } from "@supreme/domain-model";
import type { AutomationExecutors } from "@supreme/automations";
import { AutomationEngine } from "@supreme/automations";
import { SupremeNativeAdapter, SupremeIntegrationLayer } from "@supreme/integration-layer";
import { SupremeKnxDriver, LutronProtocolDriver } from "@supreme/protocols";
import type { IKnxProvider, KnxTask, KnxProviderDiagnostics, KnxProviderHealth } from "@supreme/protocols";
import { KeypadMappingEngine, KeypadMappingService, UniversalInputEngine, InMemoryKeypadMappingStore } from "@supreme/keypad-framework";
import { afterEach, describe, expect, it } from "vitest";
import type net from "node:net";
import { EventEmitter } from "node:events";

/**
 * § Supreme Universal Keypad, Stage 5B — KNX as the second physical input protocol.
 *
 * Mirrors `keypad-cross-protocol.e2e.test.ts`'s Stage 4A proof exactly, with KNX as the SOURCE
 * this time (Casambi proved the pattern first; this proves it generalizes with zero protocol
 * branches added anywhere above `SupremeKnxDriver`'s own boundary):
 *
 *   real KNX GroupValueWrite telegram (DPT1.001 make/break)
 *     -> SupremeKnxDriver.observeKeypadButton decodes it (real, unmodified decode path)
 *     -> SupremeKnxDriver.onInputEvent (Stage 5B's one new bridge, same shape as Casambi's)
 *     -> SupremeNativeAdapter's generic per-driver onInputEvent wiring (pre-existing, unmodified)
 *     -> SupremeIntegrationLayer.subscribeKeypadInput (pre-existing passthrough)
 *     -> UniversalInputEngine.ingest (pre-existing, protocol-agnostic press-timing engine —
 *        THIS is what turns raw button_pressed/button_released into short_press, not the driver)
 *     -> KeypadMappingService -> KeypadMappingEngine (direct mapping, Stage 2, unmodified)
 *        AND
 *     -> AutomationEngine.onKeypadInput (Stage 4B, unmodified) — the SAME normalized event,
 *        no KNX-specific trigger type, fired independently of the direct mapping (§ coexistence)
 *     -> the TARGET protocol's own driver (Lutron), exercised through its existing real DI seam.
 */
class FakeKnxProvider implements IKnxProvider {
  readonly name = "fake";
  connected = false;
  writes: KnxTask[] = [];
  private observers = new Map<string, (value: unknown) => void>();
  async initialize(): Promise<void> {}
  async discover() { return []; }
  async connect(): Promise<void> { this.connected = true; }
  async disconnect(): Promise<void> { this.connected = false; }
  async shutdown(): Promise<void> { this.connected = false; }
  async execute(task: KnxTask): Promise<unknown> {
    if (task.kind === "bus.group_write") { this.writes.push(task); return undefined; }
    if (task.kind === "bus.group_read") return undefined;
    throw new Error(`unsupported: ${task.kind}`);
  }
  subscribe(ga: string, _dpt: string, handler: (value: unknown) => void): void { this.observers.set(ga, handler); }
  unsubscribe(ga: string): void { this.observers.delete(ga); }
  health(): KnxProviderHealth { return { connected: this.connected, lastError: null }; }
  diagnostics(): KnxProviderDiagnostics {
    return { provider: this.name, connected: this.connected, packetsSent: this.writes.length, packetsReceived: 0, lastTelegramAt: null, lastCommandAt: null, lastError: null, reconnectAttempts: 0 };
  }
  /** Simulates a REAL physical push-button's GroupValueWrite telegram. */
  emit(ga: string, value: unknown): void { this.observers.get(ga)?.(value); }
}

class FakeLutronSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  setEncoding(): void {}
  write(data: string): boolean { this.written.push(data); return true; }
  destroy(): void { this.destroyed = true; }
  handshake(): void {
    this.emit("data", "login: ");
    this.emit("data", "password: ");
    this.emit("data", "GNET> ");
  }
  reportOutput(id: string, level: number): void { this.emit("data", `~OUTPUT,${id},1,${level}\r\n`); }
}

function executors(adapter: SupremeNativeAdapter): AutomationExecutors {
  return {
    command: (deviceId, command) => adapter.command(deviceId, command),
    getState: (deviceId, capability) => Promise.resolve(adapter.getState(deviceId, capability)),
    activateScene: async () => {},
    notify: async () => {},
  };
}

describe("Supreme Universal Keypad — Stage 5B, KNX as a second physical input protocol", () => {
  let cleanup: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.reverse()) await fn();
    cleanup = [];
  });

  /** Wires the REAL execution path, identical shape to Stage 4A's own harness — proves no new
   * pipeline was invented for KNX. */
  async function wireKeypadPipeline(drivers: import("@supreme/integration-layer").INativeProtocolDriver[]) {
    const adapter = new SupremeNativeAdapter({ drivers });
    const sil = new SupremeIntegrationLayer({ adapter });
    await sil.start();
    const mappingEngine = new KeypadMappingEngine({ executors: executors(adapter), sleep: async () => {} });
    const mappingService = new KeypadMappingService(mappingEngine, new InMemoryKeypadMappingStore());
    await mappingService.start();
    const automationRuns: { trigger: string; ok: boolean }[] = [];
    const automations = new AutomationEngine({ executors: executors(adapter), onRun: (id, ok) => automationRuns.push({ trigger: "keypad_input", ok }) });
    const inputEngine = new UniversalInputEngine({
      publish: (event: KeypadInputEvent) => {
        void mappingService.onInputEvent(event);
        void automations.onKeypadInput(event);
      },
      doublePressWindowMs: 5,
    });
    const unsub = sil.subscribeKeypadInput((event) => inputEngine.ingest(event));
    cleanup.push(() => { unsub(); inputEngine.dispose(); });
    return { adapter, sil, mappingEngine, mappingService, automations, automationRuns };
  }

  it("1. KNX Button 1 -> short_press (derived by the REAL Universal Input Engine, not the driver) -> Direct -> Lutron output", async () => {
    const provider = new FakeKnxProvider();
    const knx = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    const lutronSocket = new FakeLutronSocket();
    const lutron = new LutronProtocolDriver({ host: "10.0.0.2", createSocket: () => lutronSocket as unknown as net.Socket });

    const keypadId = newId("device") as DeviceId;
    const outputId = newId("device") as DeviceId;
    // § Identity — the Supreme DeviceId is assigned directly by commissioning (bindKeypadButton
    // takes it as a parameter, exactly like bind() does for a capability) — the KNX group
    // address below is only ever the protocol backend identity underneath it, never the ID.
    knx.bindKeypadButton(keypadId, "1", "1/2/1");

    const { adapter, mappingService } = await wireKeypadPipeline([knx, lutron]);
    await knx.connect();
    cleanup.push(() => knx.disconnect());
    await adapter.bind({ deviceId: outputId, capability: "onoff", address: "2" }, "lutron");
    lutronSocket.handshake();

    await mappingService.create({
      homeId: newId("home") as HomeId,
      name: "KNX Button 1 -> Lutron output",
      input: { keypadId, control: "1", event: "short_press" },
      behavior: "direct",
      actions: [{ type: "device_command", deviceId: outputId, command: { capability: "onoff", action: "on" } }],
    });

    provider.emit("1/2/1", true); // real press (make contact)
    provider.emit("1/2/1", false); // real release (break contact) — short_press only exists
    // once the Universal Input Engine has seen BOTH, exactly like a physical finger tap.
    await new Promise((r) => setTimeout(r, 15));

    expect(lutronSocket.written.some((w) => w.includes("#OUTPUT,2,1,100"))).toBe(true);
  });

  it("2. KNX Button -> short_press -> Automation WHEN, using the SAME normalized event Casambi already uses, no KNX-specific trigger type", async () => {
    const provider = new FakeKnxProvider();
    const knx = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });

    const keypadId = newId("device") as DeviceId;
    knx.bindKeypadButton(keypadId, "5", "1/2/5");

    const { automations, automationRuns } = await wireKeypadPipeline([knx]);
    await knx.connect();
    cleanup.push(() => knx.disconnect());

    automations.setAutomations([
      Automation.parse({
        id: newId("automation"),
        homeId: newId("home") as HomeId,
        name: "KNX keypad WHEN",
        triggers: [{ type: "keypad_input", keypadId, control: "5", event: "short_press" }],
        actions: [{ type: "notify", level: "info", title: "pressed", body: "pressed" }],
      }),
    ]);

    provider.emit("1/2/5", true);
    provider.emit("1/2/5", false);
    await new Promise((r) => setTimeout(r, 15));

    expect(automationRuns.some((r) => r.trigger === "keypad_input" && r.ok)).toBe(true);
  });

  it("3. Direct mapping and Automation WHEN both fire from the SAME KNX press — neither suppresses the other (§ coexistence, same policy Casambi already proved)", async () => {
    const provider = new FakeKnxProvider();
    const knx = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    const lutronSocket = new FakeLutronSocket();
    const lutron = new LutronProtocolDriver({ host: "10.0.0.2", createSocket: () => lutronSocket as unknown as net.Socket });

    const keypadId = newId("device") as DeviceId;
    const outputId = newId("device") as DeviceId;
    knx.bindKeypadButton(keypadId, "9", "1/2/9");

    const { adapter, mappingService, automations, automationRuns } = await wireKeypadPipeline([knx, lutron]);
    await knx.connect();
    cleanup.push(() => knx.disconnect());
    await adapter.bind({ deviceId: outputId, capability: "onoff", address: "3" }, "lutron");
    lutronSocket.handshake();

    await mappingService.create({
      homeId: newId("home") as HomeId,
      name: "Direct",
      input: { keypadId, control: "9", event: "short_press" },
      behavior: "direct",
      actions: [{ type: "device_command", deviceId: outputId, command: { capability: "onoff", action: "on" } }],
    });
    automations.setAutomations([
      Automation.parse({
        id: newId("automation"),
        homeId: newId("home") as HomeId,
        name: "Automation",
        triggers: [{ type: "keypad_input", keypadId, control: "9", event: "short_press" }],
        actions: [{ type: "notify", level: "info", title: "pressed", body: "pressed" }],
      }),
    ]);

    provider.emit("1/2/9", true);
    provider.emit("1/2/9", false);
    await new Promise((r) => setTimeout(r, 15));

    expect(lutronSocket.written.some((w) => w.includes("#OUTPUT,3,1,100"))).toBe(true);
    expect(automationRuns.some((r) => r.trigger === "keypad_input" && r.ok)).toBe(true);
  });

  it("4. Multi-instance isolation: two KNX gateways, both with a button on GA 1/2/1, never cross-fire", async () => {
    const providerA = new FakeKnxProvider();
    const providerB = new FakeKnxProvider();
    const knxA = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: providerA });
    const knxB = new SupremeKnxDriver({ host: "10.0.0.2", ultimateProvider: providerB });
    const lutronSocket = new FakeLutronSocket();
    const lutron = new LutronProtocolDriver({ host: "10.0.0.3", createSocket: () => lutronSocket as unknown as net.Socket });

    const keypadA = newId("device") as DeviceId;
    const keypadB = newId("device") as DeviceId;
    const outputA = newId("device") as DeviceId;
    const outputB = newId("device") as DeviceId;
    knxA.bindKeypadButton(keypadA, "1", "1/2/1");
    knxB.bindKeypadButton(keypadB, "1", "1/2/1"); // same GA string, physically different gateway

    const { adapter, mappingService } = await wireKeypadPipeline([knxA, knxB, lutron]);
    await knxA.connect();
    await knxB.connect();
    cleanup.push(() => knxA.disconnect(), () => knxB.disconnect());
    await adapter.bind({ deviceId: outputA, capability: "onoff", address: "4" }, "lutron");
    await adapter.bind({ deviceId: outputB, capability: "onoff", address: "5" }, "lutron");
    lutronSocket.handshake();

    await mappingService.create({
      homeId: newId("home") as HomeId, name: "Instance A mapping",
      input: { keypadId: keypadA, control: "1", event: "short_press" },
      behavior: "direct", actions: [{ type: "device_command", deviceId: outputA, command: { capability: "onoff", action: "on" } }],
    });
    await mappingService.create({
      homeId: newId("home") as HomeId, name: "Instance B mapping",
      input: { keypadId: keypadB, control: "1", event: "short_press" },
      behavior: "direct", actions: [{ type: "device_command", deviceId: outputB, command: { capability: "onoff", action: "on" } }],
    });

    providerA.emit("1/2/1", true);
    providerA.emit("1/2/1", false);
    await new Promise((r) => setTimeout(r, 15));
    expect(lutronSocket.written.filter((w) => w.includes("#OUTPUT")).some((w) => w.includes("#OUTPUT,4,1,100"))).toBe(true);
    expect(lutronSocket.written.some((w) => w.includes("#OUTPUT,5,1,100"))).toBe(false);
  });
});

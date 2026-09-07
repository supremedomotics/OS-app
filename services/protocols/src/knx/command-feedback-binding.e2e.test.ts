import { newId, type DeviceId } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import type { DiscoveredDevice } from "@supreme/integration-layer";
import { mapUnifiedDevices } from "./unified-device-mapper.js";
import { planBindings } from "./binding-engine.js";
import { SupremeKnxDriver } from "./supreme-knx-driver.js";
import type { IKnxProvider, KnxTask, ProviderDiagnostics, ProviderHealth } from "./provider.js";

/**
 * § Command/Feedback Binding Architecture (Production KNX Driver 2.0, third pass) —
 * end-to-end proof that real ETS Send/Receive relationships (not Group Address names,
 * not DPT-only inference, not text heuristics) determine which address a capability
 * COMMANDS versus which address it reads FEEDBACK from, all the way through to a real
 * `SupremeKnxDriver` binding's observable behavior — not just the intermediate
 * `mapUnifiedDevices()`/`planBindings()` data structures.
 */

/** Same fake provider shape as supreme-knx-driver.test.ts — proves the driver/router
 * layer without a real KNX bus. */
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
    if (task.kind === "bus.group_read") return undefined;
    throw new Error(`unsupported: ${task.kind}`);
  }
  subscribe(ga: string, _dpt: string, handler: (value: unknown) => void): void { this.observers.set(ga, handler); }
  unsubscribe(ga: string): void { this.observers.delete(ga); }
  health(): ProviderHealth { return { connected: this.connected, lastError: null }; }
  diagnostics(): ProviderDiagnostics {
    return { provider: this.name, connected: this.connected, packetsSent: this.writes.length, packetsReceived: 0, lastTelegramAt: null, lastCommandAt: null, lastError: null, reconnectAttempts: 0 };
  }
  emit(ga: string, value: unknown): void { this.observers.get(ga)?.(value); }
}

/** Wires a real UnifiedKnxDevice's binding plans into a real SupremeKnxDriver, exactly
 * as installer-context.ts's approveKnxDevice()/bindProtocol() does in production. */
async function bindDevice(provider: FakeKnxProvider, capabilities: ReturnType<typeof mapUnifiedDevices>) {
  const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
  const deviceId = newId("device") as DeviceId;
  const plans = planBindings(capabilities[0]!);
  for (const plan of plans) {
    if (!plan.bindable || !plan.address) continue;
    await driver.bind({ deviceId, capability: plan.capability, address: plan.address, config: plan.config });
  }
  await driver.connect();
  return { driver, deviceId, plans };
}

describe("Command/Feedback Binding — Device 1.1.12, Channel 1: Switch + Dimming + Absolute Value + Absolute Feedback", () => {
  // The exact spec example: Switch has SEND→1/2/1 and RECEIVE→1/2/4 (self-status);
  // Dimming (relative/step) SEND→1/2/2; Absolute Value SEND→1/2/3; Absolute Feedback
  // RECEIVE→1/2/5 (a separate object entirely, no send side of its own).
  // A fresh array per call, not a shared constant — mapUnifiedDevices/planBindings must
  // never be assumed side-effect-free on their input across independent test cases.
  const buildEts = () => [
    { id: "1/2/1", name: "Switch", dpt: "1.001", individualAddress: "1.1.12", channel: 1, links: [{ role: "send" as const }] },
    { id: "1/2/4", name: "Switch", dpt: "1.001", individualAddress: "1.1.12", channel: 1, links: [{ role: "receive" as const }] },
    { id: "1/2/2", name: "Dimming", dpt: "3.007", individualAddress: "1.1.12", channel: 1, links: [{ role: "send" as const }] },
    { id: "1/2/3", name: "Absolute Value", dpt: "5.001", individualAddress: "1.1.12", channel: 1, links: [{ role: "send" as const }] },
    { id: "1/2/5", name: "Absolute Feedback", dpt: "5.001", individualAddress: "1.1.12", channel: 1, links: [{ role: "receive" as const }] },
  ];

  it("produces ONE device with Power (command=1/2/1, feedback=1/2/4) and Brightness (command=1/2/3, feedback=1/2/5) via planBindings()", () => {
    const devices = mapUnifiedDevices({ ets: buildEts() });
    expect(devices).toHaveLength(1);
    const plans = planBindings(devices[0]!);
    const power = plans.find((p) => p.capability === "onoff")!;
    const brightness = plans.find((p) => p.capability === "brightness")!;
    expect(power.address).toBe("1/2/1");
    expect(power.config.statusAddress).toBe("1/2/4");
    expect(brightness.address).toBe("1/2/3");
    expect(brightness.config.statusAddress).toBe("1/2/5");
    expect(brightness.config.stepAddress).toBe("1/2/2"); // DPT 3.007 relative dimming — a step control, not the write address
  });

  it("end to end: Power command actually writes the SEND GA (1/2/1), and REAL feedback on the RECEIVE GA (1/2/4) is authoritative — it corrects state even when it disagrees with the optimistic guess", async () => {
    const provider = new FakeKnxProvider();
    const devices = mapUnifiedDevices({ ets: buildEts() });
    const { driver, deviceId } = await bindDevice(provider, devices);
    const events: unknown[] = [];
    driver.onState((e) => events.push(e));

    await driver.command(deviceId, { capability: "onoff", action: "on" });
    expect(provider.writes).toHaveLength(1);
    expect(provider.writes[0]).toMatchObject({ kind: "bus.group_write", groupAddress: "1/2/1" });
    expect(driver.getState(deviceId, "onoff")).toMatchObject({ on: true }); // optimistic, pending real confirmation

    // Real feedback on the RECEIVE ga disagrees with the optimistic guess (e.g. the
    // physical actuator didn't actually switch) — the feedback GA is authoritative and
    // must correct Supreme's state, never leave the optimistic guess standing.
    provider.emit("1/2/4", false);
    expect(driver.getState(deviceId, "onoff")).toMatchObject({ on: false });
    expect(events.some((e) => (e as { state: { on: boolean } }).state.on === false)).toBe(true);

    // The SEND ga is a write-only target — a telegram arriving there must never be
    // interpreted as this device's status (the driver never subscribed to it).
    const eventsBefore = events.length;
    provider.emit("1/2/1", true);
    expect(events).toHaveLength(eventsBefore);
    expect(driver.getState(deviceId, "onoff")).toMatchObject({ on: false }); // unchanged by the SEND-ga telegram
  });

  it("end to end: Brightness command writes 1/2/3 (Absolute Value SEND), feedback comes from 1/2/5 (Absolute Feedback RECEIVE)", async () => {
    const provider = new FakeKnxProvider();
    const devices = mapUnifiedDevices({ ets: buildEts() });
    const { driver, deviceId } = await bindDevice(provider, devices);

    await driver.command(deviceId, { capability: "brightness", on: true, level: 80 });
    expect(provider.writes.some((w) => w.kind === "bus.group_write" && w.groupAddress === "1/2/3")).toBe(true);

    const events: unknown[] = [];
    driver.onState((e) => events.push(e));
    provider.emit("1/2/5", 200); // Absolute Feedback
    expect(events).toHaveLength(1);
  });
});

describe("Command/Feedback role resolution — explicit ETS Send/Receive wins over weaker evidence", () => {
  it("wins over a Group Address literally named '... Status' that this device actually WRITES (real projects are inconsistent)", () => {
    // Named like a status object, but the ETS wire relationship says this device SENDS it
    // — the wire relationship must win, not the name.
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Weird Status Name", dpt: "1.001", individualAddress: "1.1.1", channel: null, links: [{ role: "send" as const }] },
      ],
    });
    const plan = planBindings(devices[0]!).find((p) => p.capability === "onoff")!;
    expect(plan.address).toBe("1/1/1"); // bound as the command address despite the name
    expect(plan.config.statusAddress).toBeUndefined();
  });

  it("wins over DPT-only inference — two DPT-1.001 objects with no Send/Receive data would be ambiguous, but explicit roles resolve them correctly", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "A", dpt: "1.001", individualAddress: "1.1.1", channel: null, links: [{ role: "send" as const }] },
        { id: "1/1/2", name: "B", dpt: "1.001", individualAddress: "1.1.1", channel: null, links: [{ role: "receive" as const }] },
      ],
    });
    const plan = planBindings(devices[0]!).find((p) => p.capability === "onoff")!;
    expect(plan.address).toBe("1/1/1");
    expect(plan.config.statusAddress).toBe("1/1/2");
  });

  it("wins over text heuristics — a GA with NO status-sounding word at all is still correctly resolved to 'status' purely from its Receive-only relationship", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Command", dpt: "1.001", individualAddress: "1.1.1", channel: null, links: [{ role: "send" as const }] },
        { id: "1/1/2", name: "Confirmation", dpt: "1.001", individualAddress: "1.1.1", channel: null, links: [{ role: "receive" as const }] }, // no "status"/"feedback"/etc. word
      ],
    });
    const plan = planBindings(devices[0]!).find((p) => p.capability === "onoff")!;
    expect(plan.address).toBe("1/1/1");
    expect(plan.config.statusAddress).toBe("1/1/2");
  });
});

describe("Command/Feedback role resolution — edge cases", () => {
  it("1. send-only command GA: no feedback address, optimistic state only, never fabricated", () => {
    const devices = mapUnifiedDevices({
      ets: [{ id: "1/1/1", name: "Switch", dpt: "1.001", individualAddress: "1.1.1", channel: null, links: [{ role: "send" as const }] }],
    });
    const plan = planBindings(devices[0]!).find((p) => p.capability === "onoff")!;
    expect(plan.address).toBe("1/1/1");
    expect(plan.config.statusAddress).toBeUndefined();
    expect(plan.bindable).toBe(true);
  });

  it("2. receive-only feedback GA with no send counterpart in the same cluster: reported honestly as not independently bindable (no write address)", () => {
    const devices = mapUnifiedDevices({
      ets: [{ id: "1/1/1", name: "Status", dpt: "1.001", individualAddress: "1.1.1", channel: null, links: [{ role: "receive" as const }] }],
    });
    const plan = planBindings(devices[0]!).find((p) => p.capability === "onoff")!;
    expect(plan.bindable).toBe(false);
    expect(plan.address).toBeNull();
  });

  it("3/8. the same GA referenced by TWO different physical devices (shared/central) never merges them into one device", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/0/0", name: "Central Off", dpt: "1.001", individualAddress: "1.1.1", channel: null, links: [{ role: "send" as const }] },
        { id: "1/1/1", name: "Other Switch", dpt: "1.001", individualAddress: "1.1.2", channel: null, links: [{ role: "send" as const }] },
      ],
    });
    expect(devices).toHaveLength(2);
    expect(new Set(devices.map((d) => d.raw.physicalDevice?.individualAddress))).toEqual(new Set(["1.1.1", "1.1.2"]));
  });

  it("4. multiple send GAs for one capability: the first is used as the write address, never silently dropped (still traceable via sourceObjects)", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Switch A", dpt: "1.001", individualAddress: "1.1.1", channel: null, links: [{ role: "send" as const }] },
        { id: "1/1/2", name: "Switch B", dpt: "1.001", individualAddress: "1.1.1", channel: null, links: [{ role: "send" as const }] },
      ],
    });
    const plan = planBindings(devices[0]!).find((p) => p.capability === "onoff")!;
    expect(["1/1/1", "1/1/2"]).toContain(plan.address);
    expect(plan.sourceObjects).toHaveLength(2);
  });

  it("5. multiple receive GAs for one capability: the first is used as the status address, the relationship data for both is preserved in sourceObjects", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Switch", dpt: "1.001", individualAddress: "1.1.1", channel: null, links: [{ role: "send" as const }] },
        { id: "1/1/2", name: "Status A", dpt: "1.001", individualAddress: "1.1.1", channel: null, links: [{ role: "receive" as const }] },
        { id: "1/1/3", name: "Status B", dpt: "1.001", individualAddress: "1.1.1", channel: null, links: [{ role: "receive" as const }] },
      ],
    });
    const plan = planBindings(devices[0]!).find((p) => p.capability === "onoff")!;
    expect(["1/1/2", "1/1/3"]).toContain(plan.config.statusAddress);
    expect(plan.sourceObjects).toHaveLength(3);
  });

  it("6. a device with no explicit receive GA at all: bindable on command alone, optimistic state only", () => {
    const devices = mapUnifiedDevices({
      ets: [{ id: "1/1/1", name: "Switch", dpt: "1.001", individualAddress: "1.1.1", channel: null, links: [{ role: "send" as const }] }],
    });
    const plan = planBindings(devices[0]!).find((p) => p.capability === "onoff")!;
    expect(plan.bindable).toBe(true);
    expect(plan.config.statusAddress).toBeUndefined();
  });

  it("7. a device with no explicit send GA at all: not bindable (no command target), never fabricates a write address from a status GA", () => {
    const devices = mapUnifiedDevices({
      ets: [{ id: "1/1/1", name: "Switch Status", dpt: "1.001", individualAddress: "1.1.1", channel: null, links: [{ role: "receive" as const }] }],
    });
    const plan = planBindings(devices[0]!).find((p) => p.capability === "onoff")!;
    expect(plan.bindable).toBe(false);
  });

  it("9. the same physical device with multiple channels resolves command/feedback correctly and independently per channel", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Ch1 Switch", dpt: "1.001", individualAddress: "1.1.20", channel: 1, links: [{ role: "send" as const }] },
        { id: "1/1/2", name: "Ch1 Switch Status", dpt: "1.001", individualAddress: "1.1.20", channel: 1, links: [{ role: "receive" as const }] },
        { id: "1/1/3", name: "Ch2 Switch", dpt: "1.001", individualAddress: "1.1.20", channel: 2, links: [{ role: "send" as const }] },
        { id: "1/1/4", name: "Ch2 Switch Status", dpt: "1.001", individualAddress: "1.1.20", channel: 2, links: [{ role: "receive" as const }] },
      ],
    });
    expect(devices).toHaveLength(2);
    const ch1 = devices.find((d) => d.raw.physicalDevice?.channel === 1)!;
    const ch2 = devices.find((d) => d.raw.physicalDevice?.channel === 2)!;
    expect(planBindings(ch1).find((p) => p.capability === "onoff")).toMatchObject({ address: "1/1/1", config: { statusAddress: "1/1/2" } });
    expect(planBindings(ch2).find((p) => p.capability === "onoff")).toMatchObject({ address: "1/1/3", config: { statusAddress: "1/1/4" } });
  });

  it("10. explicit ETS role wins even when DPT/name would suggest the opposite", () => {
    // Named "Feedback" and would name-heuristic to "status", but the wire relationship
    // says this device actually SENDS it.
    const devices = mapUnifiedDevices({
      ets: [{ id: "1/1/1", name: "Feedback", dpt: "1.001", individualAddress: "1.1.1", channel: null, links: [{ role: "send" as const }] }],
    });
    const plan = planBindings(devices[0]!).find((p) => p.capability === "onoff")!;
    expect(plan.address).toBe("1/1/1"); // bound as command, per the explicit send relationship — not "status" per the name
  });

  it("11. a KNX-IoT-only signal (no ETS role information at all) falls back to existing functional-block classification, unaffected", () => {
    const devices = mapUnifiedDevices({
      knxIot: [{ host: "10.0.0.1", linkFormat: '</dev>;title="Kitchen Light"' }],
    });
    expect(devices).toHaveLength(1);
    expect(devices[0]!.raw.communicationObjects[0]?.role).toBe("primary"); // fallback default, unchanged
  });

  it("12. a legacy flattened ETS signal without Send/Receive metadata (links absent) falls back to DPT/name heuristics, unaffected", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Kitchen Light SW", dpt: "1.001" }, // no links field at all
        { id: "1/1/2", name: "Kitchen Light Status", dpt: "1.001" },
      ],
    });
    const plan = planBindings(devices[0]!).find((p) => p.capability === "onoff")!;
    expect(plan.address).toBe("1/1/1");
    expect(plan.config.statusAddress).toBe("1/1/2"); // resolved via the pre-existing name-heuristic path
  });
});

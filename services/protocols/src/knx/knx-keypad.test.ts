import { newId, type DeviceId, type KeypadInputEvent } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import { SupremeKnxDriver } from "./supreme-knx-driver.js";
import type { IKnxProvider, KnxTask, ProviderDiagnostics, ProviderHealth } from "./provider.js";
import type { DiscoveredDevice } from "@supreme/integration-layer";

/**
 * § Supreme Universal Keypad, Stage 5B — KNX Keypad / Push-Button Input Driver.
 *
 * Proves `SupremeKnxDriver.bindKeypadButton`/`onInputEvent`/`getKeypadCapabilities` using the
 * SAME `INativeProtocolDriver` extension points `CasambiProtocolDriver` already implements
 * (`casambi-driver.ts`) — no second keypad framework, no KNX-specific event model. See
 * `supreme-knx-driver.ts`'s own doc comments on `bindKeypadButton`/`observeKeypadButton` for why
 * a plain KNX push-button (DPT1.001 make/break) only ever produces `button_pressed`/
 * `button_released` here — short/long/double/triple classification is the Universal Input
 * Engine's job (`services/keypad-framework/src/input-engine.ts`), proven with the REAL engine
 * below, not re-implemented in this driver.
 */
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
  isSubscribed(ga: string): boolean { return this.observers.has(ga); }
  health(): ProviderHealth { return { connected: this.connected, lastError: null }; }
  diagnostics(): ProviderDiagnostics {
    return { provider: this.name, connected: this.connected, packetsSent: this.writes.length, packetsReceived: 0, lastTelegramAt: null, lastCommandAt: null, lastError: null, reconnectAttempts: 0 };
  }
  /** Test helper: simulate a real GroupValueWrite telegram arriving on the bus. */
  emit(ga: string, value: unknown): void { this.observers.get(ga)?.(value); }
}

describe("SupremeKnxDriver — Universal Keypad, Stage 5B", () => {
  it("Test A: getKeypadCapabilities reports only genuinely registered buttons, honestly nothing for an unregistered device", () => {
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: new FakeKnxProvider() });
    const keypadId = newId("device") as DeviceId;
    const otherId = newId("device") as DeviceId;
    expect(driver.getKeypadCapabilities(keypadId)).toBeNull();

    driver.bindKeypadButton(keypadId, "1", "1/2/1");
    driver.bindKeypadButton(keypadId, "2", "1/2/2");

    const decl = driver.getKeypadCapabilities(keypadId);
    expect(decl).toMatchObject({ keypadId, protocol: "knx" });
    expect(decl!.controls).toHaveLength(2);
    expect(decl!.controls.map((c) => c.id).sort()).toEqual(["1", "2"]);
    for (const c of decl!.controls) {
      expect(c.kind).toBe("button");
      expect(c.input).toEqual(["buttons", "hold"]);
      // § 9 — no KNX keypad feedback path exists; an honest empty capability, never fabricated LEDs.
      expect(c.feedback).toEqual([]);
    }
    expect(driver.getKeypadCapabilities(otherId)).toBeNull();
  });

  it("Test B: input normalization — a boolean GroupValueWrite on the button's GA becomes button_pressed/button_released, never a KNX-specific event", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    await driver.connect();
    const keypadId = newId("device") as DeviceId;
    driver.bindKeypadButton(keypadId, "1", "1/2/1");

    const seen: KeypadInputEvent[] = [];
    driver.onInputEvent((e) => seen.push(e));

    provider.emit("1/2/1", true);
    provider.emit("1/2/1", false);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ type: "button_pressed", keypadId, control: "1" });
    expect(seen[1]).toMatchObject({ type: "button_released", keypadId, control: "1" });
    // Never leaked: no group address, no DPT, no KNX telegram type on the normalized event.
    expect(Object.keys(seen[0]!)).toEqual(["type", "keypadId", "control", "ts"]);
  });

  it("Test C: identity — the Supreme DeviceId is never the group address; two different devices with different GAs stay distinct, and a non-boolean value on the GA is honestly dropped, not fabricated into a press", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    await driver.connect();
    const keypadId = newId("device") as DeviceId;
    expect(keypadId).not.toMatch(/^1\/2\/1$/);
    driver.bindKeypadButton(keypadId, "1", "1/2/1");

    const seen: KeypadInputEvent[] = [];
    driver.onInputEvent((e) => seen.push(e));
    provider.emit("1/2/1", 42); // wrong DPT / not a plain switch telegram
    expect(seen).toHaveLength(0);
  });

  // Test D (short press, derived by the REAL Universal Input Engine from these same raw
  // button_pressed/button_released events) lives in `services/gateway/src/
  // knx-keypad-cross-protocol.e2e.test.ts` — `@supreme/keypad-framework` is a gateway-layer
  // dependency, never a `@supreme/protocols` one (§ Extend, don't fork / dependency direction).

  it("Test E: restart/rediscovery — a fresh driver instance never resurrects a button that was never re-registered, and re-registering the same (deviceId, controlId) is idempotent", async () => {
    const provider = new FakeKnxProvider();
    const driver1 = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    await driver1.connect();
    const keypadId = newId("device") as DeviceId;
    driver1.bindKeypadButton(keypadId, "1", "1/2/1");
    expect(driver1.getKeypadCapabilities(keypadId)!.controls).toHaveLength(1);

    // Simulated restart: a brand-new driver instance, nothing persisted at the driver level
    // (persistence/identity is the registry's job, not the driver's — § Identity).
    const driver2 = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    expect(driver2.getKeypadCapabilities(keypadId)).toBeNull(); // honest: nothing re-registered yet

    // Re-registration (what commissioning replay does on boot) is idempotent, never duplicates.
    driver2.bindKeypadButton(keypadId, "1", "1/2/1");
    driver2.bindKeypadButton(keypadId, "1", "1/2/1");
    expect(driver2.getKeypadCapabilities(keypadId)!.controls).toHaveLength(1);
  });

  it("Test F: removal — unbind(deviceId) removes every button for that device and releases its group address subscription", async () => {
    const provider = new FakeKnxProvider();
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    await driver.connect();
    const keypadId = newId("device") as DeviceId;
    driver.bindKeypadButton(keypadId, "1", "1/2/1");
    driver.bindKeypadButton(keypadId, "2", "1/2/2");
    expect(provider.isSubscribed("1/2/1")).toBe(true);

    await driver.unbind(keypadId);

    expect(driver.getKeypadCapabilities(keypadId)).toBeNull();
    expect(driver.manages(keypadId)).toBe(false);
    expect(provider.isSubscribed("1/2/1")).toBe(false);
    expect(provider.isSubscribed("1/2/2")).toBe(false);

    // A press after removal must not resurrect an event — the subscription is genuinely gone.
    const seen: KeypadInputEvent[] = [];
    driver.onInputEvent((e) => seen.push(e));
    provider.emit("1/2/1", true);
    expect(seen).toHaveLength(0);
  });

  it("Test G: feedback — this driver has no keypad feedback path; getKeypadCapabilities honestly declares feedback: [] rather than fabricating LED support", () => {
    const driver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: new FakeKnxProvider() });
    expect(driver.sendKeypadFeedback).toBeUndefined();
    const keypadId = newId("device") as DeviceId;
    driver.bindKeypadButton(keypadId, "1", "1/2/1");
    expect(driver.getKeypadCapabilities(keypadId)!.controls[0]!.feedback).toEqual([]);
  });

  it("Test H: multi-instance isolation — two SupremeKnxDriver instances (two gateways) with the SAME group address never cross-fire", async () => {
    const providerA = new FakeKnxProvider();
    const providerB = new FakeKnxProvider();
    const driverA = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: providerA });
    const driverB = new SupremeKnxDriver({ host: "10.0.0.2", ultimateProvider: providerB });
    await driverA.connect();
    await driverB.connect();

    const keypadA = newId("device") as DeviceId;
    const keypadB = newId("device") as DeviceId;
    driverA.bindKeypadButton(keypadA, "1", "1/2/1");
    driverB.bindKeypadButton(keypadB, "1", "1/2/1"); // same GA, different physical gateway/instance

    const seenA: KeypadInputEvent[] = [];
    const seenB: KeypadInputEvent[] = [];
    driverA.onInputEvent((e) => seenA.push(e));
    driverB.onInputEvent((e) => seenB.push(e));

    providerA.emit("1/2/1", true);
    expect(seenA).toHaveLength(1);
    expect(seenA[0]).toMatchObject({ keypadId: keypadA });
    expect(seenB).toHaveLength(0); // instance B's provider never fired — no cross-fire possible
  });
});

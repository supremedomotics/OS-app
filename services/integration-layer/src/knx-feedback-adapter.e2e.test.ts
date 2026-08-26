import { newId, type DeviceId } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import { SupremeNativeAdapter } from "./native-adapter.js";
import type { BackendStateEvent } from "./adapter.js";

// These come from the protocols package's real ETS import/binding pipeline (same
// pipeline `command-feedback-binding.e2e.test.ts` proves in isolation) and the real
// SupremeKnxDriver — nothing here is a stand-in fake for the KNX-specific logic.
// eslint-disable-next-line import/no-relative-packages
import { mapUnifiedDevices } from "../../protocols/src/knx/unified-device-mapper.js";
// eslint-disable-next-line import/no-relative-packages
import { planBindings } from "../../protocols/src/knx/binding-engine.js";
// eslint-disable-next-line import/no-relative-packages
import { SupremeKnxDriver } from "../../protocols/src/knx/supreme-knx-driver.js";
// eslint-disable-next-line import/no-relative-packages
import type { IKnxProvider, KnxTask, ProviderDiagnostics, ProviderHealth } from "../../protocols/src/knx/provider.js";
import type { DiscoveredDevice } from "./protocols/driver.js";

/**
 * § Pass 25 — physical KNX keypad feedback investigation. `command-feedback-binding
 * .e2e.test.ts` (in `@supreme/protocols`) already proves real ETS Send/Receive data
 * survives import → `SupremeKnxDriver` binding → provider subscription, and
 * `native-adapter.test.ts` already proves `SupremeNativeAdapter` correctly fans out
 * ANY driver's `onState()` events. Neither test proves the two wired TOGETHER — this
 * closes that gap using the exact real ETS group addresses from live hardware
 * (Conference Hanging: onoff 5/3/0 write / 5/3/1 status; brightness 5/3/3 write /
 * 5/3/4 status), through the same `SupremeNativeAdapter.bind()`/`connect()` sequence
 * `installer-context.ts`'s `bindProtocol()` drives in production.
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
  health(): ProviderHealth { return { connected: this.connected, lastError: null }; }
  diagnostics(): ProviderDiagnostics {
    return { provider: this.name, connected: this.connected, packetsSent: this.writes.length, packetsReceived: 0, lastTelegramAt: null, lastCommandAt: null, lastError: null, reconnectAttempts: 0 };
  }
  emit(ga: string, value: unknown): void { this.observers.get(ga)?.(value); }
}

describe("SupremeKnxDriver feedback reaches SupremeNativeAdapter.onState() (real GAs 5/3/0-1, 5/3/3-4)", () => {
  it("physical ON/OFF and brightness feedback telegrams fan out through the adapter exactly like a command-issued state does", async () => {
    const ets = [
      { id: "5/3/0", name: "Conference Hanging Switch", dpt: "1.001", individualAddress: "1.1.20", channel: 1, links: [{ role: "send" as const }] },
      { id: "5/3/1", name: "Conference Hanging Switch Status", dpt: "1.001", individualAddress: "1.1.20", channel: 1, links: [{ role: "receive" as const }] },
      { id: "5/3/3", name: "Conference Hanging Brightness", dpt: "5.001", individualAddress: "1.1.20", channel: 1, links: [{ role: "send" as const }] },
      { id: "5/3/4", name: "Conference Hanging Brightness Status", dpt: "5.001", individualAddress: "1.1.20", channel: 1, links: [{ role: "receive" as const }] },
    ];
    const devices = mapUnifiedDevices({ ets });
    expect(devices).toHaveLength(1);
    const plans = planBindings(devices[0]!);
    const onoffPlan = plans.find((p) => p.capability === "onoff")!;
    const brightnessPlan = plans.find((p) => p.capability === "brightness")!;
    expect(onoffPlan.address).toBe("5/3/0");
    expect(onoffPlan.config.statusAddress).toBe("5/3/1");
    expect(brightnessPlan.address).toBe("5/3/3");
    expect(brightnessPlan.config.statusAddress).toBe("5/3/4");

    const provider = new FakeKnxProvider();
    const knxDriver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    const adapter = new SupremeNativeAdapter({ drivers: [knxDriver] });
    const events: BackendStateEvent[] = [];
    adapter.onState((e) => events.push(e));
    await adapter.connect(); // wires knxDriver.onState() into the adapter's fan-out, exactly like production boot

    const deviceId = newId("device") as DeviceId;
    await adapter.bind({ deviceId, capability: onoffPlan.capability, address: onoffPlan.address!, config: onoffPlan.config }, "knx");
    await adapter.bind({ deviceId, capability: brightnessPlan.capability, address: brightnessPlan.address!, config: brightnessPlan.config }, "knx");

    // A physical keypad press: a real GroupValueWrite telegram arrives on the STATUS
    // GA (never the command GA) — exactly what a keypad's own status object reports.
    provider.emit("5/3/1", true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ deviceId, capability: "onoff", state: { kind: "onoff", on: true } });
    expect(await adapter.getState(deviceId, "onoff")).toMatchObject({ kind: "onoff", on: true });

    provider.emit("5/3/4", 128);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ deviceId, capability: "brightness", state: { kind: "brightness" } });
    expect(await adapter.getState(deviceId, "brightness")).toMatchObject({ kind: "brightness" });
  });
});

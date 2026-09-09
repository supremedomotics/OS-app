import type {
  CapabilityState,
  DeviceId,
  KeypadCapabilityDeclaration,
  KeypadFeedbackCommand,
  KeypadInputEvent,
} from "@supreme/domain-model";
import { newId } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import type { DiscoveredDevice } from "../adapter.js";
import { SupremeIntegrationLayer } from "../sil.js";
import { SupremeNativeAdapter } from "../native-adapter.js";
import type { INativeProtocolDriver, ProtocolBinding } from "./driver.js";

/**
 * Driver SDK Extension proof (§ Universal Keypad Framework, Phase 1) — a SYNTHETIC,
 * non-real keypad driver built ONLY from the optional
 * `getKeypadCapabilities`/`onInputEvent`/`sendKeypadFeedback` members added to
 * {@link INativeProtocolDriver}, with ZERO changes to this test's imports beyond what
 * already exists. Not a real protocol (no manifest, not registered in
 * `native-driver-factory.ts`) — it exists to prove the seam a future KNX/Casambi/
 * Lutron/Matter/Zigbee/MQTT/RTI/BLE/DALI keypad driver will implement is genuinely
 * sufficient end-to-end: bind → capability declaration → input event flows up through
 * `SupremeNativeAdapter`/`SupremeIntegrationLayer` → a feedback command flows back
 * down to the exact same driver instance.
 */
class FakeKeypadDriver implements INativeProtocolDriver {
  readonly protocol = "fake-keypad-extensibility-proof";
  private connected = false;
  private readonly devices = new Set<DeviceId>();
  private readonly inputListeners = new Set<(event: KeypadInputEvent) => void>();
  readonly sentFeedback: KeypadFeedbackCommand[] = [];

  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  isConnected(): boolean {
    return this.connected;
  }
  async bind(binding: ProtocolBinding): Promise<void> {
    this.devices.add(binding.deviceId);
  }
  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }
  async command(): Promise<void> {
    /* this fake is input-only; no device commands to translate */
  }
  getState(): CapabilityState | null {
    return null;
  }
  async discover(): Promise<DiscoveredDevice[]> {
    return [];
  }
  onState(): () => void {
    return () => {};
  }

  getKeypadCapabilities(deviceId: DeviceId): KeypadCapabilityDeclaration | null {
    if (!this.manages(deviceId)) return null;
    return {
      keypadId: deviceId,
      protocol: this.protocol,
      controls: [{ id: "btn1", kind: "button", label: "Scene 1", input: ["buttons"], feedback: ["led"] }],
    };
  }

  onInputEvent(listener: (event: KeypadInputEvent) => void): () => void {
    this.inputListeners.add(listener);
    return () => this.inputListeners.delete(listener);
  }

  /** Test-only hook simulating a physical button press arriving over this fake's wire. */
  simulatePress(deviceId: DeviceId): void {
    const event: KeypadInputEvent = { type: "short_press", keypadId: deviceId, control: "btn1", ts: new Date().toISOString() };
    for (const l of this.inputListeners) l(event);
  }

  async sendKeypadFeedback(command: KeypadFeedbackCommand): Promise<void> {
    this.sentFeedback.push(command);
  }
}

describe("Driver SDK Extension — keypad capability seam", () => {
  it("proves capability declaration, input event flow-up, and feedback flow-down through SupremeNativeAdapter + the SIL facade", async () => {
    const driver = new FakeKeypadDriver();
    const native = new SupremeNativeAdapter({ drivers: [driver] });
    const sil = new SupremeIntegrationLayer({ adapter: native });
    await sil.start();

    const keypadId = newId("device") as DeviceId;
    await native.bind({ deviceId: keypadId, capability: "onoff", address: "btn1" }, driver.protocol);

    // Capability declaration flows up through the SIL exactly like getCapabilityConfig/getDiagnostics.
    const decl = await sil.getKeypadCapabilities(keypadId);
    expect(decl?.controls[0]?.id).toBe("btn1");
    expect(decl?.controls[0]?.feedback).toEqual(["led"]);

    // Input flows up: SIL.subscribeKeypadInput sees an event this driver never touched
    // any other driver's code to produce.
    const received: KeypadInputEvent[] = [];
    const unsub = sil.subscribeKeypadInput((e) => received.push(e));
    driver.simulatePress(keypadId);
    expect(received).toEqual([{ type: "short_press", keypadId, control: "btn1", ts: expect.any(String) }]);
    unsub();

    // Feedback flows down: SIL.sendKeypadFeedback reaches the SAME bound driver instance.
    await sil.sendKeypadFeedback({ type: "led_on", keypadId, control: "btn1" });
    expect(driver.sentFeedback).toEqual([{ type: "led_on", keypadId, control: "btn1" }]);
  });

  it("getKeypadCapabilities/sendKeypadFeedback are honest no-ops/errors for a keypad with no bound driver", async () => {
    const native = new SupremeNativeAdapter({ drivers: [] });
    const sil = new SupremeIntegrationLayer({ adapter: native });
    await sil.start();
    const unbound = newId("device") as DeviceId;

    expect(await sil.getKeypadCapabilities(unbound)).toBeNull();
    await expect(sil.sendKeypadFeedback({ type: "led_on", keypadId: unbound, control: "btn1" })).rejects.toThrow();
  });

  it("a driver with no keypad support at all is unaffected — the members are truly optional", async () => {
    class PlainDriver implements INativeProtocolDriver {
      readonly protocol = "plain";
      async connect() {}
      async disconnect() {}
      isConnected() {
        return true;
      }
      async bind() {}
      manages() {
        return false;
      }
      async command() {}
      getState() {
        return null;
      }
      async discover() {
        return [];
      }
      onState(): () => void {
        return () => {};
      }
    }
    const native = new SupremeNativeAdapter({ drivers: [new PlainDriver()] });
    const sil = new SupremeIntegrationLayer({ adapter: native });
    await sil.start();
    expect(await sil.getKeypadCapabilities(newId("device") as DeviceId)).toBeNull();
    // subscribeKeypadInput never throws even though no registered driver implements onInputEvent.
    expect(() => sil.subscribeKeypadInput(() => {})()).not.toThrow();
  });

  /** § Universal Keypad Framework, Stage 5A-4 — a REAL keypad's own identity, resolved
   * purely from `getKeypadCapabilities`' own `deviceId` parameter (exactly how
   * `CasambiProtocolDriver`'s `keypadIdentity` resolver works — § Stage 4A), never from
   * `manages()`/`bind()`. A keypad has zero capabilities, so real commissioning
   * (`CommissioningService.commission` → `HomeService.addDevice` → `SIL.mapDeviceEntity`)
   * never calls `bind()` at all — the ABOVE test's `native.bind(..., "onoff", ...)` line
   * is a fabricated capability no real keypad has, which is exactly why it masked this
   * gap. This driver recognizes its OWN unit by device identity alone (a `Map`
   * populated at construction, mirroring a driver's own protocol-native unit list —
   * never `SupremeNativeAdapter.ownerByDevice`, which stays empty for this device the
   * whole test). */
  class IdentityOnlyKeypadDriver implements INativeProtocolDriver {
    readonly protocol = "fake-identity-only-keypad";
    private connected = false;
    readonly sentFeedback: KeypadFeedbackCommand[] = [];
    constructor(private readonly ownKeypadId: DeviceId) {}
    async connect(): Promise<void> {
      this.connected = true;
    }
    async disconnect(): Promise<void> {
      this.connected = false;
    }
    isConnected(): boolean {
      return this.connected;
    }
    async bind(): Promise<void> {
      throw new Error("real keypad commissioning never calls bind() — this driver must never see it");
    }
    manages(): boolean {
      return false; // deliberately never true — proves getKeypadCapabilities doesn't depend on it
    }
    async command(): Promise<void> {}
    getState(): CapabilityState | null {
      return null;
    }
    async discover(): Promise<DiscoveredDevice[]> {
      return [];
    }
    onState(): () => void {
      return () => {};
    }
    getKeypadCapabilities(deviceId: DeviceId): KeypadCapabilityDeclaration | null {
      if (deviceId !== this.ownKeypadId) return null; // honest — not this driver's unit
      return { keypadId: deviceId, protocol: this.protocol, controls: [{ id: "1", kind: "button", label: null, input: ["buttons"], feedback: [] }] };
    }
    onInputEvent(): () => void {
      return () => {};
    }
    async sendKeypadFeedback(command: KeypadFeedbackCommand): Promise<void> {
      this.sentFeedback.push(command);
    }
  }

  it("§ Stage 5A-4 — getKeypadCapabilities resolves for a keypad commissioned WITHOUT any capability bind (the real production path), by driver-identity scan, not ownerByDevice", async () => {
    const keypadId = newId("device") as DeviceId;
    const driver = new IdentityOnlyKeypadDriver(keypadId);
    const native = new SupremeNativeAdapter({ drivers: [driver] });
    const sil = new SupremeIntegrationLayer({ adapter: native });
    await sil.start();

    // The ONLY thing real keypad commissioning ever does — no bind() call at all.
    sil.mapDeviceEntity(keypadId, "fake:4");

    const decl = await sil.getKeypadCapabilities(keypadId);
    expect(decl?.controls[0]?.id).toBe("1");

    // A different, never-commissioned deviceId still honestly resolves to null — the
    // driver-scan never guesses/fabricates an owner for an id it doesn't recognize.
    expect(await sil.getKeypadCapabilities(newId("device") as DeviceId)).toBeNull();
  });

  it("§ Stage 5A-4 — sendKeypadFeedback reaches the SAME identity-resolved driver, and never fabricates success for a driver that doesn't recognize the keypad", async () => {
    const keypadId = newId("device") as DeviceId;
    const driver = new IdentityOnlyKeypadDriver(keypadId);
    const native = new SupremeNativeAdapter({ drivers: [driver] });
    const sil = new SupremeIntegrationLayer({ adapter: native });
    await sil.start();
    sil.mapDeviceEntity(keypadId, "fake:4");

    await sil.sendKeypadFeedback({ type: "led_on", keypadId, control: "1" });
    expect(driver.sentFeedback).toEqual([{ type: "led_on", keypadId, control: "1" }]);

    const strangerId = newId("device") as DeviceId;
    await expect(sil.sendKeypadFeedback({ type: "led_on", keypadId: strangerId, control: "1" })).rejects.toThrow();
  });
});

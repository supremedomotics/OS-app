import type { CapabilityState, DeviceId, KeypadCapabilityDeclaration, KeypadControlDescriptor, KeypadFeedbackCommand } from "@supreme/domain-model";
import { newId } from "@supreme/domain-model";
import { describe, expect, it, vi } from "vitest";
import { UniversalFeedbackEngine, renderFeedback } from "./feedback-engine.js";
import { InMemoryKeypadSubscriptionStore, SubscriptionManager } from "./subscription-manager.js";

const deviceId = () => newId("device") as DeviceId;
const homeId = () => newId("home") as never;

function control(feedback: KeypadControlDescriptor["feedback"]): KeypadControlDescriptor {
  return { id: "btn1", kind: "button", label: null, input: [], feedback };
}

describe("renderFeedback (pure, capability-gated)", () => {
  const target = { keypadId: deviceId(), control: "btn1" };

  it("emits nothing for a control with no declared feedback capabilities", () => {
    const state: CapabilityState = { kind: "onoff", on: true };
    expect(renderFeedback(state, control([]), target)).toEqual([]);
  });

  it("emits led_on/led_off for onoff, gated on the 'led' capability", () => {
    const on: CapabilityState = { kind: "onoff", on: true };
    expect(renderFeedback(on, control(["led"]), target)).toEqual([{ type: "led_on", ...target }]);
    const off: CapabilityState = { kind: "onoff", on: false };
    expect(renderFeedback(off, control(["led"]), target)).toEqual([{ type: "led_off", ...target }]);
    expect(renderFeedback(on, control([]), target)).toEqual([]);
  });

  it("emits led_brightness for brightness only when brightness_feedback + led/rgb_led are both declared", () => {
    const state: CapabilityState = { kind: "brightness", on: true, level: 42 };
    expect(renderFeedback(state, control(["led"]), target)).toEqual([{ type: "led_on", ...target }]);
    const withBrightness = renderFeedback(state, control(["led", "brightness_feedback"]), target);
    expect(withBrightness).toContainEqual({ type: "led_brightness", ...target, level: 42 });
  });

  it("emits led_color for color only when rgb_led is declared and hue/saturation are non-null", () => {
    const colorState: CapabilityState = { kind: "color", on: true, level: 80, hue: 120, saturation: 60, kelvin: null };
    expect(renderFeedback(colorState, control(["rgb_led"]), target)).toContainEqual({ type: "led_color", ...target, hue: 120, saturation: 60 });
    const kelvinMode: CapabilityState = { kind: "color", on: true, level: 80, hue: null, saturation: null, kelvin: 4000 };
    expect(renderFeedback(kelvinMode, control(["rgb_led"]), target)).not.toContainEqual(expect.objectContaining({ type: "led_color" }));
  });

  it("emits an honest display_text summary only when text_feedback or display is declared", () => {
    const lock: CapabilityState = { kind: "lock", locked: true, jammed: false };
    expect(renderFeedback(lock, control([]), target)).toEqual([]);
    expect(renderFeedback(lock, control(["text_feedback"]), target)).toContainEqual({ type: "display_text", ...target, text: "Locked" });
    const sensor: CapabilityState = { kind: "sensor", value: 21.5, unit: "°C", measure: "temperature" };
    expect(renderFeedback(sensor, control(["display"]), target)).toContainEqual({ type: "display_text", ...target, text: "21.5°C" });
  });

  it("never emits led_on/off for media (no single on/off field)", () => {
    const media: CapabilityState = {
      kind: "media",
      playback: "playing",
      volume: 50,
      muted: false,
      title: "Some Track",
      source: "airplay",
      artworkUrl: null,
    };
    const commands = renderFeedback(media, control(["led", "text_feedback"]), target);
    expect(commands.some((c) => c.type === "led_on" || c.type === "led_off")).toBe(false);
    expect(commands).toContainEqual({ type: "display_text", ...target, text: "Some Track" });
  });
});

describe("UniversalFeedbackEngine", () => {
  it("fans a state change out to every subscribed keypad control, gated by declaration", async () => {
    const store = new InMemoryKeypadSubscriptionStore();
    const subs = new SubscriptionManager(store);
    const light = deviceId();
    const knxKeypad = deviceId();
    const casambiKeypad = deviceId();
    await subs.subscribe({ homeId: homeId(), deviceId: light, capability: "onoff", keypadId: knxKeypad, control: "btn1" });
    await subs.subscribe({ homeId: homeId(), deviceId: light, capability: "onoff", keypadId: casambiKeypad, control: "btn2" });

    const declarations: Record<string, KeypadCapabilityDeclaration> = {
      [knxKeypad]: { keypadId: knxKeypad, protocol: "knx", controls: [{ id: "btn1", kind: "button", label: null, input: [], feedback: ["led"] }] },
      [casambiKeypad]: { keypadId: casambiKeypad, protocol: "casambi", controls: [{ id: "btn2", kind: "button", label: null, input: [], feedback: [] }] },
    };
    const sent: KeypadFeedbackCommand[] = [];
    const engine = new UniversalFeedbackEngine({
      subscriptions: subs,
      getKeypadCapabilities: async (id) => declarations[id] ?? null,
      sendFeedback: async (cmd) => {
        sent.push(cmd);
      },
    });

    await engine.onDeviceState({ deviceId: light, capability: "onoff", state: { kind: "onoff", on: true } });

    // The Casambi keypad's control declared NO feedback capability — never fabricated.
    expect(sent).toEqual([{ type: "led_on", keypadId: knxKeypad, control: "btn1" }]);
  });

  it("isolates one subscriber's send failure from the rest", async () => {
    const store = new InMemoryKeypadSubscriptionStore();
    const subs = new SubscriptionManager(store);
    const light = deviceId();
    const failing = deviceId();
    const working = deviceId();
    await subs.subscribe({ homeId: homeId(), deviceId: light, capability: "onoff", keypadId: failing, control: "btn1" });
    await subs.subscribe({ homeId: homeId(), deviceId: light, capability: "onoff", keypadId: working, control: "btn1" });

    const decl = (id: DeviceId): KeypadCapabilityDeclaration => ({
      keypadId: id,
      protocol: "test",
      controls: [{ id: "btn1", kind: "button", label: null, input: [], feedback: ["led"] }],
    });
    const sent: KeypadFeedbackCommand[] = [];
    const onError = vi.fn();
    const engine = new UniversalFeedbackEngine({
      subscriptions: subs,
      getKeypadCapabilities: async (id) => decl(id),
      sendFeedback: async (cmd) => {
        if (cmd.keypadId === failing) throw new Error("driver offline");
        sent.push(cmd);
      },
      onError,
    });

    await engine.onDeviceState({ deviceId: light, capability: "onoff", state: { kind: "onoff", on: true } });

    expect(sent).toEqual([{ type: "led_on", keypadId: working, control: "btn1" }]);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

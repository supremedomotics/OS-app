import type { CapabilityState } from "@supreme/domain-model";
import { describe, expect, it, vi } from "vitest";
import { registerBuiltinIntents } from "./catalog.js";
import type { IntentEngineExecutors } from "./engine.js";
import { IntentRegistry } from "./registry.js";

function registry(): IntentRegistry<IntentEngineExecutors> {
  const r = new IntentRegistry<IntentEngineExecutors>();
  registerBuiltinIntents(r);
  return r;
}

describe("registerBuiltinIntents — catalog completeness", () => {
  it("registers every intent the brief lists, across all six categories", () => {
    const r = registry();
    const ids = r.list().map((d) => d.id).sort();
    expect(ids).toEqual(
      [
        "activateScene", "arm", "close", "decreaseBrightness", "decreaseCCT", "decreaseTemperature",
        "disarm", "executeScript", "fanSpeedDown", "fanSpeedUp", "hvacMode", "increaseBrightness",
        "increaseCCT", "increaseTemperature", "inputNext", "inputPrevious", "lightOff", "lightOn",
        "lock", "mute", "nextTrack", "notification", "open", "panic", "playPause", "powerToggle",
        "previousTrack", "runAutomation", "runScene", "setBrightness", "setColor", "setTemperature",
        "stop", "stopCover", "swingMode", "tiltDown", "tiltUp", "toggleHVAC", "toggleLight", "unlock",
        "volumeDown", "volumeUp", "webhook",
      ].sort(),
    );
  });

  it("covers all six categories", () => {
    const r = registry();
    const categories = new Set(r.list().map((d) => d.category));
    expect(categories).toEqual(new Set(["lighting", "climate", "av", "blinds", "security", "system"]));
  });
});

describe("registerBuiltinIntents — translation correctness", () => {
  const r = registry();

  it("toggleLight and powerToggle share the same onoff-toggle behavior", () => {
    const a = r.get("toggleLight")!.translate!({ params: {}, state: null, capabilityConfig: null });
    const b = r.get("powerToggle")!.translate!({ params: {}, state: null, capabilityConfig: null });
    expect(a).toEqual({ capability: "onoff", action: "toggle" });
    expect(b).toEqual({ capability: "onoff", action: "toggle" });
  });

  it("increaseBrightness/decreaseBrightness step from current state and clamp 0-100", () => {
    const state: CapabilityState = { kind: "brightness", on: true, level: 95 };
    expect(r.get("increaseBrightness")!.translate!({ params: { step: 10 }, state, capabilityConfig: null })).toEqual({
      capability: "brightness", action: "set", level: 100,
    });
    const low: CapabilityState = { kind: "brightness", on: true, level: 5 };
    expect(r.get("decreaseBrightness")!.translate!({ params: { step: 10 }, state: low, capabilityConfig: null })).toEqual({
      capability: "brightness", action: "set", level: 0,
    });
  });

  it("increaseCCT/decreaseCCT step kelvin and clamp to 1000-10000", () => {
    const state: CapabilityState = { kind: "color", on: true, level: 50, hue: 0, saturation: 0, kelvin: 9950 };
    expect(r.get("increaseCCT")!.translate!({ params: { step: 200 }, state, capabilityConfig: null })).toEqual({
      capability: "color", kelvin: 10000,
    });
  });

  it("mute toggles based on the device's real reported mute state", () => {
    const muted: CapabilityState = { kind: "media", playback: "playing", volume: 20, muted: true, title: null, source: null, artworkUrl: null };
    const unmuted = { ...muted, muted: false };
    expect(r.get("mute")!.translate!({ params: {}, state: muted, capabilityConfig: null })).toEqual({ capability: "media", action: "unmute" });
    expect(r.get("mute")!.translate!({ params: {}, state: unmuted, capabilityConfig: null })).toEqual({ capability: "media", action: "mute" });
  });

  it("playPause reads current playback and picks the opposite transport action", () => {
    const playing: CapabilityState = { kind: "media", playback: "playing", volume: 20, muted: false, title: null, source: null, artworkUrl: null };
    expect(r.get("playPause")!.translate!({ params: {}, state: playing, capabilityConfig: null })).toEqual({ capability: "media", action: "pause" });
    const paused = { ...playing, playback: "paused" as const };
    expect(r.get("playPause")!.translate!({ params: {}, state: paused, capabilityConfig: null })).toEqual({ capability: "media", action: "play" });
  });

  it("inputNext cycles a device's REAL reported input list, never a guessed one", () => {
    const config = { inputs: [{ id: "HDMI1" }, { id: "HDMI2" }, { id: "NET" }] };
    const state: CapabilityState = { kind: "media", playback: "playing", volume: 20, muted: false, title: null, source: "HDMI1", artworkUrl: null };
    expect(r.get("inputNext")!.translate!({ params: {}, state, capabilityConfig: config })).toEqual({
      capability: "media", action: "source", source: "HDMI2",
    });
    // wraps around
    const lastState = { ...state, source: "NET" };
    expect(r.get("inputNext")!.translate!({ params: {}, state: lastState, capabilityConfig: config })).toEqual({
      capability: "media", action: "source", source: "HDMI1",
    });
  });

  it("inputNext throws honestly when the device has no reported input list", () => {
    expect(() => r.get("inputNext")!.translate!({ params: {}, state: null, capabilityConfig: null })).toThrow(/no known input list/);
  });

  it("fanSpeedUp/fanSpeedDown step through the documented preset order", () => {
    const auto: CapabilityState = { kind: "fan", on: true, preset: "auto", direction: "forward" };
    expect(r.get("fanSpeedUp")!.translate!({ params: {}, state: auto, capabilityConfig: null })).toEqual({
      capability: "fan", action: "preset", preset: "turbo",
    });
    expect(r.get("fanSpeedDown")!.translate!({ params: {}, state: auto, capabilityConfig: null })).toEqual({
      capability: "fan", action: "preset", preset: "sleep",
    });
  });

  it("toggleHVAC goes off<->auto based on current mode", () => {
    const off: CapabilityState = { kind: "temperature", ambientC: 20, targetC: 20, mode: "off" };
    expect(r.get("toggleHVAC")!.translate!({ params: {}, state: off, capabilityConfig: null })).toEqual({
      capability: "temperature", mode: "auto",
    });
    const heat = { ...off, mode: "heat" as const };
    expect(r.get("toggleHVAC")!.translate!({ params: {}, state: heat, capabilityConfig: null })).toEqual({
      capability: "temperature", mode: "off",
    });
  });
});

describe("registerBuiltinIntents — honest gaps (registered, execution throws)", () => {
  const r = registry();

  it("swingMode/tiltUp/tiltDown throw a clear 'not a modeled capability field' error", () => {
    expect(() => r.get("swingMode")!.translate!({ params: {}, state: null, capabilityConfig: null })).toThrow(/not a modeled Supreme capability field/);
    expect(() => r.get("tiltUp")!.translate!({ params: {}, state: null, capabilityConfig: null })).toThrow(/not a modeled Supreme capability field/);
    expect(() => r.get("tiltDown")!.translate!({ params: {}, state: null, capabilityConfig: null })).toThrow(/not a modeled Supreme capability field/);
  });

  it("executeScript/webhook throw a clear 'no execution backend' error", async () => {
    const executors = {} as IntentEngineExecutors;
    await expect(r.get("executeScript")!.runSystem!({ target: { kind: "home" }, params: {}, executors })).rejects.toThrow(/no script engine/);
    await expect(r.get("webhook")!.runSystem!({ target: { kind: "home" }, params: {}, executors })).rejects.toThrow(/no webhook dispatcher/);
  });
});

describe("registerBuiltinIntents — system dispatch", () => {
  it("runScene/activateScene call executors.activateScene with the target sceneId", async () => {
    const r = registry();
    const activateScene = vi.fn(async () => {});
    const executors = { activateScene } as unknown as IntentEngineExecutors;
    const sceneId = "scn_01ARZ3NDEKTSV4RRFFQ69G5FAV" as never;
    await r.get("runScene")!.runSystem!({ target: { kind: "scene", sceneId }, params: {}, executors });
    await r.get("activateScene")!.runSystem!({ target: { kind: "scene", sceneId }, params: {}, executors });
    expect(activateScene).toHaveBeenCalledTimes(2);
    expect(activateScene).toHaveBeenCalledWith(sceneId);
  });

  it("arm/disarm/panic call the security executor, and fail honestly when none is wired", async () => {
    const r = registry();
    const security = { arm: vi.fn(async () => {}), disarm: vi.fn(async () => {}), panic: vi.fn(async () => {}) };
    const executors = { security } as unknown as IntentEngineExecutors;
    await r.get("arm")!.runSystem!({ target: { kind: "home" }, params: { mode: "armed_away" }, executors });
    expect(security.arm).toHaveBeenCalledWith("armed_away");

    const noSecurity = {} as IntentEngineExecutors;
    await expect(r.get("disarm")!.runSystem!({ target: { kind: "home" }, params: {}, executors: noSecurity })).rejects.toThrow(
      /no security panel/,
    );
  });

  it("notification calls executors.notify with validated params", async () => {
    const r = registry();
    const notify = vi.fn(async () => {});
    const executors = { notify } as unknown as IntentEngineExecutors;
    await r.get("notification")!.runSystem!({
      target: { kind: "home" },
      params: { level: "warning", title: "Door left open", body: "Front door has been open for 10 minutes." },
      executors,
    });
    expect(notify).toHaveBeenCalledWith({ level: "warning", title: "Door left open", body: "Front door has been open for 10 minutes.", userId: null });
  });
});

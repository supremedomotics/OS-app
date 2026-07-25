import { newId, type DeviceId, type KeypadInputEvent } from "@supreme/domain-model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UniversalInputEngine } from "./input-engine.js";

const keypadId = () => newId("device") as DeviceId;

function press(keypadId: DeviceId, control = "btn1"): KeypadInputEvent {
  return { type: "button_pressed", keypadId, control, ts: new Date().toISOString() };
}
function release(keypadId: DeviceId, control = "btn1"): KeypadInputEvent {
  return { type: "button_released", keypadId, control, ts: new Date().toISOString() };
}

describe("UniversalInputEngine", () => {
  let published: KeypadInputEvent[];
  let engine: UniversalInputEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    published = [];
    engine = new UniversalInputEngine({ publish: (e) => published.push(e), longPressMs: 500, doublePressWindowMs: 300, holdTickMs: 200 });
  });

  afterEach(() => {
    engine.dispose();
    vi.useRealTimers();
  });

  it("passes raw button_pressed/button_released through unchanged", () => {
    const kp = keypadId();
    engine.ingest(press(kp));
    engine.ingest(release(kp));
    const raw = published.filter((e) => e.type === "button_pressed" || e.type === "button_released");
    expect(raw.map((e) => e.type)).toEqual(["button_pressed", "button_released"]);
  });

  it("derives a short_press for a quick tap", () => {
    const kp = keypadId();
    engine.ingest(press(kp));
    vi.advanceTimersByTime(50);
    engine.ingest(release(kp));
    vi.advanceTimersByTime(300); // decision window
    expect(published.map((e) => e.type)).toContain("short_press");
    expect(published.some((e) => e.type === "double_press" || e.type === "triple_press")).toBe(false);
  });

  it("derives a double_press for two quick taps within the window", () => {
    const kp = keypadId();
    engine.ingest(press(kp));
    vi.advanceTimersByTime(30);
    engine.ingest(release(kp));
    vi.advanceTimersByTime(100);
    engine.ingest(press(kp));
    vi.advanceTimersByTime(30);
    engine.ingest(release(kp));
    vi.advanceTimersByTime(300);
    expect(published.map((e) => e.type)).toContain("double_press");
    expect(published.some((e) => e.type === "short_press")).toBe(false);
  });

  it("derives a triple_press for three quick taps", () => {
    const kp = keypadId();
    for (let i = 0; i < 3; i++) {
      engine.ingest(press(kp));
      vi.advanceTimersByTime(30);
      engine.ingest(release(kp));
      vi.advanceTimersByTime(80);
    }
    vi.advanceTimersByTime(300);
    expect(published.map((e) => e.type)).toContain("triple_press");
  });

  it("fires hold_start then repeating holding, then hold_end + long_press on release", () => {
    const kp = keypadId();
    engine.ingest(press(kp));
    vi.advanceTimersByTime(500); // crosses longPressMs
    expect(published.map((e) => e.type)).toContain("hold_start");
    vi.advanceTimersByTime(450); // ~2 holdTicks
    const holdingCount = published.filter((e) => e.type === "holding").length;
    expect(holdingCount).toBeGreaterThanOrEqual(2);
    engine.ingest(release(kp));
    const types = published.map((e) => e.type);
    expect(types).toContain("hold_end");
    expect(types).toContain("long_press");
    const longPress = published.find((e) => e.type === "long_press");
    expect(longPress && "holdMs" in longPress ? longPress.holdMs : 0).toBeGreaterThanOrEqual(500);
  });

  it("stops holding ticks once released (no leaked interval)", () => {
    const kp = keypadId();
    engine.ingest(press(kp));
    vi.advanceTimersByTime(500);
    engine.ingest(release(kp));
    const countAtRelease = published.filter((e) => e.type === "holding").length;
    vi.advanceTimersByTime(1000);
    expect(published.filter((e) => e.type === "holding").length).toBe(countAtRelease);
  });

  it("tracks independent controls on the same keypad separately", () => {
    const kp = keypadId();
    engine.ingest(press(kp, "btn1"));
    engine.ingest(press(kp, "btn2"));
    vi.advanceTimersByTime(30);
    engine.ingest(release(kp, "btn1"));
    vi.advanceTimersByTime(500);
    engine.ingest(release(kp, "btn2"));
    vi.advanceTimersByTime(300);
    const btn1 = published.filter((e) => "control" in e && e.control === "btn1");
    const btn2 = published.filter((e) => "control" in e && e.control === "btn2");
    expect(btn1.map((e) => e.type)).toContain("short_press");
    expect(btn2.map((e) => e.type)).toContain("hold_start");
  });

  it("passes rotation/swipe/gesture events straight through without derivation", () => {
    const kp = keypadId();
    const rotate: KeypadInputEvent = { type: "rotate_clockwise", keypadId: kp, control: "enc1", ts: new Date().toISOString(), steps: 1 };
    engine.ingest(rotate);
    expect(published).toEqual([rotate]);
  });

  it("ignores a duplicate press with no intervening release", () => {
    const kp = keypadId();
    engine.ingest(press(kp));
    vi.advanceTimersByTime(50);
    engine.ingest(press(kp)); // duplicate, no release yet
    vi.advanceTimersByTime(50);
    engine.ingest(release(kp));
    vi.advanceTimersByTime(300);
    // Should resolve as exactly one short_press, not throw or double count.
    expect(published.filter((e) => e.type === "short_press").length).toBe(1);
  });
});

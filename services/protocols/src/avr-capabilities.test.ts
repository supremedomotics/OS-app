import { describe, expect, it } from "vitest";
import { percentFromScale, scaleFromPercent } from "./avr-capabilities.js";

describe("AVR volume scale conversion", () => {
  it("round-trips a percentage through a Yamaha-style 0..194 range", () => {
    expect(percentFromScale(0, 0, 194)).toBe(0);
    expect(percentFromScale(194, 0, 194)).toBe(100);
    expect(percentFromScale(97, 0, 194)).toBe(50);
  });

  it("snaps a percentage down to the device's native scale + step", () => {
    expect(scaleFromPercent(50, 0, 194, 1)).toBe(97);
    expect(scaleFromPercent(0, 0, 194, 1)).toBe(0);
    expect(scaleFromPercent(100, 0, 194, 1)).toBe(194);
    // A coarser step (e.g. a half-dB scale exposed as 2-unit steps) snaps to the nearest step.
    expect(scaleFromPercent(50, 0, 100, 2)).toBe(50);
    expect(scaleFromPercent(51, 0, 100, 2)).toBe(52);
  });

  it("never exceeds the declared range even with an out-of-bounds input", () => {
    expect(percentFromScale(-10, 0, 194)).toBe(0);
    expect(percentFromScale(999, 0, 194)).toBe(100);
    expect(scaleFromPercent(-20, 0, 194, 1)).toBe(0);
    expect(scaleFromPercent(150, 0, 194, 1)).toBe(194);
  });

  it("degrades gracefully for a degenerate (min>=max) range instead of dividing by zero", () => {
    expect(percentFromScale(50, 10, 10)).toBe(0);
  });
});

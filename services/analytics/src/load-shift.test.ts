import { describe, expect, it } from "vitest";
import type { Tariff } from "./tariff.js";
import { loadShiftDecision, peakRate } from "./load-shift.js";

const tariff: Tariff = {
  currency: "USD",
  periods: [
    { name: "peak", ratePerKwh: 0.45, hours: [16, 17, 18, 19, 20] },
    { name: "shoulder", ratePerKwh: 0.25, hours: [7, 8, 9, 10, 11, 12, 13, 14, 15, 21, 22] },
    { name: "off-peak", ratePerKwh: 0.12, hours: [0, 1, 2, 3, 4, 5, 6, 23] },
  ],
};

describe("load shifting", () => {
  it("identifies the peak rate", () => {
    expect(peakRate(tariff)).toBe(0.45);
  });

  it("pauses deferrable loads only during the peak period by default", () => {
    expect(loadShiftDecision(tariff, 18 * 60, false).allowRun).toBe(false); // 18:00 peak
    expect(loadShiftDecision(tariff, 2 * 60, false).allowRun).toBe(true); // 02:00 off-peak
    expect(loadShiftDecision(tariff, 10 * 60, false).allowRun).toBe(true); // 10:00 shoulder
  });

  it("with a rate ceiling, also avoids shoulder", () => {
    expect(loadShiftDecision(tariff, 10 * 60, false, { maxRunRatePerKwh: 0.15 }).allowRun).toBe(false); // shoulder 0.25 > 0.15
    expect(loadShiftDecision(tariff, 2 * 60, false, { maxRunRatePerKwh: 0.15 }).allowRun).toBe(true); // off-peak 0.12 ≤ 0.15
  });

  it("reports the current period + rates", () => {
    const d = loadShiftDecision(tariff, 18 * 60, false);
    expect(d).toMatchObject({ allowRun: false, period: "peak", currentRate: 0.45, peakRate: 0.45 });
  });

  it("does not pause when the tariff doesn't cover the hour (fail-open)", () => {
    const gap: Tariff = { currency: "USD", periods: [{ name: "day", ratePerKwh: 0.2, hours: [9, 10] }] };
    expect(loadShiftDecision(gap, 18 * 60, false).allowRun).toBe(true);
  });
});

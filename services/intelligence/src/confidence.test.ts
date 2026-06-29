import { describe, expect, it } from "vitest";
import { clamp01, makeConfidence, rollUpDecision, toPct, weightedMean } from "./confidence.js";

describe("confidence helpers", () => {
  it("clamps to 0..1 and treats non-finite as 0", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(NaN)).toBe(0);
  });

  it("weightedMean weights votes and returns 0 with no weight", () => {
    expect(weightedMean([{ value: 1, weight: 3 }, { value: 0, weight: 1 }])).toBe(0.75);
    expect(weightedMean([])).toBe(0);
    expect(weightedMean([{ value: 1, weight: 0 }])).toBe(0);
  });

  it("rollUpDecision is the weakest link by default, mean when asked", () => {
    expect(rollUpDecision({ a: 0.9, b: 0.4, c: 0.8 })).toBe(0.4);
    expect(rollUpDecision({ a: 0.9, b: 0.3 }, "mean")).toBe(0.6);
    expect(rollUpDecision({})).toBe(0);
  });

  it("makeConfidence keeps dimensions and computes the decision", () => {
    const c = makeConfidence({ presence: 0.98, roomVacancy: 0.91, ownership: 1 });
    expect(c.presence).toBe(0.98);
    expect(c.decision).toBe(0.91); // min(0.98, 0.91, 1)
  });

  it("toPct rounds to whole percent", () => {
    expect(toPct(0.985)).toBe(99);
    expect(toPct(0.6)).toBe(60);
  });
});

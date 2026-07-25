import { describe, expect, it } from "vitest";
import { evaluateComparator, isWithinScheduleWindow, readCapabilityField } from "./condition-eval.js";
import type { CapabilityState } from "./capabilities.js";

describe("readCapabilityField", () => {
  it("reads a named field off any capability state", () => {
    const state: CapabilityState = { kind: "brightness", on: true, level: 42 };
    expect(readCapabilityField(state, "level")).toBe(42);
    expect(readCapabilityField(state, "on")).toBe(true);
  });
});

describe("evaluateComparator", () => {
  it("evaluates every comparator", () => {
    expect(evaluateComparator(5, "eq", 5)).toBe(true);
    expect(evaluateComparator(5, "ne", 6)).toBe(true);
    expect(evaluateComparator(5, "gt", 3)).toBe(true);
    expect(evaluateComparator(5, "lt", 3)).toBe(false);
    expect(evaluateComparator(5, "gte", 5)).toBe(true);
    expect(evaluateComparator(5, "lte", 4)).toBe(false);
    expect(evaluateComparator(false, "changed", undefined)).toBe(true);
  });
});

describe("isWithinScheduleWindow", () => {
  it("matches only within the declared days and time range", () => {
    const window = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };
    const wednesdayNoon = new Date(2026, 0, 7, 12, 0); // a Wednesday
    const wednesdayNight = new Date(2026, 0, 7, 22, 0);
    const sundayNoon = new Date(2026, 0, 4, 12, 0); // a Sunday
    expect(isWithinScheduleWindow(window, wednesdayNoon)).toBe(true);
    expect(isWithinScheduleWindow(window, wednesdayNight)).toBe(false);
    expect(isWithinScheduleWindow(window, sundayNoon)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { occupancyEventsAt, OccupancyError, planOccupancy, type OccupancyConfig } from "./occupancy.js";

const base: OccupancyConfig = {
  deviceIds: ["lr", "kitchen", "study"],
  startMinute: 18 * 60, // 18:00
  endMinute: 23 * 60, // 23:00
  seed: 42,
};

describe("planOccupancy", () => {
  it("is deterministic for a given seed", () => {
    expect(planOccupancy(base)).toEqual(planOccupancy(base));
  });

  it("differs for a different seed", () => {
    expect(planOccupancy(base)).not.toEqual(planOccupancy({ ...base, seed: 7 }));
  });

  it("keeps every event inside the window and pairs every on with an off", () => {
    const plan = planOccupancy(base);
    expect(plan.length).toBeGreaterThan(0);
    for (const e of plan) {
      expect(e.atMinutes).toBeGreaterThanOrEqual(base.startMinute);
      expect(e.atMinutes).toBeLessThanOrEqual(base.endMinute);
    }
    for (const id of base.deviceIds) {
      const ons = plan.filter((e) => e.deviceId === id && e.action === "on").length;
      const offs = plan.filter((e) => e.deviceId === id && e.action === "off").length;
      expect(ons).toBe(offs); // balanced
    }
  });

  it("staggers lights so they don't all turn on at the same minute", () => {
    const firstOnByDevice = new Map<string, number>();
    for (const e of planOccupancy(base)) {
      if (e.action === "on" && !firstOnByDevice.has(e.deviceId)) firstOnByDevice.set(e.deviceId, e.atMinutes);
    }
    const times = [...firstOnByDevice.values()];
    expect(new Set(times).size).toBeGreaterThan(1); // not all identical
  });

  it("returns the events due at a given minute", () => {
    const plan = planOccupancy(base);
    const minute = plan[0]!.atMinutes;
    const due = occupancyEventsAt(plan, minute);
    expect(due.length).toBeGreaterThan(0);
    expect(due.every((e) => e.atMinutes === minute)).toBe(true);
  });

  it("validates inputs", () => {
    expect(() => planOccupancy({ ...base, deviceIds: [] })).toThrow(OccupancyError);
    expect(() => planOccupancy({ ...base, endMinute: base.startMinute })).toThrow(/after startMinute/);
    expect(() => planOccupancy({ ...base, minOnMinutes: 0 })).toThrow(/on-duration/);
  });
});

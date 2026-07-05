import { describe, expect, it } from "vitest";
import {
  circadianAt,
  circadianColorCommand,
  circadianForLocalTime,
  CircadianError,
  defaultCircadianProfile,
  type CircadianProfile,
} from "./circadian.js";

const profile: CircadianProfile = {
  keyframes: [
    { atMinutes: 6 * 60, kelvin: 2700, brightness: 20 }, // 06:00
    { atMinutes: 12 * 60, kelvin: 6000, brightness: 100 }, // 12:00
    { atMinutes: 22 * 60, kelvin: 2300, brightness: 10 }, // 22:00
  ],
};

describe("circadianAt", () => {
  it("returns a keyframe exactly at its time", () => {
    expect(circadianAt(profile, 12 * 60)).toEqual({ kelvin: 6000, brightness: 100 });
  });

  it("interpolates linearly between keyframes", () => {
    // 09:00 is halfway between 06:00 (2700K/20) and 12:00 (6000K/100).
    expect(circadianAt(profile, 9 * 60)).toEqual({ kelvin: Math.round((2700 + 6000) / 2), brightness: 60 });
  });

  it("wraps across midnight (22:00 → 06:00 next day)", () => {
    // 02:00 is 4h after 22:00 and 4h before 06:00 → exactly halfway on the wrap span (8h).
    const t = circadianAt(profile, 2 * 60);
    expect(t.kelvin).toBe(Math.round((2300 + 2700) / 2)); // 2500
    expect(t.brightness).toBe(Math.round((10 + 20) / 2)); // 15
  });

  it("clamps brightness and rounds kelvin to integers", () => {
    const t = circadianAt(defaultCircadianProfile, 13 * 60);
    expect(t).toEqual({ kelvin: 6000, brightness: 100 });
    expect(Number.isInteger(t.kelvin)).toBe(true);
  });

  it("handles a single-keyframe profile", () => {
    expect(circadianAt({ keyframes: [{ atMinutes: 0, kelvin: 3000, brightness: 50 }] }, 600)).toEqual({ kelvin: 3000, brightness: 50 });
  });

  it("rejects an empty profile and out-of-range keyframes", () => {
    expect(() => circadianAt({ keyframes: [] }, 0)).toThrow(CircadianError);
    expect(() => circadianAt({ keyframes: [{ atMinutes: 5000, kelvin: 3000, brightness: 50 }] }, 0)).toThrow(/atMinutes/);
    expect(() => circadianAt({ keyframes: [{ atMinutes: 0, kelvin: 50, brightness: 50 }] }, 0)).toThrow(/kelvin/);
  });
});

describe("helpers", () => {
  it("builds a color command from a target", () => {
    expect(circadianColorCommand({ kelvin: 4000, brightness: 70 })).toEqual({ capability: "color", kelvin: 4000, level: 70 });
  });
  it("computes the target for a local time", () => {
    expect(circadianForLocalTime(profile, 12, 0)).toEqual({ kelvin: 6000, brightness: 100 });
  });
});

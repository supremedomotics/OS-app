import { describe, expect, it } from "vitest";
import { climateSetpointAt, ClimateProgramError, defaultClimateProgram, validateClimateProgram, type ClimateProgram } from "./climate-program.js";

const program: ClimateProgram = {
  weekday: [
    { atMinutes: 6 * 60, targetC: 21 },
    { atMinutes: 9 * 60, targetC: 18 },
    { atMinutes: 17 * 60, targetC: 22 },
    { atMinutes: 22 * 60, targetC: 17 },
  ],
  weekend: [{ atMinutes: 8 * 60, targetC: 20 }],
};

describe("climateSetpointAt", () => {
  it("holds the most recent block's setpoint (step, not interpolated)", () => {
    expect(climateSetpointAt(program, "weekday", 6 * 60)).toBe(21); // exactly at wake
    expect(climateSetpointAt(program, "weekday", 7 * 60)).toBe(21); // still wake
    expect(climateSetpointAt(program, "weekday", 9 * 60 + 30)).toBe(18); // away
    expect(climateSetpointAt(program, "weekday", 18 * 60)).toBe(22); // home
    expect(climateSetpointAt(program, "weekday", 23 * 60)).toBe(17); // sleep
  });

  it("wraps across midnight (before the first block, the day's last block holds)", () => {
    expect(climateSetpointAt(program, "weekday", 3 * 60)).toBe(17); // 03:00 → still the 22:00 sleep setpoint
  });

  it("uses the weekend program for weekend day type", () => {
    expect(climateSetpointAt(program, "weekend", 12 * 60)).toBe(20);
  });

  it("the default program is warm during the day, cool at night", () => {
    expect(climateSetpointAt(defaultClimateProgram, "weekday", 7 * 60)).toBe(21);
    expect(climateSetpointAt(defaultClimateProgram, "weekday", 23 * 60)).toBe(18);
  });
});

describe("validateClimateProgram", () => {
  it("accepts a valid program", () => {
    expect(validateClimateProgram(program).weekday).toHaveLength(4);
  });
  it("rejects malformed programs", () => {
    expect(() => validateClimateProgram({ weekday: [], weekend: [] })).toThrow(ClimateProgramError);
    expect(() => validateClimateProgram({ weekday: [{ atMinutes: 2000, targetC: 21 }], weekend: [{ atMinutes: 0, targetC: 21 }] })).toThrow(/atMinutes/);
    expect(() => validateClimateProgram({ weekday: [{ atMinutes: 0, targetC: 99 }], weekend: [{ atMinutes: 0, targetC: 21 }] })).toThrow(/targetC/);
    expect(() => validateClimateProgram({ weekday: [{ atMinutes: 0, targetC: 21 }] })).toThrow(/weekend/);
  });
});

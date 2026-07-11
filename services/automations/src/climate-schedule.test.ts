import { describe, expect, it } from "vitest";
import { ClimateScheduleError, dueClimateEvents, validateClimateScheduleEvent, type ClimateScheduleEvent } from "./climate-schedule.js";

const base = { deviceId: "dev1", atMinutes: 420, targetC: 22, mode: "cool" as const };

describe("validateClimateScheduleEvent", () => {
  it("accepts a daily event with defaults", () => {
    const e = validateClimateScheduleEvent({ ...base, recurrence: "daily" });
    expect(e).toMatchObject({ deviceId: "dev1", enabled: true, recurrence: "daily", atMinutes: 420, targetC: 22, mode: "cool" });
    expect(e.id).toMatch(/^cse_/);
  });

  it("requires a date for a one-time event", () => {
    expect(() => validateClimateScheduleEvent({ ...base, recurrence: "once" })).toThrow(ClimateScheduleError);
    expect(validateClimateScheduleEvent({ ...base, recurrence: "once", date: "2026-08-01" }).date).toBe("2026-08-01");
  });

  it("requires weekdays for a weekly event", () => {
    expect(() => validateClimateScheduleEvent({ ...base, recurrence: "weekly" })).toThrow(ClimateScheduleError);
    expect(validateClimateScheduleEvent({ ...base, recurrence: "weekly", weekdays: [1, 3, 5] }).weekdays).toEqual([1, 3, 5]);
  });

  it("rejects an out-of-range temperature", () => {
    expect(() => validateClimateScheduleEvent({ ...base, recurrence: "daily", targetC: 60 })).toThrow(ClimateScheduleError);
  });

  it("rejects an invalid mode", () => {
    expect(() => validateClimateScheduleEvent({ ...base, recurrence: "daily", mode: "dry" })).toThrow(ClimateScheduleError);
  });
});

describe("dueClimateEvents", () => {
  const daily: ClimateScheduleEvent = validateClimateScheduleEvent({ ...base, recurrence: "daily" });
  const weekly: ClimateScheduleEvent = validateClimateScheduleEvent({ ...base, deviceId: "dev2", recurrence: "weekly", weekdays: [1] });
  const once: ClimateScheduleEvent = validateClimateScheduleEvent({ ...base, deviceId: "dev3", recurrence: "once", date: "2026-08-01" });

  it("fires a daily event every day at its minute", () => {
    const due = dueClimateEvents([daily], [], { nowMinute: 420, dayOfWeek: 3, todayIso: "2026-08-05" });
    expect(due).toEqual([daily]);
  });

  it("does not fire at a different minute", () => {
    expect(dueClimateEvents([daily], [], { nowMinute: 421, dayOfWeek: 3, todayIso: "2026-08-05" })).toEqual([]);
  });

  it("fires a weekly event only on its configured weekday", () => {
    expect(dueClimateEvents([weekly], [], { nowMinute: 420, dayOfWeek: 1, todayIso: "2026-08-05" })).toEqual([weekly]);
    expect(dueClimateEvents([weekly], [], { nowMinute: 420, dayOfWeek: 2, todayIso: "2026-08-05" })).toEqual([]);
  });

  it("fires a one-time event only on its exact date, any weekday", () => {
    expect(dueClimateEvents([once], [], { nowMinute: 420, dayOfWeek: 6, todayIso: "2026-08-01" })).toEqual([once]);
    expect(dueClimateEvents([once], [], { nowMinute: 420, dayOfWeek: 6, todayIso: "2026-08-02" })).toEqual([]);
  });

  it("never fires a disabled event", () => {
    expect(dueClimateEvents([{ ...daily, enabled: false }], [], { nowMinute: 420, dayOfWeek: 3, todayIso: "2026-08-05" })).toEqual([]);
  });

  it("holiday mode suspends every event for that device, but not others", () => {
    const due = dueClimateEvents([daily, weekly], ["dev1"], { nowMinute: 420, dayOfWeek: 1, todayIso: "2026-08-05" });
    expect(due).toEqual([weekly]);
  });
});

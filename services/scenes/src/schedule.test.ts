import { describe, expect, it } from "vitest";
import { dueScenes, ScheduleError, triggerMinute, validateSchedule, type SceneSchedule } from "./schedule.js";

const ctx = { nowMinute: 18 * 60, dayOfWeek: 1, sunriseMinute: 6 * 60, sunsetMinute: 18 * 60 };

describe("triggerMinute", () => {
  it("resolves time + solar (with offset) triggers", () => {
    expect(triggerMinute({ type: "time", atMinutes: 390 }, 360, 1080)).toBe(390);
    expect(triggerMinute({ type: "solar", event: "sunrise" }, 360, 1080)).toBe(360);
    expect(triggerMinute({ type: "solar", event: "sunset", offsetMinutes: -15 }, 360, 1080)).toBe(1065);
  });
});

describe("dueScenes", () => {
  const schedules: SceneSchedule[] = [
    { id: "a", sceneId: "evening", trigger: { type: "solar", event: "sunset" } }, // 18:00 → due
    { id: "b", sceneId: "wake", trigger: { type: "time", atMinutes: 6 * 60 } }, // 06:00 → not now
    { id: "c", sceneId: "disabled", trigger: { type: "time", atMinutes: 18 * 60 }, enabled: false }, // off
  ];

  it("returns scenes whose resolved trigger equals the current minute", () => {
    expect(dueScenes(schedules, ctx)).toEqual(["evening"]);
  });

  it("skips disabled schedules and respects the day filter", () => {
    expect(dueScenes([{ id: "x", sceneId: "weekend", trigger: { type: "solar", event: "sunset" }, days: [0, 6] }], ctx)).toEqual([]); // Monday
    expect(dueScenes([{ id: "x", sceneId: "weekday", trigger: { type: "solar", event: "sunset" }, days: [1] }], ctx)).toEqual(["weekday"]);
  });

  it("fires a sunset+offset trigger at the offset minute", () => {
    expect(dueScenes([{ id: "y", sceneId: "predusk", trigger: { type: "solar", event: "sunset", offsetMinutes: -30 } }], { ...ctx, nowMinute: 17 * 60 + 30 })).toEqual(["predusk"]);
  });
});

describe("validateSchedule", () => {
  it("accepts valid time + solar schedules and fills an id", () => {
    expect(validateSchedule({ sceneId: "evening", trigger: { type: "solar", event: "sunset" } }).id).toMatch(/^sch_evening_sunset/);
    expect(validateSchedule({ sceneId: "wake", trigger: { type: "time", atMinutes: 390 } }).sceneId).toBe("wake");
  });
  it("rejects malformed schedules", () => {
    expect(() => validateSchedule({ trigger: { type: "time", atMinutes: 1 } })).toThrow(ScheduleError);
    expect(() => validateSchedule({ sceneId: "x", trigger: { type: "time", atMinutes: 2000 } })).toThrow(/0\.\.1439/);
    expect(() => validateSchedule({ sceneId: "x", trigger: { type: "nope" } })).toThrow(/time or solar/);
    expect(() => validateSchedule({ sceneId: "x", trigger: { type: "solar", event: "sunrise" }, days: [9] })).toThrow(/days/);
  });
});

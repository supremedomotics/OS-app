import { describe, expect, it } from "vitest";
import { sunTimes } from "@supreme/automations";
import type { SceneSchedule } from "@supreme/scenes";
import { SceneScheduler } from "./scene-scheduler.js";

function at(hour: number, minute = 0): Date {
  // A fixed local date/time (Monday 2026-01-05).
  return new Date(2026, 0, 5, hour, minute, 0);
}

describe("SceneScheduler", () => {
  it("activates a scene whose time trigger matches the current minute, once", async () => {
    const activated: string[] = [];
    let clock = at(6, 30);
    const scheduler = new SceneScheduler({
      getSchedules: async (): Promise<SceneSchedule[]> => [{ id: "w", sceneId: "wake", trigger: { type: "time", atMinutes: 6 * 60 + 30 } }],
      getLocation: async () => undefined,
      activate: async (id) => void activated.push(id),
      now: () => clock,
    });
    await scheduler.tick();
    await scheduler.tick(); // same minute → no double fire
    expect(activated).toEqual(["wake"]);

    clock = at(7, 0); // different minute, not due
    await scheduler.tick();
    expect(activated).toEqual(["wake"]);
  });

  it("fires a sunset-anchored scene at the computed sunset minute", async () => {
    // The scheduler reads sunset as the hub's LOCAL minute-of-day (in production the hub clock is
    // the home's timezone). Compute the same minute here so the test is timezone-independent.
    const t = sunTimes({ year: 2026, month: 6, day: 21, latitude: 51.5, longitude: 0 }); // London
    const sunsetLocal = new Date(t.sunset);
    const fireMinute = sunsetLocal.getHours() * 60 + sunsetLocal.getMinutes();
    const activated: string[] = [];
    const scheduler = new SceneScheduler({
      getSchedules: async (): Promise<SceneSchedule[]> => [{ id: "e", sceneId: "evening", trigger: { type: "solar", event: "sunset" } }],
      getLocation: async () => ({ lat: 51.5, lon: 0 }),
      activate: async (id) => void activated.push(id),
      now: () => new Date(2026, 5, 21, Math.floor(fireMinute / 60), fireMinute % 60, 0),
    });
    await scheduler.tick();
    expect(activated).toEqual(["evening"]);
  });

  it("does nothing when there are no schedules", async () => {
    const activated: string[] = [];
    const scheduler = new SceneScheduler({
      getSchedules: async () => [],
      getLocation: async () => undefined,
      activate: async (id) => void activated.push(id),
      now: () => at(18, 0),
    });
    await scheduler.tick();
    expect(activated).toEqual([]);
  });
});

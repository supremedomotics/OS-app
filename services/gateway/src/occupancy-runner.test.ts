import { describe, expect, it } from "vitest";
import { OccupancyRunner } from "./occupancy-runner.js";

describe("OccupancyRunner", () => {
  it("applies the on/off events due at a minute", async () => {
    const calls: { deviceId: string; on: boolean }[] = [];
    const runner = new OccupancyRunner({ command: async (deviceId, on) => void calls.push({ deviceId, on }) });
    runner.start([
      { atMinutes: 1080, deviceId: "lr", action: "on" },
      { atMinutes: 1100, deviceId: "lr", action: "off" },
      { atMinutes: 1080, deviceId: "kitchen", action: "on" },
    ]);
    expect(runner.running).toBe(true);

    await runner.tick(1080);
    expect(calls).toEqual([
      { deviceId: "lr", on: true },
      { deviceId: "kitchen", on: true },
    ]);
    await runner.tick(1100);
    expect(calls.at(-1)).toEqual({ deviceId: "lr", on: false });
    await runner.tick(1200); // nothing due
    expect(calls).toHaveLength(3);
  });

  it("stop() clears the plan and stops running", async () => {
    const calls: unknown[] = [];
    const runner = new OccupancyRunner({ command: async () => void calls.push(1) });
    runner.start([{ atMinutes: 600, deviceId: "x", action: "on" }]);
    runner.stop();
    expect(runner.running).toBe(false);
    await runner.tick(600);
    expect(calls).toHaveLength(0); // plan cleared
  });
});

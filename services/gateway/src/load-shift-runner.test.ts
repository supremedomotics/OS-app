import { describe, expect, it } from "vitest";
import type { Tariff } from "@supreme/analytics";
import { LoadShiftRunner } from "./load-shift-runner.js";

const tariff: Tariff = {
  currency: "USD",
  periods: [
    { name: "peak", ratePerKwh: 0.45, hours: [16, 17, 18, 19, 20] },
    { name: "off-peak", ratePerKwh: 0.12, hours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 21, 22, 23] },
  ],
};

const monday = (h: number) => new Date(2026, 0, 5, h, 0, 0);

describe("LoadShiftRunner", () => {
  it("pauses deferrable loads during peak and resumes them off-peak", async () => {
    const ops: { id: string; on: boolean }[] = [];
    let clock = monday(2); // off-peak
    const runner = new LoadShiftRunner({
      getTariff: async () => tariff,
      getDeferrableDeviceIds: async () => ["ev", "pool"],
      getCeiling: async () => undefined,
      setDeviceOn: async (id, on) => void ops.push({ id, on }),
      now: () => clock,
    });

    await runner.tick(); // off-peak → nothing to do (we paused nothing)
    expect(ops).toEqual([]);

    clock = monday(18); // peak → pause both
    await runner.tick();
    expect(ops).toEqual([{ id: "ev", on: false }, { id: "pool", on: false }]);
    expect(runner.pausedDevices).toEqual(["ev", "pool"]);

    await runner.tick(); // still peak → don't re-pause
    expect(ops).toHaveLength(2);

    clock = monday(22); // off-peak → resume only what we paused
    await runner.tick();
    expect(ops.slice(2)).toEqual([{ id: "ev", on: true }, { id: "pool", on: true }]);
    expect(runner.pausedDevices).toEqual([]);
  });

  it("does nothing without a tariff or deferrable devices", async () => {
    const ops: unknown[] = [];
    const noDevices = new LoadShiftRunner({ getTariff: async () => tariff, getDeferrableDeviceIds: async () => [], getCeiling: async () => undefined, setDeviceOn: async () => void ops.push(1), now: () => monday(18) });
    await noDevices.tick();
    const noTariff = new LoadShiftRunner({ getTariff: async () => undefined, getDeferrableDeviceIds: async () => ["ev"], getCeiling: async () => undefined, setDeviceOn: async () => void ops.push(1), now: () => monday(18) });
    await noTariff.tick();
    expect(ops).toEqual([]);
  });
});

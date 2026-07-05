import { describe, expect, it } from "vitest";
import type { ClimateProgram } from "@supreme/automations";
import { ClimateProgramRunner } from "./climate-runner.js";

const program: ClimateProgram = {
  weekday: [
    { atMinutes: 6 * 60, targetC: 21 },
    { atMinutes: 9 * 60, targetC: 18 },
  ],
  weekend: [{ atMinutes: 8 * 60, targetC: 20 }],
};

// 2026-01-05 is a Monday (weekday); 2026-01-03 is a Saturday (weekend).
const monday = (h: number, m = 0) => new Date(2026, 0, 5, h, m, 0);

describe("ClimateProgramRunner", () => {
  it("applies the scheduled setpoint and only re-applies when it changes", async () => {
    const applied: number[] = [];
    let clock = monday(7, 0); // within the 06:00 (21°C) block
    const runner = new ClimateProgramRunner({
      getProgram: async () => program,
      applySetpoint: async (t) => void applied.push(t),
      now: () => clock,
    });
    await runner.tick();
    expect(applied).toEqual([21]);

    clock = monday(8, 0); // still 21°C block → no re-apply
    await runner.tick();
    expect(applied).toEqual([21]);

    clock = monday(9, 30); // crossed into the 18°C block → apply
    await runner.tick();
    expect(applied).toEqual([21, 18]);
  });

  it("uses the weekend program on weekends", async () => {
    const applied: number[] = [];
    const runner = new ClimateProgramRunner({
      getProgram: async () => program,
      applySetpoint: async (t) => void applied.push(t),
      now: () => new Date(2026, 0, 3, 12, 0, 0), // Saturday noon
    });
    await runner.tick();
    expect(applied).toEqual([20]);
  });

  it("does nothing when no program is configured", async () => {
    const applied: number[] = [];
    const runner = new ClimateProgramRunner({ getProgram: async () => undefined, applySetpoint: async (t) => void applied.push(t), now: () => monday(7) });
    await runner.tick();
    expect(applied).toEqual([]);
    expect(runner.lastSetpoint).toBeNull();
  });
});

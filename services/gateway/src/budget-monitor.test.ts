import { describe, expect, it } from "vitest";
import { BudgetMonitor, BudgetError, validateBudget } from "./budget-monitor.js";

const at = (iso: string) => () => new Date(iso);

describe("validateBudget", () => {
  it("accepts a positive budget", () => {
    expect(validateBudget({ monthlyBudget: 120 })).toEqual({ monthlyBudget: 120 });
  });
  it("rejects non-positive or absurd budgets", () => {
    expect(() => validateBudget({ monthlyBudget: 0 })).toThrow(BudgetError);
    expect(() => validateBudget({ monthlyBudget: -5 })).toThrow(BudgetError);
    expect(() => validateBudget({ monthlyBudget: 2e9 })).toThrow(BudgetError);
    expect(() => validateBudget({})).toThrow(BudgetError);
  });
});

describe("BudgetMonitor", () => {
  const rate = { ratePerKwh: 0.2, currency: "USD" };

  it("fires once when projected month-end spend exceeds budget", async () => {
    const fired: { msg: string; projected: number }[] = [];
    // Day 10 of a 30-day month, 300 kWh so far → $60 spent → projected $180 → over a $100 budget.
    const mon = new BudgetMonitor({
      getBudget: async () => ({ monthlyBudget: 100 }),
      getRate: async () => rate,
      monthToDateKwh: async () => 300,
      notify: async (msg, status) => void fired.push({ msg, projected: status.projectedMonthEnd }),
      now: at("2026-06-10T12:00:00Z"),
    });
    await mon.tick();
    await mon.tick(); // same month, still over → must NOT fire again
    expect(fired).toHaveLength(1);
    expect(fired[0]!.projected).toBe(180);
    expect(fired[0]!.msg).toContain("over your USD 100 budget");
  });

  it("does not fire when projection is under budget", async () => {
    let fired = 0;
    const mon = new BudgetMonitor({
      getBudget: async () => ({ monthlyBudget: 100 }),
      getRate: async () => rate,
      monthToDateKwh: async () => 100, // $20 by day 10 → projected $60 < $100
      notify: async () => void fired++,
      now: at("2026-06-10T12:00:00Z"),
    });
    await mon.tick();
    expect(fired).toBe(0);
  });

  it("re-arms after dropping back under budget, and fires again next month", async () => {
    const fired: number[] = [];
    let kwh = 300; // over
    let clock = at("2026-06-10T12:00:00Z");
    const mon = new BudgetMonitor({
      getBudget: async () => ({ monthlyBudget: 100 }),
      getRate: async () => rate,
      monthToDateKwh: async () => kwh,
      notify: async (_m, s) => void fired.push(s.projectedMonthEnd),
      now: () => clock(),
    });
    await mon.tick(); // fires (projected 180)
    kwh = 50; // back under → projected $30, re-arms
    await mon.tick();
    kwh = 300; // over again, SAME month → fires again after re-arm
    await mon.tick();
    expect(fired).toHaveLength(2);

    // New month resets the per-month latch independently.
    clock = at("2026-07-10T12:00:00Z");
    await mon.tick();
    expect(fired).toHaveLength(3);
  });

  it("does nothing without a budget or without a provider rate", async () => {
    let fired = 0;
    const noBudget = new BudgetMonitor({
      getBudget: async () => undefined,
      getRate: async () => rate,
      monthToDateKwh: async () => 9999,
      notify: async () => void fired++,
      now: at("2026-06-10T12:00:00Z"),
    });
    await noBudget.tick();
    const noRate = new BudgetMonitor({
      getBudget: async () => ({ monthlyBudget: 1 }),
      getRate: async () => undefined,
      monthToDateKwh: async () => 9999,
      notify: async () => void fired++,
      now: at("2026-06-10T12:00:00Z"),
    });
    await noRate.tick();
    expect(fired).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { budgetStatus, computeEnergyCost, TariffError, type Tariff } from "./tariff.js";

// A simple time-of-use tariff: peak 16:00–21:00, off-peak otherwise. 2026-01-05 is a Monday.
const tariff: Tariff = {
  currency: "USD",
  standingChargePerDay: 0.5,
  exportRatePerKwh: 0.1,
  periods: [
    { name: "peak", ratePerKwh: 0.4, hours: [16, 17, 18, 19, 20] },
    { name: "off-peak", ratePerKwh: 0.15, hours: [...Array(24).keys()].filter((h) => h < 16 || h > 20) },
  ],
};

describe("computeEnergyCost", () => {
  it("prices consumption by time-of-use period and adds the standing charge", () => {
    const b = computeEnergyCost(tariff, [
      { ts: "2026-01-05T10:00:00Z", kwh: 2 }, // off-peak: 2 * 0.15 = 0.30
      { ts: "2026-01-05T18:00:00Z", kwh: 3 }, // peak:     3 * 0.40 = 1.20
    ]);
    expect(b.energyCost).toBe(1.5);
    expect(b.standingCharge).toBe(0.5); // one day
    expect(b.totalCost).toBe(2.0);
    expect(b.byPeriod).toEqual([
      { name: "peak", kwh: 3, cost: 1.2 },
      { name: "off-peak", kwh: 2, cost: 0.3 },
    ]);
  });

  it("credits exported (negative) energy at the feed-in rate", () => {
    const b = computeEnergyCost(tariff, [
      { ts: "2026-01-05T12:00:00Z", kwh: -4 }, // export: 4 * 0.10 = 0.40 credit
      { ts: "2026-01-05T18:00:00Z", kwh: 1 }, // peak: 0.40
    ]);
    expect(b.exportCredit).toBe(0.4);
    expect(b.energyCost).toBe(0.4);
    expect(b.totalCost).toBe(0.5); // 0.40 energy + 0.50 standing - 0.40 export
  });

  it("counts standing charge per distinct day", () => {
    const b = computeEnergyCost(tariff, [
      { ts: "2026-01-05T10:00:00Z", kwh: 1 },
      { ts: "2026-01-06T10:00:00Z", kwh: 1 },
    ]);
    expect(b.standingCharge).toBe(1.0); // two days
  });

  it("throws if the tariff doesn't cover a sample's hour", () => {
    const gap: Tariff = { currency: "USD", periods: [{ name: "day", ratePerKwh: 0.2, hours: [9, 10, 11] }] };
    expect(() => computeEnergyCost(gap, [{ ts: "2026-01-05T18:00:00Z", kwh: 1 }])).toThrow(TariffError);
  });

  it("rejects an invalid timestamp", () => {
    expect(() => computeEnergyCost(tariff, [{ ts: "not-a-date", kwh: 1 }])).toThrow(/invalid sample timestamp/);
  });
});

describe("budgetStatus", () => {
  it("projects month-end spend and flags over-budget", () => {
    const s = budgetStatus({ monthlyBudget: 100, spentSoFar: 40, dayOfMonth: 10, daysInMonth: 30 });
    expect(s.projectedMonthEnd).toBe(120); // 40/10*30
    expect(s.overBudget).toBe(true);
    expect(s.remaining).toBe(60);
    expect(s.utilization).toBe(0.4);
  });

  it("is under budget when the run-rate is below the budget", () => {
    const s = budgetStatus({ monthlyBudget: 100, spentSoFar: 20, dayOfMonth: 10, daysInMonth: 30 });
    expect(s.projectedMonthEnd).toBe(60);
    expect(s.overBudget).toBe(false);
  });

  it("validates dayOfMonth", () => {
    expect(() => budgetStatus({ monthlyBudget: 100, spentSoFar: 1, dayOfMonth: 0, daysInMonth: 30 })).toThrow(TariffError);
  });
});

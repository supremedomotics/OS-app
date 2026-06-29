import { describe, expect, it } from "vitest";
import { applyGroupCost, bucketCostHistory, compareGroupCost, RateError, resolveRate, resolveRateAsync } from "./index.js";

describe("resolveRate", () => {
  it("uses a manual rate when provided (most accurate)", () => {
    const r = resolveRate({ country: "IN", city: "Mumbai", provider: "Adani", ratePerKwh: 9.5 });
    expect(r).toMatchObject({ source: "manual", ratePerKwh: 9.5, currency: "INR", country: "IN", city: "Mumbai", provider: "Adani" });
  });

  it("falls back to the curated country default", () => {
    expect(resolveRate({ country: "in" })).toMatchObject({ source: "country-default", currency: "INR", ratePerKwh: 8.0 });
    expect(resolveRate({ country: "GB" })).toMatchObject({ currency: "GBP" });
  });

  it("requires a manual rate for an unknown country", () => {
    expect(() => resolveRate({ country: "ZZ" })).toThrow(/no default rate/);
    expect(resolveRate({ country: "ZZ", ratePerKwh: 1.2, currency: "XYZ" })).toMatchObject({ source: "manual", currency: "XYZ", ratePerKwh: 1.2 });
  });

  it("validates the country code and rate", () => {
    expect(() => resolveRate({ country: "India" })).toThrow(/alpha-2/);
    expect(() => resolveRate({ country: "IN", ratePerKwh: -1 })).toThrow(/non-negative/);
  });

  it("resolveRateAsync prefers a live provider rate over the country default", async () => {
    const fetcher = async () => ({ currency: "INR", ratePerKwh: 8.75 });
    expect(await resolveRateAsync({ country: "IN" }, fetcher)).toMatchObject({ source: "provider", ratePerKwh: 8.75 });
    // Live failure falls back to the country default.
    const failing = async () => {
      throw new Error("api down");
    };
    expect(await resolveRateAsync({ country: "IN" }, failing)).toMatchObject({ source: "country-default" });
    // Manual still wins over a live fetch.
    expect(await resolveRateAsync({ country: "IN", ratePerKwh: 10 }, fetcher)).toMatchObject({ source: "manual", ratePerKwh: 10 });
  });
});

describe("bucketCostHistory", () => {
  const days = [
    { day: "2026-01-05", kwh: 10 }, // Mon (week of 2026-01-05)
    { day: "2026-01-06", kwh: 5 }, // Tue (same week)
    { day: "2026-01-12", kwh: 8 }, // next Mon
    { day: "2026-02-02", kwh: 4 }, // Feb
  ];

  it("buckets by day, week, month, year with cost", () => {
    expect(bucketCostHistory(days, "day", 0.2)).toEqual([
      { period: "2026-01-05", kwh: 10, cost: 2 },
      { period: "2026-01-06", kwh: 5, cost: 1 },
      { period: "2026-01-12", kwh: 8, cost: 1.6 },
      { period: "2026-02-02", kwh: 4, cost: 0.8 },
    ]);
    expect(bucketCostHistory(days, "week", 0.2)).toEqual([
      { period: "2026-01-05", kwh: 15, cost: 3 }, // Mon+Tue of that week
      { period: "2026-01-12", kwh: 8, cost: 1.6 },
      { period: "2026-02-02", kwh: 4, cost: 0.8 },
    ]);
    expect(bucketCostHistory(days, "month", 0.2)).toEqual([
      { period: "2026-01", kwh: 23, cost: 4.6 },
      { period: "2026-02", kwh: 4, cost: 0.8 },
    ]);
    expect(bucketCostHistory(days, "year", 0.2)).toEqual([{ period: "2026", kwh: 27, cost: 5.4 }]);
  });

  it("ignores malformed day keys", () => {
    expect(bucketCostHistory([{ day: "bad", kwh: 99 }, { day: "2026-01-05", kwh: 1 }], "day", 1)).toEqual([{ period: "2026-01-05", kwh: 1, cost: 1 }]);
  });

  it("computes the Sunday week-start back to the prior Monday", () => {
    // 2026-01-04 is a Sunday → its week starts Monday 2025-12-29.
    expect(bucketCostHistory([{ day: "2026-01-04", kwh: 2 }], "week", 1)[0]!.period).toBe("2025-12-29");
  });
});

describe("applyGroupCost", () => {
  it("prices per-group consumption, highest cost first", () => {
    expect(applyGroupCost([{ key: "lr", kwh: 5 }, { key: "kitchen", kwh: 12 }], 0.2)).toEqual([
      { key: "kitchen", kwh: 12, cost: 2.4 },
      { key: "lr", kwh: 5, cost: 1 },
    ]);
  });
});

describe("compareGroupCost", () => {
  it("reports each current group's cost and percent change vs the previous period", () => {
    const current = [{ key: "kitchen", kwh: 12 }, { key: "lr", kwh: 5 }];
    const previous = [{ key: "kitchen", kwh: 10 }, { key: "lr", kwh: 10 }];
    expect(compareGroupCost(current, previous, 0.2)).toEqual([
      { key: "kitchen", kwh: 12, cost: 2.4, prevCost: 2, deltaPct: 20 }, // 10 → 12 = +20%
      { key: "lr", kwh: 5, cost: 1, prevCost: 2, deltaPct: -50 }, //        10 → 5  = -50%
    ]);
  });

  it("uses a null delta when the group had no baseline last period", () => {
    expect(compareGroupCost([{ key: "new", kwh: 3 }], [], 1)).toEqual([
      { key: "new", kwh: 3, cost: 3, prevCost: 0, deltaPct: null },
    ]);
  });

  it("omits groups that only consumed in the previous period", () => {
    const out = compareGroupCost([{ key: "a", kwh: 1 }], [{ key: "a", kwh: 1 }, { key: "gone", kwh: 9 }], 1);
    expect(out.map((g) => g.key)).toEqual(["a"]);
  });
});

/**
 * Energy cost history bucketing (§16). The analytics layer pulls per-DAY kWh from the time-series
 * table; this rolls those days up into the requested bucket (day / week / month / year) and applies
 * the per-kWh rate to get cost. Pure + deterministic — no DB, no clock — so it's DB-agnostic and
 * trivially testable, and the same code serves the energy dashboard's history view at every zoom.
 */

export type HistoryBucket = "day" | "week" | "month" | "year";

export interface DailyEnergy {
  /** YYYY-MM-DD (local day, as recorded). */
  day: string;
  kwh: number;
}

export interface CostBucket {
  /** The bucket key: YYYY-MM-DD (day), the Monday's date (week), YYYY-MM (month), or YYYY (year). */
  period: string;
  kwh: number;
  cost: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The Monday (ISO week start) of a YYYY-MM-DD day, as YYYY-MM-DD. */
function weekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0 = Sunday … 6 = Saturday
  const offset = dow === 0 ? -6 : 1 - dow; // back to Monday
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function periodKey(day: string, bucket: HistoryBucket): string {
  switch (bucket) {
    case "day":
      return day;
    case "week":
      return weekStart(day);
    case "month":
      return day.slice(0, 7); // YYYY-MM
    case "year":
      return day.slice(0, 4); // YYYY
  }
}

/** Roll daily energy into the requested bucket and price it at `ratePerKwh`. Periods sorted ascending. */
export function bucketCostHistory(days: DailyEnergy[], bucket: HistoryBucket, ratePerKwh: number): CostBucket[] {
  const byPeriod = new Map<string, number>();
  for (const d of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.day)) continue; // ignore malformed day keys
    const key = periodKey(d.day, bucket);
    byPeriod.set(key, (byPeriod.get(key) ?? 0) + d.kwh);
  }
  return [...byPeriod.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([period, kwh]) => ({ period, kwh: round2(kwh), cost: round2(kwh * ratePerKwh) }));
}

export interface GroupConsumption {
  key: string;
  kwh: number;
}

export interface GroupCost {
  key: string;
  kwh: number;
  cost: number;
}

/** Apply the rate to per-device / per-room consumption, highest cost first. */
export function applyGroupCost(groups: GroupConsumption[], ratePerKwh: number): GroupCost[] {
  return groups
    .map((g) => ({ key: g.key, kwh: round2(g.kwh), cost: round2(g.kwh * ratePerKwh) }))
    .sort((a, b) => b.cost - a.cost);
}

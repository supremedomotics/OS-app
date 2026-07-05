/**
 * Tariff-aware energy cost engine (§16). Turns measured consumption into MONEY — time-of-use rates
 * (peak / off-peak / shoulder), a daily standing charge, and a solar feed-in (export) credit — plus
 * a month-end budget projection. Pure and deterministic (no DB, no I/O): the analytics layer feeds
 * it hourly kWh buckets and a tariff, and it returns a cost breakdown the cost dashboard renders.
 *
 * Sample timestamps are interpreted in the home's LOCAL time (the analytics layer buckets locally),
 * so a tariff's `hours` line up with the wall clock the homeowner sees.
 */

export type DayType = "weekday" | "weekend";

export interface TariffPeriod {
  /** Display name, e.g. "peak", "off-peak", "shoulder". */
  name: string;
  /** Price per kWh in the tariff's currency. */
  ratePerKwh: number;
  /** Hours of the day (0–23) this period covers. */
  hours: number[];
  /** Which day types it applies to (default: both). */
  dayTypes?: DayType[];
}

export interface Tariff {
  currency: string;
  /** Fixed charge per day regardless of usage. */
  standingChargePerDay?: number;
  /** Time-of-use periods. Together they must cover all 24 hours for each day type a sample falls in. */
  periods: TariffPeriod[];
  /** Feed-in tariff: credit per kWh exported (negative consumption). Default 0. */
  exportRatePerKwh?: number;
}

export interface ConsumptionSample {
  /** ISO timestamp of the hour bucket (local time). */
  ts: string;
  /** Net kWh in that hour; negative = exported to the grid. */
  kwh: number;
}

export interface CostBreakdown {
  currency: string;
  totalKwh: number;
  energyCost: number;
  standingCharge: number;
  exportCredit: number;
  totalCost: number;
  byPeriod: { name: string; kwh: number; cost: number }[];
}

export class TariffError extends Error {}

const dayTypeOf = (ts: string): DayType => {
  const day = new Date(ts).getUTCDay(); // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6 ? "weekend" : "weekday";
};

function periodFor(tariff: Tariff, hour: number, dayType: DayType): TariffPeriod {
  const match = tariff.periods.find((p) => p.hours.includes(hour) && (p.dayTypes ?? ["weekday", "weekend"]).includes(dayType));
  if (!match) throw new TariffError(`tariff has no period covering hour ${hour} on a ${dayType}`);
  return match;
}

/** Compute the cost of a set of hourly consumption samples under a tariff. */
export function computeEnergyCost(tariff: Tariff, samples: ConsumptionSample[]): CostBreakdown {
  const byPeriod = new Map<string, { kwh: number; cost: number }>();
  const days = new Set<string>();
  let totalKwh = 0;
  let energyCost = 0;
  let exportCredit = 0;
  const exportRate = tariff.exportRatePerKwh ?? 0;

  for (const s of samples) {
    const d = new Date(s.ts);
    if (Number.isNaN(d.getTime())) throw new TariffError(`invalid sample timestamp: ${s.ts}`);
    days.add(s.ts.slice(0, 10)); // YYYY-MM-DD
    totalKwh += s.kwh;
    if (s.kwh < 0) {
      exportCredit += -s.kwh * exportRate;
      continue;
    }
    const period = periodFor(tariff, d.getUTCHours(), dayTypeOf(s.ts));
    const cost = s.kwh * period.ratePerKwh;
    energyCost += cost;
    const acc = byPeriod.get(period.name) ?? { kwh: 0, cost: 0 };
    acc.kwh += s.kwh;
    acc.cost += cost;
    byPeriod.set(period.name, acc);
  }

  const standingCharge = round2((tariff.standingChargePerDay ?? 0) * days.size);
  return {
    currency: tariff.currency,
    totalKwh: round2(totalKwh),
    energyCost: round2(energyCost),
    standingCharge,
    exportCredit: round2(exportCredit),
    totalCost: round2(energyCost + standingCharge - exportCredit),
    byPeriod: [...byPeriod.entries()].map(([name, v]) => ({ name, kwh: round2(v.kwh), cost: round2(v.cost) })).sort((a, b) => b.cost - a.cost),
  };
}

export interface BudgetStatus {
  budget: number;
  spent: number;
  remaining: number;
  /** Linear projection of spend by month end at the current daily rate. */
  projectedMonthEnd: number;
  overBudget: boolean;
  /** Fraction of budget used so far (0..1+). */
  utilization: number;
}

/** Project month-end spend from spend-so-far and flag if it's tracking over budget. */
export function budgetStatus(opts: { monthlyBudget: number; spentSoFar: number; dayOfMonth: number; daysInMonth: number }): BudgetStatus {
  const { monthlyBudget, spentSoFar, dayOfMonth, daysInMonth } = opts;
  if (dayOfMonth < 1 || dayOfMonth > daysInMonth) throw new TariffError("dayOfMonth out of range");
  const projectedMonthEnd = round2((spentSoFar / dayOfMonth) * daysInMonth);
  return {
    budget: round2(monthlyBudget),
    spent: round2(spentSoFar),
    remaining: round2(monthlyBudget - spentSoFar),
    projectedMonthEnd,
    overBudget: projectedMonthEnd > monthlyBudget,
    utilization: monthlyBudget > 0 ? round2(spentSoFar / monthlyBudget) : 0,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

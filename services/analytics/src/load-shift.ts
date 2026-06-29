import type { Tariff } from "./tariff.js";

/**
 * Peak-aware load shifting (§16) — an eco/cost feature. During the most expensive tariff period,
 * pause DEFERRABLE high-draw loads (EV charger, pool pump, water heater) and resume them once the
 * rate drops, so the homeowner spends less without thinking about it. Pure + deterministic: given
 * the tariff and the current local minute, decide whether deferrable loads should run now.
 *
 * The "peak" period is the tariff's highest-rate period; a load is allowed to run whenever the
 * current period's rate is at or below the configured ceiling (default: anything cheaper than peak).
 */

/** Resolve the tariff period covering a given local minute (mirrors the cost engine's lookup). */
function rateAt(tariff: Tariff, minuteOfDay: number, weekend: boolean): { name: string; rate: number } | null {
  const hour = Math.floor(minuteOfDay / 60);
  const dayType = weekend ? "weekend" : "weekday";
  const p = tariff.periods.find((x) => x.hours.includes(hour) && (x.dayTypes ?? ["weekday", "weekend"]).includes(dayType));
  return p ? { name: p.name, rate: p.ratePerKwh } : null;
}

/** The highest per-kWh rate across all of the tariff's periods (the "peak"). */
export function peakRate(tariff: Tariff): number {
  return tariff.periods.reduce((m, p) => Math.max(m, p.ratePerKwh), 0);
}

export interface LoadShiftDecision {
  /** Whether deferrable loads should be allowed to run right now. */
  allowRun: boolean;
  /** The current period name + rate (for the UI / audit). */
  period: string | null;
  currentRate: number | null;
  peakRate: number;
}

export interface LoadShiftOptions {
  /**
   * Only pause when the current rate is strictly the peak. If a `maxRunRatePerKwh` is given instead,
   * loads run whenever the current rate is ≤ that ceiling (lets the owner also avoid "shoulder").
   */
  maxRunRatePerKwh?: number;
}

/**
 * Decide whether deferrable loads may run at `minuteOfDay`. By default they run except during the
 * single most-expensive (peak) period; with `maxRunRatePerKwh` they run only when the rate is at or
 * below that ceiling.
 */
export function loadShiftDecision(tariff: Tariff, minuteOfDay: number, weekend: boolean, opts: LoadShiftOptions = {}): LoadShiftDecision {
  const peak = peakRate(tariff);
  const here = rateAt(tariff, minuteOfDay, weekend);
  if (!here) return { allowRun: true, period: null, currentRate: null, peakRate: peak }; // unknown → don't pause
  const ceiling = opts.maxRunRatePerKwh;
  const allowRun = ceiling !== undefined ? here.rate <= ceiling : here.rate < peak;
  return { allowRun, period: here.name, currentRate: here.rate, peakRate: peak };
}

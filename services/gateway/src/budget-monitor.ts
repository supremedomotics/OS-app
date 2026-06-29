/**
 * Monthly energy-budget monitor (§16). The owner sets a monthly spend budget; each tick the hub
 * sums the home's month-to-date energy, prices it at the provider rate, and linearly projects
 * month-end spend (the pure `budgetStatus` core). When the projection first crosses the budget it
 * fires ONE notification for that calendar month, so the homeowner hears about a high bill while
 * there's still time to act — not when it arrives. Re-arms if spend drops back under budget, and
 * naturally resets each new month. Budget unset or provider unconfigured → nothing fires.
 */
import { budgetStatus, type BudgetStatus } from "@supreme/analytics";

export interface EnergyBudget {
  /** Spend cap for the calendar month, in the provider's currency. */
  monthlyBudget: number;
}

export class BudgetError extends Error {}

/** Validate a budget on write. */
export function validateBudget(b: unknown): EnergyBudget {
  const o = b as Partial<EnergyBudget>;
  if (!o || typeof o.monthlyBudget !== "number" || !Number.isFinite(o.monthlyBudget) || o.monthlyBudget <= 0 || o.monthlyBudget > 1e9) {
    throw new BudgetError("monthlyBudget must be a number > 0 and ≤ 1e9");
  }
  return { monthlyBudget: o.monthlyBudget };
}

export class BudgetMonitor {
  /** The `YYYY-MM` we last alerted for, so we fire at most once per month per crossing. */
  private firedForMonth: string | null = null;
  private readonly now: () => Date;

  constructor(
    private readonly opts: {
      getBudget: () => Promise<EnergyBudget | undefined>;
      getRate: () => Promise<{ ratePerKwh: number; currency: string } | undefined>;
      /** Sum of kWh recorded from `fromIsoDay` (inclusive, YYYY-MM-DD) to now. */
      monthToDateKwh: (fromIsoDay: string) => Promise<number>;
      notify: (message: string, status: BudgetStatus, currency: string) => Promise<void>;
      now?: () => Date;
      log?: (msg: string, meta?: Record<string, unknown>) => void;
    },
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  async tick(): Promise<void> {
    const budget = await this.opts.getBudget();
    if (!budget) return;
    const rate = await this.opts.getRate();
    if (!rate) return;

    const now = this.now();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth(); // 0-based
    const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
    const monthStart = `${monthKey}-01`;
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const dayOfMonth = now.getUTCDate();

    const kwh = await this.opts.monthToDateKwh(monthStart);
    const status = budgetStatus({
      monthlyBudget: budget.monthlyBudget,
      spentSoFar: kwh * rate.ratePerKwh,
      dayOfMonth,
      daysInMonth,
    });

    if (status.overBudget) {
      if (this.firedForMonth === monthKey) return; // already warned this month
      this.firedForMonth = monthKey;
      const message = `On track to spend ${rate.currency} ${status.projectedMonthEnd} on energy this month — over your ${rate.currency} ${status.budget} budget`;
      try {
        await this.opts.notify(message, status, rate.currency);
        this.opts.log?.("budget alert fired", { monthKey, projected: status.projectedMonthEnd, budget: status.budget });
      } catch (err) {
        this.firedForMonth = null; // delivery failed → allow a retry next tick
        this.opts.log?.("budget notify failed", { monthKey, error: (err as Error).message });
      }
    } else if (this.firedForMonth === monthKey) {
      // Projection fell back under budget within the same month → re-arm for a future crossing.
      this.firedForMonth = null;
    }
  }
}

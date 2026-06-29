/**
 * Intelligence reports (pure). Turns the raw history aggregate (savings + interaction tallies the
 * persistence layer sums) into a period report with derived metrics — CO₂ avoided, approval rate,
 * Auto Pilot activity — for the daily/weekly/monthly/yearly/lifetime views. Deterministic: no clock,
 * no I/O; the caller picks the date range and passes the aggregate.
 */
export type ReportPeriod = "day" | "week" | "month" | "year" | "lifetime";
export const REPORT_PERIODS: readonly ReportPeriod[] = ["day", "week", "month", "year", "lifetime"];

/** Tallies the history store produces for a range (see IntelligenceRepo.aggregate). */
export interface ReportAggregate {
  kwhSaved: number;
  costSaved: number;
  autoActions: number;
  notificationsSent: number;
  notificationsIgnored: number;
  userOff: number;
  keepOn: number;
}

export interface ReportOptions {
  currency?: string | null;
  /** Grid carbon intensity (kg CO₂ per kWh). Default 0.475 (a global-average proxy). */
  co2KgPerKwh?: number;
}

export interface IntelligenceReport {
  period: string;
  energySavedKwh: number;
  moneySaved: number;
  currency: string | null;
  co2SavedKg: number;
  automaticActions: number;
  notificationsSent: number;
  notificationsIgnored: number;
  /** Of prompts the user acted on (turn-off vs keep-on), the fraction they agreed to switch off. */
  approvalRate: number;
  /** Total off-actions taken (automatic + user-confirmed). */
  offActions: number;
  interactions: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function buildIntelligenceReport(period: ReportPeriod | string, agg: ReportAggregate, opts: ReportOptions = {}): IntelligenceReport {
  const co2PerKwh = opts.co2KgPerKwh ?? 0.475;
  const decided = agg.userOff + agg.keepOn;
  return {
    period,
    energySavedKwh: round3(agg.kwhSaved),
    moneySaved: round2(agg.costSaved),
    currency: opts.currency ?? null,
    co2SavedKg: round3(agg.kwhSaved * co2PerKwh),
    automaticActions: agg.autoActions,
    notificationsSent: agg.notificationsSent,
    notificationsIgnored: agg.notificationsIgnored,
    approvalRate: decided > 0 ? round2(agg.userOff / decided) : 0,
    offActions: agg.autoActions + agg.userOff,
    interactions: agg.userOff + agg.keepOn + agg.notificationsIgnored,
  };
}

/** Report as CSV (one metric per row) for the owner's records / their accountant. */
export function reportToCsv(report: IntelligenceReport): string {
  const rows: [string, string | number][] = [
    ["metric", "value"],
    ["period", report.period],
    ["energy_saved_kwh", report.energySavedKwh],
    ["money_saved", report.moneySaved],
    ["currency", report.currency ?? ""],
    ["co2_saved_kg", report.co2SavedKg],
    ["automatic_actions", report.automaticActions],
    ["off_actions", report.offActions],
    ["notifications_sent", report.notificationsSent],
    ["notifications_ignored", report.notificationsIgnored],
    ["approval_rate", report.approvalRate],
    ["interactions", report.interactions],
  ];
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

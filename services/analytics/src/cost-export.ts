import type { CostBucket, GroupCost } from "./cost-history.js";

/**
 * Cost data export (§16) — homeowners want their cost history as a file for their records / their
 * accountant. Pure CSV serialization (no I/O): the route streams the string with a text/csv header.
 * RFC-4180-ish: comma-separated, CRLF rows, quoted fields containing commas/quotes/newlines.
 */

function csvField(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: string[], rows: (string | number)[][]): string {
  const lines = [headers, ...rows].map((r) => r.map(csvField).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** Cost history (per period) → CSV with period, kWh, cost, currency. */
export function costHistoryToCsv(history: CostBucket[], currency: string): string {
  return toCsv(["period", "kwh", "cost", "currency"], history.map((h) => [h.period, h.kwh, h.cost, currency]));
}

/** Per-device / per-room cost breakdown → CSV. `nameOf` resolves a key to a human label. */
export function costBreakdownToCsv(groups: GroupCost[], currency: string, nameOf: (key: string) => string): string {
  return toCsv(["name", "id", "kwh", "cost", "currency"], groups.map((g) => [nameOf(g.key), g.key, g.kwh, g.cost, currency]));
}

import { describe, expect, it } from "vitest";
import { buildIntelligenceReport, reportToCsv, type ReportAggregate } from "./reports.js";

const agg: ReportAggregate = {
  kwhSaved: 4,
  costSaved: 32,
  autoActions: 3,
  notificationsSent: 10,
  notificationsIgnored: 2,
  userOff: 4,
  keepOn: 1,
};

describe("buildIntelligenceReport", () => {
  it("derives CO2, approval rate and off-actions", () => {
    const r = buildIntelligenceReport("month", agg, { currency: "INR" });
    expect(r.energySavedKwh).toBe(4);
    expect(r.moneySaved).toBe(32);
    expect(r.currency).toBe("INR");
    expect(r.co2SavedKg).toBe(1.9); // 4 × 0.475
    expect(r.approvalRate).toBe(0.8); // 4 off / (4 off + 1 keep)
    expect(r.offActions).toBe(7); // 3 auto + 4 user
    expect(r.interactions).toBe(7); // 4 + 1 + 2
  });

  it("uses a custom grid intensity and handles no decisions", () => {
    const r = buildIntelligenceReport("day", { ...agg, userOff: 0, keepOn: 0 }, { co2KgPerKwh: 0.7 });
    expect(r.co2SavedKg).toBe(2.8); // 4 × 0.7
    expect(r.approvalRate).toBe(0); // nothing decided → 0, not NaN
  });

  it("exports CSV with a metric/value row per field", () => {
    const csv = reportToCsv(buildIntelligenceReport("year", agg, { currency: "USD" }));
    expect(csv.split("\r\n")[0]).toBe("metric,value");
    expect(csv).toContain("co2_saved_kg,1.9");
    expect(csv).toContain("approval_rate,0.8");
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});

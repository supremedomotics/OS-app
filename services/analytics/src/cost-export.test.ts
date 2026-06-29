import { describe, expect, it } from "vitest";
import { costBreakdownToCsv, costHistoryToCsv } from "./cost-export.js";

describe("cost CSV export", () => {
  it("serializes cost history with a header and CRLF rows", () => {
    const csv = costHistoryToCsv([{ period: "2026-01", kwh: 10, cost: 80 }, { period: "2026-02", kwh: 2, cost: 16 }], "INR");
    expect(csv).toBe("period,kwh,cost,currency\r\n2026-01,10,80,INR\r\n2026-02,2,16,INR\r\n");
  });

  it("quotes fields containing commas/quotes", () => {
    const csv = costBreakdownToCsv([{ key: "d1", kwh: 5, cost: 1 }], "USD", () => 'Living Room, "Main"');
    expect(csv).toContain('"Living Room, ""Main"""');
    expect(csv.startsWith("name,id,kwh,cost,currency\r\n")).toBe(true);
  });

  it("handles an empty dataset (header only)", () => {
    expect(costHistoryToCsv([], "USD")).toBe("period,kwh,cost,currency\r\n");
  });
});

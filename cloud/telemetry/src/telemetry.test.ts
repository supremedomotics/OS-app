import { describe, expect, it } from "vitest";
import { TelemetryService, type TelemetryEvent } from "./index.js";

const ev = (homeId: string, metric: string, value: number, at = 1_750_000_000_000): TelemetryEvent => ({ homeId, metric, value, at });

function svc(now = () => 1_750_000_000_000) {
  return new TelemetryService({ salt: "test-salt", now });
}

describe("TelemetryService — opt-in gate", () => {
  it("drops events from homes that have not opted in", () => {
    const t = svc();
    expect(t.ingest([ev("h1", "energy_kwh", 5)])).toBe(0); // not opted in → dropped
    t.setOptIn("h1", true);
    expect(t.ingest([ev("h1", "energy_kwh", 5)])).toBe(1);
  });

  it("stops contributing when opt-in is withdrawn", () => {
    const t = svc();
    t.setOptIn("h1", true);
    t.ingest([ev("h1", "energy_kwh", 5)]);
    t.setOptIn("h1", false);
    expect(t.ingest([ev("h1", "energy_kwh", 9)])).toBe(0);
  });
});

describe("TelemetryService — anonymization + aggregation", () => {
  it("aggregates across homes using pseudonyms (no raw home id stored)", () => {
    const t = svc();
    t.setOptIn("h1", true);
    t.setOptIn("h2", true);
    t.ingest([ev("h1", "energy_kwh", 10, 1), ev("h2", "energy_kwh", 20, 2), ev("h1", "energy_kwh", 30, 3)].map((e) => ({ ...e, at: 1_750_000_000_000 })));
    const agg = t.aggregate("energy_kwh");
    expect(agg.count).toBe(3);
    expect(agg.sum).toBe(60);
    expect(agg.avg).toBe(20);
    expect(agg.homes).toBe(2); // two distinct pseudonyms
  });

  it("respects retention (old events are pruned)", () => {
    let now = 1_750_000_000_000;
    const t = new TelemetryService({ salt: "s", retentionMs: 1000, now: () => now });
    t.setOptIn("h1", true);
    t.ingest([{ homeId: "h1", metric: "m", value: 1, at: now }]);
    now += 2000; // beyond retention
    expect(t.aggregate("m").count).toBe(0);
  });
});

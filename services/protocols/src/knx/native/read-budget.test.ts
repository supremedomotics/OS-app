import { describe, expect, it } from "vitest";
import { ReadBudget, type ReadGrant } from "./read-budget.js";

const clockAt = () => { const c = { t: 0, now: () => c.t }; return c; };
const grant = (g: ReadGrant | string): ReadGrant => { if (typeof g === "string") throw new Error(`refused: ${g}`); return g; };

describe("ReadBudget (shared by state sync and health probes)", () => {
  it("caps concurrency across both kinds and frees a slot on release (release is idempotent)", () => {
    const b = new ReadBudget(clockAt(), { maxConcurrent: 2, maxPerMinute: 100 });
    const a = grant(b.acquire("sync")); grant(b.acquire("sync"));
    expect(b.acquire("sync")).toBe("concurrency");
    expect(b.acquire("health")).toBe("concurrency");
    a.release(); a.release();
    expect(b.stats().inFlight).toBe(1);
    grant(b.acquire("sync"));
    expect(b.stats().refused.concurrency).toBe(2);
  });

  it("caps starts per sliding minute across both kinds and recovers as the window slides", () => {
    const c = clockAt();
    const b = new ReadBudget(c, { maxConcurrent: 100, maxPerMinute: 4, healthShare: 1 });
    for (let i = 0; i < 2; i++) grant(b.acquire("sync")).release();
    c.t = 30_000;
    for (let i = 0; i < 2; i++) grant(b.acquire("health")).release();
    expect(b.acquire("sync")).toBe("rate");
    c.t = 60_001;                                      // the first two left the window
    expect(b.stats().startedLastMinute).toBe(2);
    grant(b.acquire("sync")).release();
    expect(b.stats().refused.rate).toBe(1);
  });

  it("health probes may use only their share, so they can never starve synchronisation", () => {
    const b = new ReadBudget(clockAt(), { maxConcurrent: 8, maxPerMinute: 8, healthShare: 0.25 });
    const h1 = grant(b.acquire("health")); grant(b.acquire("health"));
    expect(b.acquire("health")).toBe("health_share"); // 2 of 8 concurrent
    expect(b.stats().healthInFlight).toBe(2);
    for (let i = 0; i < 6; i++) grant(b.acquire("sync"));  // synchronisation still gets everything that is left
    expect(b.acquire("sync")).toBe("concurrency");
    h1.release();
  });

  it("health share applies to the per-minute window too, and always allows at least one probe", () => {
    const b = new ReadBudget(clockAt(), { maxConcurrent: 100, maxPerMinute: 8, healthShare: 0.25 });
    for (let i = 0; i < 2; i++) grant(b.acquire("health")).release();
    expect(b.acquire("health")).toBe("health_share");
    grant(b.acquire("sync")).release();
    const tiny = new ReadBudget(clockAt(), { maxConcurrent: 1, maxPerMinute: 1, healthShare: 0 });
    grant(tiny.acquire("health"));
  });
});

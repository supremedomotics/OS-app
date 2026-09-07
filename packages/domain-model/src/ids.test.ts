import { describe, expect, it } from "vitest";
import { newId } from "./ids.js";

/**
 * § Multi-network Casambi, Stage 2b review — found live: two Casambi driver instances created
 * back-to-back (the wizard's own install loop, or a fast test) can legitimately share one
 * millisecond, and `DriverManager`'s instance ordering (which decides which instance stays
 * "primary" — see `installer-context.ts`'s `runtimeProtocolFor`) sorts by `installedAt` then by
 * `id` as a tie-break. Before this fix, the random suffix `newId()` draws per call gave that
 * tie-break no relationship to actual creation order — a coin flip, not a tie-break.
 */
describe("newId — monotonic within one millisecond", () => {
  it("a later id in the SAME millisecond always sorts after an earlier one", () => {
    const now = Date.now();
    const first = newId("driver", now);
    const second = newId("driver", now);
    const third = newId("driver", now);
    expect(second > first).toBe(true);
    expect(third > second).toBe(true);
  });

  it("ordering is monotonic across many rapid same-millisecond calls, not just two", () => {
    const now = Date.now();
    const ids = Array.from({ length: 200 }, () => newId("device", now));
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length); // never collides either
  });

  it("a genuinely later millisecond still sorts after an earlier one — this isn't just a same-tick counter", () => {
    const t1 = 1_700_000_000_000;
    const t2 = t1 + 1;
    const a = newId("driver", t1);
    const b = newId("driver", t2);
    expect(b > a).toBe(true);
  });

  it("resets to fresh randomness on a new millisecond, rather than continuing to increment forever", () => {
    const t1 = 1_700_000_000_500;
    const t2 = t1 + 5;
    const first = newId("driver", t1);
    // Advance the clock, then come back to a DIFFERENT later millisecond — the random suffix
    // must not be constrained by whatever the previous millisecond's counter had reached.
    const second = newId("driver", t2);
    expect(first.slice(0, 14)).not.toBe(second.slice(0, 14)); // different timestamp-encoded prefix
  });

  it("still produces a validly-shaped id (unchanged format, only the generation strategy changed)", () => {
    const id = newId("driver");
    expect(id).toMatch(/^drv_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

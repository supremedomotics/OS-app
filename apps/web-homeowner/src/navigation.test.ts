import { describe, expect, it } from "vitest";
import { parseTabFromHash, DEFAULT_TAB, shouldApplySeq, shouldApplySnapshot } from "./App.js";

// § Navigation / Tab Persistence — a refresh (or deep link) must land on the tab the URL
// hash actually names, and Extension Center — never Dashboard — is the fallback when no
// valid tab is present. See App.tsx's tabFromHash()/go()/the popstate listener for the
// DOM-reading half of this fix; this covers the pure parsing logic.
describe("parseTabFromHash", () => {
  it("resolves a valid tab from the hash", () => {
    expect(parseTabFromHash("#/extensions")).toBe("extensions");
    expect(parseTabFromHash("#/settings")).toBe("settings");
    expect(parseTabFromHash("#/media")).toBe("media");
  });

  it("resolves a hash without the leading slash", () => {
    expect(parseTabFromHash("#devices")).toBe("devices");
  });

  it("returns null for an empty hash (caller falls back to DEFAULT_TAB, not Dashboard)", () => {
    expect(parseTabFromHash("")).toBeNull();
    expect(parseTabFromHash("#")).toBeNull();
    expect(parseTabFromHash("#/")).toBeNull();
  });

  it("returns null for an unrecognized/garbage hash rather than guessing a tab", () => {
    expect(parseTabFromHash("#/not-a-real-tab")).toBeNull();
  });

  it("§ Default Tab — the documented fallback is Extension Center, not Dashboard", () => {
    expect(DEFAULT_TAB).toBe("extensions");
  });
});

// § Realtime State Hardening — race conditions: a stale reconciliation snapshot or an
// out-of-order redelivered frame must never overwrite a newer realtime event.
describe("shouldApplySeq", () => {
  it("applies the first-ever update for a key (no prior sequence)", () => {
    expect(shouldApplySeq(undefined, 1)).toBe(true);
  });
  it("applies a strictly newer sequence", () => {
    expect(shouldApplySeq(5, 6)).toBe(true);
  });
  it("drops an out-of-order (older) sequence", () => {
    expect(shouldApplySeq(6, 5)).toBe(false);
  });
  it("applies a repeated identical sequence (idempotent redelivery, not a regression)", () => {
    expect(shouldApplySeq(5, 5)).toBe(true);
  });
});

describe("shouldApplySnapshot", () => {
  it("applies a snapshot value when no realtime event for that key has ever landed", () => {
    expect(shouldApplySnapshot(undefined, 1000)).toBe(true);
  });
  it("applies a snapshot value whose last live event predates the snapshot fetch starting", () => {
    expect(shouldApplySnapshot(500, 1000)).toBe(true);
  });
  it("does NOT apply a snapshot value when a realtime event arrived DURING the snapshot fetch — the newer event wins", () => {
    expect(shouldApplySnapshot(1500, 1000)).toBe(false);
  });
});

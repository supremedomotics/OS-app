import { describe, expect, it } from "vitest";
import { TvStateCache } from "./tv-state-cache.js";

const MEDIA_PRIORITY = ["agent", "mediasession", "cast", "poll"];
const APP_PRIORITY = ["agent_accessibility", "adb"];

describe("TvStateCache — §14/§15/§28 arbitration invariants (direct, no session in the loop)", () => {
  it("a higher revision always wins, regardless of source priority", () => {
    const cache = new TvStateCache(MEDIA_PRIORITY, APP_PRIORITY);
    expect(cache.offerMedia({ value: { title: "A" }, source: "agent", timestamp: "t1", revision: 3 })).toBe(true);
    expect(cache.offerMedia({ value: { title: "B" }, source: "poll", timestamp: "t2", revision: 9 })).toBe(true);
    expect(cache.getMedia()?.title).toBe("B");
  });

  it("a lower revision is REJECTED outright, even from the highest-priority source", () => {
    const cache = new TvStateCache(MEDIA_PRIORITY, APP_PRIORITY);
    cache.offerMedia({ value: { title: "Newer" }, source: "poll", timestamp: "t1", revision: 10 });
    const accepted = cache.offerMedia({ value: { title: "Stale" }, source: "agent", timestamp: "t2", revision: 4 });
    expect(accepted).toBe(false);
    expect(cache.getMedia()?.title).toBe("Newer");
  });

  it("equal-revision arbitration is deterministic: same inputs, same winner, every time", () => {
    for (let i = 0; i < 20; i++) {
      const cache = new TvStateCache(MEDIA_PRIORITY, APP_PRIORITY);
      cache.offerMedia({ value: { title: "Low priority" }, source: "cast", timestamp: "t1", revision: 5 });
      const accepted = cache.offerMedia({ value: { title: "High priority" }, source: "agent", timestamp: "t2", revision: 5 });
      expect(accepted).toBe(true);
      expect(cache.getMedia()?.title).toBe("High priority");
    }
  });

  it("equal-revision from a source ranked BELOW the current holder is rejected", () => {
    const cache = new TvStateCache(MEDIA_PRIORITY, APP_PRIORITY);
    cache.offerMedia({ value: { title: "Agent value" }, source: "agent", timestamp: "t1", revision: 5 });
    const accepted = cache.offerMedia({ value: { title: "Cast value" }, source: "cast", timestamp: "t2", revision: 5 });
    expect(accepted).toBe(false);
    expect(cache.getMedia()?.title).toBe("Agent value");
  });

  it("an unlisted source ranks lowest and loses every tie against a listed source", () => {
    const cache = new TvStateCache(MEDIA_PRIORITY, APP_PRIORITY);
    cache.offerMedia({ value: { title: "Known source" }, source: "poll", timestamp: "t1", revision: 1 });
    const accepted = cache.offerMedia({ value: { title: "Unknown source" }, source: "mystery", timestamp: "t2", revision: 1 });
    expect(accepted).toBe(false);
  });

  it("media and foreground-app arbitration are fully independent field groups", () => {
    const cache = new TvStateCache(MEDIA_PRIORITY, APP_PRIORITY);
    cache.offerMedia({ value: { title: "Movie" }, source: "poll", timestamp: "t1", revision: 100 });
    cache.offerForegroundApp({
      value: { packageName: "com.example.app", applicationName: "Example", source: "adb", confidence: "app_only", timestamp: "t1" },
      source: "adb",
      timestamp: "t1",
      revision: 1,
    });
    expect(cache.getMedia()?.title).toBe("Movie");
    expect(cache.getForegroundApp()?.packageName).toBe("com.example.app");
  });

  it("when no revision is supplied, arrival order is used (never a tie, so priority never even needs to break one)", () => {
    const cache = new TvStateCache(MEDIA_PRIORITY, APP_PRIORITY);
    cache.offerMedia({ value: { title: "First" }, source: "cast", timestamp: "t1" });
    const accepted = cache.offerMedia({ value: { title: "Second" }, source: "cast", timestamp: "t2" });
    expect(accepted).toBe(true);
    expect(cache.getMedia()?.title).toBe("Second");
  });
});

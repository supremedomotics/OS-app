import { describe, expect, it, vi, afterEach } from "vitest";
import { TvReconnectScheduler } from "./tv-reconnect.js";

describe("TvReconnectScheduler — §12/§19 bounded, jittered backoff", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("each successive delay is bounded within backoffMaxMs, even after many attempts", () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const scheduler = new TvReconnectScheduler({ backoffBaseMs: 100, backoffMaxMs: 1000, attempt: async () => {} });
    scheduler.start();
    const delays: number[] = [];
    for (let i = 0; i < 10; i++) {
      scheduler.scheduleNext();
      const call = setTimeoutSpy.mock.calls.at(-1)!;
      delays.push(call[1] as number);
      vi.advanceTimersByTime(delays.at(-1)!);
    }
    // Every delay must sit within the jitter envelope around [0, backoffMaxMs * 1.2].
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1200);
    }
    // The curve must actually have grown at some point (not flat from attempt 0), proving
    // this isn't a constant/no-op backoff.
    expect(Math.max(...delays)).toBeGreaterThan(delays[0]!);
    setTimeoutSpy.mockRestore();
  });

  it("jitter makes consecutive runs of the same scenario vary (not lockstep across devices)", () => {
    const samples = new Set<number>();
    for (let i = 0; i < 30; i++) {
      let observed = -1;
      const scheduler = new TvReconnectScheduler({
        backoffBaseMs: 1000,
        backoffMaxMs: 60000,
        attempt: async () => {},
      });
      scheduler.start();
      const orig = setTimeout;
      (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, ms: number) => {
        observed = ms;
        return orig(fn, 0);
      }) as typeof setTimeout;
      scheduler.scheduleNext();
      scheduler.stop();
      global.setTimeout = orig;
      samples.add(observed);
    }
    // With ±20% jitter on a 1000ms base, 30 independent draws should not all collapse to
    // the exact same integer millisecond value.
    expect(samples.size).toBeGreaterThan(1);
  });

  it("stop() cancels a pending attempt and prevents further scheduling", () => {
    vi.useFakeTimers();
    let attempts = 0;
    const scheduler = new TvReconnectScheduler({
      backoffBaseMs: 10,
      backoffMaxMs: 50,
      attempt: async () => {
        attempts++;
      },
    });
    scheduler.start();
    scheduler.scheduleNext();
    scheduler.stop();
    vi.advanceTimersByTime(10_000);
    expect(attempts).toBe(0);
    // Also must refuse to schedule anything new once stopped.
    scheduler.scheduleNext();
    vi.advanceTimersByTime(10_000);
    expect(attempts).toBe(0);
  });

  it("resetOnSuccess() restarts the backoff curve from attempt 0", () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const scheduler = new TvReconnectScheduler({ backoffBaseMs: 100, backoffMaxMs: 100000, attempt: async () => {} });
    scheduler.start();
    for (let i = 0; i < 5; i++) {
      scheduler.scheduleNext();
      vi.advanceTimersByTime(setTimeoutSpy.mock.calls.at(-1)![1] as number);
    }
    expect(scheduler.attempts).toBe(5);
    scheduler.resetOnSuccess();
    expect(scheduler.attempts).toBe(0);
    setTimeoutSpy.mockRestore();
  });
});

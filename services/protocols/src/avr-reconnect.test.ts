import { afterEach, describe, expect, it, vi } from "vitest";
import { ReconnectScheduler } from "./avr-reconnect.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ReconnectScheduler", () => {
  it("retries once after a disconnect, then stops once reconnect succeeds", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const scheduler = new ReconnectScheduler({
      baseMs: 1_000,
      maxMs: 1_000,
      reconnect: async () => {
        attempts += 1;
      },
    });

    scheduler.notifyDisconnected();
    await vi.advanceTimersByTimeAsync(1_200);
    expect(attempts).toBe(1);

    scheduler.reset();
    // No further attempts once reset (a successful reconnect) has run.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(attempts).toBe(1);
  });

  it("backs off exponentially, capped at maxMs, across repeated failures", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const scheduler = new ReconnectScheduler({
      baseMs: 1_000,
      maxMs: 4_000,
      reconnect: async () => {
        attempts += 1;
        throw new Error("still down");
      },
    });

    scheduler.notifyDisconnected();
    await vi.advanceTimersByTimeAsync(1_000); // 1st attempt at ~1s
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000); // 2nd attempt at ~2s later
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(4_000); // 3rd attempt at ~4s (capped) later
    expect(attempts).toBe(3);
    expect(scheduler.attemptCount).toBeGreaterThanOrEqual(3);
  });

  it("does not schedule a second timer while one is already pending", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const scheduler = new ReconnectScheduler({
      baseMs: 1_000,
      reconnect: async () => {
        attempts += 1;
      },
    });

    scheduler.notifyDisconnected();
    scheduler.notifyDisconnected();
    scheduler.notifyDisconnected();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(1);
  });

  it("stop() prevents any further scheduled attempts", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const scheduler = new ReconnectScheduler({
      baseMs: 1_000,
      reconnect: async () => {
        attempts += 1;
      },
    });

    scheduler.notifyDisconnected();
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(0);
  });
});

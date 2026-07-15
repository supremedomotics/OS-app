import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionManager, type ConnectionState } from "./connection-manager.js";

describe("ConnectionManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Backoff jitter uses Math.random(), which fake timers don't control — pin it to
    // the midpoint (no deviation) so every test's advanceTimersByTimeAsync() call can
    // use an exact, deterministic delay instead of a jitter-widened range.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("connects immediately on start() when connect() succeeds", async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const cm = new ConnectionManager({ connect, disconnect: vi.fn() });
    await cm.start();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(cm.state).toBe("connected");
    expect(cm.metrics().uptimeMs).toBe(0);
  });

  it("measures a real connect duration, on success and on failure (§ Connection Quality Monitoring)", async () => {
    let now = 0;
    const connect = vi.fn().mockImplementation(() => {
      now += 42; // simulate 42ms of real elapsed connect time
      return Promise.resolve();
    });
    const cm = new ConnectionManager({ connect, disconnect: vi.fn(), now: () => now });
    await cm.start();
    expect(cm.metrics().lastConnectDurationMs).toBe(42);

    now = 0;
    const failing = vi.fn().mockImplementation(() => {
      now += 17;
      return Promise.reject(new Error("refused"));
    });
    const cm2 = new ConnectionManager({ connect: failing, disconnect: vi.fn(), now: () => now });
    await cm2.start();
    expect(cm2.metrics().lastConnectDurationMs).toBe(17); // a failed attempt's duration is real data too
  });

  it("retries with exponential backoff on repeated connect failures, capped at maxBackoffMs", async () => {
    let attempt = 0;
    const connect = vi.fn().mockImplementation(() => {
      attempt++;
      return attempt <= 3 ? Promise.reject(new Error("refused")) : Promise.resolve();
    });
    const states: ConnectionState[] = [];
    const cm = new ConnectionManager({
      connect,
      disconnect: vi.fn(),
      minBackoffMs: 100,
      maxBackoffMs: 1000,
      onStateChange: (s) => states.push(s),
    });

    await cm.start(); // attempt 1 fails synchronously (fake timers still control setTimeout)
    expect(cm.state).toBe("error");
    expect(connect).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100); // backoff #1 (min)
    expect(connect).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(200); // backoff #2 (doubled)
    expect(connect).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(400); // backoff #3 (doubled again) — succeeds
    expect(connect).toHaveBeenCalledTimes(4);
    expect(cm.state).toBe("connected");

    const metrics = cm.metrics();
    expect(metrics.reconnectAttempts).toBe(0); // reset on success
    expect(metrics.successfulReconnects).toBe(1);
    expect(metrics.failedReconnects).toBe(3);
    expect(metrics.currentBackoffMs).toBe(100); // reset to min — fast reconnect after the NEXT blip
    expect(states).toContain("recovering");
  });

  it("marks degraded and reconnects when the heartbeat reports unhealthy", async () => {
    let healthy = true;
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const cm = new ConnectionManager({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect,
      isHealthy: () => healthy,
      heartbeatIntervalMs: 1000,
      minBackoffMs: 50,
    });
    await cm.start();
    expect(cm.state).toBe("connected");

    healthy = false;
    await vi.advanceTimersByTimeAsync(1000); // first heartbeat tick — fails
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(cm.metrics().heartbeatFailures).toBe(1);

    healthy = true;
    await vi.advanceTimersByTimeAsync(50); // reconnect fires on schedule
    expect(cm.state).toBe("connected");
  });

  it("stop() clears every timer — no reconnect fires afterward (no orphaned timers/duplicate work)", async () => {
    const connect = vi.fn().mockRejectedValue(new Error("down"));
    const cm = new ConnectionManager({ connect, disconnect: vi.fn(), minBackoffMs: 100 });
    await cm.start();
    expect(connect).toHaveBeenCalledTimes(1);

    await cm.stop();
    expect(cm.state).toBe("disconnected");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(connect).toHaveBeenCalledTimes(1); // no further attempts after stop
  });

  it("markConnected() takes over supervision after a caller-driven initial connect, without calling connect() itself", async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const cm = new ConnectionManager({ connect, disconnect: vi.fn(), minBackoffMs: 50 });
    cm.markConnected();
    expect(cm.state).toBe("connected");
    expect(connect).not.toHaveBeenCalled();

    cm.reportDisconnected("tunnel closed");
    await vi.advanceTimersByTimeAsync(50);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(cm.state).toBe("connected");
  });

  it("reportDisconnected() triggers a supervised reconnect for an async, event-driven drop", async () => {
    const cm = new ConnectionManager({ connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(), minBackoffMs: 50 });
    await cm.start();
    expect(cm.state).toBe("connected");

    cm.reportDisconnected("socket closed");
    expect(cm.state).toBe("error");
    expect(cm.metrics().lastError).toBe("socket closed");

    await vi.advanceTimersByTimeAsync(50);
    expect(cm.state).toBe("connected");
  });

  it("reportDisconnected() is a no-op when not connected (a late/duplicate event can't double-schedule)", async () => {
    const connect = vi.fn().mockRejectedValue(new Error("down"));
    const cm = new ConnectionManager({ connect, disconnect: vi.fn(), minBackoffMs: 100 });
    await cm.start();
    expect(cm.state).toBe("error");
    cm.reportDisconnected("stale event");
    await vi.advanceTimersByTimeAsync(100);
    expect(connect).toHaveBeenCalledTimes(2); // exactly the one scheduled retry, not two
  });

  it("never overlaps two in-flight connect attempts (guards against duplicate connections)", async () => {
    let resolveConnect!: () => void;
    const connect = vi.fn().mockImplementation(() => new Promise<void>((res) => { resolveConnect = res; }));
    const cm = new ConnectionManager({ connect, disconnect: vi.fn() });
    const startPromise = cm.start();
    await cm.start(); // start() again while the first is still in flight
    expect(connect).toHaveBeenCalledTimes(1);
    resolveConnect();
    await startPromise;
    expect(cm.state).toBe("connected");
  });
});

import { describe, expect, it, vi } from "vitest";
import { DriverMetricsEngine } from "./driver-metrics-engine.js";

describe("DriverMetricsEngine", () => {
  it("cumulative counters (restRequests/udpEvents/reconnects/droppedEvents) never expire", () => {
    const engine = new DriverMetricsEngine();
    engine.increment("restRequests", 3);
    engine.increment("udpEvents");
    engine.increment("reconnects", 2);
    engine.increment("droppedEvents", 5);
    const snap = engine.snapshot();
    expect(snap.restRequestsTotal).toBe(3);
    expect(snap.udpEventsTotal).toBe(1);
    expect(snap.reconnectsTotal).toBe(2);
    expect(snap.droppedEventsTotal).toBe(5);
  });

  it("rate metrics (packets/commands/events) count only hits within the sliding window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const engine = new DriverMetricsEngine(1_000);
    engine.increment("packets", 5);
    expect(engine.snapshot().packetsPerSec).toBe(5);

    vi.setSystemTime(1_500); // past the 1s window — those 5 hits should have aged out
    expect(engine.snapshot().packetsPerSec).toBe(0);
    vi.useRealTimers();
  });

  it("recordLatency computes average and max across recorded samples", () => {
    const engine = new DriverMetricsEngine();
    engine.recordLatency(10);
    engine.recordLatency(20);
    engine.recordLatency(30);
    const snap = engine.snapshot();
    expect(snap.averageLatencyMs).toBe(20);
    expect(snap.maxLatencyMs).toBe(30);
  });

  it("latency is null before any sample is recorded", () => {
    expect(new DriverMetricsEngine().snapshot().averageLatencyMs).toBeNull();
    expect(new DriverMetricsEngine().snapshot().maxLatencyMs).toBeNull();
  });

  it("setQueueLength reports the caller's most recent value", () => {
    const engine = new DriverMetricsEngine();
    engine.setQueueLength(7);
    expect(engine.snapshot().queueLength).toBe(7);
  });

  it("caps its retained latency samples at 500 (bounded memory)", () => {
    const engine = new DriverMetricsEngine();
    for (let i = 0; i < 600; i++) engine.recordLatency(i);
    // The oldest 100 samples (0..99) should have been dropped; max stays the true max.
    expect(engine.snapshot().maxLatencyMs).toBe(599);
  });
});

/**
 * SupremeOS Driver Metrics Engine (§ Casambi Driver Refactor — PR-2). A reusable rate/counter
 * framework any driver can feed real events into. Pure counting + a sliding-window rate
 * computation — no protocol-specific logic, no timers of its own (the caller decides when to read
 * a snapshot).
 */

export type MetricCounterName =
  | "packets"
  | "commands"
  | "events"
  | "restRequests"
  | "udpEvents"
  | "reconnects"
  | "droppedEvents";

export interface DriverMetricsSnapshot {
  packetsPerSec: number;
  commandsPerSec: number;
  eventsPerSec: number;
  restRequestsTotal: number;
  udpEventsTotal: number;
  reconnectsTotal: number;
  droppedEventsTotal: number;
  averageLatencyMs: number | null;
  maxLatencyMs: number | null;
  queueLength: number;
}

interface CounterEntry {
  total: number;
  /** Timestamps (ms) of increments within the current rate window, for `.../Sec` metrics only. */
  windowHits: number[];
}

const RATE_METRICS: ReadonlySet<MetricCounterName> = new Set(["packets", "commands", "events"]);

/** Tracks counters + a rolling latency sample list; `snapshot()` reduces both into one
 * `DriverMetricsSnapshot`. Instance-scoped (one per driver instance), matching every other
 * per-driver counter this codebase already keeps (e.g. `CasambiHealth.reconnects`). */
export class DriverMetricsEngine {
  private readonly windowMs: number;
  private readonly counters = new Map<MetricCounterName, CounterEntry>();
  private readonly latenciesMs: number[] = [];
  private queueLength = 0;

  constructor(windowMs = 1_000) {
    this.windowMs = windowMs;
  }

  increment(name: MetricCounterName, by = 1): void {
    const entry = this.counters.get(name) ?? { total: 0, windowHits: [] };
    entry.total += by;
    if (RATE_METRICS.has(name)) {
      const now = Date.now();
      for (let i = 0; i < by; i++) entry.windowHits.push(now);
    }
    this.counters.set(name, entry);
  }

  recordLatency(ms: number): void {
    this.latenciesMs.push(ms);
    if (this.latenciesMs.length > 500) this.latenciesMs.shift();
  }

  setQueueLength(length: number): void {
    this.queueLength = length;
  }

  private rate(name: MetricCounterName): number {
    const entry = this.counters.get(name);
    if (!entry) return 0;
    const cutoff = Date.now() - this.windowMs;
    entry.windowHits = entry.windowHits.filter((t) => t >= cutoff);
    return entry.windowHits.length / (this.windowMs / 1_000);
  }

  private total(name: MetricCounterName): number {
    return this.counters.get(name)?.total ?? 0;
  }

  snapshot(): DriverMetricsSnapshot {
    return {
      packetsPerSec: this.rate("packets"),
      commandsPerSec: this.rate("commands"),
      eventsPerSec: this.rate("events"),
      restRequestsTotal: this.total("restRequests"),
      udpEventsTotal: this.total("udpEvents"),
      reconnectsTotal: this.total("reconnects"),
      droppedEventsTotal: this.total("droppedEvents"),
      averageLatencyMs:
        this.latenciesMs.length > 0
          ? Math.round(this.latenciesMs.reduce((a, b) => a + b, 0) / this.latenciesMs.length)
          : null,
      maxLatencyMs: this.latenciesMs.length > 0 ? Math.max(...this.latenciesMs) : null,
      queueLength: this.queueLength,
    };
  }
}

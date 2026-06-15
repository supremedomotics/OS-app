/**
 * Latency + outcome collector for the load harness (§15). Records per-request latency
 * (ms) and errors, and computes percentiles + a summary. Memory is sampled separately
 * so soak runs can detect unbounded growth.
 */
export class Metrics {
  private readonly latencies: number[] = [];
  private errorCount = 0;
  private startedAt = 0;
  private endedAt = 0;

  start(): void {
    this.startedAt = performance.now();
  }
  stop(): void {
    this.endedAt = performance.now();
  }

  record(latencyMs: number, ok: boolean): void {
    this.latencies.push(latencyMs);
    if (!ok) this.errorCount++;
  }

  private percentile(p: number): number {
    if (this.latencies.length === 0) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return Math.round(sorted[idx]! * 100) / 100;
  }

  summary(): LoadSummary {
    const count = this.latencies.length;
    const durationS = Math.max(0.001, (this.endedAt - this.startedAt) / 1000);
    return {
      count,
      errors: this.errorCount,
      errorRate: count > 0 ? this.errorCount / count : 0,
      rps: Math.round(count / durationS),
      durationS: Math.round(durationS * 100) / 100,
      p50: this.percentile(50),
      p95: this.percentile(95),
      p99: this.percentile(99),
      max: this.latencies.length ? Math.round(Math.max(...this.latencies) * 100) / 100 : 0,
    };
  }
}

export interface LoadSummary {
  count: number;
  errors: number;
  errorRate: number;
  rps: number;
  durationS: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Sample RSS (MB) over the run so a soak can flag a leak (slope, not absolute). */
export class MemorySampler {
  private readonly samples: number[] = [];
  sample(): void {
    this.samples.push(process.memoryUsage().rss / (1024 * 1024));
  }
  /** MB growth from the first to the last sample. */
  growthMb(): number {
    if (this.samples.length < 2) return 0;
    return Math.round((this.samples[this.samples.length - 1]! - this.samples[0]!) * 10) / 10;
  }
  get start(): number {
    return Math.round((this.samples[0] ?? 0) * 10) / 10;
  }
  get end(): number {
    return Math.round((this.samples[this.samples.length - 1] ?? 0) * 10) / 10;
  }
}

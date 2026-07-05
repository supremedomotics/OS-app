import { sha256Hex } from "@supreme/crypto";

/**
 * @supreme/telemetry — OPT-IN, anonymized telemetry (blueprint §19).
 *
 * Telemetry is never required for operation. A hub only contributes if its home has opted in;
 * ingested events are anonymized (the home id is replaced by a stable salted pseudonym, raw
 * identifiers are dropped) and retention-bounded. Aggregation answers fleet questions without
 * exposing any individual home.
 */

export interface TelemetryEvent {
  homeId: string;
  metric: string;
  value: number;
  at: number;
  /** Raw context (identifiers here are stripped on ingest). */
  context?: Record<string, unknown>;
}

export interface StoredEvent {
  pseudonym: string; // salted hash of homeId — not reversible without the salt
  metric: string;
  value: number;
  at: number;
}

export interface TelemetryOptions {
  /** Secret salt for pseudonymization (from cloud secrets). */
  salt: string;
  /** Retention window in ms (events older than this are dropped on ingest/aggregate). */
  retentionMs?: number;
  now?: () => number;
}

export class TelemetryService {
  private events: StoredEvent[] = [];
  private readonly optedIn = new Set<string>();
  private readonly salt: string;
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(opts: TelemetryOptions) {
    this.salt = opts.salt;
    this.retentionMs = opts.retentionMs ?? 90 * 24 * 60 * 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  setOptIn(homeId: string, optedIn: boolean): void {
    if (optedIn) this.optedIn.add(homeId);
    else this.optedIn.delete(homeId);
  }

  isOptedIn(homeId: string): boolean {
    return this.optedIn.has(homeId);
  }

  private pseudonym(homeId: string): string {
    return sha256Hex(`${this.salt}|${homeId}`).slice(0, 24);
  }

  /** Ingest events — dropped entirely unless the home has opted in. Returns count accepted. */
  ingest(events: TelemetryEvent[]): number {
    let accepted = 0;
    for (const e of events) {
      if (!this.optedIn.has(e.homeId)) continue; // opt-in gate
      // Anonymize: pseudonymous id, drop raw context identifiers entirely.
      this.events.push({ pseudonym: this.pseudonym(e.homeId), metric: e.metric, value: e.value, at: e.at });
      accepted++;
    }
    this.prune();
    return accepted;
  }

  private prune(): void {
    const cutoff = this.now() - this.retentionMs;
    this.events = this.events.filter((e) => e.at >= cutoff);
  }

  /** Aggregate a metric across the (anonymized) fleet within retention. */
  aggregate(metric: string): { count: number; sum: number; avg: number; homes: number } {
    this.prune();
    const rows = this.events.filter((e) => e.metric === metric);
    const sum = rows.reduce((a, e) => a + e.value, 0);
    const homes = new Set(rows.map((e) => e.pseudonym)).size;
    return { count: rows.length, sum, avg: rows.length ? sum / rows.length : 0, homes };
  }
}

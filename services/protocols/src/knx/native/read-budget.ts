/**
 * Shared GroupValueRead budget (§ Clean-room KNX stack — health ownership). ONE instance per {@link NativeKnxConnection}: ordinary state
 * synchronisation reads and the health monitor's active probes draw on the same concurrency cap and the same sliding one-minute window, so
 * probing can never add load that synchronisation did not leave room for. Synchronisation may use the whole budget; health probes are admitted
 * only up to `healthShare` of it, so a fleet of probes cannot starve a state sync. Clock-injected, no timers (the window is pruned on use).
 */
import type { Clock } from "./transport.js";

export type ReadKind = "sync" | "health";
export type ReadRefusal = "concurrency" | "rate" | "health_share";

export interface ReadBudgetOptions {
  /** Reads in flight at once, both kinds together (default 64 — the cap read() already had). */
  maxConcurrent?: number;
  /** Reads started in any sliding 60 s window, both kinds together (default 600). */
  maxPerMinute?: number;
  /** Fraction of both limits that health probes may use (default 0.25, at least one read). */
  healthShare?: number;
}

export interface ReadBudgetStats {
  inFlight: number;
  healthInFlight: number;
  startedLastMinute: number;
  healthStartedLastMinute: number;
  refused: Record<ReadRefusal, number>;
}

export interface ReadGrant { release(): void }

export class ReadBudget {
  private readonly maxConcurrent: number;
  private readonly maxPerMinute: number;
  private readonly healthShare: number;
  private inFlight = 0;
  private healthInFlight = 0;
  private starts: Array<{ at: number; kind: ReadKind }> = [];
  private readonly refused: Record<ReadRefusal, number> = { concurrency: 0, rate: 0, health_share: 0 };

  constructor(private readonly clock: Pick<Clock, "now">, o: ReadBudgetOptions = {}) {
    this.maxConcurrent = o.maxConcurrent ?? 64;
    this.maxPerMinute = o.maxPerMinute ?? 600;
    this.healthShare = Math.min(1, Math.max(0, o.healthShare ?? 0.25));
  }

  /** A grant (release it exactly when the read has ended; releasing twice is harmless) or the reason it was refused. */
  acquire(kind: ReadKind): ReadGrant | ReadRefusal {
    this.prune();
    const refuse = (r: ReadRefusal): ReadRefusal => { this.refused[r]++; return r; };
    if (this.inFlight >= this.maxConcurrent) return refuse("concurrency");
    if (this.starts.length >= this.maxPerMinute) return refuse("rate");
    if (kind === "health") {
      if (this.healthInFlight >= Math.max(1, Math.floor(this.maxConcurrent * this.healthShare))) return refuse("health_share");
      if (this.starts.filter((s) => s.kind === "health").length >= Math.max(1, Math.floor(this.maxPerMinute * this.healthShare))) return refuse("health_share");
    }
    this.inFlight++;
    if (kind === "health") this.healthInFlight++;
    this.starts.push({ at: this.clock.now(), kind });
    let released = false;
    return { release: () => { if (released) return; released = true; this.inFlight--; if (kind === "health") this.healthInFlight--; } };
  }

  stats(): ReadBudgetStats {
    this.prune();
    return {
      inFlight: this.inFlight, healthInFlight: this.healthInFlight, startedLastMinute: this.starts.length,
      healthStartedLastMinute: this.starts.filter((s) => s.kind === "health").length, refused: { ...this.refused },
    };
  }

  private prune(): void {
    const cutoff = this.clock.now() - 60_000;
    let i = 0;
    while (i < this.starts.length && this.starts[i]!.at <= cutoff) i++;
    if (i > 0) this.starts = this.starts.slice(i);
  }
}

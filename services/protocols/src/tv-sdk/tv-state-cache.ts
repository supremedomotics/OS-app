import type { TvForegroundApp, TvMediaState } from "./tv-types.js";

/**
 * (§13 Feedback Arbitration, §28 Event Ordering) Per-session, field-aware state cache.
 * One instance per `TvDeviceSession` — never shared, so isolation is structural rather
 * than policy: there is no map key to get wrong, no possibility of one device's update
 * landing in another's cache.
 *
 * Arbitration is deliberately per FIELD GROUP (media vs. foreground-app), not a single
 * global "last writer wins" — a Cast update should not be allowed to clobber a more
 * authoritative Agent MediaSession title just because it happened to arrive later, but a
 * media update and a foreground-app update from different sources never compete with each
 * other at all. Each field group tracks its own revision counter; when a source doesn't
 * supply a revision, sequence-of-arrival within that source is used as a fallback ONLY
 * for updates from a source with no stronger claim already cached (see `offer()`).
 */
export interface SourcedUpdate<T> {
  value: T;
  source: string;
  /** Higher wins when present. Absent (undefined) sources fall back to arrival order,
   * but can never overwrite a value that DOES carry a revision unless their priority
   * (via `sourcePriority`) is strictly higher. */
  revision?: number;
  timestamp: string;
}

export class TvStateCache {
  private media: SourcedUpdate<Partial<TvMediaState>> | null = null;
  private mediaRevisionCounter = 0;
  private foregroundApp: SourcedUpdate<TvForegroundApp> | null = null;
  private foregroundRevisionCounter = 0;

  constructor(
    /** Lower index = higher priority, per §13's documented per-field-group ordering.
     * Callers pass the ordering that applies to THIS field group (media sources vs.
     * foreground-app sources differ per the spec). An unlisted source is treated as
     * lowest priority. */
    private readonly mediaSourcePriority: string[],
    private readonly foregroundSourcePriority: string[],
  ) {}

  /** Returns true if the update was accepted (and is now the cached value). */
  offerMedia(update: Omit<SourcedUpdate<Partial<TvMediaState>>, "revision"> & { revision?: number }): boolean {
    const revision = update.revision ?? ++this.mediaRevisionCounter;
    const accepted = this.shouldAccept(this.media, { ...update, revision }, this.mediaSourcePriority);
    if (accepted) this.media = { ...update, revision };
    return accepted;
  }

  offerForegroundApp(update: Omit<SourcedUpdate<TvForegroundApp>, "revision"> & { revision?: number }): boolean {
    const revision = update.revision ?? ++this.foregroundRevisionCounter;
    const accepted = this.shouldAccept(this.foregroundApp, { ...update, revision }, this.foregroundSourcePriority);
    if (accepted) this.foregroundApp = { ...update, revision };
    return accepted;
  }

  getMedia(): Partial<TvMediaState> | null {
    return this.media?.value ?? null;
  }

  getForegroundApp(): TvForegroundApp | null {
    return this.foregroundApp?.value ?? null;
  }

  /** A higher revision always wins (§28: "do not allow stale events to overwrite newer
   * state"). At equal revision, a strictly higher-priority source wins — this is what
   * lets a lower-priority source's late-arriving duplicate never clobber a
   * higher-priority source's value that happened to be assigned the same synthetic
   * revision. A source that ranks BELOW the current holder can still win with a
   * genuinely higher revision — revision, not priority, is the primary ordering signal;
   * priority only breaks ties. */
  private shouldAccept<T>(current: SourcedUpdate<T> | null, next: SourcedUpdate<T>, priority: string[]): boolean {
    if (!current) return true;
    if (next.revision! > current.revision!) return true;
    if (next.revision! < current.revision!) return false;
    return this.priorityRank(next.source, priority) < this.priorityRank(current.source, priority);
  }

  private priorityRank(source: string, priority: string[]): number {
    const idx = priority.indexOf(source);
    return idx === -1 ? priority.length : idx;
  }
}

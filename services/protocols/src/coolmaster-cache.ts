import type { CoolMasterUnitStatus } from "./coolmaster-types.js";

/** One cached unit's status plus bookkeeping (§ State Cache: "last values, last update,
 * online status, quality"). */
interface CachedEntry {
  status: CoolMasterUnitStatus;
  lastUpdateMs: number;
  online: boolean;
  /** Consecutive polls this unit has failed to report on — drives the offline
   * determination (a single missed poll is noise; several in a row is a real signal). */
  missedPolls: number;
}

const OFFLINE_AFTER_MISSED_POLLS = 3;

/**
 * Per-unit state cache with change detection — "publish entity updates only when values
 * change" (§ State Cache). Deep-equal comparison (via JSON, same pattern already used by
 * every other native driver's state cache in this codebase — avr/heos/yamaha-driver.ts)
 * so a poll that reports identical values never fires a spurious update.
 */
export class CoolMasterStateCache {
  private readonly entries = new Map<string, CachedEntry>();

  /** Records a fresh reading. Returns the previous status (null if this is the first
   * reading) so callers can diff/log what changed; the caller decides whether the diff
   * is worth emitting (coolmaster-driver.ts emits unconditionally when this returns a
   * value that differs from the previous one). */
  update(status: CoolMasterUnitStatus, nowMs: number): { changed: boolean; previous: CoolMasterUnitStatus | null } {
    const existing = this.entries.get(status.uid);
    const previous = existing?.status ?? null;
    const changed = !existing || !deepEqual(existing.status, status);
    this.entries.set(status.uid, { status, lastUpdateMs: nowMs, online: true, missedPolls: 0 });
    return { changed, previous };
  }

  get(uid: string): CoolMasterUnitStatus | null {
    return this.entries.get(uid)?.status ?? null;
  }

  isOnline(uid: string): boolean {
    return this.entries.get(uid)?.online ?? false;
  }

  lastUpdateMs(uid: string): number | null {
    return this.entries.get(uid)?.lastUpdateMs ?? null;
  }

  all(): CoolMasterUnitStatus[] {
    return [...this.entries.values()].map((e) => e.status);
  }

  knownUids(): string[] {
    return [...this.entries.keys()];
  }

  /** Called once per poll cycle for every unit NOT present in that poll's results — a
   * unit that stops appearing in ls2 (HVAC line communication lost) should eventually
   * read as offline rather than silently keep its last-known "on" state forever. */
  markMissedPoll(uid: string): boolean {
    const entry = this.entries.get(uid);
    if (!entry) return false;
    entry.missedPolls += 1;
    const wasOnline = entry.online;
    if (entry.missedPolls >= OFFLINE_AFTER_MISSED_POLLS) entry.online = false;
    return wasOnline !== entry.online;
  }

  delete(uid: string): void {
    this.entries.delete(uid);
  }

  clear(): void {
    this.entries.clear();
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

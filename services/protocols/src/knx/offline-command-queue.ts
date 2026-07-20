/**
 * Offline Command Queue (§ Enterprise Reliability — Queue Recovery Policy).
 *
 * Generic (not KNX-specific — typed over any command shape) — a reusable piece of the
 * broader Reliability Framework the same way {@link "./connection-manager.js"
 * ConnectionManager} already is. Answers the exact policy question the spec poses
 * ("Light ON → gateway offline → reconnect → execute / expire / merge / cancel?") with
 * one deterministic rule, not four competing behaviors:
 *
 *   - MERGE: a new command for the same (subject, kind) key replaces any still-queued
 *     one — "I turned it on then off while offline" only ever applies OFF, never both.
 *   - EXPIRE: a command older than `ttlMs` is dropped, never executed late — a light
 *     switched at 9am shouldn't snap on at 6pm just because the gateway finally
 *     reconnected.
 *   - EXECUTE: anything neither superseded nor expired runs for real once the
 *     connection returns.
 *   - CANCEL: the caller can always clear the whole queue explicitly (e.g. on driver
 *     shutdown) — never a fourth silent behavior, an explicit method.
 */
export interface QueuedCommand<TSubject, TCommand> {
  subject: TSubject;
  command: TCommand;
  queuedAt: number;
}

export interface OfflineCommandQueueOptions<TSubject, TCommand> {
  /** How stale a queued command may be before it's dropped instead of executed —
   * default 5 minutes, a deliberately conservative "don't surprise the homeowner"
   * default rather than a long window that risks a very-late, very-unexpected action. */
  ttlMs?: number;
  /** The dedupe/merge key — two commands with the same key supersede each other. For a
   * KNX device this is `${deviceId}:${capability}`, but the queue itself doesn't know
   * what a device or capability is (§ generic, reusable infrastructure). */
  keyOf: (subject: TSubject, command: TCommand) => string;
  now?: () => number;
}

export interface DrainResult {
  executed: number;
  expired: number;
}

export class OfflineCommandQueue<TSubject, TCommand> {
  private readonly ttlMs: number;
  private readonly keyOf: (subject: TSubject, command: TCommand) => string;
  private readonly now: () => number;
  private readonly byKey = new Map<string, QueuedCommand<TSubject, TCommand>>();

  constructor(opts: OfflineCommandQueueOptions<TSubject, TCommand>) {
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this.keyOf = opts.keyOf;
    this.now = opts.now ?? (() => Date.now());
  }

  /** MERGE semantics — a new command for the same key overwrites, never appends. */
  enqueue(subject: TSubject, command: TCommand): void {
    this.byKey.set(this.keyOf(subject, command), { subject, command, queuedAt: this.now() });
  }

  size(): number {
    return this.byKey.size;
  }

  pending(): QueuedCommand<TSubject, TCommand>[] {
    return [...this.byKey.values()];
  }

  /** CANCEL — explicit, never implicit. */
  clear(): void {
    this.byKey.clear();
  }

  /** Removes queued commands whose subject matches `predicate` — e.g. a device that was
   * just unbound (§ Driver Lifecycle Completion: nothing may remain queued for a device
   * that no longer exists). Returns the count removed; a no-op if none match. */
  evict(predicate: (subject: TSubject) => boolean): number {
    let removed = 0;
    for (const [key, item] of [...this.byKey]) {
      if (predicate(item.subject)) {
        this.byKey.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** EXECUTE/EXPIRE — called once the connection returns. Runs `execute` for every
   * still-fresh command (sequentially, so a slow/failing one can't starve the rest via
   * unbounded concurrency) and drops anything past its TTL without running it. Always
   * clears the queue afterward, whether or not individual executions succeeded — a
   * failed execution isn't re-queued (§ deterministic recovery, not a silent retry
   * loop); the caller decides whether a failure needs its own handling. */
  async drain(execute: (subject: TSubject, command: TCommand) => Promise<void>): Promise<DrainResult> {
    const nowMs = this.now();
    const items = [...this.byKey.values()];
    this.byKey.clear();
    let executed = 0;
    let expired = 0;
    for (const item of items) {
      if (nowMs - item.queuedAt > this.ttlMs) {
        expired++;
        continue;
      }
      await execute(item.subject, item.command);
      executed++;
    }
    return { executed, expired };
  }
}

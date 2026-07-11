/**
 * Poll scheduling (§ Polling Strategy: "Fast: HVAC state/faults/temperature. Slow:
 * configuration/discovery. Never flood the gateway. Reuse cached values.") and the
 * command queue (§ Command Queue: "FIFO, Timeout, Retry, Deduplication, Validation,
 * Priority handling").
 *
 * Retry/timeout for an individual wire request already live in coolmaster-connection.ts
 * (which serializes ASCII_IF requests one-at-a-time at the transport level — see
 * coolmaster-ascii-protocol.ts). This module adds the layer above that: deduplicating
 * rapid repeated commands for the same target+field before they ever reach the wire
 * (e.g. a user dragging a temperature slider shouldn't send ten "temp" commands, only
 * the last one), and giving user commands priority over routine poll reads so control
 * still feels responsive while a poll is in flight.
 */

interface QueuedItem {
  /** When set, a later enqueue() with the SAME key replaces this item instead of
   * appending a second one — the dedup mechanism. Poll reads pass null (never dedup'd
   * against each other; each poll cycle enqueues fresh). */
  dedupeKey: string | null;
  /** Lower runs first. User commands (0) jump ahead of poll reads (10). */
  priority: number;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export class CoolMasterCommandQueue {
  private readonly items: QueuedItem[] = [];
  private draining = false;

  enqueue(run: () => Promise<void>, opts: { dedupeKey?: string | null; priority?: number } = {}): Promise<void> {
    const dedupeKey = opts.dedupeKey ?? null;
    const priority = opts.priority ?? 5;
    return new Promise((resolve, reject) => {
      if (dedupeKey) {
        const existingIdx = this.items.findIndex((i) => i.dedupeKey === dedupeKey);
        if (existingIdx >= 0) {
          // Superseded — the earlier queued (not-yet-started) command for this exact
          // target+field is replaced by the newer one; its caller still resolves
          // normally once THIS one runs, since from the caller's perspective the queue
          // simply took a little longer, not failed.
          const [old] = this.items.splice(existingIdx, 1);
          old!.resolve();
        }
      }
      const item: QueuedItem = { dedupeKey, priority, run, resolve, reject };
      const insertAt = this.items.findIndex((i) => i.priority > priority);
      if (insertAt === -1) this.items.push(item);
      else this.items.splice(insertAt, 0, item);
      void this.drain();
    });
  }

  size(): number {
    return this.items.length;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.items.length > 0) {
        const item = this.items.shift()!;
        try {
          await item.run();
          item.resolve();
        } catch (err) {
          item.reject(err);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

export type PollTier = "fast" | "slow" | "discovery";

export interface CoolMasterPollerOptions {
  fastMs: number;
  slowMs: number;
  discoveryMs: number;
  onFastPoll: () => Promise<void>;
  onSlowPoll: () => Promise<void>;
  onDiscoveryDue: () => Promise<void>;
  onError: (tier: PollTier, err: unknown) => void;
}

/**
 * Self-rescheduling timers (NOT raw setInterval) — each tier waits for its own cycle to
 * finish before scheduling the next, so a slow gateway response can never cause
 * overlapping polls to pile up against it ("never flood the gateway").
 */
export class CoolMasterPoller {
  private fastTimer: ReturnType<typeof setTimeout> | null = null;
  private slowTimer: ReturnType<typeof setTimeout> | null = null;
  private discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly opts: CoolMasterPollerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleFast();
    this.scheduleSlow();
    this.scheduleDiscovery();
  }

  stop(): void {
    this.running = false;
    for (const t of [this.fastTimer, this.slowTimer, this.discoveryTimer]) if (t) clearTimeout(t);
    this.fastTimer = null;
    this.slowTimer = null;
    this.discoveryTimer = null;
  }

  private scheduleFast(): void {
    if (!this.running) return;
    this.fastTimer = this.runTier("fast", this.opts.onFastPoll, this.opts.fastMs, () => this.scheduleFast());
  }
  private scheduleSlow(): void {
    if (!this.running) return;
    this.slowTimer = this.runTier("slow", this.opts.onSlowPoll, this.opts.slowMs, () => this.scheduleSlow());
  }
  private scheduleDiscovery(): void {
    if (!this.running) return;
    this.discoveryTimer = this.runTier("discovery", this.opts.onDiscoveryDue, this.opts.discoveryMs, () => this.scheduleDiscovery());
  }

  private runTier(tier: PollTier, fn: () => Promise<void>, delayMs: number, reschedule: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      void fn()
        .catch((err) => this.opts.onError(tier, err))
        .finally(() => reschedule());
    }, delayMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    return timer;
  }
}

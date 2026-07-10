/**
 * Shared capped-exponential-backoff reconnect scheduler (§5 of the Universal AVR
 * Framework review) — used by every driver that owns a persistent socket and needs to
 * recover from a drop without hammering the device or leaving it silently stale. Mirrors
 * the backoff arithmetic already proven in the Casambi driver, factored out so
 * `AvrProtocolDriver` (extended for reconnect) and `HeosProtocolDriver` share one
 * implementation instead of three near-identical copies.
 *
 * The scheduler owns ONLY the timing; each driver supplies its own `reconnect()` (what
 * "reconnect" means — re-opening a TCP socket, re-authenticating, re-subscribing — is
 * entirely driver-specific and stays in the driver).
 */
export interface ReconnectSchedulerOptions {
  /** Attempt a fresh connection. Throwing schedules the next retry automatically. */
  reconnect: () => Promise<void>;
  /** Backoff floor in ms (default 2000). */
  baseMs?: number;
  /** Backoff ceiling in ms (default 60000). */
  maxMs?: number;
}

export class ReconnectScheduler {
  private readonly opts: ReconnectSchedulerOptions;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(opts: ReconnectSchedulerOptions) {
    this.opts = opts;
  }

  /** The connection dropped — schedule the next reconnect attempt (idempotent: a
   * reconnect already pending is left alone). */
  notifyDisconnected(): void {
    if (this.stopped || this.timer) return;
    this.scheduleNext();
  }

  /** A connection attempt just succeeded — clear backoff state. */
  reset(): void {
    this.attempts = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Permanently stop scheduling (driver is disconnecting for good). */
  stop(): void {
    this.stopped = true;
    this.reset();
  }

  /** Number of consecutive failed attempts since the last successful connect. */
  get attemptCount(): number {
    return this.attempts;
  }

  private scheduleNext(): void {
    const base = this.opts.baseMs ?? 2_000;
    const max = this.opts.maxMs ?? 60_000;
    const delay = Math.min(max, base * 2 ** Math.min(this.attempts, 10));
    this.attempts += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped) return;
      this.opts.reconnect().catch(() => {
        if (!this.stopped) this.scheduleNext();
      });
    }, delay);
    (this.timer as { unref?: () => void }).unref?.();
  }
}

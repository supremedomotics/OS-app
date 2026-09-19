/**
 * (§19 Reconnect/Self-Healing) Bounded exponential backoff with jitter — one instance per
 * `TvDeviceSession`. Deliberately NOT shared/coordinated across devices: with 100
 * independent schedulers all jittered independently, a mass network outage self-heals
 * without a synchronized retry storm (§19 "never create an uncontrolled retry storm"),
 * and one device's reconnect loop can never be slowed or sped up by another's.
 */
export interface TvReconnectOptions {
  backoffBaseMs: number;
  backoffMaxMs: number;
  attempt: () => Promise<void>;
}

export class TvReconnectScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attemptCount = 0;
  private stopped = true;

  constructor(private readonly opts: TvReconnectOptions) {}

  get attempts(): number {
    return this.attemptCount;
  }

  /** Call once a connection attempt has failed — schedules the next attempt and returns.
   * No-op if already scheduled or stopped. */
  scheduleNext(): void {
    if (this.stopped || this.timer) return;
    const delayMs = this.backoffMs(this.attemptCount);
    this.attemptCount += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.opts.attempt();
    }, delayMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /** Call on a successful connect — resets the backoff curve so a later drop starts fresh
   * rather than inheriting a long delay from a prior outage. */
  resetOnSuccess(): void {
    this.attemptCount = 0;
  }

  start(): void {
    this.stopped = false;
  }

  /** Cancels any pending attempt and prevents new ones — used on disconnect()/unbind() so
   * a device deliberately taken offline doesn't keep trying to reconnect in the
   * background (§20). Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private backoffMs(attempt: number): number {
    const exp = this.opts.backoffBaseMs * 2 ** attempt;
    const capped = Math.min(exp, this.opts.backoffMaxMs);
    // ±20% jitter so 100 devices dropped by the same outage don't all retry in lockstep.
    const jitter = capped * 0.2 * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(capped + jitter));
  }
}

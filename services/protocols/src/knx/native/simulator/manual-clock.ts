/**
 * SIMULATION INFRASTRUCTURE — deterministic clock for the virtual KNX bus. Results obtained
 * with it are simulated results, never hardware validation.
 */
import type { Clock, TimerHandle } from "../transport.js";

interface Timer { id: number; at: number; fn: () => void }

export class ManualClock implements Clock {
  private t = 0;
  private seq = 0;
  private readonly timers = new Map<number, Timer>();

  now(): number { return this.t; }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq;
    this.timers.set(id, { id, at: this.t + Math.max(0, ms), fn });
    return id as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle): void { this.timers.delete(handle as unknown as number); }

  /** Live timers — tests assert this returns to 0 after a session closes (leak check). */
  get pendingTimers(): number { return this.timers.size; }

  /** Lets promise continuations run between timer callbacks. */
  async flush(): Promise<void> { for (let i = 0; i < 8; i++) await Promise.resolve(); }

  /** Advances virtual time, firing due timers in (time, creation) order — including timers
   * scheduled by callbacks that fall inside the window. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      await this.flush();
      let next: Timer | null = null;
      for (const tm of this.timers.values()) {
        if (tm.at <= target && (next === null || tm.at < next.at || (tm.at === next.at && tm.id < next.id))) next = tm;
      }
      if (!next) break;
      this.t = Math.max(this.t, next.at);
      this.timers.delete(next.id);
      next.fn();
    }
    this.t = target;
    await this.flush();
  }
}

/**
 * Paced init-sync handshake (§ RTI Capability Audit, Category C.1/C.2) — a shared AV SDK
 * primitive reproducing a real, decade-tested pattern found in RTI's own Denon/Marantz
 * driver (`docs/architecture/RTI-Driver-Knowledge-Base.md`, Finding 3.1/4.1/5.1;
 * `docs/architecture/RTI-Capability-Audit.md`, C.1/C.2) — never copied from RTI's actual
 * code (which was never quoted anywhere in this codebase), only its *behavior*:
 *
 * On a fresh connect, a driver typically needs to send several `?`-suffixed status
 * queries to sync its initial state. The previous approach (still valid, still used by
 * every driver that hasn't opted into this primitive) writes them all in one burst. RTI's
 * driver instead sends one, waits for *any* line to come back from the receiver, then
 * sends the next — repeating until the queue is empty, at which point (and not before) it
 * considers itself genuinely synced, not just transport-connected. This is a real,
 * evidenced, low-risk robustness improvement: some receivers may not reliably process a
 * burst of back-to-back commands (the official Denon protocol PDF itself advises waiting
 * before a command that follows a power-on command, for exactly this reason).
 *
 * This primitive owns ONLY the queue-draining/readiness bookkeeping — it has no opinion
 * about sockets, line-buffering, or which tokens to send; a driver supplies those via
 * `start()`'s `write` callback and calls `onLineReceived()` from its own receive handler.
 */
export class InitHandshake {
  private queue: string[] = [];
  private ready = true;
  private write: ((token: string) => void) | null = null;
  private onReadyCb: (() => void) | null = null;

  /** Begin a new handshake, replacing any handshake already in progress. Sends the first
   * token immediately (via `write`); every subsequent token is sent one at a time from
   * `onLineReceived()`. `onReady` fires once the whole list has been drained — synchronously,
   * within this call, if `tokens` is empty. */
  start(tokens: string[], write: (token: string) => void, onReady: () => void): void {
    this.write = write;
    this.onReadyCb = onReady;
    this.queue = tokens.slice(1);
    this.ready = tokens.length === 0;
    if (tokens.length > 0) write(tokens[0]!);
    if (this.ready) onReady();
  }

  /** Call once per line received from the device while a handshake may be in progress.
   * A no-op once already ready (or if `start()` was never called) — cheap enough to call
   * unconditionally from a driver's normal receive-dispatch path, matching RTI's own
   * "any line advances the queue" behavior rather than trying to correlate which specific
   * query a given reply answers (Telnet has no per-command request id to do that with). */
  onLineReceived(): void {
    if (this.ready || !this.write) return;
    const next = this.queue.shift();
    if (next !== undefined) {
      this.write(next);
      return;
    }
    this.ready = true;
    this.onReadyCb?.();
  }

  /** True once the most recent `start()`'s token list has fully drained. */
  isReady(): boolean {
    return this.ready;
  }

  /** Abandon any in-progress handshake without firing `onReady` — used on disconnect, so a
   * stale queue from a dropped connection never resumes draining against a new one. */
  reset(): void {
    this.queue = [];
    this.ready = true;
    this.write = null;
    this.onReadyCb = null;
  }
}

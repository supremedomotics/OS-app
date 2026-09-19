/**
 * (§18 Command Architecture) Per-device FIFO command queue — one instance per
 * `TvDeviceSession`, never shared, so a slow/stuck command on one device can never block
 * another device's queue (§4 isolation). Same dedupe-by-key + priority shape as
 * coolmaster-polling.ts's CoolMasterCommandQueue, generified since a TV session has no
 * per-request wire response to thread back through the queue itself.
 *
 * Replay policy (§18/§19) is enforced by the CALLER (TvDeviceSession), not here: this
 * queue only ever holds commands for the device it belongs to, and it never persists
 * anything across a disconnect — a dropped connection simply lets in-flight/queued items
 * fail normally; TvDeviceSession decides what (if anything) to reissue on reconnect.
 */
export type TvCommandType = "state-setting" | "transient" | "idempotent";

interface QueuedItem {
  dedupeKey: string | null;
  priority: number;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export class TvCommandQueue {
  private readonly items: QueuedItem[] = [];
  private draining = false;
  private disposed = false;

  enqueue(run: () => Promise<void>, opts: { dedupeKey?: string | null; priority?: number } = {}): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("tv: command queue disposed"));
    const dedupeKey = opts.dedupeKey ?? null;
    const priority = opts.priority ?? 5;
    return new Promise((resolve, reject) => {
      if (dedupeKey) {
        const existingIdx = this.items.findIndex((i) => i.dedupeKey === dedupeKey);
        if (existingIdx >= 0) {
          // Superseded while still queued (not yet running) — the classic "state-setting"
          // coalescing case (§18): a dragged volume slider only ever sends its latest
          // value. An item already shifted off the queue and executing cannot be
          // cancelled this way (see coolmaster session's own documented nuance).
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

  /** Rejects everything still queued (not yet running) without touching whatever item is
   * currently mid-`run()` — used on unbind/disconnect so callers awaiting a now-pointless
   * command don't hang forever (§20 unbind must be idempotent and complete promptly). */
  clear(reason: string): void {
    const pending = this.items.splice(0, this.items.length);
    for (const item of pending) item.reject(new Error(`tv: command cancelled (${reason})`));
  }

  /** Permanently stops accepting new work — called from TvDeviceSession.dispose(). */
  dispose(): void {
    this.clear("session disposed");
    this.disposed = true;
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

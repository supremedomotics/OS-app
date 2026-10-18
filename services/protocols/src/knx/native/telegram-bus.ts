/**
 * Native telegram bus (§ Clean-room KNX stack — group communication, Stage 2). The one fan-out point between a tunnel and everything that
 * wants group telegrams (driver observers, a pending read, the health monitor). It knows nothing about sockets, sessions, DPTs or Supreme
 * capabilities: it moves {@link NativeTelegram}s to per-handle subscriptions and nothing else.
 *
 * Behaviour, stated explicitly (every item has a test in telegram-bus.test.ts):
 *   - DELIVERY is synchronous and in subscription order (same-tick, like the legacy wrapper), to a snapshot of the subscribers taken when the
 *     telegram is dequeued: a subscriber added during delivery does not see that telegram; one removed during delivery never sees it.
 *   - ISOLATION: a handler that throws (or returns a rejecting promise) is counted and skipped; other handlers and the tunnel are unaffected.
 *     The legacy wrapper lets one throwing handler abort delivery to the rest — that is deliberately not reproduced.
 *   - MALFORMED telegrams (out-of-range address, unknown service, a read with data, a write without) are counted and dropped, never delivered
 *     and never thrown at the tunnel.
 *   - BOUNDS: subscriptions are capped (subscribe throws {@link KnxBusError} `subscription_limit` — a leak must be loud); the only buffering is
 *     the re-entrancy queue (a handler that publishes while delivery is running), capped with drop-OLDEST so the newest state wins, and counted.
 *     There is no unbounded queue and no async hop, so there is no slow-consumer memory growth: a slow handler delays the tunnel's receive path
 *     rather than buffering behind it (bounded by the tunnel's own ACK/queue limits upstream).
 *   - LIFECYCLE: unsubscribe is per handle and idempotent; close() deactivates every handle, empties the queue and history, and is final —
 *     later subscribe() returns an inert handle and publish() is refused (counted). Link loss is NOT close(): subscriptions deliberately
 *     outlive any one tunnel so a reconnect never needs (or duplicates) re-subscription.
 */
import type { CemiFrame, GroupData, GroupService } from "./cemi.js";

export interface NativeTelegram {
  /** Raw 16-bit individual address of the sender — kept on every telegram so feedback can be attributed. */
  readonly source: number;
  /** Raw 16-bit group address. */
  readonly destination: number;
  readonly service: GroupService;
  /** `null` only for GroupValueRead. */
  readonly data: GroupData | null;
  /** Bus-local, strictly increasing from 1. */
  readonly seq: number;
  readonly receivedAt: number;
}

export type TelegramInput = Omit<NativeTelegram, "seq" | "receivedAt">;

export type PublishOutcome = "delivered" | "queued" | "malformed" | "closed";

export class KnxBusError extends Error {
  constructor(readonly code: "subscription_limit", message: string) {
    super(message);
    this.name = "KnxBusError";
  }
}

export interface TelegramBusOptions {
  clock?: { now(): number };
  /** Hard cap on live subscriptions (default 4096). */
  maxSubscriptions?: number;
  /** Cap on telegrams queued by handlers that publish during delivery (default 1024; drop-oldest). */
  maxReentrantQueue?: number;
  /** Ring of the most recent telegrams for diagnostics; 0 disables (default 128). */
  historyLimit?: number;
}

export interface SubscribeOptions {
  /** Raw group address to match; omit for every group address. */
  destination?: number;
  /** Services to receive; omit for all. */
  services?: readonly GroupService[];
  label?: string;
}

export interface TelegramSubscription {
  readonly id: number;
  readonly active: boolean;
  unsubscribe(): void;
}

export interface TelegramBusStats {
  published: number;
  /** Handler invocations that started (including ones that then threw). */
  deliveries: number;
  malformed: number;
  listenerErrors: number;
  overflowDropped: number;
  refusedAfterClose: number;
  activeSubscriptions: number;
  closed: boolean;
  lastListenerError: string | null;
}

type Handler = (t: NativeTelegram) => unknown;

interface Sub {
  id: number;
  destination: number | null;
  services: ReadonlySet<GroupService> | null;
  handler: Handler;
  active: boolean;
}

const SERVICES: ReadonlySet<string> = new Set(["read", "response", "write"]);
const isAddr = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 0xffff;

function wellFormed(i: TelegramInput): boolean {
  if (typeof i !== "object" || i === null) return false;
  if (!isAddr(i.source) || !isAddr(i.destination) || !SERVICES.has(i.service)) return false;
  const d = i.data;
  if (i.service === "read") return d === null;
  if (d === null || typeof d !== "object") return false;
  if (d.kind === "short") return Number.isInteger(d.value) && d.value >= 0 && d.value <= 0x3f;
  return d.kind === "bytes" && Buffer.isBuffer(d.bytes) && d.bytes.length >= 1 && d.bytes.length <= 14;
}

/** The group-addressed telegram carried by a tunnel indication, or `null` for anything else (individually addressed, undecoded APCI). */
export function telegramFromCemi(f: CemiFrame): TelegramInput | null {
  if (!f.destinationIsGroup || !f.group) return null;
  return { source: f.source, destination: f.destination, service: f.group.service, data: f.group.data };
}

export class NativeTelegramBus {
  private readonly byDestination = new Map<number, Sub[]>();
  private readonly wildcards: Sub[] = [];
  private readonly queue: NativeTelegram[] = [];
  private readonly ring: NativeTelegram[] = [];
  private readonly clock: { now(): number };
  private readonly maxSubs: number;
  private readonly maxQueue: number;
  private readonly historyLimit: number;
  private nextId = 0;
  private seq = 0;
  private live = 0;
  private draining = false;
  private closed = false;
  private readonly counters = { published: 0, deliveries: 0, malformed: 0, listenerErrors: 0, overflowDropped: 0, refusedAfterClose: 0 };
  private lastError: string | null = null;

  constructor(opts: TelegramBusOptions = {}) {
    this.clock = opts.clock ?? { now: () => Date.now() };
    this.maxSubs = opts.maxSubscriptions ?? 4096;
    this.maxQueue = opts.maxReentrantQueue ?? 1024;
    this.historyLimit = opts.historyLimit ?? 128;
  }

  subscribe(handler: Handler, opts: SubscribeOptions = {}): TelegramSubscription {
    const inert: TelegramSubscription = { id: -1, active: false, unsubscribe: () => undefined };
    if (this.closed) return inert;
    if (this.live >= this.maxSubs) throw new KnxBusError("subscription_limit", `telegram bus already holds ${this.maxSubs} subscriptions`);
    const dest = opts.destination ?? null;
    if (dest !== null && !isAddr(dest)) throw new RangeError(`group address ${String(dest)} is not a 16-bit address`);
    const sub: Sub = { id: ++this.nextId, destination: dest, services: opts.services ? new Set(opts.services) : null, handler, active: true };
    if (dest === null) this.wildcards.push(sub);
    else { const l = this.byDestination.get(dest); if (l) l.push(sub); else this.byDestination.set(dest, [sub]); }
    this.live++;
    const bus = this;
    return {
      id: sub.id,
      get active() { return sub.active; },
      unsubscribe() { bus.remove(sub); },
    };
  }

  /** Feeds one telegram. Never throws. */
  publish(input: TelegramInput): PublishOutcome {
    if (this.closed) { this.counters.refusedAfterClose++; return "closed"; }
    if (!wellFormed(input)) { this.counters.malformed++; return "malformed"; }
    const t: NativeTelegram = { source: input.source, destination: input.destination, service: input.service, data: input.data, seq: ++this.seq, receivedAt: this.clock.now() };
    this.counters.published++;
    if (this.historyLimit > 0) { this.ring.push(t); if (this.ring.length > this.historyLimit) this.ring.shift(); }
    if (this.draining) {
      if (this.queue.length >= this.maxQueue) { this.queue.shift(); this.counters.overflowDropped++; }
      this.queue.push(t);
      return "queued";
    }
    this.draining = true;
    try {
      this.deliver(t);
      while (!this.closed) { const next = this.queue.shift(); if (!next) break; this.deliver(next); }
    } finally { this.draining = false; }
    return "delivered";
  }

  /** The most recent telegrams, oldest first (bounded by `historyLimit`). */
  recent(): readonly NativeTelegram[] { return [...this.ring]; }

  stats(): TelegramBusStats {
    return { ...this.counters, activeSubscriptions: this.live, closed: this.closed, lastListenerError: this.lastError };
  }

  /** Final. Deactivates every handle; idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of [...this.byDestination.values(), this.wildcards]) for (const s of l) s.active = false;
    this.byDestination.clear();
    this.wildcards.length = 0;
    this.queue.length = 0;
    this.ring.length = 0;
    this.live = 0;
  }

  // ---------------------------------------------------------------------------------------------------------------------------------

  private remove(sub: Sub): void {
    if (!sub.active) return;
    sub.active = false;
    this.live--;
    const list = sub.destination === null ? this.wildcards : this.byDestination.get(sub.destination);
    if (!list) return;
    const i = list.indexOf(sub);
    if (i >= 0) list.splice(i, 1);
    if (sub.destination !== null && list.length === 0) this.byDestination.delete(sub.destination);
  }

  private deliver(t: NativeTelegram): void {
    const specific = this.byDestination.get(t.destination);
    let targets: Sub[];
    if (!specific) targets = this.wildcards.length ? this.wildcards.slice() : [];
    else if (!this.wildcards.length) targets = specific.slice();
    else targets = [...specific, ...this.wildcards].sort((a, b) => a.id - b.id);
    for (const s of targets) {
      if (!s.active) continue; // unsubscribed (or bus closed) by an earlier handler in this same delivery
      if (s.services && !s.services.has(t.service)) continue;
      this.counters.deliveries++;
      try {
        const r = s.handler(t);
        if (r !== null && typeof r === "object" && typeof (r as PromiseLike<unknown>).then === "function") {
          (r as PromiseLike<unknown>).then(undefined, (e: unknown) => this.noteError(e));
        }
      } catch (e) { this.noteError(e); }
    }
  }

  private noteError(e: unknown): void {
    this.counters.listenerErrors++;
    this.lastError = e instanceof Error ? e.message : String(e);
  }
}

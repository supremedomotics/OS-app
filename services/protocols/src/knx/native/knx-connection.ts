/**
 * NativeKnxConnection (§ Clean-room KNX stack — Stage 3): the production driver's four-method {@link KnxConnection} seam implemented on the
 * native tunnel client, telegram bus and DPT codec instead of `knxultimate`. It is NOT registered anywhere (no factory, no flag); a caller has
 * to construct it explicitly, e.g. as `KnxProtocolDriver({ createConnection })` in a test or a shadow rig. The driver is untouched.
 *
 * Contract and the deliberate differences from the legacy wrapper (each is asserted in simulator/knx-connection.contract.ts / knx-connection.test.ts):
 *   - connect(): the FIRST attempt is the caller's (rejects with the real error, leaves nothing behind); afterwards {@link SupervisedTunnel}
 *     owns reconnection with the existing ConnectionManager. See docs/knx/knx-reconnect-ownership.md.
 *   - write(): resolves when the gateway ACKed the frame (UDP) / the secure session accepted it — TRANSPORT ACCEPTANCE ONLY. It never means a
 *     device executed anything and never produces an observed state; only a status telegram does (the driver already enforces this).
 *     Rejects `outcome: "not_sent"` when provably nothing was transmitted, `"unknown"` otherwise (it may still reach the bus). The legacy
 *     wrapper is fire-and-forget and cannot report either. `writeDetailed()` also returns the L_Data.con confirmation promise.
 *   - observe(): subscriptions live on the bus, not on a tunnel, so they survive reconnects without re-subscribing and never duplicate. Values
 *     are decoded per DPT; a payload that fails strict decoding (wrong size, reserved bits, the 0x7FFF invalid marker) is counted and NOT
 *     delivered, so the previous good state stays (legacy: 0x7FFF reaches the handler as 670760.96). Handler exceptions are isolated. An
 *     invalid group address or unsupported DPT yields an inert subscription that is recorded in diagnostics (legacy: silently never matches) —
 *     it must not throw, because the driver subscribes inside connect()/bind() and one bad binding would otherwise break the whole driver.
 *   - disconnect() is final: observers, pending reads and the supervisor are released synchronously-or-bounded and nothing fires afterwards.
 *     (Legacy leaves its observers registered on the dead client.) A driver builds a new connection per connect(), so no reuse is needed.
 *   - Beyond the contract (not called by the driver): observeTelegrams() adds the sender and service to each value; read() sends a
 *     GroupValueRead and correlates only a GroupValueResponse on that address.
 * `mode: "observe_only"` makes write()/read() reject before any frame is built — the enforcement point the shadow-mode design relies on.
 */
import type { KnxConnection } from "../../knx-driver.js";
import type { KnxValue } from "../../knx-codec.js";
import { parseGroupAddress } from "./address.js";
import { decodeDpt, encodeDpt, isSupportedDpt, KnxDptError } from "./dpt.js";
import { NativeTelegramBus, type TelegramBusOptions, type TelegramBusStats } from "./telegram-bus.js";
import { SupervisedTunnel, type LinkEvent, type LinkState, type SupervisedTunnelDiagnostics } from "./supervised-tunnel.js";
import { KnxTunnelError, type ConfirmationOutcome, type KnxTunnelClient, type TunnelErrorCode } from "./tunnel-client.js";
import { systemClock, type Clock, type TimerHandle } from "./transport.js";

export type ConnectionErrorCode = "invalid_address" | "invalid_dpt" | "invalid_value" | "observe_only" | "not_connected" | "closed" | "read_limit" | "tunnel";

/** `not_sent`: provably nothing was transmitted. `unknown`: a frame may have reached the bus — never retry blindly, never assume it failed. */
export type SendOutcome = "not_sent" | "unknown";

export class KnxConnectionError extends Error {
  constructor(readonly code: ConnectionErrorCode, readonly outcome: SendOutcome, message: string, readonly tunnelCode?: TunnelErrorCode) {
    super(message);
    this.name = "KnxConnectionError";
  }
}

export interface FeedbackMeta {
  /** Raw 16-bit individual address of the device that sent the telegram. */
  source: number;
  service: "write" | "response";
  seq: number;
  receivedAt: number;
}

export interface NativeWriteResult {
  /** The only thing a resolved write proves. */
  evidence: "transport_accepted";
  transportAck: "ack" | "none";
  attempts: number;
  ackLatencyMs: number | null;
  sequence: number;
  /** Never rejects. `confirmed` = the interface reports the frame left on the KNX line; `not_confirmed` = UNKNOWN. Neither says a device acted. */
  confirmation: Promise<ConfirmationOutcome>;
}

export type NativeReadResult =
  | { outcome: "value"; value: KnxValue; source: number; seq: number; receivedAt: number }
  /** No GroupValueResponse arrived in time. The device may still answer later (that response reaches ordinary observers) — this is not "offline". */
  | { outcome: "timeout" }
  | { outcome: "cancelled"; reason: "aborted" | "disconnected" };

export interface NativeKnxConnectionOptions {
  /** Builds a NEW, not yet connected tunnel for every attempt (the tunnel client is single-use). */
  createTunnel: () => KnxTunnelClient;
  clock?: Clock;
  mode?: "active" | "observe_only";
  reconnect?: { minBackoffMs?: number; maxBackoffMs?: number; random?: () => number };
  bus?: Omit<TelegramBusOptions, "clock">;
  /** Default read() budget (3 s). */
  readTimeoutMs?: number;
  /** Concurrent read() cap (64). */
  maxPendingReads?: number;
  /**
   * Called on EVERY link-up (first connect and each recovery) with the live tunnel and the bus; the returned cleanup runs on the matching
   * link-down or on disconnect(), exactly once. This is how a health monitor attaches without owning a second tunnel and without outliving
   * the link it was started for.
   */
  onLinkUp?: (ctx: { tunnel: KnxTunnelClient; bus: NativeTelegramBus }) => void | (() => void);
}

export interface NativeConnectionDiagnostics {
  mode: "active" | "observe_only";
  link: SupervisedTunnelDiagnostics;
  bus: TelegramBusStats;
  writes: { attempted: number; accepted: number; notSent: number; unknown: number };
  reads: { attempted: number; answered: number; timedOut: number; cancelled: number; pending: number };
  /** Telegrams whose payload failed strict DPT decoding for an observer/read, by error code. */
  decodeFailures: Record<string, number>;
  rejectedObservers: number;
  /** The most recent rejected observer registrations (bounded, newest last). */
  lastRejectedObservers: Array<{ groupAddress: string; dpt: string; reason: string }>;
  hookErrors: number;
}

const bump = (m: Record<string, number>, k: string): void => { m[k] = (m[k] ?? 0) + 1; };
const NOT_SENT_TUNNEL_CODES: ReadonlySet<TunnelErrorCode> = new Set(["invalid_argument", "not_connected", "queue_full"]);

export class NativeKnxConnection implements KnxConnection {
  readonly bus: NativeTelegramBus;
  private readonly link: SupervisedTunnel;
  private readonly clock: Clock;
  private readonly mode: "active" | "observe_only";
  private readonly readTimeoutMs: number;
  private readonly maxPendingReads: number;
  private readonly pendingReads = new Set<{ cancel(reason: "aborted" | "disconnected"): void }>();
  private disconnecting: Promise<void> | null = null;
  private hookCleanup: (() => void) | null = null;
  private readonly writes = { attempted: 0, accepted: 0, notSent: 0, unknown: 0 };
  private readonly reads = { attempted: 0, answered: 0, timedOut: 0, cancelled: 0 };
  private readonly decodeFailures: Record<string, number> = {};
  private rejected = 0;
  private readonly lastRejected: Array<{ groupAddress: string; dpt: string; reason: string }> = [];
  private hookErrors = 0;

  constructor(private readonly o: NativeKnxConnectionOptions) {
    this.clock = o.clock ?? systemClock;
    this.mode = o.mode ?? "active";
    this.readTimeoutMs = o.readTimeoutMs ?? 3_000;
    this.maxPendingReads = o.maxPendingReads ?? 64;
    this.bus = new NativeTelegramBus({ ...o.bus, clock: this.clock });
    this.link = new SupervisedTunnel({ clock: this.clock, createTunnel: o.createTunnel, bus: this.bus, ...(o.reconnect ? { reconnect: o.reconnect } : {}) });
    this.link.onLinkChange((e) => this.onLink(e));
  }

  get linkState(): LinkState { return this.link.link; }

  onLinkChange(l: (e: LinkEvent) => void): () => void { return this.link.onLinkChange(l); }

  async connect(): Promise<void> { await this.link.connect(); }

  async disconnect(): Promise<void> {
    if (this.disconnecting) return this.disconnecting;
    this.disconnecting = (async () => {
      for (const r of [...this.pendingReads]) r.cancel("disconnected");
      this.bus.close();            // stop deliveries first: nothing observable may happen after this point
      await this.link.disconnect(); // cancels the reconnect timer / in-flight attempt, closes the tunnel, runs the link-down hook cleanup
    })();
    return this.disconnecting;
  }

  // ------------------------------------------------------------------------------------------------------------------ writes

  async write(groupAddress: string, value: KnxValue, dpt: string): Promise<void> {
    await this.writeDetailed(groupAddress, value, dpt);
  }

  async writeDetailed(groupAddress: string, value: KnxValue, dpt: string): Promise<NativeWriteResult> {
    this.writes.attempted++;
    try {
      this.assertActive("write");
      const destination = this.parseGa(groupAddress);
      const data = this.encode(dpt, value);
      const r = await this.link.send({ destination, service: "write", data });
      this.writes.accepted++;
      return { evidence: "transport_accepted", transportAck: r.transportAck, attempts: r.attempts, ackLatencyMs: r.ackLatencyMs, sequence: r.sequence, confirmation: r.confirmation };
    } catch (e) {
      const err = this.asConnectionError(e);
      if (err.outcome === "not_sent") this.writes.notSent++; else this.writes.unknown++;
      throw err;
    }
  }

  // ------------------------------------------------------------------------------------------------------------------ reads

  /** Sends a GroupValueRead and resolves with the first GroupValueResponse on that address (the only correlation KNX offers is the address). */
  async read(groupAddress: string, dpt: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<NativeReadResult> {
    this.reads.attempted++;
    this.assertActive("read");
    const destination = this.parseGa(groupAddress);
    if (!isSupportedDpt(dpt)) throw new KnxConnectionError("invalid_dpt", "not_sent", `unsupported datapoint type "${dpt}"`);
    if (this.pendingReads.size >= this.maxPendingReads) throw new KnxConnectionError("read_limit", "not_sent", `${this.maxPendingReads} reads already pending`);
    if (opts.signal?.aborted) { this.reads.cancelled++; return { outcome: "cancelled", reason: "aborted" }; }
    return new Promise<NativeReadResult>((resolve, reject) => {
      let done = false;
      let timer: TimerHandle | null = null;
      const entry = { cancel: (reason: "aborted" | "disconnected") => settle({ outcome: "cancelled", reason }) };
      const onAbort = (): void => entry.cancel("aborted");
      const sub = this.bus.subscribe((t) => {
        let value: KnxValue;
        try { value = decodeDpt(dpt, t.data!); } catch (e) { this.noteDecodeFailure(e); return; } // a malformed response is not an answer; keep waiting
        settle({ outcome: "value", value, source: t.source, seq: t.seq, receivedAt: t.receivedAt });
      }, { destination, services: ["response"] });
      const settle = (r: NativeReadResult | Error): void => {
        if (done) return;
        done = true;
        if (timer) this.clock.clearTimeout(timer);
        sub.unsubscribe();
        opts.signal?.removeEventListener("abort", onAbort);
        this.pendingReads.delete(entry);
        if (r instanceof Error) { reject(r); return; }
        if (r.outcome === "value") this.reads.answered++; else if (r.outcome === "timeout") this.reads.timedOut++; else this.reads.cancelled++;
        resolve(r);
      };
      this.pendingReads.add(entry);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      timer = this.clock.setTimeout(() => settle({ outcome: "timeout" }), opts.timeoutMs ?? this.readTimeoutMs);
      // Subscribed before sending, so a response can never slip between the send and the subscription.
      this.link.send({ destination, service: "read" }).then(() => undefined, (e) => settle(this.asConnectionError(e)));
    });
  }

  // ------------------------------------------------------------------------------------------------------------------ observers

  observe(groupAddress: string, dpt: string, handler: (value: KnxValue) => void): () => void {
    return this.observeTelegrams(groupAddress, dpt, handler);
  }

  /** Like {@link observe} but also passes the sender and service, for attribution. Receives writes and responses, never reads. */
  observeTelegrams(groupAddress: string, dpt: string, handler: (value: KnxValue, meta: FeedbackMeta) => void): () => void {
    let destination: number;
    try {
      destination = parseGroupAddress(groupAddress);
      if (!isSupportedDpt(dpt)) throw new KnxDptError("unsupported_dpt", `unsupported datapoint type "${dpt}"`);
    } catch (e) {
      this.rejected++;
      this.lastRejected.push({ groupAddress, dpt, reason: e instanceof Error ? e.message : String(e) });
      if (this.lastRejected.length > 8) this.lastRejected.shift();
      return () => undefined;
    }
    const sub = this.bus.subscribe((t) => {
      let value: KnxValue;
      try { value = decodeDpt(dpt, t.data!); } catch (e) { this.noteDecodeFailure(e); return; }
      handler(value, { source: t.source, service: t.service as "write" | "response", seq: t.seq, receivedAt: t.receivedAt });
    }, { destination, services: ["write", "response"] });
    return () => sub.unsubscribe();
  }

  diagnostics(): NativeConnectionDiagnostics {
    return {
      mode: this.mode, link: this.link.diagnostics(), bus: this.bus.stats(), writes: { ...this.writes },
      reads: { ...this.reads, pending: this.pendingReads.size }, decodeFailures: { ...this.decodeFailures },
      rejectedObservers: this.rejected, lastRejectedObservers: [...this.lastRejected], hookErrors: this.hookErrors,
    };
  }

  // ------------------------------------------------------------------------------------------------------------------ internals

  private onLink(e: LinkEvent): void {
    if (e.state === "up" && e.tunnel && this.o.onLinkUp) {
      this.runCleanup(); // defensive: never two live attachments
      try { const c = this.o.onLinkUp({ tunnel: e.tunnel, bus: this.bus }); this.hookCleanup = typeof c === "function" ? c : null; } catch { this.hookErrors++; }
    } else if (e.state === "down") this.runCleanup();
  }

  private runCleanup(): void {
    const c = this.hookCleanup;
    this.hookCleanup = null;
    if (!c) return;
    try { c(); } catch { this.hookErrors++; }
  }

  private assertActive(op: "write" | "read"): void {
    if (this.mode === "observe_only") throw new KnxConnectionError("observe_only", "not_sent", `${op} refused: this connection is observe-only`);
    if (this.disconnecting) throw new KnxConnectionError("closed", "not_sent", `${op} refused: connection was disconnected`);
  }

  private parseGa(text: string): number {
    try { return parseGroupAddress(text); } catch (e) {
      throw new KnxConnectionError("invalid_address", "not_sent", e instanceof Error ? e.message : String(e));
    }
  }

  private encode(dpt: string, value: KnxValue): ReturnType<typeof encodeDpt> {
    try { return encodeDpt(dpt, value); } catch (e) {
      if (e instanceof KnxDptError) throw new KnxConnectionError(e.code === "unsupported_dpt" ? "invalid_dpt" : "invalid_value", "not_sent", e.message);
      throw e;
    }
  }

  private asConnectionError(e: unknown): KnxConnectionError {
    if (e instanceof KnxConnectionError) return e;
    if (e instanceof KnxTunnelError) {
      const sent: SendOutcome = NOT_SENT_TUNNEL_CODES.has(e.code) ? "not_sent" : "unknown"; // anything after a frame may have gone out is "unknown", never "failed"
      return new KnxConnectionError(e.code === "not_connected" ? "not_connected" : "tunnel", sent, e.message, e.code);
    }
    return new KnxConnectionError("tunnel", "unknown", e instanceof Error ? e.message : String(e));
  }

  private noteDecodeFailure(e: unknown): void {
    bump(this.decodeFailures, e instanceof KnxDptError ? e.code : "unexpected");
  }
}

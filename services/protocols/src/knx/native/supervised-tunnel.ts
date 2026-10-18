/**
 * Supervised native tunnel (§ Clean-room KNX stack — reconnect ownership, Stage 1). The single owner of "is there a live tunnel, and if it
 * dies, who brings it back" for one native KNX connection. See docs/knx/knx-reconnect-ownership.md for the system-wide decision; the rules
 * enforced here:
 *
 *   1. ONE supervisor per instance: the existing {@link ConnectionManager} (exponential backoff, ±10% jitter, one reconnect timer at a time).
 *   2. HAND-OFF, never overlap. The FIRST attempt is the caller's (`connect()` rejects with the real error, exactly as the legacy wrapper does,
 *      so the gateway's 60 s `reconcileDriverConnectivity()` retry keeps working unchanged). A failed first attempt leaves NOTHING running — no
 *      timer, socket or listener — so that retry can never compete with a hidden loop. Only after the first attempt succeeds does the
 *      ConnectionManager take over, and from then on it alone reconnects an established link.
 *   3. ONE tunnel at a time: every attempt builds a fresh single-use {@link KnxTunnelClient}; the previous one is detached before the next is
 *      attached, and an attempt that finishes after cancellation disconnects the tunnel it just opened instead of attaching it.
 *   4. ONE telegram feed per tunnel, attached on link-up and detached on link-down, into a bus that outlives tunnels — so a reconnect can
 *      neither duplicate nor lose subscriptions.
 *   5. disconnect() is final and idempotent. It cancels everything the CALLER can observe immediately — the reconnect timer, the first
 *      connect() promise (rejected `closed`), pending sends, the feed — and closes the attached tunnel orderly. A handshake that is already in
 *      flight is deliberately NOT aborted: the client has not yet learned its channel id, so aborting would leave an orphan channel on the
 *      gateway until its ~120 s idle timeout (a single-slot gateway then refuses the next connect with "no more connections"). It is allowed to
 *      finish, and its tunnel is then discarded with an orderly DISCONNECT instead of being attached. That tail is bounded by the tunnel's own
 *      connect timeout and only ever closes; it never attaches, subscribes, or schedules anything.
 */
import { ConnectionManager, type ConnectionManagerMetrics } from "../connection-manager.js";
import { telegramFromCemi, type NativeTelegramBus } from "./telegram-bus.js";
import { KnxTunnelClient, KnxTunnelError, type SendInput, type SendReceipt } from "./tunnel-client.js";
import type { Clock } from "./transport.js";

export type LinkState = "idle" | "connecting" | "up" | "recovering" | "closed";

export interface LinkEvent {
  state: "up" | "down";
  /** For "down": the tunnel's close reason, or "local_disconnect". */
  reason?: string;
  tunnel?: KnxTunnelClient;
}

export interface SupervisedTunnelOptions {
  clock: Clock;
  /** Builds a NEW, not yet connected tunnel client for every attempt. */
  createTunnel: () => KnxTunnelClient;
  /** Receives every group telegram of whichever tunnel is currently attached. */
  bus: NativeTelegramBus;
  reconnect?: { minBackoffMs?: number; maxBackoffMs?: number; random?: () => number };
}

export interface SupervisedTunnelDiagnostics {
  link: LinkState;
  supervisor: ConnectionManagerMetrics;
  tunnelsCreated: number;
  attachedTunnels: 0 | 1;
  attemptInFlight: boolean;
  /** Individually addressed / undecoded frames the tunnel delivered that carry no group telegram. */
  ignoredFrames: number;
}

export class SupervisedTunnel {
  private readonly manager: ConnectionManager;
  private tunnel: KnxTunnelClient | null = null;
  private candidate: KnxTunnelClient | null = null;
  private detachers: Array<() => void> = [];
  private initial: Promise<void> | null = null;
  private cancelInitial: ((e: Error) => void) | null = null;
  private established = false;
  private closed = false;
  private closing: Promise<void> | null = null;
  private tunnelsCreated = 0;
  private ignoredFrames = 0;
  private readonly listeners = new Set<(e: LinkEvent) => void>();

  constructor(private readonly o: SupervisedTunnelOptions) {
    this.manager = new ConnectionManager({
      connect: () => this.attempt(),
      disconnect: () => this.teardown("local_disconnect"),
      clock: o.clock,
      minBackoffMs: o.reconnect?.minBackoffMs ?? 2_000,
      maxBackoffMs: o.reconnect?.maxBackoffMs ?? 60_000,
      ...(o.reconnect?.random ? { random: o.reconnect.random } : {}),
    });
  }

  get link(): LinkState {
    if (this.closed) return "closed";
    if (this.tunnel) return "up";
    if (this.established) return "recovering";
    return this.initial ? "connecting" : "idle";
  }

  /** The attached tunnel, or `null` while the link is down. Do not retain it across awaits. */
  get currentTunnel(): KnxTunnelClient | null { return this.tunnel; }

  onLinkChange(l: (e: LinkEvent) => void): () => void { this.listeners.add(l); return () => { this.listeners.delete(l); }; }

  /**
   * The first connection attempt. Rejects with the underlying error and leaves nothing behind, so the caller may simply call it again later.
   * No-op once established (recovery is the supervisor's); concurrent calls share one attempt; rejects after {@link disconnect}.
   */
  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new KnxTunnelError("closed", "connection was disconnected; create a new one"));
    if (this.established) return Promise.resolve();
    if (this.initial) return this.initial;
    const run = (async () => {
      await this.attempt();
      if (this.closed) throw new KnxTunnelError("closed", "disconnected during connect"); // e.g. a link listener disconnected inside the "up" event
      this.established = true;
      this.manager.markConnected(); // from here on the ConnectionManager owns reconnection
    })();
    // The caller's promise can be cancelled at once (disconnect()) while `run` finishes in the background and discards its tunnel.
    const p = new Promise<void>((resolve, reject) => { this.cancelInitial = reject; run.then(resolve, reject); });
    this.initial = p;
    const clear = (): void => { if (this.initial === p) { this.initial = null; this.cancelInitial = null; } };
    p.then(clear, clear);
    run.catch(() => undefined); // a cancelled caller no longer observes `run`; never leave its rejection unhandled
    return p;
  }

  /** Queues one group telegram on the current tunnel; rejects `not_connected` while the link is down (no buffering across outages). */
  send(input: SendInput): Promise<SendReceipt> {
    const t = this.tunnel;
    if (!t) return Promise.reject(new KnxTunnelError("not_connected", `tunnel link is ${this.link}`));
    return t.sendGroup(input);
  }

  /** Final and idempotent. Resolves once the tunnel is closed (bounded by the tunnel's own disconnect timeout). */
  disconnect(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.candidate = null;            // marks any in-flight attempt as cancelled: attempt() discards its tunnel when the handshake ends
    this.cancelInitial?.(new KnxTunnelError("closed", "disconnected during connect"));
    this.closing = (async () => {
      await this.manager.stop(); // clears the reconnect timer; never starts another attempt
      await this.teardown("local_disconnect");
    })();
    return this.closing;
  }

  diagnostics(): SupervisedTunnelDiagnostics {
    return {
      link: this.link, supervisor: this.manager.metrics(), tunnelsCreated: this.tunnelsCreated, attachedTunnels: this.tunnel ? 1 : 0,
      attemptInFlight: this.candidate !== null, ignoredFrames: this.ignoredFrames,
    };
  }

  // ------------------------------------------------------------------------------------------------------------------ internals

  private async attempt(): Promise<void> {
    if (this.closed) throw new KnxTunnelError("closed", "disconnected");
    if (this.tunnel) await this.teardown("superseded"); // never two attachments, whatever happened before
    if (this.closed) throw new KnxTunnelError("closed", "disconnected");
    const t = this.o.createTunnel();
    this.tunnelsCreated++;
    this.candidate = t;
    try { await t.connect(); } catch (e) {
      if (this.candidate === t) this.candidate = null;
      void t.disconnect(); // already closed after a failed connect; a no-op that also covers a tunnel left half-open
      throw e;
    }
    // Cancelled while the handshake was running: close the tunnel orderly and RETURN (not throw) — the ConnectionManager then treats it as "stop() ran
    // during connect" instead of recording a failed reconnect; the first-connect path rejects its caller itself (see connect()).
    if (this.candidate !== t || this.closed) { void t.disconnect(); return; }
    this.candidate = null;
    if (t.state !== "connected") throw new KnxTunnelError("closed", "tunnel closed during connect"); // closed between the handshake and attach: no listener could have seen it
    this.tunnel = t;
    this.detachers.push(t.onTelegram((f) => {
      const tg = telegramFromCemi(f);
      if (!tg) { this.ignoredFrames++; return; }
      this.o.bus.publish(tg);
    }));
    this.detachers.push(t.onClosed((e) => this.onTunnelClosed(t, e.reason)));
    this.emit({ state: "up", tunnel: t });
  }

  private onTunnelClosed(t: KnxTunnelClient, reason: string): void {
    if (t !== this.tunnel) return; // a stale tunnel's late event
    this.detach();
    this.emit({ state: "down", reason, tunnel: t });
    if (!this.closed) this.manager.reportDisconnected(reason);
  }

  /** Detaches and closes the current tunnel (if any). Idempotent. */
  private async teardown(reason: string): Promise<void> {
    const t = this.tunnel;
    this.detach();
    if (!t) return;
    this.emit({ state: "down", reason, tunnel: t });
    await t.disconnect();
  }

  private detach(): void {
    for (const d of this.detachers.splice(0)) d();
    this.tunnel = null;
  }

  private emit(e: LinkEvent): void {
    for (const l of [...this.listeners]) { try { l(e); } catch { /* a link listener must never break supervision */ } }
  }
}

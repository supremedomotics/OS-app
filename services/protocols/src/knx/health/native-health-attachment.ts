/**
 * Health monitoring on the connection's OWN tunnel (§ Supreme KNX Health — ownership). {@link KnxHealthService} owns a second, private tunnel and
 * stays a standalone/simulator composition; the production-shaped path is this attachment: it opens NO tunnel, supervises nothing and reconnects
 * nothing. It plugs into {@link NativeKnxConnection}'s `onLinkUp` hook and so lives exactly as long as a link does.
 *
 * OWNERSHIP (one owner per thing, so a reconnect can neither duplicate nor orphan any of it):
 *   - the TUNNEL and its reconnects: the connection's SupervisedTunnel (never touched here — the hook's raw `tunnel` is deliberately ignored);
 *   - the TELEGRAM SUBSCRIPTION: this attachment, one wildcard subscription on the connection's bus, created in the hook and removed by the cleanup
 *     the hook returns (the connection runs it on every link-down and on disconnect, exactly once, before the next link-up);
 *   - the MONITOR instance, its evidence and its per-minute check budget: this attachment, for its whole life (they survive outages);
 *   - the monitor's tick/wait TIMERS: the monitor; started on link-up (idempotent — one loop) and stopped by the cleanup;
 *   - the READ BUDGET: the connection — probes go through `ctx.reads`, the same {@link ReadBudget} state synchronisation draws on.
 * READ-ONLY: the monitor's only outbound dependency is `ReadOnlyGroupBus`; here it is bound to `ctx.reads`, which has no write method, and is
 * refused entirely on an observe-only connection. Not wired into any production path.
 */
import type { NativeKnxConnectionOptions, ReadOnlyBusPort } from "../native/knx-connection.js";
import type { TelegramSubscription } from "../native/telegram-bus.js";
import type { Clock } from "../native/transport.js";
import type { HealthConfig } from "./health-model.js";
import { KnxHealthMonitor, type ReadOnlyGroupBus } from "./health-monitor.js";

export interface NativeHealthAttachmentDiagnostics {
  /** True between a link-up and the matching link-down. */
  attached: boolean;
  linkUps: number;
  linkDowns: number;
  /** Live bus subscriptions owned by this attachment (0 or 1). */
  subscriptions: 0 | 1;
  monitorRunning: boolean;
  /** Probe reads refused before reaching the bus (no link, observe-only, or the shared budget). */
  readsRefused: number;
}

export class NativeKnxHealthAttachment {
  readonly monitor: KnxHealthMonitor;
  private reads: ReadOnlyBusPort | null = null;
  private sub: TelegramSubscription | null = null;
  /** Identity of the link-up the current subscription belongs to: a stale cleanup (an older link, or another connection) must not tear down a newer one. */
  private token: object | null = null;
  private disposed = false;
  private linkUps = 0;
  private linkDowns = 0;
  private refused = 0;

  constructor(o: { clock: Clock; health?: Partial<HealthConfig> }) {
    const bus: ReadOnlyGroupBus = {
      readGroup: async (destination) => {
        const port = this.reads;
        if (!port) { this.refused++; throw new Error("no link"); }
        try {
          const r = await port.readGroup(destination);
          void r.confirmation.then((outcome) => this.monitor.noteSendOutcome(outcome));
        } catch (e) { this.refused++; throw e; }
      },
    };
    this.monitor = new KnxHealthMonitor(o.clock, bus, o.health);
  }

  /** Pass as `NativeKnxConnectionOptions.onLinkUp`. */
  readonly onLinkUp: NonNullable<NativeKnxConnectionOptions["onLinkUp"]> = ({ bus, reads }) => {
    if (this.disposed) return undefined;              // a disposed attachment never re-attaches
    this.release();                                   // defensive: never two attachments, whatever happened before
    const token = {};
    this.token = token;
    this.linkUps++;
    this.reads = reads;
    this.sub = bus.subscribe((t) => this.monitor.observeTelegram({ source: t.source, destination: t.destination, service: t.service }), { label: "health-monitor" });
    this.monitor.setPath({ gateway: "reachable", interface: "up" });
    this.monitor.start();                             // idempotent: exactly one loop
    return () => { if (this.token === token) this.onLinkDown(); };
  };

  diagnostics(): NativeHealthAttachmentDiagnostics {
    return { attached: this.reads !== null, linkUps: this.linkUps, linkDowns: this.linkDowns, subscriptions: this.sub?.active ? 1 : 0, monitorRunning: this.monitor.isRunning, readsRefused: this.refused };
  }

  /** Final and idempotent: releases the subscription, stops the monitor and refuses any later link-up. Does not touch the connection. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.token) this.onLinkDown(); else this.monitor.stop();
  }

  private onLinkDown(): void {
    this.token = null;
    this.linkDowns++;
    this.release();
    this.monitor.stop();                              // cancels pending probes; evidence and budgets survive
    // The hook cleanup carries no close reason, so the cause is not classified here: "unknown", not a guessed "unreachable".
    this.monitor.setPath({ interface: "down", gateway: "unknown" });
  }

  private release(): void {
    this.sub?.unsubscribe();
    this.sub = null;
    this.reads = null;
  }
}

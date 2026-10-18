/**
 * KNX health service (§ Supreme KNX Health, vertical slice): ETS-derived registrations → SUPERVISED native tunnel → device-health monitor → diagnostics.
 * It composes existing parts and adds only glue:
 *   - supervision/backoff/reconnect = {@link ConnectionManager} (existing; now with an injectable clock) around a FRESH single-use {@link KnxTunnelClient}
 *     per attempt (the tunnel client is single-use by design);
 *   - evidence + scheduling + budgets = {@link KnxHealthMonitor} (one instance for the service's whole life, so probe spacing and per-minute budgets
 *     stay valid across reconnects);
 *   - connection counters = the existing {@link DriverDiagnosticsTracker}.
 * Read-only boundary: the monitor can only read; the tunnel is reached through readOnlyBusFromTunnel. Not wired to any production driver; no secure mode.
 */
import { ConnectionManager } from "../connection-manager.js";
import { DriverDiagnosticsTracker } from "../../driver-diagnostics.js";
import type { KnxTunnelClient } from "../native/tunnel-client.js";
import type { Clock } from "../native/transport.js";
import type { HealthConfig } from "./health-model.js";
import { buildHealthDiagnostics, type KnxHealthDiagnostics } from "./health-diagnostics.js";
import { reconcileEtsDevices, type EtsDeviceInfo, type ReconcileOptions, type ReconcileReport } from "./ets-registry.js";
import { KnxHealthMonitor, type HealthSnapshot, type ReadOnlyGroupBus } from "./health-monitor.js";
import { readOnlyBusFromTunnel } from "./tunnel-health-adapter.js";
import { formatGroupAddress } from "../native/address.js";

export interface KnxHealthServiceOptions {
  clock: Clock;
  /** Builds a NEW, not yet connected tunnel client for every connection attempt. */
  createTunnel: () => KnxTunnelClient;
  gateway: { host: string; port?: number };
  health?: Partial<HealthConfig>;
  reconnect?: { minBackoffMs?: number; maxBackoffMs?: number; random?: () => number };
}

/** Close reasons that say the gateway itself could not be reached (versus "we closed it" / "it refused"). */
const UNREACHABLE = new Set(["connect_timeout", "heartbeat_lost", "socket_error"]);

export class KnxHealthService {
  readonly monitor: KnxHealthMonitor;
  private readonly tracker = new DriverDiagnosticsTracker();
  private readonly manager: ConnectionManager;
  private readonly bus: ReadOnlyGroupBus;
  private tunnel: KnxTunnelClient | null = null;
  /** The tunnel of an attempt still connecting; stop() clears it and a late success is then closed orderly instead of attached. */
  private candidate: KnxTunnelClient | null = null;
  private detachers: Array<() => void> = [];
  private tunnelsCreated = 0;
  private lastReconcile: { at: number; report: ReconcileReport } | null = null;
  private started = false;

  constructor(private readonly o: KnxHealthServiceOptions) {
    // The monitor's only bus access: read-only, and bound to whatever tunnel is currently attached (none ⇒ the read is refused ⇒ inconclusive).
    this.bus = {
      readGroup: async (ga: number): Promise<void> => {
        const t = this.tunnel;
        if (!t) throw new Error("no tunnel attached");
        this.tracker.recordSend(`GroupValueRead ${formatGroupAddress(ga)}`);
        await readOnlyBusFromTunnel(t, this.monitor).readGroup(ga);
      },
    };
    this.monitor = new KnxHealthMonitor(o.clock, this.bus, o.health);
    this.manager = new ConnectionManager({
      connect: () => this.connectOnce(),
      disconnect: () => this.disconnectCurrent(),
      clock: o.clock,
      minBackoffMs: o.reconnect?.minBackoffMs ?? 2_000,
      maxBackoffMs: o.reconnect?.maxBackoffMs ?? 60_000,
      ...(o.reconnect?.random ? { random: o.reconnect.random } : {}),
      onStateChange: (state, prev) => { if (prev === "connected" && state !== "connected") this.tracker.recordReconnect(); },
    });
  }

  /** Reconciles the monitor's ETS-managed registrations with the project (idempotent; safe before or after start()). */
  importEts(devices: readonly EtsDeviceInfo[], opts: ReconcileOptions = {}): ReconcileReport {
    const report = reconcileEtsDevices(this.monitor, devices, opts);
    this.lastReconcile = { at: this.o.clock.now(), report };
    return report;
  }

  /** Starts supervision. Monitoring starts only once a tunnel is actually connected. Resolves after the first attempt (success or failure). */
  async start(): Promise<void> {
    this.started = true;
    await this.manager.start();
  }

  /** Stops supervision, cancels pending probes, detaches and disconnects. Idempotent. */
  async stop(): Promise<void> {
    this.started = false;
    this.candidate = null;                           // an attempt still connecting is not aborted (that would orphan a gateway channel); connectOnce closes its tunnel orderly when the handshake ends
    this.monitor.stop();
    await this.manager.stop();
    this.detach();
    this.monitor.setPath({ interface: "down", gateway: "unknown" });
  }

  snapshot(): HealthSnapshot { return this.monitor.snapshot(); }

  diagnostics(): KnxHealthDiagnostics {
    const m = this.manager.metrics();
    const status = m.state === "connected" ? "connected" : m.state === "connecting" || m.state === "recovering" ? "connecting" : "disconnected";
    return buildHealthDiagnostics({
      snapshot: this.monitor.snapshot(), events: this.monitor.events(),
      connection: {
        status, supervisor: m, gateway: { host: this.o.gateway.host, port: this.o.gateway.port ?? 3671 },
        tunnelsCreated: this.tunnelsCreated, attachedTunnels: this.tunnel ? 1 : 0, monitorRunning: this.monitor.isRunning,
        driver: this.tracker.snapshot(status, { protocol: "knx", driverVersion: "native-health-0", ip: this.o.gateway.host }),
      },
      reconcile: this.lastReconcile,
    });
  }

  // ------------------------------------------------------------------------------------------------------------------ internals

  private async connectOnce(): Promise<void> {
    this.detach();                                   // never two attachments, whatever happened before
    const t = this.o.createTunnel();
    this.tunnelsCreated++;
    this.candidate = t;
    try { await t.connect(); } catch (e) {
      if (this.candidate === t) this.candidate = null;
      this.tracker.recordError(e instanceof Error ? e.message : String(e));
      const code = (e as { code?: string }).code;
      this.monitor.setPath({ interface: "down", gateway: code !== undefined && UNREACHABLE.has(code) ? "unreachable" : "unknown" });
      throw e;
    }
    if (this.candidate !== t || !this.started) { void t.disconnect(); throw new Error("stopped while connecting"); }
    this.candidate = null;
    this.tunnel = t;
    this.detachers.push(t.onTelegram((f) => {
      if (!f.destinationIsGroup || !f.group) return;
      this.tracker.recordReceive(`${f.group.service} ${formatGroupAddress(f.destination)}`);
      this.monitor.observeTelegram({ source: f.source, destination: f.destination, service: f.group.service });
    }));
    this.detachers.push(t.onClosed((e) => this.onTunnelClosed(t, e.reason)));
    this.monitor.setPath({ gateway: "reachable", interface: "up" });
    this.monitor.start();                            // idempotent: exactly one loop
  }

  private onTunnelClosed(t: KnxTunnelClient, reason: string): void {
    if (t !== this.tunnel) return;                   // a stale tunnel's late event
    this.tracker.recordError(`tunnel closed: ${reason}`);
    this.detach();
    this.monitor.stop();                             // cancels pending probes; evidence and budgets survive
    this.monitor.setPath({ interface: "down", gateway: UNREACHABLE.has(reason) ? "unreachable" : "unknown" });
    if (this.started) this.manager.reportDisconnected(reason);
  }

  private async disconnectCurrent(): Promise<void> {
    const t = this.tunnel;
    this.detach();
    if (t) void t.disconnect();                      // best effort; the tunnel bounds it with its own disconnect timeout
  }

  private detach(): void {
    for (const d of this.detachers.splice(0)) d();
    this.tunnel = null;
  }
}

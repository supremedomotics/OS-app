import type { DiscoveredDevice } from "@supreme/integration-layer";
import type { IKnxProvider, KnxFeedbackTelegramSnapshot, KnxTask, ProviderDiagnostics, ProviderHealth } from "./provider.js";
import { ConnectionManager, type ConnectionManagerMetrics, type ConnectionState } from "./connection-manager.js";

/**
 * KNX Ultimate Provider (§ Internal Architecture) — the real KNXnet/IP transport,
 * backed by the `knxultimate` npm package (tunnelling over UDP). Owns everything the
 * Task Router routes to it: group-address communication, DPT encode/decode, bus
 * monitoring, bus reads/writes, KNX Secure, routing, and tunnelling.
 *
 * This is the ONLY file in the Supreme KNX Driver that imports `knxultimate` — exactly
 * mirroring how the rest of the platform never sees Home Assistant, nothing outside
 * this file (and nothing outside this driver at all) may know `knxultimate` exists.
 */

interface KnxUltimateModule {
  default?: KnxUltimateModule;
  KNXClient?: new (opts: Record<string, unknown>) => KnxUltimateClient;
  dptlib?: KnxUltimateDptLib;
}
interface KnxUltimateClient {
  Connect(): void;
  Disconnect(): Promise<void>;
  write(groupAddress: string, value: unknown, dpt: string): void;
  /** Sends a real GroupValueRead request (verified against the installed `knxultimate`
   * package's `KNXClient.read()`). Fire-and-forget by design — matches the KNX bus
   * itself: the response is a separate, asynchronous GroupValueResponse telegram that
   * arrives through the same "indication" event every other status update does, so it
   * needs no separate response-correlation machinery (§ State Synchronization). */
  read(groupAddress: string): void;
  on(event: "connected", cb: () => void): KnxUltimateClient;
  on(event: "error", cb: (err: unknown) => void): KnxUltimateClient;
  on(event: "indication", cb: (packet: KnxUltimateIndication) => void): KnxUltimateClient;
}
interface KnxUltimateDptLib {
  resolve(dpt: string): unknown;
  fromBuffer(raw: Buffer, dptConfig: unknown): unknown;
}
interface KnxUltimateIndication {
  cEMIMessage?: {
    dstAddress?: { toString(): string };
    srcAddress?: { toString(): string };
    npdu?: { dataValue?: Buffer; isGroupWrite?: boolean; isGroupResponse?: boolean };
  };
}

export interface KnxUltimateProviderOptions {
  host: string;
  port?: number;
  /** Local network interface to bind the tunnel through — plumbed straight to
   * `knxultimate`'s `KNXClient` `localIPAddress` option (verified present in the
   * installed `knxultimate@6` typings). Omitted means "let the OS default route
   * decide", the pre-existing behavior — needed on a multi-homed hub where the wrong
   * interface silently prevents the tunnel from ever reaching the gateway. */
  localAddress?: string;
  /** How long a single connect attempt may take before it's treated as failed and
   * handed to the Connection Manager's existing backoff/retry (default 10s). Without
   * this, a connect attempt whose underlying handshake never emits `connected` or
   * `error` (a dropped UDP packet, wrong interface, unreachable gateway — all real,
   * observed KNXnet/IP failure modes) hangs indefinitely instead of ever failing. */
  connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

class KnxConnectTimeoutError extends Error {
  constructor(host: string, port: number, timeoutMs: number) {
    super(`knx-ultimate: connect to ${host}:${port} timed out after ${timeoutMs}ms`);
    this.name = "KnxConnectTimeoutError";
  }
}

export class KnxUltimateProvider implements IKnxProvider {
  readonly name = "knx-ultimate";
  private readonly opts: KnxUltimateProviderOptions;
  private client: KnxUltimateClient | null = null;
  private dptlib: KnxUltimateDptLib | null = null;
  private readonly observers = new Map<string, { dpt: string; handler: (value: unknown) => void }[]>();
  /** Owns ONGOING reconnect supervision (§ Phase 6 Connection Manager) — created after
   * the FIRST successful connect, which stays a direct, synchronously-rejecting call so
   * a genuine startup misconfiguration still surfaces immediately rather than retrying
   * silently forever. */
  private connectionManager: ConnectionManager | null = null;
  /** Real subscribers to connection-state transitions (§ Phase 7 State Synchronization)
   * — lets {@link "./supreme-knx-driver.js" SupremeKnxDriver} trigger a group-read sync
   * pass whenever the connection (re)establishes, without this provider needing to know
   * anything about bindings/devices itself (§ Ownership: providers never own devices). */
  private readonly stateListeners = new Set<(state: ConnectionState, previous: ConnectionState) => void>();

  // Real, incrementing-only counters — never fabricated (§ Diagnostics).
  private packetsSent = 0;
  private packetsReceived = 0;
  private lastTelegramAt: string | null = null;
  private lastCommandAt: string | null = null;
  private lastError: string | null = null;
  private reconnectAttempts = 0;
  private unmatchedFeedbackTelegrams = 0;
  // § PASS 20 diagnostic (Part A) — bounded, one-entry snapshots; never an unbounded log.
  private lastFeedbackTelegram: KnxFeedbackTelegramSnapshot | null = null;
  private lastUnmatchedFeedback: KnxFeedbackTelegramSnapshot | null = null;

  constructor(opts: KnxUltimateProviderOptions) {
    this.opts = opts;
  }

  async initialize(): Promise<void> {
    // Nothing to do ahead of connect() for a tunnelling client; kept as an explicit
    // lifecycle stage (§ Driver Provider Interface) so a future provider with real
    // pre-connect setup (e.g. loading an ETS-derived DPT table) has somewhere to put it.
  }

  async discover(): Promise<DiscoveredDevice[]> {
    // KNX Ultimate has no LAN discovery of its own (that is KNX IoT's job, per the
    // Task Router's routing table) — group addresses are only known once bound from
    // an ETS import or manual entry. Never fabricates a discovery result.
    return [];
  }

  async connect(): Promise<void> {
    if (this.client) return;
    await this.doConnect(); // first connect stays direct — a real misconfiguration must
    // still reject synchronously here, not retry silently forever (§ Connection Manager).
    this.connectionManager ??= new ConnectionManager({
      connect: () => this.doConnect(),
      disconnect: () => this.doDisconnect(),
      // § production defect: a tunnel the gateway drops without a clean
      // TUNNELING_ACK/DISCONNECT_REQUEST (a real KNXnet/IP failure mode) previously went
      // undetected until the next write/read happened to fail — `client !== null` is a
      // real, honestly-known fact (not a fabricated bus ping this codebase can't yet
      // perform), and it's exactly what closes that gap: any path that nulls `this.client`
      // (the existing `client.on("error", ...)` handler, or this timeout wrapper) now
      // gets caught by the heartbeat too, not just by a caller's next command attempt.
      isHealthy: () => this.client !== null,
      onStateChange: (state, previous, reason) => {
        if (state === "error" || state === "degraded") this.lastError = reason;
        for (const listener of this.stateListeners) listener(state, previous);
      },
    });
    this.connectionManager.markConnected();
    for (const listener of this.stateListeners) listener("connected", "connecting");
  }

  /** Subscribes to real connection-state transitions. Returns an unsubscribe function.
   * The very first successful {@link connect} fires this too (via the explicit call
   * above) even though it predates the Connection Manager's own "connected" transition
   * — a caller shouldn't have to special-case "first connect vs. reconnect" to know
   * when a sync pass is due. */
  onConnectionStateChange(listener: (state: ConnectionState, previous: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** The real connect logic (§ Connection Manager: `connect` callback). Always builds a
   * fresh client — idempotency for "already connected" is the PUBLIC {@link connect}'s
   * job, not this one's, since the manager also calls this directly on every reconnect
   * attempt when `this.client` is already null. */
  private async doConnect(): Promise<void> {
    const moduleName = "knxultimate";
    try {
      const imported = (await import(moduleName)) as unknown as KnxUltimateModule;
      const runtime = (imported.default ?? imported) as KnxUltimateModule;
      const Client = imported.KNXClient ?? runtime.KNXClient;
      const dptlib = imported.dptlib ?? runtime.dptlib;
      if (!Client || !dptlib) throw new Error("knxultimate did not expose KNXClient and dptlib");
      this.dptlib = dptlib;
      const port = this.opts.port ?? 3671;
      const client = new Client({
        hostProtocol: "TunnelUDP",
        ipAddr: this.opts.host,
        ipPort: port,
        ...(this.opts.localAddress ? { localIPAddress: this.opts.localAddress } : {}),
      });
      this.wireIndications(client, dptlib);
      const connectTimeoutMs = this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          this.lastError = `connect to ${this.opts.host}:${port} timed out after ${connectTimeoutMs}ms`;
          // Best-effort cleanup of the half-open client so it can't emit a late
          // "connected"/"error" into a promise nobody's listening to anymore, and so
          // the next attempt starts from a genuinely fresh client rather than leaking
          // this one's socket.
          void client.Disconnect().catch(() => { /* already dead — nothing to clean up */ });
          reject(new KnxConnectTimeoutError(this.opts.host, port, connectTimeoutMs));
        }, connectTimeoutMs);
        (timer as { unref?: () => void }).unref?.();
        client.on("connected", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.client = client;
          resolve();
        });
        client.on("error", (err) => {
          this.lastError = err instanceof Error ? err.message : String(err);
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          // A post-connect error (§ Self-Healing: "lost tunnels") — the client is dead;
          // hand off to the Connection Manager rather than swallowing it silently, which
          // is what this code did before Phase 6 (a real, now-fixed gap).
          this.client = null;
          this.connectionManager?.reportDisconnected(this.lastError ?? "knx-ultimate: connection error");
        });
        client.Connect();
      });
    } catch (err) {
      this.reconnectAttempts++;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.client = null;
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    await this.connectionManager?.stop();
    await this.doDisconnect();
  }

  private async doDisconnect(): Promise<void> {
    await this.client?.Disconnect();
    this.client = null;
  }

  async shutdown(): Promise<void> {
    await this.disconnect();
    this.observers.clear();
  }

  private wireIndications(client: KnxUltimateClient, dptlib: KnxUltimateDptLib): void {
    client.on("indication", (packet) => {
      // Guards against a STALE listener on a retired client instance (§ Phase 7 Resource
      // Cleanup — "removes stale references/callbacks"): after a reconnect, the old
      // client's own EventEmitter can still be holding this closure even though nothing
      // calls `.removeAllListeners()` on it (knxultimate exposes no such hook this
      // provider can rely on) — this identity check is what actually stops it from
      // double-delivering through both the dead and the live client.
      if (this.client !== client) return;
      const cemi = packet.cEMIMessage;
      const dst = cemi?.dstAddress?.toString?.();
      const src = cemi?.srcAddress?.toString?.() ?? null;
      const raw = cemi?.npdu?.dataValue;
      if (!dst || !raw) return;
      this.packetsReceived++;
      const ts = new Date().toISOString();
      this.lastTelegramAt = ts;
      const handlers = this.observers.get(dst);
      if (!handlers?.length) {
        this.unmatchedFeedbackTelegrams++;
        this.lastUnmatchedFeedback = { source: src, destination: dst, matched: false, ts };
        return;
      }
      // § PASS 20 diagnostic (Part A) — decode using the FIRST matched observer's own
      // DPT for the snapshot (a GA can have multiple observers in principle, but always
      // the same real DPT in practice — this is diagnostic visibility, not a second
      // decode path); every matched handler still gets called exactly as before.
      const { dpt: firstDpt } = handlers[0]!;
      let decodedForDiagnostics: unknown;
      try { decodedForDiagnostics = dptlib.fromBuffer(raw, dptlib.resolve(firstDpt)); } catch { /* diagnostic-only, never block real handling */ }
      this.lastFeedbackTelegram = { source: src, destination: dst, matched: true, dpt: firstDpt, value: decodedForDiagnostics, ts };
      for (const { dpt, handler } of handlers) handler(dptlib.fromBuffer(raw, dptlib.resolve(dpt)));
    });
  }

  async execute(task: KnxTask): Promise<unknown> {
    if (!this.client) throw new Error("knx-ultimate: not connected");
    if (task.kind === "bus.group_write") {
      this.client.write(task.groupAddress, task.value, task.dpt);
      this.packetsSent++;
      this.lastCommandAt = new Date().toISOString();
      return undefined;
    }
    if (task.kind === "bus.group_read") {
      // Real GroupValueRead request (§ Phase 7 State Synchronization — verified against
      // KNXClient.read() in the installed knxultimate package). The value itself arrives
      // asynchronously via the existing "indication" handler/subscribe() path, exactly
      // like a spontaneous status telegram — this call only triggers the request.
      this.client.read(task.groupAddress);
      this.packetsSent++;
      this.lastCommandAt = new Date().toISOString();
      return undefined;
    }
    throw new Error(`knx-ultimate: unsupported task "${(task as KnxTask).kind}"`);
  }

  subscribe(groupAddress: string, dpt: string, handler: (value: unknown) => void): void {
    const list = this.observers.get(groupAddress) ?? [];
    list.push({ dpt, handler });
    this.observers.set(groupAddress, list);
  }

  unsubscribe(groupAddress: string): void {
    this.observers.delete(groupAddress);
  }

  /** § PASS 20 diagnostic (Part A) — a safe way to check whether an exact GA string
   * currently has a registered observer, without exposing the observer map itself. */
  isSubscribed(groupAddress: string): boolean {
    return (this.observers.get(groupAddress)?.length ?? 0) > 0;
  }

  health(): ProviderHealth {
    return { connected: this.client !== null, lastError: this.lastError };
  }

  /** Real Connection Manager metrics (§ Phase 6 Metrics) — null before the first
   * connect() has run, never fabricated. */
  connectionMetrics(): ConnectionManagerMetrics | null {
    return this.connectionManager?.metrics() ?? null;
  }

  /** Connection Quality Monitoring (§ Enterprise Reliability — "telegram rate"): a real
   * division of two real counters (packets received ÷ elapsed connected minutes), never
   * a fabricated/simulated rate. Null whenever either input isn't meaningful yet — no
   * uptime recorded, or uptime is effectively zero (a fresh connect, avoiding a
   * division that would report a wildly inflated instantaneous rate off one packet). */
  telegramRatePerMinute(): number | null {
    const uptimeMs = this.connectionManager?.metrics().uptimeMs;
    if (!uptimeMs || uptimeMs < 1000) return null;
    return this.packetsReceived / (uptimeMs / 60_000);
  }

  diagnostics(): ProviderDiagnostics {
    return {
      provider: this.name,
      connected: this.client !== null,
      packetsSent: this.packetsSent,
      packetsReceived: this.packetsReceived,
      lastTelegramAt: this.lastTelegramAt,
      lastCommandAt: this.lastCommandAt,
      lastError: this.lastError,
      // Once the Connection Manager exists it's the authoritative counter (it also
      // tracks post-first-connect reconnects the old local counter never saw); fall
      // back to the pre-first-connect local count otherwise.
      reconnectAttempts: this.connectionManager?.metrics().reconnectAttempts ?? this.reconnectAttempts,
      connectionState: this.connectionManager?.state ?? null,
      unmatchedFeedbackTelegrams: this.unmatchedFeedbackTelegrams,
      lastFeedbackTelegram: this.lastFeedbackTelegram,
      lastUnmatchedFeedback: this.lastUnmatchedFeedback,
    };
  }
}

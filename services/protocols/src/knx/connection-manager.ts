/**
 * Connection Manager (§ Supreme KNX Driver — Phase 6, Production Readiness).
 *
 * A generic (not KNX-specific) supervised-connection state machine: owns the
 * connect/disconnect lifecycle for anything that can fail and needs automatic recovery
 * — exponential backoff with jitter, an optional heartbeat, and real metrics. Wraps a
 * caller-supplied `connect`/`disconnect`/`isHealthy` — it never knows what protocol is
 * underneath, so the exact same class can supervise KNX Ultimate's tunnel today and any
 * future provider (Matter, Modbus, …) without duplicating this logic per protocol.
 *
 * Design choices, stated explicitly (§ Code Quality: "prefer deterministic recovery over
 * retry loops"):
 *   - Exactly ONE pending timer at a time — `scheduleReconnect` always clears any
 *     existing timer first, so `stop()`/rapid state changes can never leave a duplicate
 *     timer running (§ Self-Healing: "duplicate timers").
 *   - Backoff resets to `minBackoffMs` on every successful connect, so the very next
 *     retry after a brief blip is always fast; consecutive failures grow the delay
 *     exponentially (capped at `maxBackoffMs`) — "fast reconnect after short outages,
 *     slow retry after long outages" falls out of this naturally, not from tracking
 *     outage duration separately.
 *   - The heartbeat and the reconnect timer are two independent, always-cleared-before-
 *     rescheduled timers — never nested `setTimeout`s that could stack.
 */

export type ConnectionState = "disconnected" | "connecting" | "connected" | "degraded" | "recovering" | "error";

export interface ConnectionManagerMetrics {
  state: ConnectionState;
  uptimeMs: number | null;
  reconnectAttempts: number;
  successfulReconnects: number;
  failedReconnects: number;
  heartbeatFailures: number;
  currentBackoffMs: number;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  lastError: string | null;
  /** Real, measured elapsed time of the most recent connect() call — successful or not
   * (§ Enterprise Reliability — Connection Quality Monitoring: "reconnect duration").
   * Null until at least one connect attempt has completed. */
  lastConnectDurationMs: number | null;
}

export interface ConnectionManagerOptions {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** Optional heartbeat check — when it returns false or throws, the manager marks
   * itself "degraded" and forces a reconnect. Absent means no heartbeat supervision
   * (the underlying transport's own error events are the only failure signal). */
  isHealthy?: () => Promise<boolean> | boolean;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  heartbeatIntervalMs?: number;
  /** Injectable for tests — never Date.now()/setTimeout directly, so backoff/heartbeat
   * timing is deterministic under vi.useFakeTimers(). */
  now?: () => number;
  onStateChange?: (state: ConnectionState, previous: ConnectionState, reason: string) => void;
}

const DEFAULTS = { minBackoffMs: 1000, maxBackoffMs: 5 * 60 * 1000, heartbeatIntervalMs: 30 * 1000 };

export class ConnectionManager {
  private readonly opts: Required<Pick<ConnectionManagerOptions, "connect" | "disconnect">> & ConnectionManagerOptions;
  private readonly now: () => number;

  private connectionState: ConnectionState = "disconnected";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private backoffMs: number;
  private stopped = true;
  /** Guards against a reconnect attempt overlapping a still-in-flight one — the
   * concrete mechanism behind "no duplicate subscriptions/connection leaks". */
  private connecting = false;

  private connectedAt: number | null = null;
  private reconnectAttempts = 0;
  private successfulReconnects = 0;
  private failedReconnects = 0;
  private heartbeatFailures = 0;
  private lastConnectedAt: string | null = null;
  private lastDisconnectedAt: string | null = null;
  private lastError: string | null = null;
  private lastConnectDurationMs: number | null = null;

  constructor(opts: ConnectionManagerOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.backoffMs = opts.minBackoffMs ?? DEFAULTS.minBackoffMs;
  }

  get state(): ConnectionState {
    return this.connectionState;
  }

  /** Begins supervision — connects immediately, then owns all reconnect/heartbeat
   * scheduling until {@link stop} is called. Idempotent. */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.attemptConnect("start");
  }

  /** Stops supervision and disconnects — the only way to guarantee no orphaned timer
   * survives (§ Self-Healing: "duplicate timers", "connection leaks"). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearReconnectTimer();
    this.clearHeartbeat();
    if (this.connectionState !== "disconnected") {
      try {
        await this.opts.disconnect();
      } catch {
        // Best-effort on shutdown — the state is being forced to disconnected regardless.
      }
    }
    this.setState("disconnected", "stopped");
  }

  /** Seeds the manager as already-connected when the FIRST connection was made directly
   * by the caller (so a meaningful startup error can still reject synchronously — this
   * manager only takes over ONGOING supervision from that point on, never the initial
   * connect promise's success/failure contract). Starts the heartbeat immediately, same
   * as a successful {@link start}. */
  markConnected(): void {
    this.stopped = false;
    this.connecting = false;
    this.connectedAt = this.now();
    this.lastConnectedAt = new Date(this.connectedAt).toISOString();
    this.lastError = null;
    this.reconnectAttempts = 0;
    this.backoffMs = this.opts.minBackoffMs ?? DEFAULTS.minBackoffMs;
    this.setState("connected", "connected externally");
    this.startHeartbeat();
  }

  /** Reports an asynchronous connection drop the underlying transport detected on its
   * own (e.g. a socket "error"/"close" event after a successful connect) — the event-
   * driven counterpart to the heartbeat's poll-driven detection. A no-op when not
   * currently connected, so a duplicate/late event can never double-schedule a
   * reconnect (§ Self-Healing: "duplicate timers"). */
  reportDisconnected(reason: string): void {
    if (this.stopped || this.connectionState !== "connected") return;
    this.lastDisconnectedAt = new Date(this.now()).toISOString();
    this.lastError = reason;
    this.connectedAt = null;
    this.clearHeartbeat();
    this.setState("error", reason);
    this.reconnectAttempts++;
    this.scheduleReconnect(reason);
  }

  /** Metrics (§ Metrics) — every field is a real counter/timestamp, never fabricated. */
  metrics(): ConnectionManagerMetrics {
    return {
      state: this.connectionState,
      uptimeMs: this.connectedAt !== null ? this.now() - this.connectedAt : null,
      reconnectAttempts: this.reconnectAttempts,
      successfulReconnects: this.successfulReconnects,
      failedReconnects: this.failedReconnects,
      heartbeatFailures: this.heartbeatFailures,
      currentBackoffMs: this.backoffMs,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastError: this.lastError,
      lastConnectDurationMs: this.lastConnectDurationMs,
    };
  }

  private setState(state: ConnectionState, reason: string): void {
    if (state === this.connectionState) return;
    const previous = this.connectionState;
    this.connectionState = state;
    this.opts.onStateChange?.(state, previous, reason);
  }

  private async attemptConnect(reason: string): Promise<void> {
    if (this.connecting || this.stopped) return;
    this.connecting = true;
    this.setState(this.reconnectAttempts > 0 ? "recovering" : "connecting", reason);
    const startedAt = this.now();
    try {
      await this.opts.connect();
      this.lastConnectDurationMs = this.now() - startedAt;
      this.connecting = false;
      if (this.stopped) return; // stop() ran while connect() was in flight
      this.connectedAt = this.now();
      this.lastConnectedAt = new Date(this.connectedAt).toISOString();
      this.lastError = null;
      if (this.reconnectAttempts > 0) this.successfulReconnects++;
      this.reconnectAttempts = 0;
      this.backoffMs = this.opts.minBackoffMs ?? DEFAULTS.minBackoffMs; // fast reconnect after the NEXT short outage
      this.setState("connected", "connected");
      this.startHeartbeat();
    } catch (err) {
      this.lastConnectDurationMs = this.now() - startedAt;
      this.connecting = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.reconnectAttempts++;
      this.failedReconnects++;
      this.setState("error", this.lastError);
      if (!this.stopped) this.scheduleReconnect("connect failed");
    }
  }

  private scheduleReconnect(reason: string): void {
    this.clearReconnectTimer();
    if (this.stopped) return;
    const maxBackoff = this.opts.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
    const jitter = 1 + (Math.random() * 0.2 - 0.1); // ±10%, avoids a reconnect-storm across many devices on the same outage
    const delay = Math.min(maxBackoff, Math.round(this.backoffMs * jitter));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptConnect(reason);
    }, delay);
    this.backoffMs = Math.min(maxBackoff, this.backoffMs * 2);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat(); // never stack a second interval on repeated connects
    if (!this.opts.isHealthy) return;
    const interval = this.opts.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs;
    this.heartbeatTimer = setInterval(() => void this.runHeartbeat(), interval);
  }

  private async runHeartbeat(): Promise<void> {
    if (this.stopped || this.connectionState !== "connected") return;
    try {
      const healthy = await this.opts.isHealthy!();
      if (!healthy) throw new Error("heartbeat reported unhealthy");
    } catch (err) {
      this.heartbeatFailures++;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.lastDisconnectedAt = new Date(this.now()).toISOString();
      this.connectedAt = null;
      this.setState("degraded", this.lastError);
      this.clearHeartbeat();
      try {
        await this.opts.disconnect();
      } catch {
        // The transport may already be dead — proceed to reconnect regardless.
      }
      this.reconnectAttempts++;
      this.scheduleReconnect("heartbeat failure");
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

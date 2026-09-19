import { isTvErrorRetryable, TvPairingRequiredError, TvAuthenticationError } from "./tv-errors.js";
import { TvCommandQueue } from "./tv-command-queue.js";
import { TvReconnectScheduler } from "./tv-reconnect.js";
import { TvStateCache } from "./tv-state-cache.js";
import { TvSessionEventBus } from "./tv-events.js";
import type {
  TvDeviceConfig,
  TvForegroundApp,
  TvMediaState,
  TvRemoteKey,
  TvSessionDiagnostics,
  TvSessionState,
  TvTransport,
} from "./tv-types.js";

/** §13 — default per-field-group source priority (lower index wins ties). Real source
 * names ("agent_mediasession", "cast", "remote_v2", ...) are added as their transports
 * ship; "fake"/"poll"/"last_known" exist now so Phase 1 tests can exercise arbitration
 * without waiting on a real transport. Never a single global priority list (§13
 * "field-aware, not one global source priority") — media and foreground-app get their
 * own orderings because the spec documents them differently. */
export const DEFAULT_MEDIA_SOURCE_PRIORITY = ["agent_mediasession", "mediasession", "cast", "remote_v2", "poll", "fake", "last_known"];
export const DEFAULT_FOREGROUND_SOURCE_PRIORITY = ["agent_accessibility", "platform_foreground_api", "adb", "fake", "last_known"];

/**
 * (§4/§19 — one fully isolated session per physical device) Owns exactly one transport
 * instance, one reconnect scheduler, one command queue, one state cache, one event bus.
 * Nothing here is ever shared with another session — see TvDeviceSessionManager's doc
 * comment for why this differs from CoolMaster's "one shared gateway connection, many
 * bound units" shape: each TV is its own independent socket, so isolation must be
 * structural (separate objects), not just policy (a shared object that's careful to key
 * by device).
 */
/** §8 Phase 3A — a position-only media-state update is throttled to at most one
 * emitted session event per this window; the cache itself is still updated on every
 * offer, so `getMediaState()` always reflects the latest position even between emitted
 * events. A genuine metadata/playback-state/app change always passes through
 * immediately, never delayed by this window. This is a documented DEFAULT policy, not
 * an unexplained permanent constant — `TvDeviceConfig.mediaPositionCoalescingMs`
 * overrides it per device once real-device MediaSession callback frequency is known. */
export const DEFAULT_MEDIA_POSITION_COALESCING_MS = 250;

export class TvDeviceSession {
  private transport: TvTransport;
  private state: TvSessionState = "disconnected";
  private readonly reconnect: TvReconnectScheduler;
  private readonly queue = new TvCommandQueue();
  private readonly cache: TvStateCache;
  private readonly events = new TvSessionEventBus();
  private unsubscribeTransport: (() => void) | null = null;
  private disposed = false;
  private stoppedDeliberately = true;

  // §1 Phase 3 — the optional TV Agent: an independent feedback channel, never coupled
  // to the primary (Remote v2/ADB/etc.) transport's lifecycle. Its own connect/
  // disconnect/error events update `agentConnected` only — they must never touch
  // `state`/the reconnect scheduler, which exist purely for the primary transport.
  private agentTransport: TvTransport | null = null;
  private unsubscribeAgent: (() => void) | null = null;
  private agentConnected: boolean | null = null;
  private lastEmittedMedia: Partial<TvMediaState> | null = null;
  private lastPositionEmitAt = 0;

  // Diagnostics counters (§21) — device-scoped, never aggregated across sessions.
  private lastConnectedAt: string | null = null;
  private lastDisconnectedAt: string | null = null;
  private lastStateEvent: string | null = null;
  private lastCommand: string | null = null;
  private lastCommandAt: string | null = null;
  private lastCommandLatencyMs: number | null = null;
  private pairingState: TvSessionDiagnostics["pairingState"] = "not_required";
  private authenticationState: TvSessionDiagnostics["authenticationState"] = "not_required";
  private errorCount = 0;
  private lastError: string | null = null;

  constructor(private readonly config: TvDeviceConfig) {
    this.transport = config.createTransport(config);
    this.cache = new TvStateCache(DEFAULT_MEDIA_SOURCE_PRIORITY, DEFAULT_FOREGROUND_SOURCE_PRIORITY);
    this.reconnect = new TvReconnectScheduler({
      backoffBaseMs: config.backoffBaseMs ?? 1000,
      backoffMaxMs: config.backoffMaxMs ?? 60000,
      attempt: () => this.establish(),
    });
  }

  get deviceId(): string {
    return this.config.deviceId;
  }

  async connect(): Promise<void> {
    this.stoppedDeliberately = false;
    this.reconnect.start();
    await this.establish();
  }

  /** Deliberate disconnect (§20 unbind/disable) — stops the reconnect loop, unlike a
   * transport-reported connection-lost, which schedules a reconnect. */
  disconnect(): void {
    this.stoppedDeliberately = true;
    this.reconnect.stop();
    this.transport.disconnect();
    this.setState("disconnected");
    this.lastDisconnectedAt = new Date().toISOString();
  }

  isConnected(): boolean {
    return this.transport.isConnected();
  }

  /** §22 Resource Management — releases every resource this session owns. Idempotent,
   * safe to call whether or not connect() ever succeeded. Distinct from disconnect():
   * a disconnected-but-still-bound session can reconnect; a disposed one cannot be used
   * again at all. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reconnect.stop();
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = null;
    this.detachAgent();
    this.queue.dispose();
    this.events.dispose();
    this.transport.dispose();
  }

  /** §1/§4/§19 Phase 3 — attaches the optional TV Agent as an independent feedback
   * channel. Its `media-state`/`foreground-app` events flow into the SAME state cache
   * (arbitrated by source priority, same as any other transport's events — see
   * DEFAULT_MEDIA_SOURCE_PRIORITY/DEFAULT_FOREGROUND_SOURCE_PRIORITY above), but its
   * connection lifecycle is tracked entirely separately from the primary transport's:
   * an agent that fails to connect, disconnects, or errors changes `agentConnected`
   * only — never `connectionState`, never triggers the primary reconnect scheduler.
   * Basic Remote v2 control keeps working with no agent attached at all (`attachAgent`
   * is never called) or after `detachAgent()` (install → uninstall, or a disabled
   * Agent). Safe to call again to replace an already-attached agent. */
  async attachAgent(agentTransport: TvTransport): Promise<void> {
    this.detachAgent();
    this.agentTransport = agentTransport;
    this.unsubscribeAgent = agentTransport.onEvent((event) => this.onAgentEvent(event));
    try {
      await agentTransport.connect();
      this.agentConnected = true;
    } catch {
      // A failed agent connection is a degraded-feedback condition, never a control
      // failure — swallow here (still discoverable via getDiagnostics().agentConnected)
      // rather than throwing out of what's meant to be a best-effort attach.
      this.agentConnected = false;
    }
  }

  /** Detaches and disposes the Agent, if one is attached — idempotent. Used for an
   * installer disabling/uninstalling the Agent (§19): control must keep working
   * unaffected, and `agentConnected` reverts to `null` ("no agent"), not `false`
   * ("agent attached but unreachable") — those are different, both honestly reported,
   * states. */
  detachAgent(): void {
    this.unsubscribeAgent?.();
    this.unsubscribeAgent = null;
    this.agentTransport?.dispose();
    this.agentTransport = null;
    this.agentConnected = null;
  }

  async sendKey(key: TvRemoteKey): Promise<void> {
    return this.runCommand(`key:${key}`, () => this.transport.sendKey(key), { dedupeKey: null, priority: 0 });
  }

  async launchApp(packageName: string): Promise<void> {
    if (!this.transport.launchApp) throw new Error(`tv: ${this.config.deviceId} transport does not support launching apps`);
    return this.runCommand(`launch:${packageName}`, () => this.transport.launchApp!(packageName), { dedupeKey: null, priority: 0 });
  }

  /** State-setting command (§18) — coalesces to the latest value via dedupe, so a
   * dragged slider only ever sends its final position. */
  async setVolume(percent: number): Promise<void> {
    if (!this.transport.setVolume) throw new Error(`tv: ${this.config.deviceId} transport does not support volume`);
    return this.runCommand(`volume:${percent}`, () => this.transport.setVolume!(percent), {
      dedupeKey: `${this.config.deviceId}:volume`,
      priority: 0,
    });
  }

  async setMuted(muted: boolean): Promise<void> {
    if (!this.transport.setMuted) throw new Error(`tv: ${this.config.deviceId} transport does not support mute`);
    return this.runCommand(`mute:${muted}`, () => this.transport.setMuted!(muted), {
      dedupeKey: `${this.config.deviceId}:mute`,
      priority: 0,
    });
  }

  getMediaState(): Partial<TvMediaState> | null {
    return this.cache.getMedia();
  }

  getForegroundApp(): TvForegroundApp | null {
    return this.cache.getForegroundApp();
  }

  onEvent(listener: (event: import("./tv-events.js").TvSessionEvent) => void): () => void {
    return this.events.on(listener);
  }

  getDiagnostics(): TvSessionDiagnostics {
    return {
      deviceId: this.config.deviceId,
      platform: this.config.platform,
      connectionState: this.state,
      activeTransport: this.transport.kind,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastStateEvent: this.lastStateEvent,
      lastCommand: this.lastCommand,
      lastCommandAt: this.lastCommandAt,
      lastCommandLatencyMs: this.lastCommandLatencyMs,
      reconnectAttempts: this.reconnect.attempts,
      pairingState: this.pairingState,
      authenticationState: this.authenticationState,
      errorCount: this.errorCount,
      lastError: this.lastError,
      agentConnected: this.agentConnected,
    };
  }

  // ── internal ─────────────────────────────────────────────────────────────────

  private async runCommand(label: string, run: () => Promise<void>, opts: { dedupeKey: string | null; priority: number }): Promise<void> {
    const startedAt = Date.now();
    await this.queue.enqueue(run, opts);
    this.lastCommand = label;
    this.lastCommandAt = new Date().toISOString();
    this.lastCommandLatencyMs = Date.now() - startedAt;
  }

  private async establish(): Promise<void> {
    if (this.disposed || this.stoppedDeliberately) return;
    this.setState(this.reconnect.attempts > 0 ? "reconnecting" : "connecting");
    // A fresh transport instance per attempt keeps a half-open socket from a failed try
    // from leaking into the next one — mirrors CoolMasterConnection's ascii transport
    // being reused only across successful connections, never across a hard failure.
    if (this.reconnect.attempts > 0) {
      this.transport.dispose();
      this.transport = this.config.createTransport(this.config);
    }
    this.subscribeTransport();
    try {
      await this.transport.connect();
      this.reconnect.resetOnSuccess();
      this.lastConnectedAt = new Date().toISOString();
      this.pairingState = "paired";
      this.authenticationState = "authenticated";
      this.setState("connected");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.recordError(error);
      if (err instanceof TvPairingRequiredError) {
        this.pairingState = "pairing_required";
        this.setState("pairing_required");
        return; // never auto-retries a pairing requirement — needs installer action
      }
      if (err instanceof TvAuthenticationError) {
        this.authenticationState = "failed";
        this.setState("failed");
        if (!isTvErrorRetryable(err)) return;
      }
      this.setState("reconnecting");
      this.reconnect.scheduleNext();
    }
  }

  private subscribeTransport(): void {
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = this.transport.onEvent((event) => this.onTransportEvent(event));
  }

  private onTransportEvent(event: import("./tv-types.js").TvTransportEvent): void {
    if (this.disposed) return; // a late event from a transport mid-teardown is discarded, never re-armed
    switch (event.type) {
      case "media-state": {
        this.offerMediaState(event.state, event.source, event.revision);
        return;
      }
      case "foreground-app": {
        const accepted = this.cache.offerForegroundApp({
          value: event.app,
          source: event.app.source,
          timestamp: event.app.timestamp,
          revision: event.revision,
        });
        if (accepted) {
          this.lastStateEvent = new Date().toISOString();
          this.events.emit({ type: "foreground-app", app: event.app });
        }
        return;
      }
      case "connection-lost": {
        this.lastDisconnectedAt = new Date().toISOString();
        this.setState("degraded");
        if (!this.stoppedDeliberately) {
          this.setState("reconnecting");
          this.reconnect.scheduleNext();
        }
        return;
      }
      case "pairing-required": {
        this.pairingState = "pairing_required";
        this.setState("pairing_required");
        return;
      }
      case "authentication-failed": {
        this.authenticationState = "failed";
        this.recordError(new TvAuthenticationError(event.reason));
        this.setState("failed");
        return;
      }
      case "error": {
        this.recordError(event.error);
        this.events.emit({ type: "error", error: event.error });
        return;
      }
    }
  }

  /** §1/§4/§19 Phase 3 — the Agent's own event handler, deliberately separate from
   * `onTransportEvent`: media/foreground-app feedback still flows into the shared,
   * source-arbitrated cache, but connection/error events here update ONLY
   * `agentConnected` — an agent crash/restart/disable must never touch `state`, the
   * reconnect scheduler, or pairing/authentication state, all of which belong solely to
   * the primary (control) transport. */
  private onAgentEvent(event: import("./tv-types.js").TvTransportEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case "media-state":
        this.offerMediaState(event.state, event.source, event.revision);
        return;
      case "foreground-app": {
        const accepted = this.cache.offerForegroundApp({
          value: event.app,
          source: event.app.source,
          timestamp: event.app.timestamp,
          revision: event.revision,
        });
        if (accepted) {
          this.lastStateEvent = new Date().toISOString();
          this.events.emit({ type: "foreground-app", app: event.app });
        }
        return;
      }
      case "connection-lost":
        this.agentConnected = false;
        return;
      case "pairing-required":
      case "authentication-failed":
        // The Agent has its own pairing/auth story (§3), but it must never masquerade
        // as the primary transport's pairing/authentication state — only its own
        // reachability is affected.
        this.agentConnected = false;
        return;
      case "error":
        // An agent-side error is diagnostic-worthy but not a session-level failure —
        // surfaced to listeners so UI/diagnostics can show it, without touching
        // errorCount/lastError, which are reserved for the control path.
        this.events.emit({ type: "error", error: event.error });
        return;
    }
  }

  /** §14 Phase 3 — shared media-state offer path for both the primary transport and
   * the Agent: always updates the cache (so `getMediaState()` is never stale), but
   * throttles the EMITTED session event to at most one per POSITION_ONLY_COALESCE_MS
   * when the update changes nothing but `positionSec` — a genuine metadata/playback/app
   * change always emits immediately, uncoalesced. */
  private offerMediaState(state: Partial<TvMediaState>, source: string, revision: number | undefined): void {
    const accepted = this.cache.offerMedia({ value: state, source, timestamp: new Date().toISOString(), revision });
    if (!accepted) return;
    this.lastStateEvent = new Date().toISOString();

    const isPositionOnlyChange = this.lastEmittedMedia !== null && this.isPositionOnlyDelta(this.lastEmittedMedia, state);
    const now = Date.now();
    const coalesceMs = this.config.mediaPositionCoalescingMs ?? DEFAULT_MEDIA_POSITION_COALESCING_MS;
    if (isPositionOnlyChange && now - this.lastPositionEmitAt < coalesceMs) return;

    this.lastEmittedMedia = { ...this.lastEmittedMedia, ...state };
    this.lastPositionEmitAt = now;
    this.events.emit({ type: "media-state", state, source });
  }

  /** True when `next` sets no key other than `positionSec` to a value different from
   * what `prev` already held (keys `next` doesn't mention are not a "change"). */
  private isPositionOnlyDelta(prev: Partial<TvMediaState>, next: Partial<TvMediaState>): boolean {
    for (const key of Object.keys(next) as (keyof TvMediaState)[]) {
      if (key === "positionSec") continue;
      if (next[key] !== prev[key]) return false;
    }
    return true;
  }

  private recordError(error: Error): void {
    this.errorCount += 1;
    this.lastError = error.message;
  }

  private setState(state: TvSessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.emit({ type: "connection-state", state });
  }
}

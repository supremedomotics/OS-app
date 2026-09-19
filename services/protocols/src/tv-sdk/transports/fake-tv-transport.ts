import { TvAuthenticationError, TvConnectionError, TvPairingRequiredError } from "../tv-errors.js";
import type { TvDeviceConfig, TvForegroundApp, TvMediaState, TvRemoteKey, TvTransport, TvTransportEvent } from "../tv-types.js";

/** (§34 Test Doubles) In-process fake transport with deterministic fault injection —
 * the TV-SDK equivalent of CoolMaster's `FakeGateway`. Tests hold a reference to the
 * SAME instance a session is using (via `createTransport`) so they can mutate
 * `fixture`/call `failNextConnect()`/`emit()` to drive the session through every
 * documented failure mode without any real network I/O. */
export class FakeTvTransport implements TvTransport {
  readonly kind = "fake";
  readonly received: TvRemoteKey[] = [];
  readonly launchedApps: string[] = [];
  volumePercent: number | null = null;
  muted: boolean | null = null;
  private connected = false;
  private disposed = false;
  private listeners = new Set<(event: TvTransportEvent) => void>();

  private failNextConnectWith: Error | null = null;
  private connectDelayMs = 0;

  constructor(readonly config: TvDeviceConfig) {}

  failNextConnect(kind: "connection" | "pairing" | "authentication" = "connection"): void {
    this.failNextConnectWith =
      kind === "pairing"
        ? new TvPairingRequiredError("fake: pairing required")
        : kind === "authentication"
          ? new TvAuthenticationError("fake: authentication failed")
          : new TvConnectionError("fake: connection refused");
  }

  setConnectDelay(ms: number): void {
    this.connectDelayMs = ms;
  }

  async connect(): Promise<void> {
    if (this.connectDelayMs > 0) await new Promise((r) => setTimeout(r, this.connectDelayMs));
    if (this.failNextConnectWith) {
      const err = this.failNextConnectWith;
      this.failNextConnectWith = null;
      throw err;
    }
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendKey(key: TvRemoteKey): Promise<void> {
    if (!this.connected) throw new TvConnectionError("fake: not connected");
    this.received.push(key);
  }

  async launchApp(packageName: string): Promise<void> {
    if (!this.connected) throw new TvConnectionError("fake: not connected");
    this.launchedApps.push(packageName);
  }

  async setVolume(percent: number): Promise<void> {
    if (!this.connected) throw new TvConnectionError("fake: not connected");
    this.volumePercent = percent;
  }

  async setMuted(muted: boolean): Promise<void> {
    if (!this.connected) throw new TvConnectionError("fake: not connected");
    this.muted = muted;
  }

  onEvent(listener: (event: TvTransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Test-only: simulate the device pushing an event (media update, connection drop,
   * duplicate/out-of-order event, etc.) — §24/§28 fault-injection surface. */
  emit(event: TvTransportEvent): void {
    for (const l of this.listeners) l(event);
  }

  emitMediaState(state: Partial<TvMediaState>, opts: { source?: string; revision?: number } = {}): void {
    this.emit({ type: "media-state", state, source: opts.source ?? "fake", revision: opts.revision });
  }

  emitForegroundApp(app: TvForegroundApp, revision?: number): void {
    this.emit({ type: "foreground-app", app, revision });
  }

  /** Simulates an unexpected mid-session drop (distinct from a graceful disconnect()) —
   * the case a reconnect scheduler must react to. */
  simulateConnectionLost(reason = "fake: connection lost"): void {
    this.connected = false;
    this.emit({ type: "connection-lost", reason });
  }

  dispose(): void {
    this.connected = false;
    this.listeners.clear();
    this.disposed = true;
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}

import { TvDeviceSession } from "./tv-device-session.js";
import type { TvSessionEvent } from "./tv-events.js";
import type { TvDeviceConfig, TvForegroundApp, TvMediaState, TvRemoteKey, TvSessionDiagnostics } from "./tv-types.js";

/**
 * (§4/§5 — "one TV protocol-driver instance -> DeviceSessionManager -> TV001..TV100")
 * Owns every `TvDeviceSession` for one driver instance, keyed by Supreme deviceId. This
 * is the ONLY place that fans an event out to per-device listeners; a platform driver
 * (AndroidTvDriver etc., added in a later phase) wraps this manager to implement
 * `INativeProtocolDriver`, translating `TvSessionEvent`s into Supreme `CapabilityState`
 * updates — that translation is deliberately NOT here, so this manager stays ignorant of
 * Supreme's capability model, matching how coolmaster-connection.ts/coolmaster-events.ts
 * stay ignorant of it too (only coolmaster-driver.ts does that translation).
 *
 * Isolation is structural: each entry in `sessions` is a fully independent object graph
 * (own transport, own reconnect scheduler, own command queue, own state cache, own event
 * bus — see TvDeviceSession's doc comment). There is no shared mutable state between
 * sessions anywhere in this class, which is what makes the §27 cross-device isolation
 * tests provable rather than merely "believed to be true."
 */
export class TvDeviceSessionManager {
  private readonly sessions = new Map<string, TvDeviceSession>();
  private readonly unsubscribers = new Map<string, () => void>();
  private readonly forwardListeners = new Set<(deviceId: string, event: TvSessionEvent) => void>();

  /** Idempotent per the interface's own bind contract expectations: binding an
   * already-bound deviceId disposes the old session first rather than leaking a second
   * one alongside it (§20/§22 — repeated bind/unbind must not increase resource counts). */
  async bind(config: TvDeviceConfig): Promise<TvDeviceSession> {
    const existing = this.sessions.get(config.deviceId);
    if (existing) await this.unbind(config.deviceId);

    const session = new TvDeviceSession(config);
    const unsubscribe = session.onEvent((event) => {
      for (const l of this.forwardListeners) l(config.deviceId, event);
    });
    this.sessions.set(config.deviceId, session);
    this.unsubscribers.set(config.deviceId, unsubscribe);
    await session.connect();
    return session;
  }

  /** §20 unbind — idempotent, only ever touches the ONE named session. Calling it for a
   * deviceId that isn't bound is a no-op, never an error (matches CoolMaster's unbind()
   * convention). */
  async unbind(deviceId: string): Promise<void> {
    const session = this.sessions.get(deviceId);
    if (!session) return;
    session.disconnect();
    session.dispose();
    this.unsubscribers.get(deviceId)?.();
    this.unsubscribers.delete(deviceId);
    this.sessions.delete(deviceId);
  }

  /** Disposes every session — used on driver disconnect()/shutdown. A failure disposing
   * one session must not prevent the rest from being cleaned up (§4 isolation applies to
   * teardown too, not just steady-state operation). */
  async unbindAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    const results = await Promise.allSettled(ids.map((id) => this.unbind(id)));
    for (const r of results) if (r.status === "rejected") throw r.reason;
  }

  manages(deviceId: string): boolean {
    return this.sessions.has(deviceId);
  }

  get(deviceId: string): TvDeviceSession | null {
    return this.sessions.get(deviceId) ?? null;
  }

  count(): number {
    return this.sessions.size;
  }

  async sendKey(deviceId: string, key: TvRemoteKey): Promise<void> {
    await this.require(deviceId).sendKey(key);
  }

  async launchApp(deviceId: string, packageName: string): Promise<void> {
    await this.require(deviceId).launchApp(packageName);
  }

  async setVolume(deviceId: string, percent: number): Promise<void> {
    await this.require(deviceId).setVolume(percent);
  }

  async setMuted(deviceId: string, muted: boolean): Promise<void> {
    await this.require(deviceId).setMuted(muted);
  }

  getMediaState(deviceId: string): Partial<TvMediaState> | null {
    return this.sessions.get(deviceId)?.getMediaState() ?? null;
  }

  getForegroundApp(deviceId: string): TvForegroundApp | null {
    return this.sessions.get(deviceId)?.getForegroundApp() ?? null;
  }

  getDiagnostics(deviceId: string): TvSessionDiagnostics | null {
    return this.sessions.get(deviceId)?.getDiagnostics() ?? null;
  }

  /** Every diagnostics snapshot currently held — device-scoped entries, never an
   * aggregated/merged view, so a caller can never mistake one device's counters for
   * another's (§21 "diagnostics must be device-scoped"). */
  getAllDiagnostics(): TvSessionDiagnostics[] {
    return [...this.sessions.values()].map((s) => s.getDiagnostics());
  }

  /** Subscribes to every session's events, present and future, tagged with the deviceId
   * they came from — the single fan-in point a platform driver uses to bridge into
   * Supreme's `StateListener` model. */
  onEvent(listener: (deviceId: string, event: TvSessionEvent) => void): () => void {
    this.forwardListeners.add(listener);
    return () => this.forwardListeners.delete(listener);
  }

  private require(deviceId: string): TvDeviceSession {
    const session = this.sessions.get(deviceId);
    if (!session) throw new Error(`tv: ${deviceId} is not managed by this session manager`);
    return session;
  }
}

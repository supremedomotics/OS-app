import type { TvForegroundApp, TvMediaState, TvSessionState } from "./tv-types.js";

/** Per-session event bus — mirrors coolmaster-events.ts's CoolMasterEventBus shape.
 * One instance per `TvDeviceSession`; never a shared/global bus, so a listener
 * subscribed to one device's events physically cannot receive another's. */
export type TvSessionEvent =
  | { type: "connection-state"; state: TvSessionState }
  | { type: "media-state"; state: Partial<TvMediaState>; source: string }
  | { type: "foreground-app"; app: TvForegroundApp }
  | { type: "error"; error: Error };

export type TvSessionEventListener = (event: TvSessionEvent) => void;

export class TvSessionEventBus {
  private readonly listeners = new Set<TvSessionEventListener>();

  emit(event: TvSessionEvent): void {
    for (const l of this.listeners) l(event);
  }

  on(listener: TvSessionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Releases every listener — called from TvDeviceSession.dispose() so a disposed
   * session can never leak a subscription (§22 Resource Management). */
  dispose(): void {
    this.listeners.clear();
  }
}

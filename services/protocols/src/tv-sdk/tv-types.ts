import type { CapabilityState } from "@supreme/domain-model";

/** `MediaState` itself is a zod schema (a value), not a type — this is the repo's real
 * exported TS shape for it (the "media" arm of the `CapabilityState` discriminated
 * union, minus its `kind` discriminant). Avoids adding a direct `zod` dependency to this
 * package just to write `z.infer<typeof MediaState>` locally. */
export type TvMediaState = Omit<Extract<CapabilityState, { kind: "media" }>, "kind">;

/**
 * (§ TV SDK Core) Shared types for the reusable TV platform SDK
 * (services/protocols/src/tv-sdk/). One `TvDeviceSession` = one physical TV/streaming
 * box, fully isolated (its own transport, reconnect scheduler, command queue, state
 * cache, diagnostics) — see tv-device-session.ts and tv-device-session-manager.ts's doc
 * comments for why this differs from CoolMaster's "one shared gateway connection" shape.
 */

/** Per-session connection lifecycle (§19 Reconnect/Self-Healing). Distinct from
 * CoolMasterConnectionState: TV devices have a real pairing step and can independently
 * be "disabled" (installer turned the device off without unbinding it). */
export type TvSessionState =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "connected"
  | "degraded"
  | "reconnecting"
  | "pairing_required"
  | "failed"
  | "disabled";

/** Remote-control key vocabulary (§6) — a superset every transport implements as much of
 * as the underlying platform actually supports; unsupported keys reject with
 * TvUnsupportedCommandError rather than silently no-op. */
export type TvRemoteKey =
  | "DPAD_UP"
  | "DPAD_DOWN"
  | "DPAD_LEFT"
  | "DPAD_RIGHT"
  | "DPAD_CENTER"
  | "BACK"
  | "HOME"
  | "POWER"
  | "VOLUME_UP"
  | "VOLUME_DOWN"
  | "MUTE"
  | "PLAY"
  | "PAUSE"
  | "PLAY_PAUSE"
  | "NEXT"
  | "PREVIOUS"
  | "STOP"
  | "FAST_FORWARD"
  | "REWIND"
  | "MENU"
  | "INFO"
  | "SETTINGS"
  | "SEARCH";

/** Foreground-app detection (§11/§12) — every detector normalizes to this shape so the
 * arbiter (tv-feedback-arbiter.ts, added when a real detector exists) can compare sources
 * uniformly. `confidence: "unknown"` means "no trustworthy source available", never a
 * guess dressed up as a real value. */
export type TvForegroundAppConfidence = "exact" | "metadata" | "app_only" | "unknown";

export interface TvForegroundApp {
  packageName: string | null;
  applicationName: string | null;
  source: string;
  confidence: TvForegroundAppConfidence;
  timestamp: string;
}

/** One transport's contribution to a device's overall state — the isolated identity for
 * an installed app on the device (§30 App Registry). */
export interface TvAppRegistryEntry {
  packageName: string;
  applicationName: string | null;
  versionName: string | null;
  versionCode: string | null;
  launchable: boolean;
  installed: boolean;
  lastSeen: string;
}

/** Stable device identity (§17) — never IP alone, never friendly name alone. A transport
 * populates whatever it can legitimately obtain; `confidence: "weak"` must be surfaced to
 * the installer/diagnostics rather than silently trusted, per the explicit instruction not
 * to fabricate identity. */
export interface TvIdentity {
  /** The identity actually used for stable addressing across IP/DHCP changes — a real
   * platform-reported serial/device-cert id when available, otherwise a documented
   * fallback (e.g. host+MAC) with `confidence: "weak"`. */
  stableId: string;
  confidence: "strong" | "weak";
  platform: "android_tv" | "google_tv" | "fire_os" | "vega_os";
  manufacturer: string | null;
  model: string | null;
  lastKnownAddress: string | null;
}

/** One transport implementation (Remote v2, ADB, Cast, Agent, Vega adapter). A
 * `TvDeviceSession` owns exactly one active transport at a time; swapping/falling back
 * between transports is a session-level policy, not a transport concern. Every method is
 * scoped to the ONE device this transport instance was constructed for — there is no
 * batch/multi-device surface here, matching the "N independent sockets" topology decided
 * in the Phase 0 audit. */
export interface TvTransport {
  readonly kind: string;
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  sendKey(key: TvRemoteKey): Promise<void>;
  launchApp?(packageName: string): Promise<void>;
  setVolume?(percent: number): Promise<void>;
  setMuted?(muted: boolean): Promise<void>;
  /** Pull-based fallback for transports with no push channel (e.g. plain ADB polling). */
  pollMediaState?(): Promise<Partial<TvMediaState> | null>;
  pollForegroundApp?(): Promise<TvForegroundApp | null>;
  /** Push-based feedback — the preferred path (§23 "prefer event-driven over polling"). */
  onEvent(listener: (event: TvTransportEvent) => void): () => void;
  /** Releases every resource this transport instance holds (sockets, timers, listeners).
   * Must be safe to call multiple times and after connect() never succeeded. */
  dispose(): void;
}

export type TvTransportEvent =
  /** `revision` is optional — a source that genuinely tracks one (e.g. a MediaSession
   * sequence number) should pass it through so `TvStateCache` can do real §28
   * revision-based ordering instead of falling back to arrival order (see that file's
   * doc comment for exactly when the fallback applies). */
  | { type: "media-state"; state: Partial<TvMediaState>; source: string; revision?: number }
  | { type: "foreground-app"; app: TvForegroundApp; revision?: number }
  | { type: "connection-lost"; reason: string }
  | { type: "pairing-required" }
  | { type: "authentication-failed"; reason: string }
  | { type: "error"; error: Error };

export interface TvDeviceConfig {
  deviceId: string;
  /** Last-known network address — used to attempt reconnect, never as the permanent
   * identity (§17). */
  host: string;
  platform: TvIdentity["platform"];
  /** Which transport(s) this device should use, preference-ordered. Session-level
   * fallback between them is out of scope for Phase 1 (fake transports only) and lands
   * with the real Android TV Remote v2 / ADB transports in later phases. */
  transportKind: string;
  timeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** §8 Phase 3A — a position-only media-state update is throttled to at most one
   * emitted session event per this window (the cache itself is still updated on every
   * offer — see tv-device-session.ts's offerMediaState). Deliberately a tunable policy,
   * not a silent hardcoded constant: the right value depends on real MediaSession
   * callback frequency, which isn't known until real-device measurement. Defaults to
   * DEFAULT_MEDIA_POSITION_COALESCING_MS. */
  mediaPositionCoalescingMs?: number;
  /** Injectable transport factory — production wiring supplies the real transport;
   * tests supply a fake. Keeps TvDeviceSession ignorant of concrete transport classes,
   * matching how CoolMasterConnection is handed a socket factory rather than importing
   * `node:net` directly. */
  createTransport: (config: TvDeviceConfig) => TvTransport;
}

export interface TvSessionDiagnostics {
  deviceId: string;
  platform: string;
  connectionState: TvSessionState;
  activeTransport: string;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  lastStateEvent: string | null;
  lastCommand: string | null;
  lastCommandAt: string | null;
  lastCommandLatencyMs: number | null;
  reconnectAttempts: number;
  pairingState: "not_required" | "pairing_required" | "paired";
  authenticationState: "not_required" | "authenticated" | "failed";
  errorCount: number;
  lastError: string | null;
  /** §4 Phase 3 — the optional TV Agent's reachability, tracked SEPARATELY from the
   * primary transport's `connectionState`. `null` = no agent ever attached (Remote-v2-
   * only device); an agent that disconnects must never be conflated with "TV offline" —
   * control can remain fully available while rich feedback is merely degraded. */
  agentConnected: boolean | null;
}

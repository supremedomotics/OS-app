/**
 * (§17 Phase 3A — Android Agent implementation contract) NOT IMPLEMENTED. There is no
 * Android application project in this repository — this file is the formal component
 * contract the future Android TV Agent project must satisfy, so that implementation
 * consumes the already-defined wire protocol (tv-agent-protocol.ts) rather than
 * inventing a second one. Every interface below describes a RESPONSIBILITY and its
 * boundary, not a class to instantiate from TypeScript — the real types live in Kotlin/
 * Java against `android.media.session.*`/`android.accessibilityservice.*`/
 * `android.content.pm.PackageManager`, none of which exist on this side of the wire.
 *
 * Component tree (§17):
 *   SupremeOsAgentService
 *     +-- SecureConnectionManager   (§1/§3 — TLS + pairing/session lifecycle)
 *     +-- PairingManager            (§2 — drives tv-agent-pairing-state.ts's state machine)
 *     +-- MediaSessionObserver      (§18 — MediaController/MediaMetadata/PlaybackState)
 *     +-- ForegroundAppObserver     (§19 — AccessibilityService or platform equivalent)
 *     +-- AccessibilityObserver     (§19 — the specific AccessibilityService, if granted)
 *     +-- AppInventoryProvider      (§20 — PackageManager)
 *     +-- DeviceInfoProvider        (manufacturer/model/OS/API level — static-ish)
 *     +-- StatePublisher            (normalizes + sends AgentMessage over the wire)
 *     +-- HeartbeatManager          (§7 — tv-agent-heartbeat.ts's policy, Agent side)
 *     +-- LocalStateCache           (§24 — bounded offline retention only)
 *
 * Each is independent (§17 "keep these components independent") — MediaSessionObserver
 * must function with ForegroundAppObserver entirely absent/permission-denied, and vice
 * versa; neither depends on AccessibilityObserver existing.
 */

/** §19 — an observer's OWN health, distinct from the Agent's overall connection state.
 * "unknown" must never be silently reported as a detected value (§19 explicit rule) —
 * `unavailable`/`permission_required`/`degraded` are the only honest substitutes. */
export type TvAgentObserverAvailability = "available" | "unavailable" | "permission_required" | "degraded";

/** §18 MediaSessionObserver responsibility contract. A real implementation wraps
 * `android.media.session.MediaSessionManager.getActiveSessions()` (requires a bound
 * notification-listener component) and, per active `MediaController`, registers a
 * `MediaController.Callback` for `onPlaybackStateChanged`/`onMetadataChanged`/
 * `onQueueChanged` — never polls `getPlaybackState()` on a timer as the primary path
 * (§6 Phase 3 "callback-driven feedback"; polling is reconciliation-only, §6). */
export interface TvAgentMediaSessionObserverContract {
  /** MUST enumerate every currently accessible session, not just the first. */
  enumerateAccessibleSessions(): Promise<TvAgentObserverAvailability>;
  /** Registers `MediaController.Callback` for one session; called once per session,
   * paired 1:1 with `unregisterSession` (§22 "every registration has a matching
   * unregister" — a leaked callback here is exactly the class of Android lifecycle bug
   * §23's resource tests exist to catch). */
  registerSession(sessionToken: unknown): void;
  unregisterSession(sessionToken: unknown): void;
  /** Maps one `PlaybackState`+`MediaMetadata` pair to `AgentMediaSessionPayload` —
   * MUST only populate fields the platform actually returned this call (§5 "only
   * transmit fields actually available" — never fabricate/infer a field the API left
   * null). */
  normalize(state: unknown, metadata: unknown): unknown; // -> AgentMediaSessionPayload, Android-side type
}

/** §19 ForegroundAppObserver responsibility contract — independent of
 * MediaSessionObserver; either may be unavailable while the other works fully. */
export interface TvAgentForegroundAppObserverContract {
  availability(): TvAgentObserverAvailability;
  /** MUST include `source` and `confidence` on every report (never bare package name) —
   * mirrors TvForegroundApp's existing shape (tv-types.ts) exactly, so SupremeOS-side
   * arbitration needs no Android-specific special case. */
  currentForegroundApp(): unknown; // -> AgentForegroundAppPayload
}

/** §20 AppInventoryProvider — wraps `PackageManager.getInstalledApplications()` +
 * `queryIntentActivities()` (for `launchable`). MUST debounce/coalesce package-changed
 * broadcasts (`ACTION_PACKAGE_ADDED`/`REMOVED`/`REPLACED`) rather than rebuilding the
 * full inventory on every foreground-app event (§20 explicit rule) — and MUST enforce
 * `AGENT_LIMITS.maxAppInventoryEntries`/name-length caps client-side too, not rely on
 * SupremeOS to reject an oversized snapshot after the fact. */
export interface TvAgentAppInventoryProviderContract {
  snapshot(): Promise<unknown[]>; // -> AgentAppInventoryEntry[]
  onPackageChanged(listener: (event: "added" | "removed" | "updated", packageName: string) => void): () => void;
}

/** §1/§3 SecureConnectionManager — TLS transport + the authenticated-session lifecycle.
 * Cryptography MUST use platform-provided primitives only (Android Keystore for key
 * generation/storage, `javax.net.ssl`/BoringSSL-backed TLS via `SSLContext`) — §1
 * "do not invent cryptographic algorithms, do not create custom encryption." Long-lived
 * pairing credentials MUST live in Android Keystore-backed storage, never a plaintext
 * file/SharedPreferences (§1 "no long-lived secrets in plaintext"). */
export interface TvAgentSecureConnectionManagerContract {
  establishSession(pairingCode: string): Promise<{ sessionId: string }>;
  /** MUST be rejected/refused locally (never attempted) once the pairing state machine
   * reports `requiresExplicitRepair()` (tv-agent-pairing-state.ts) — no automatic
   * reconnection after revocation. */
  reconnectWithStoredCredentials(): Promise<{ sessionId: string } | "requires_explicit_repair">;
  rotateCredentials(): Promise<void>;
  revokeLocally(): Promise<void>;
}

/** §7 HeartbeatManager — Agent-side counterpart to tv-agent-heartbeat.ts's policy; MUST
 * use the SAME `DEFAULT_AGENT_HEARTBEAT_POLICY.intervalMs` (or a value SupremeOS
 * negotiated during `hello`) so both sides agree on the health contract without a
 * separate negotiation message. */
export interface TvAgentHeartbeatManagerContract {
  start(intervalMs: number): void;
  stop(): void;
}

/** §24 LocalStateCache — offline operation only. MUST be BOUNDED (§24 "do not build an
 * unlimited offline event queue") — a fixed-size ring of the most recent state per
 * field group (current media session, current foreground app), never a growing event
 * log. On reconnect, this is what seeds the snapshot messages (§10), then is cleared —
 * it is current-state cache, not a history store (§25 "primarily report current state,
 * not build a viewing-history database"). */
export interface TvAgentLocalStateCacheContract {
  maxRetainedEntries: number;
  currentMediaSnapshot(): unknown | null;
  currentForegroundAppSnapshot(): unknown | null;
}

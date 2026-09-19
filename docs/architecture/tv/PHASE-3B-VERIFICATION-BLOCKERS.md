# Phase 3B — Android TV Agent Verification Blockers

Status as of this document: **ANDROID AGENT SOURCE WRITTEN — UNCOMPILED / UNVERIFIED.**
Nothing in `android/supremeos-tv-agent/` has been compiled, built, or run. This document
tracks exactly what's missing before that can change, plus the findings from a manual
static audit performed without a working build.

## 1. Current implementation status

Written (Kotlin, never compiled): protocol codec, pairing state machine, heartbeat
policy, reconnect backoff, media position coalescer, `AgentSession`, `LocalStateCache`,
`SecureConnectionManager` (partial — see §5), `PairingManager`, `DeviceInfoProvider`,
`AppInventoryProvider`, `MediaSessionObserver`, `AccessibilityObserverService`,
`StatePublisher`, `SupremeOsAgentService` (wiring only, incomplete — see §12), manifest,
accessibility config, strings. 3 JUnit test files (written, never run).

Not written: pairing-code entry UI, certificate-pinning implementation, package-changed
broadcast receiver, fake-SupremeOS-server test harness, instrumentation tests, any
notification-channel/`startForeground()` code.

## 2. Exact environment blockers

```
Required JDK:          17 (matches apps/mobile/android's compileOptions target)
Required Gradle:       9.x wrapper (apps/mobile/android currently vendors 9.1.0)
Required Android SDK:  compileSdk 35, platform-tools + build-tools for API 35
Required Build Tools:  matching build-tools 35.x
Required Kotlin:       2.3.20 (repo's existing pin, apps/mobile/android/settings.gradle.kts)
Required AGP:          9.0.1 (repo's existing pin, same file)
```

This session has: no `java`, no `kotlinc`, `JAVA_HOME` unset, no `ANDROID_HOME`. All
four (JDK, Gradle, Android SDK, AGP/Kotlin toolchain) are missing. **This environment
cannot provide them without installing system packages, which was not authorized and
was not attempted.** Compiling `android/supremeos-tv-agent` requires either a different
execution environment with these installed, or explicit authorization to install them
here.

## 3. Protocol compatibility matrix (TS ↔ Kotlin)

| Concern | TypeScript (`tv-agent-protocol.ts`) | Kotlin (`AgentProtocol.kt`) | Status |
|---|---|---|---|
| Envelope fields | `protocolVersion, protocolMinor?, agentId, deviceId, messageId, timestamp, sessionId?, sequenceNumber?, messageType, payload` | identical field names, same optionality | MATCH |
| Major version | must equal `AGENT_PROTOCOL_VERSION` (1) | must equal `PROTOCOL_VERSION` (1) | MATCH |
| Minor version | any value tolerated; must be non-negative integer **if present** | any value tolerated on outgoing (`buildEnvelope`); **incoming `parseIncoming` never validates `protocolMinor`'s type/range at all** | **GAP** — see §12 finding 1 |
| sessionId/sequenceNumber requirement | required for every type except `hello`/`pair` | identical set, identical exemption | MATCH |
| Message types | 14 types, exhaustive | same 14 types in `semanticsOf`/`RECONNECT_SNAPSHOT_SEQUENCE` | MATCH |
| Snapshot/delta semantics | `MESSAGE_SEMANTICS` map | `semanticsOf()` map | MATCH, value-for-value |
| Reconnect sequence | `deviceInfo, appInventory, foregroundApp, mediaSession` | `RECONNECT_SNAPSHOT_SEQUENCE` — identical order | MATCH |
| `maxMessageBytes` | 65536 | 65536 | MATCH |
| `maxAppInventoryEntries` | 2000 | 2000 | MATCH |
| `maxPackageNameLength` / `maxApplicationNameLength` | 255 / 255 | 255 / 255 | MATCH |
| `maxMetadataFieldLength` | 500 | 500 | MATCH |
| `maxUriLength` | 2048 | 2048 | MATCH |
| `maxMediaIdLength` | 255 | 255 | MATCH |
| `maxSupportedActionsEntries` / `maxCustomActionsEntries` | 64 / 64 | 64 / 64 | MATCH |
| **Payload-level validation on incoming messages** | full per-`messageType` switch validating every required field, type, and length/count limit | **`parseIncoming` validates ONLY the envelope + protocol version — `checkLength`/`checkArrayLength` exist but are never called from any incoming-message path** | **GAP — significant, see §12 finding 2** |
| Pairing states | 9 states, exhaustive transition table | identical 9 states, identical table | MATCH |
| Revocation rule | only path out of `revoked` is `pairing_required` | identical | MATCH |
| Heartbeat interval/timeout | 15000 / 45000 ms | 15000 / 45000 ms | MATCH |
| Authorization/replay (server-side `TvAgentSessionRegistry`) | agentId↔deviceId binding, sequence-based replay rejection | Kotlin has no equivalent SERVER-role registry (correct — the Agent is the client, not the authority) but ALSO has no CLIENT-side check that an incoming message's `deviceId`/`sessionId` actually match its own — see §12 finding 3 | **GAP** |

**Conclusion: field-for-field envelope/limits/semantics compatibility is exact. The
Kotlin side's weakness is entirely in what it does with a message AFTER the envelope
passes — payload validation and self-identity checks are incomplete.** These are
documented as gaps, not fixed, per this phase's "do not expand the implementation" rule.

## 4. Static Android API audit

Performed by reading every `.kt` file against documented Android SDK behavior — no
compiler, no IDE inspection, so this is necessarily incomplete. Findings:

**Fixed in this pass (safe, contained, no new feature surface):**
1. `MediaSessionObserver` keyed its tracking map by `MediaController` instance identity.
   `MediaSessionManager.getActiveSessions()` returns a **new** `MediaController` wrapper
   object on every call for the same underlying session (AOSP behavior), and
   `MediaController` does not override `equals()`/`hashCode()` — so the "already
   tracked, don't re-register" check was permanently false, defeating the class's own
   documented idempotency guarantee and causing register/unregister churn every
   refresh. **Fixed**: now keyed by `MediaSession.Token`, which has real structural
   equality.
2. `AndroidManifest.xml` was missing `FOREGROUND_SERVICE` and (API 34+)
   `FOREGROUND_SERVICE_DATA_SYNC` permissions required for
   `SupremeOsAgentService`'s declared `foregroundServiceType="dataSync"`. **Fixed** —
   permissions added.

**Documented, NOT fixed (would require new code = scope expansion, blocked by this
phase's rules):**
3. `SupremeOsAgentService` declares a foreground-service type but **never calls
   `startForeground()`** and creates no `NotificationChannel`. As written, starting
   this service on API 26+ would very likely throw
   `ForegroundServiceStartNotAllowedException`/be killed by the system within seconds.
   Needs: a notification channel + a call to `startForeground(id, notification)` early
   in `onCreate()` or `onStartCommand()`.
4. `AndroidKeyStore` EC keypair (`SecureConnectionManager.ensureIdentityKeyExists()`)
   is generated but **never wired into the TLS handshake at all** —
   `openTlsSocket()` builds an `SSLContext` with a `TrustManager` only (`init(null,
   arrayOf(trustManager), null)` — the first arg, `KeyManager[]`, is `null`), so no
   client certificate is ever presented. The generated keypair is currently dead code.
   See §5 for the design decision this needs before it's fixed.
5. `checkLength`/`checkArrayLength` in `AgentProtocol.kt` are defined but unused —
   direct evidence of finding 2 above (payload validation was never wired up).
6. `PairingManager.canAutoReconnect()`'s logic (`isUsable(state) ||
   state == AUTHENTICATED`) is a confusing predicate — worth revisiting when the real
   reconnect flow is implemented; not touched now since its intended semantics aren't
   pinned down by any test yet.
7. `AppInventoryProvider.registerPackageChangeListener()` and
   `SecureConnectionManager`'s cert-pinning trust manager are explicit `TODO` stubs —
   already flagged in the Phase 3B report, not new findings.
8. API-level notes: `MediaSessionManager`/`MediaController` (API 21+, but
   `getActiveSessions()` requires a bound `NotificationListenerService`, itself API
   18+), `AccessibilityService` (API 4+, config XML attributes used here are API 16+),
   `PackageManager.getInstalledApplications` (all API levels, but API 30+ package
   visibility needs the `<queries>` block already present in the manifest),
   `AndroidKeyStore` EC key generation (API 23+ for EC; this app's `minSdk = 24` is
   already above that), `EncryptedSharedPreferences` (`androidx.security.crypto`, works
   down to API 23). No API used requires higher than `minSdk = 24`, as far as this
   static read can determine — **not verified without a compiler**.

## 5. Security architecture decision (§4 of the request)

**Chosen design: Option B — TLS for confidentiality + pinned server-certificate for
server authentication, layered with the application-layer pairing/session protocol
(already fully specified in Phase 3A) for Agent authentication, device binding, replay
protection, rotation, and revocation. NOT mutual TLS.**

Rationale:
- This is the same pattern Android TV Remote v2 already uses in this exact codebase
  (self-signed server TLS + an out-of-band, application-layer secret exchange for
  pairing — see `pairing-secret.ts`), so the Agent channel stays architecturally
  consistent with the transport SupremeOS already ships, rather than introducing a
  second, differently-shaped trust model.
- Phase 3A's server-side `TvAgentSessionRegistry` already implements exactly the
  device-binding/replay/revocation machinery this decision needs, entirely at the
  application layer. Duplicating that in an X.509 client-certificate lifecycle (issuance,
  storage, rotation, CRL/OCSP-equivalent revocation across heterogeneous Android TV/OEM
  Keystore implementations) would be a second, parallel, harder-to-operate trust plane
  for no protection this design doesn't already provide.
- Revoking a compromised Agent becomes "delete a row in `TvAgentSessionRegistry`,"
  not "manage a certificate revocation list across every OEM's TLS stack" — operationally
  far simpler at 100-agent scale (§17).

**Consequence for the current code:** the `AndroidKeyStore` EC keypair
`SecureConnectionManager` generates is **not** a TLS client certificate under this
design. Its purpose becomes proving Agent identity continuity at the application layer
(e.g., signing the `hello`/`pair` handshake, analogous to how Remote v2's pairing secret
binds a specific RSA keypair to a pairing ceremony) — this needs a follow-up change to
either wire the keypair into the pairing message signing, or remove it if a simpler
symmetric-secret scheme is chosen instead. **Not implemented in this pass** (new
feature work, blocked by this phase's scope rule).

The certificate-pinning `TrustManager` itself (server authentication) still needs
real implementation: pin the SupremeOS hub's self-signed certificate, captured once
during the pairing exchange and persisted in the same `EncryptedSharedPreferences`
store as everything else — **not** the "trust-all" anti-pattern; a stub still throws
until a real cert is loaded. **Not implemented in this pass.**

## 6. Pairing flow (designed, not implemented)

```
Agent installed
      │
      ▼
  pairing_required            (AgentPairingStateMachine: UNKNOWN -> DISCOVERED -> PAIRING_REQUIRED)
      │  Agent generates (once) a persistent agentId (SecureConnectionManager.loadOrCreateAgentId)
      │  and displays it + a short pairing code on-screen (UI not yet built)
      ▼
  SupremeOS discovers Agent    (LAN discovery mechanism not yet designed — likely mDNS,
      │                         matching the existing tools/discover-supremeos-url pattern)
      ▼
  installer authorizes pairing (explicit action in the SupremeOS installer UI — an Agent
      │                         must NEVER be auto-trusted merely for appearing on the LAN)
      ▼
  secure credential exchange   (hello -> pair -> authenticated, per tv-agent-protocol.ts;
      │                         server captures the hub's TLS cert fingerprint for pinning)
      ▼
  device binding               (SupremeOS's TvAgentSessionRegistry.bind(agentId, deviceId, sessionId))
      ▼
  authenticated -> connected    (AgentPairingStateMachine)
```

Post-pairing scenarios, decided but not implemented:
- **Credential loss / Agent reinstall**: `agentId` is regenerated (a fresh install has
  no Keystore-backed identity to recover); SupremeOS sees this as a NEW agent and
  requires a fresh, explicit pairing — never auto-bound to the old `deviceId`.
- **SupremeOS reinstall / factory reset**: the hub's own device registry is gone;
  every Agent must re-pair. The Agent itself keeps its stored `agentId`/pairing state
  until it reconnects and gets rejected (`unknown_session`/`revoked`-equivalent),
  at which point `PairingManager` must transition back to `pairing_required`.
- **Credential revocation**: SupremeOS calls `TvAgentSessionRegistry.revoke()`
  server-side; the next message from that Agent is rejected, and (per
  `AgentPairingStateMachine`) the Agent can only recover via an explicit re-pair, never
  automatically.
- **Device reassignment**: not automatic — `TvAgentSessionRegistry.bind()` already
  throws on an attempt to rebind an existing `agentId` to a different `deviceId`; a
  genuine reassignment requires an explicit `unbind()` + fresh `bind()` on the
  SupremeOS side, an installer action, never inferred from the Agent's traffic alone.
- **Agent identity collision** (two physical devices somehow generating the same
  `agentId` — should be cryptographically implausible with UUIDv4, but): the SECOND
  Agent to attempt `bind()` for an already-bound `agentId` pointing at a different
  device is rejected by the existing `bind()` throw; this needs no new code.

## 7. MediaSession architecture — distinguishing availability from richness

`MediaSessionObserver.availability()` distinguishes: no `MediaSessionManager` service
(`UNAVAILABLE`), present but the notification-listener grant is missing
(`PERMISSION_REQUIRED`, from the caught `SecurityException`), and normal operation
(`AVAILABLE`). Within `AVAILABLE`, `emit()` sets `confidence = METADATA` only when the
platform actually returned a non-null `MediaMetadata`, else `APP_ONLY` — every other
field (`shuffle`, `repeat`, `sessionRevision`) is left `null` rather than guessed,
matching §7's explicit "do not fabricate" rule. This structure is correct as designed;
it has never been exercised against a real app's session.

## 8. Foreground-app architecture — confirmed optional

`SupremeOsAgentService` holds no hard reference to `AccessibilityObserverService` —
`ForegroundAppObserver.isAccessibilityServiceEnabled()` is a query the service can make
before deciding whether to use accessibility-sourced foreground-app data at all;
`MediaSessionObserver`, `DeviceInfoProvider`, and `AppInventoryProvider` have zero
dependency on it. `AccessibilityObserverService`'s config sets
`canRetrieveWindowContent="false"` and only listens for
`TYPE_WINDOW_STATE_CHANGED` — structurally incapable of screen-content
scraping/OCR by the permissions it even requests.

## 9. Outstanding implementation gaps (not attempted this phase)

- `startForeground()` + notification channel (service will not start correctly without this)
- Certificate-pinning `TrustManager` (real implementation, per the §5 decision)
- Repurposing or removing the currently-unused AndroidKeyStore identity keypair
- Payload-level validation on `AgentProtocol.parseIncoming` (currently envelope-only)
- Pairing-code entry UI
- Package-changed `BroadcastReceiver` for `AppInventoryProvider`
- Fake-SupremeOS-server Android test harness
- Instrumentation tests (security/media/foreground/lifecycle suites)
- Hardware and scale/soak testing

## 10. Verification plans (for when a build environment exists)

**Compile verification plan**: `./gradlew :app:compileDebugKotlin` first (catches type
errors fast without a full assemble), then `./gradlew :app:assembleDebug`.

**Unit-test plan**: `./gradlew :app:testDebugUnitTest` — the 3 existing JUnit files
first; expand to cover the payload-validation gap (§3) once that code exists.

**Instrumentation-test plan**: requires an emulator/device — `MediaSessionObserver`
against a real or test `MediaSession`, `AccessibilityObserverService` via
`UiAutomator`-driven app switches, `SupremeOsAgentService` lifecycle via
`ServiceTestRule`.

**Security verification plan**: once the §5 pinning implementation exists, a fake
SupremeOS TLS server presenting a wrong/expired/self-signed-but-unpinned certificate
must be rejected; a real pinned cert must be accepted; the app-layer registry rejection
scenarios already covered server-side (Phase 3A's `tv-agent-session-registry.test.ts`)
need Kotlin-side equivalents exercising the SAME rejections from the Agent's receiving
end.

**Interoperability verification plan**: a Node-based fake SupremeOS server (reusing
`tv-agent-protocol.ts`'s `parseAgentMessageFromJson`) driving the real compiled APK
over a real TLS socket on a local network — the actual first end-to-end proof this
wire contract works across both languages.

**Hardware test plan**: unchanged from the Phase 3B report — at least one Android TV
device and one Google TV device, ideally two manufacturers, none available in this
environment.

## 11. Known unverified assumptions

- That `MediaSessionManager.getActiveSessions()`'s "new wrapper per call" behavior
  (the basis for finding 1) is accurate for the Android API levels this Agent targets —
  based on published AOSP source reading, not confirmed against a real device.
- That every Android TV/Google TV OEM implements `getActiveSessions()`,
  `AccessibilityService` window-state events, and `PackageManager` package-visibility
  rules identically to stock AOSP (explicitly flagged as unconfirmed in the original
  Phase 3B report and repeated here).
- That `androidx.security.crypto:1.1.0-alpha06`'s `EncryptedSharedPreferences.create()`
  signature (the `MasterKey`-object overload used here) is compatible with AGP 9.0.1 /
  compileSdk 35 — dependency versions were chosen by convention, not verified against a
  real dependency resolution.

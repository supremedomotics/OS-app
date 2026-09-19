# Phase 13.5 — SIP Voice Communication — Final Report

Scope: voice-only SIP domain abstraction and orchestration for door-station intercom calling.
Video, door release, unlock, and camera streaming are explicitly out of scope (Phases 13.6/13.7).

## 1. SIP technology evaluation

Performed. See
[PHASE_13_5_SIP_STACK_DECISION.md](PHASE_13_5_SIP_STACK_DECISION.md) — evaluated PJSIP/PJSUA2,
Linphone SDK, WebRTC-based Dart SIP (`dart_sip_ua`), native platform SIP APIs (none viable),
Sofia-SIP, reSIProcate, and CPaaS/cloud-relay SDKs (rejected outright as incompatible with
SupremeOS's local-first architecture) against the full criteria list (platform support, background
call delivery, PushKit/CallKit/ConnectionService fit, RTP/SRTP, codecs, NAT traversal, licensing,
maintenance, long-term viability).

## 2. Selected stack

**PJSIP/PJSUA2**, behind a native Android/iOS platform-channel module, reached exclusively through
the `SipEngine` abstraction. Decision doc §17.

## 3. Rejected alternatives

Linphone SDK (documented fallback), `dart_sip_ua`/WebRTC, Sofia-SIP, reSIProcate, native platform
SIP APIs, CPaaS/cloud SDKs. Decision doc §§18–19.

## 4. Licensing

PJSIP is dual-licensed (GPLv2 or a commercial license from Teluu). A commercial license is
required for SupremeOS's closed-source redistribution. **This has not been procured** — it is a
business/legal action item outside engineering's ability to resolve inside this phase. Decision
doc §§4, 20.

## 5. Architecture

`SupremeOS UI → SipService → SipEngine → [PJSIP native engine]`. See
[PHASE_13_5_SIP_ARCHITECTURE.md](PHASE_13_5_SIP_ARCHITECTURE.md) for the full data-flow, lifecycle,
and integration design.

## 6. SIP domain model

Implemented in `apps/new/shared/lib/src/sip/`: `SipAccountConfig`, `SipDoorStationConfig`,
`SipCredentials`, `SipRegistrationState`/`SipRegistrationStatus`, `SipCall`, `SipCallDirection`,
`SipCallState`, `SipTransport`, `SipAudioState`, `SipCodec`, `SipFailure`/`SipFailureReason`,
`SipEngine` (abstract), `MockSipEngine`, `SipService`. No library-specific type leaks into these
files or into the shared semantic model (`CallSession`/`CallState`, extended with a new
`doorStationId` field). **Classification: REAL** (real, tested Dart domain logic — not a stub).

## 7. Registration

Implemented: account configuration, registration, per-`hubId` status
(`unregistered/registering/registered/failed/expired`), failure surfacing, unregister.
**Classification: REAL** against `MockSipEngine`; **NATIVE BUILD ACCEPTANCE REQUIRED** for real
REGISTER/re-REGISTER/retry-backoff behavior, which only a real PJSIP engine can provide. Retry/
backoff and network-transition re-registration are explicitly a `SipEngine`-internal concern (see
architecture doc's Failure Handling section) — **NOT IMPLEMENTED** at the `SipService` level
because there is no real transport under `MockSipEngine` to lose, and delegated to whichever real
engine is eventually built.

## 8. Incoming calls

Implemented end-to-end at the domain-model level: engine `SipCall` (state `trying`) → door-station
resolution → `CallSession`(`CallState.incoming`) → `MobileRuntime.ingestIncomingCall`. Deterministic
state machine transitions through to `connected`/`ended`/`failed`, duplicate-INVITE and illegal-
transition handling, all covered by tests. **Classification: REAL** (domain logic);
**BACKEND CONTRACT MISSING** for the actual physical INVITE arriving from a real door station
(no native SIP engine exists yet to receive one) — same limitation already documented for
`CallSession` since Phase 12.5.

## 9. Outgoing calls

**Explicitly deferred — NOT IMPLEMENTED.** No existing SupremeOS doorphone architecture requires
placing an outgoing SIP call (the homeowner answers; they do not dial the door station). Per the
phase brief's own instruction not to implement functionality merely because the underlying
protocol supports it, `SipEngine`/`SipService` expose no outgoing-call method.

## 10. Android integration

**NOT IMPLEMENTED / NATIVE BUILD ACCEPTANCE REQUIRED.** This environment cannot build or run
Android native code (Gradle loopback-socket failure, no working `adb` — unchanged since Phase
13.1). The design constraint (reuse the Phase 13.3 runtime/foreground service, no second Dart
isolate, `ConnectionService` for OS call presentation only) is documented in the architecture
doc but no native Kotlin code was written this phase to avoid producing unverified/unverifiable
native code that would misrepresent its own status.

## 11. iOS integration

**NOT IMPLEMENTED / NATIVE BUILD ACCEPTANCE REQUIRED.** Same reason — no macOS/Xcode exists in
this environment (unchanged since Phase 13.0). Design constraint (PushKit wakes native code, which
must reach the SIP engine before Dart is alive) documented in the architecture doc.

## 12. CallKit

**NOT IMPLEMENTED / NATIVE BUILD ACCEPTANCE REQUIRED** on the native (Swift) side, for the same
environment reason as §11. The Dart-side half of the contract — the CallKit-UUID ↔
`(hubId, callId)` mapping, with no credential ever entering it — is **REAL**, implemented and
tested in `SipService.mapPlatformCallId`/`callIdForPlatformUuid`.

## 13. Android call integration

**NOT IMPLEMENTED / NATIVE BUILD ACCEPTANCE REQUIRED**, same reason as §10.

## 14. RTP/SRTP

**NOT IMPLEMENTED.** Requires the real PJSIP native engine, which does not exist in this build.
`SipAudioState`/`SipCodec` define the contract; `MockSipEngine`'s audio methods are honest no-ops.

## 15. Codecs

Modeled (`SipCodec`: PCMU, PCMA, G.722, Opus — decision doc §12's realistic floor for the target
door-station population). Negotiation itself is **NOT IMPLEMENTED** (requires the real engine).

## 16. DTMF

**Explicitly deferred — NOT IMPLEMENTED.** Not required by the current voice-only doorphone
workflow (answer/hangup/mute/speaker only); no DTMF send/receive method exists on `SipEngine` or
`SipService`.

## 17. NAT traversal

Not applicable to what was built this phase — no real transport exists yet. Architecturally
scoped as LAN-first, with the Tunnel Broker explicitly NOT assumed to carry SIP RTP (architecture
doc, Networking section) — remote (outside-LAN) voice calling is out of scope for this phase.

## 18. Network transitions

**NOT IMPLEMENTED / PRODUCTION HARDENING REQUIRED.** No real transport exists yet to transition.
The existing `ConnectionManager` Wi-Fi/mobile-data reconnect path (Hub control traffic) is
unaffected by and independent from this phase's work, as required.

## 19. Multi-Home

**REAL.** `SipAccountConfig`/`SipService` are keyed by `hubId` throughout; no global account or
global "current Home" concept exists anywhere in this code. Proven by the Home A/Home B isolation
tests in `apps/new/shared/test/sip_service_test.dart`.

## 20. Multiple door stations

**REAL.** `SipAccountConfig.doorStations`/`SipDoorStationConfig`/`doorStationFor` support any
number of independently identified door stations per Home, each resolved by its own SIP URI.
Proven by the "multiple door stations on the same Home resolve independently" test.

## 21. Security

**REAL** for everything at this layer: `SipCredentials` redacts its password in `toString()` and
is never retained by `SipService` beyond the `registerAccount` call; `answer`/`hangup`/
`setMuted`/`setSpeakerOn` all reject an unknown/forged `callId` as a silent no-op; the CallKit-UUID
map refuses to map an unknown call; **`SipService` has no door-unlock/release method at all** —
answering a call cannot unlock anything, structurally, not by a runtime check. Push-payload/
Intent-extra/notification/analytics/crash-log credential exposure is **N/A this phase** — no
native push/notification/Intent code was written (§§10–13).

## 22. Diagnostics

Data model is in place (`SipRegistrationStatus`, `SipCall` carry everything a future Professional
Mode SIP diagnostics screen needs) — **NOT IMPLEMENTED** as an actual UI (not yet required, per
the phase brief's own "do not build an enormous diagnostics UI unless already required").

## 23. Tests

All required deterministic scenarios implemented and passing in
`apps/new/shared/test/sip_service_test.dart` (19 tests): account lifecycle, registration state,
registration expiry, authentication failure, incoming call, call state transitions, duplicate
INVITE handling, malformed SIP event (unconfigured-Home drop), Home A/Home B isolation, multiple
door stations, Call UUID mapping, call termination/cleanup, authorization (no command execution
from an unknown call), no door-release capability exists, no credential leakage. Retry/backoff and
network-transition tests are **N/A** at this layer (§7, §18 — no real transport to retry/transition
against yet). **Classification: REAL.**

## 24. Native build status

**BLOCKED**, unchanged from every prior phase in this environment: no macOS/Xcode (iOS), Gradle
loopback-socket failure + no working `adb` (Android). No native SIP code was written this phase
specifically to avoid claiming a build/integration status that cannot be verified here.

## 25. Real SIP E2E status

**NOT ATTEMPTED / NOT APPLICABLE THIS PHASE.** No real SIP engine exists yet to test against a
real SIP server or door station. Real E2E (REGISTER/INVITE/100-180-200/ACK/RTP/BYE against a real
endpoint) is a **REAL-WORLD ACCEPTANCE TEST REQUIRED** item for whichever future phase completes
the native PJSIP engine.

## 26. Real-device status

**REAL-WORLD ACCEPTANCE TEST REQUIRED** for the entire native/device-facing surface (§§10–14,
24–25) — no device or simulator is reachable from this environment (established since Phase 13.0).

## 27. Visual QA status

**NOT APPLICABLE THIS PHASE.** No call UI (incoming/ringing/active/muted/speaker/ending/ended/
failed screens) was built this phase — this phase's deliverable is the domain model and
orchestration layer beneath where a call UI would attach. Building that UI against a domain model
that cannot yet receive a real call would mean visually inspecting screens with no real behavior
behind them; deferred to the phase that pairs a real (or realistically mocked, and clearly labeled
as such) native call-delivery path with the UI, per this project's standing rule against fabricated
screenshots/functionality.

## 28. Remaining blockers

1. **PJSIP commercial license not procured** (business/legal action, §4/§20 of decision doc).
2. **No native Android/iOS build capability in this environment** (environmental, unchanged since
   Phase 13.0/13.1) — blocks §§10–14, 24–27 entirely.
3. **No real SIP server/door station available to this session** — blocks §25 regardless of #2.

## 29. Classification matrix

| Area | Classification |
|---|---|
| SIP technology evaluation | REAL (complete, documented) |
| SIP domain model (`sip_domain`/`sip_account`/`sip_call`) | REAL |
| `SipEngine` abstraction | REAL (interface); no production implementation |
| `MockSipEngine` | REAL (as a test/dev tool — never claimed as production) |
| `SipService` orchestration | REAL |
| `CallSession`/`MobileRuntime` integration | REAL (reused, extended with `doorStationId`) |
| Registration lifecycle (against mock) | REAL |
| Registration retry/backoff/network-transition | NOT IMPLEMENTED (delegated to a real `SipEngine`) |
| Incoming call flow (domain-model level) | REAL |
| Incoming call flow (physical door station → app) | BACKEND CONTRACT MISSING |
| Outgoing calls | NOT IMPLEMENTED (deferred, not required) |
| DTMF | NOT IMPLEMENTED (deferred, not required) |
| Android native SIP/CallKit-equivalent integration | NOT IMPLEMENTED / NATIVE BUILD ACCEPTANCE REQUIRED |
| iOS native SIP/CallKit/PushKit integration | NOT IMPLEMENTED / NATIVE BUILD ACCEPTANCE REQUIRED |
| CallKit-UUID mapping (Dart side) | REAL |
| RTP/SRTP | NOT IMPLEMENTED |
| Codec negotiation | NOT IMPLEMENTED (codec vocabulary modeled: REAL) |
| NAT traversal | NOT IMPLEMENTED |
| Multi-Home isolation | REAL |
| Multiple door stations | REAL |
| Security (credential handling, call authorization, no door release) | REAL |
| Diagnostics UI | NOT IMPLEMENTED (data model REAL) |
| Tests (domain/service layer) | REAL |
| Native build | NOT IMPLEMENTED (environment cannot build) |
| Real SIP E2E | REAL-WORLD ACCEPTANCE TEST REQUIRED |
| Real-device acceptance | REAL-WORLD ACCEPTANCE TEST REQUIRED |
| Visual QA (call UI) | NOT APPLICABLE THIS PHASE (no UI built) |
| PJSIP commercial licensing | PRODUCTION HARDENING REQUIRED (business action, not engineering) |

## Regression gate (this phase)

- `flutter analyze`: clean (0 issues) — `shared`, `mobile`, `shared_ui`, `touchpanel`.
- Tests: `shared` 191 pass (+19 new SIP tests), `mobile` 83 pass, `shared_ui` 7 pass, `touchpanel`
  23 pass. Zero regressions in any of the "DO NOT REGRESS" list from the phase brief's status
  header.
- Web builds: `apps/new/mobile` and `apps/new/touchpanel` both succeed.
- Native builds: unchanged BLOCKED status (§24).
- No `services/*`, `cloud/*`, or `packages/*` file was modified this phase — no backend test run
  was required.

## Stop condition

Per the phase brief: stopping after Phase 13.5. Video, SIP video codecs, camera streaming, door
release, unlock, security relay control, new cloud relay, and unrelated Hub changes were not
implemented, touched, or designed beyond the explicit "future video compatibility" note in the
architecture document (a compatibility observation, not an implementation).

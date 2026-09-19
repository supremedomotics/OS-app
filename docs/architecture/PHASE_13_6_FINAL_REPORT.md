# Phase 13.6 — Native SIP Voice + Real End-to-End Acceptance — Final Report

## 1. Licensing status

**PRODUCTION HARDENING REQUIRED.** Full analysis in
[PHASE_13_6_SIP_LICENSING.md](PHASE_13_6_SIP_LICENSING.md). PJSIP requires a commercial license
from Teluu for SupremeOS's closed-source commercial distribution (GPLv2 is not viable). Not yet
procured — a business/legal action, not an engineering one. Codec-level risk identified and
mitigated at the design level: G.729/AMR carry separate patent-license obligations and are
excluded from the planned codec set (PCMU/PCMA/G.722/Opus only), so no additional unaddressed
codec-licensing burden exists beyond the core PJSIP commercial license.

## 2. Native SIP architecture

Documented in full in
[PHASE_13_6_SIP_NATIVE_ARCHITECTURE.md](PHASE_13_6_SIP_NATIVE_ARCHITECTURE.md):
`SupremeOS → SipService → SipEngine → NativeSipEngine → [native Kotlin/Swift bridge] → PJSIP`.
No `pjsua`/`pjsua2`/`pjmedia`/`pjlib` type crosses above `NativeSipEngine`.

## 3. PJSIP integration

**NOT LINKED.** No native build environment exists in this session to compile or link `pjsua2`
into an Android or iOS binary (see §22). What was built is the complete Dart-side contract
(`NativeSipEngine`) that a real PJSIP-backed native module must satisfy — this is real,
verifiable, tested code, but it is not itself a PJSIP integration.

## 4. Android integration

**NOT IMPLEMENTED / NATIVE BUILD ACCEPTANCE REQUIRED.** Design fully specified (native architecture
doc's Android section: one `pjsua2::Endpoint` per process, one `Account` per Home, `Call` map keyed
by SupremeOS `callId`, reuse of the Phase 13.3 runtime, no second isolate). No Kotlin code was
written, deliberately — unverifiable native glue calling an SDK this environment cannot compile
would not meet this project's "never fabricate" standard.

## 5. iOS integration

**NOT IMPLEMENTED / NATIVE BUILD ACCEPTANCE REQUIRED.** Same reasoning as §4; design specified in
the native architecture doc's iOS section (PushKit wakes native code before Dart is assumed alive,
immediate `CXProvider.reportNewIncomingCall`, no Home logic in `AppDelegate`).

## 6. CallKit

**Dart-side mapping: REAL** (`SipService.mapPlatformCallId`/`callIdForPlatformUuid`, from Phase
13.5, unchanged and still tested). **Native CallKit integration: NOT IMPLEMENTED / NATIVE BUILD
ACCEPTANCE REQUIRED** (§5).

## 7. Android call integration

**NOT IMPLEMENTED / NATIVE BUILD ACCEPTANCE REQUIRED** (§4). `ConnectionService` design specified
(OS presentation only, never owns Home/authorization/device state) but not built.

## 8. SIP registration

**REAL** at the domain/orchestration layer (`SipService`, Phase 13.5, unchanged) and **REAL** for
the new native wire-format contract (`NativeSipEngine.registerAccount`, tested against a mocked
channel — proves the full config, including all configured door stations, is sent, and that the
password is never logged, only ever placed on the channel argument map once). **Real REGISTER/
401-challenge/authenticated-REGISTER/200-OK/retry-backoff against an actual SIP server: NOT
IMPLEMENTED** (no native engine exists to perform it).

## 9. Incoming INVITE

**Domain/orchestration logic: REAL** (Phase 13.5, unchanged, still 19/19 passing).
**Wire-format parsing of a native `call` event: REAL** (`NativeSipEngine`, tested).
**An actual physical door station's INVITE reaching this code: BACKEND CONTRACT MISSING** — no
native SIP engine exists yet to receive one.

## 10. RTP/SRTP

**NOT IMPLEMENTED.** Requires the native `pjmedia` engine, not built this phase (§§3–5).

## 11. Codecs

Vocabulary modeled (`SipCodec`: PCMU/PCMA/G.722/Opus) and licensing-cleared (§1). Negotiation
itself: **NOT IMPLEMENTED** (requires the native media engine).

## 12. Audio

**NOT IMPLEMENTED.** No microphone capture, speaker output, or real audio session activation
exists — all require the native engine. `NativeSipEngine.setMuted`/`setSpeakerOn` define the
control surface a real implementation must respond to; they currently degrade to a documented
no-op when no native handler exists (proven by the "every method degrades honestly" test).
**No synthetic/generated audio was used or is claimed as evidence of anything.**

## 13. Network transitions

**NOT IMPLEMENTED / NOT APPLICABLE.** No real transport exists yet to transition. Design
constraint (SIP media and Hub control transport stay separate; Tunnel Broker carries no SIP RTP)
reaffirmed in the native architecture doc, unchanged from Phase 13.5.

## 14. NAT traversal

STUN: planned, opt-in, documented (native architecture doc's Networking/NAT section). TURN:
explicitly not planned — no architectural justification for relaying residential intercom media
through a TURN server. **Status: NOT IMPLEMENTED** (no real transport exists to traverse NAT
with yet); design decision recorded so it isn't silently revisited later.

## 15. PushKit/FCM

**Design only, reusing the existing Phase 13.2/13.4 push foundation exactly as required** — no new
push architecture was created. Native VoIP-push-to-CallKit wiring: **NOT IMPLEMENTED / NATIVE
BUILD ACCEPTANCE REQUIRED** (§5).

## 16. Multi-Home

**REAL**, unchanged from Phase 13.5 (`SipService` keyed by `hubId` throughout) — this phase adds
no new multi-Home logic, only a (currently unlinked) native transport beneath it. No test
regressed; isolation tests still pass.

## 17. Multiple door stations

**REAL**, unchanged from Phase 13.5. The new `NativeSipEngine.registerAccount` wire format
explicitly serializes the full `doorStations` list (proven by the "registerAccount sends the full
config" test) — the native side, once built, receives everything it needs to map an inbound
remote URI to a door station without any additional round-trip.

## 18. Security

**REAL** for everything actually built this phase: `NativeSipEngine` sends `SipCredentials.
password` over the channel exactly once per `registerAccount` call and never includes it in an
event frame; a registration-failure event's `failureDetail` field is documented as
Professional-Mode-diagnostic-only and the test suite confirms a failure's `toString()` never
leaks the raw detail text. Push payload / CallKit metadata / Android Intent extra / notification /
analytics / crash-log credential exposure: **NOT APPLICABLE THIS PHASE** — no native push,
notification, or Intent code was written (§§4–5, 15).

## 19. Diagnostics

Data model unchanged and sufficient (`SipRegistrationStatus`, `SipCall` — Phase 13.5). No
diagnostics UI built (not yet required, same as Phase 13.5's own conclusion).

## 20. Failure recovery

**REAL** at the Dart layer: `NativeSipEngine` drops any malformed/unknown event rather than
throwing (proven by the "unknown event type/state is dropped" test); `SipService`'s own
malformed-event/illegal-transition handling (Phase 13.5) is unchanged and still passing. Native
callback-exception-to-Dart-crash isolation: **design-only** (native architecture doc's Failure
Recovery section) — not built, since no native callbacks exist yet.

## 21. Tests

- New this phase: `apps/new/mobile/test/native_sip_engine_test.dart` — 7 tests (degrade-honestly,
  registerAccount full-payload/credential handling, answer/hangup/mute/speaker channel calls,
  registration-status success/failure parsing with credential-safety check, call-event parsing
  with codec/audio state, unknown-event/state resilience).
- Unchanged and still passing: `apps/new/shared/test/sip_service_test.dart` — 19 tests (Phase
  13.5's full account-lifecycle/incoming-call/state-transition/isolation/CallKit-mapping/
  authorization suite).
- Full regression: `shared` 191/191, `mobile` 90/90 (+7 from this phase), `shared_ui` 7/7,
  `touchpanel` 23/23. `flutter analyze` clean (0 issues) on all four packages.
- Native-specific items the brief lists (engine initialization/disposal against a REAL native
  engine, network loss/recovery against a REAL transport, media/codec failure against REAL RTP,
  Android call mapping against a REAL `ConnectionService`) are **NOT APPLICABLE THIS PHASE** — no
  real native engine exists to test any of them against; testing them against `MockSipEngine`
  again would not add information beyond what Phase 13.5 already proved, and testing them against
  nothing would be fabrication.

## 22. Native build status

**BLOCKED, reconfirmed once this phase** (per the phase brief's explicit instruction not to
repeatedly re-attempt a known-blocked build): `flutter build apk --debug` was run once and failed
with the same `java.io.IOException: Unable to establish loopback connection` Gradle error observed
in every prior phase since 13.1. iOS: not attempted — no macOS/Xcode exists on this machine, a
hardware/OS precondition, not something a retry could ever satisfy. **Web builds succeed**
(`apps/new/mobile`, `apps/new/touchpanel`) — explicitly not claimed as Android/iOS build success.

## 23. Real SIP E2E status

**NOT ATTEMPTED.** Full reasoning and required topology documented in
[PHASE_13_6_SIP_E2E_TEST.md](PHASE_13_6_SIP_E2E_TEST.md). Three independent unmet preconditions:
no native SIP engine linked, no working device/emulator/simulator, no reachable SIP test server or
door-station endpoint. **Classification: REAL-WORLD ACCEPTANCE TEST REQUIRED.**

## 24. Real Android acceptance

**REAL-WORLD ACCEPTANCE TEST REQUIRED.** Blocked by §22 (build) independently of §23 (no native
engine to test even if a build succeeded).

## 25. Real iOS acceptance

**REAL-WORLD ACCEPTANCE TEST REQUIRED.** Blocked by the absence of macOS/Xcode, independently of
§23.

## 26. Visual call UI status

**NOT APPLICABLE THIS PHASE.** No call UI was built or inspected this phase — building one against
a call path that cannot yet receive a real call would mean visually reviewing screens with no real
behavior behind them, which this project's standing rule against fabricated UI/functionality
rules out. Deferred to the phase that pairs a real native call-delivery path with the UI.

## 27. Remaining blockers

1. PJSIP commercial license not procured (§1 — business/legal action).
2. No native Android/iOS build capability in this environment (§22 — environmental,
   reconfirmed once this phase, unchanged since Phase 13.0/13.1). **What would resolve it**: a
   macOS machine with Xcode for iOS; a Linux/macOS/properly-configured Windows host without the
   Gradle IPC/loopback restriction for Android (or a cloud CI build runner for both).
3. No real SIP test server or door-station endpoint reachable from this session (§23).
4. Native Kotlin/Swift PJSIP bridge implementation itself does not exist yet — a real engineering
   task gated on #2 (nothing to build/test against without a working native toolchain) and #1
   (should not ship a redistributable build with PJSIP linked before the license question closes,
   even for internal test builds — confirm with counsel/Teluu rather than assume an internal debug
   build is exempt).

## 28. Classification matrix

| Area | Classification |
|---|---|
| SIP licensing analysis | REAL (analysis complete); underlying license itself: PRODUCTION HARDENING REQUIRED |
| Native architecture design | REAL (fully documented) |
| `NativeSipEngine` (Dart wire-format bridge) | REAL |
| Native Kotlin/Swift PJSIP bridge | NOT IMPLEMENTED / NATIVE BUILD ACCEPTANCE REQUIRED |
| PJSIP linking | NOT IMPLEMENTED |
| `SipService`/domain model (Phase 13.5) | REAL (unchanged, still fully tested) |
| SIP registration (against real server) | NOT IMPLEMENTED |
| Incoming INVITE (from a real door station) | BACKEND CONTRACT MISSING |
| RTP/SRTP | NOT IMPLEMENTED |
| Codec negotiation | NOT IMPLEMENTED (codec set licensing-cleared: REAL) |
| Real audio (mic/speaker/mute/route) | NOT IMPLEMENTED |
| CallKit native integration | NOT IMPLEMENTED / NATIVE BUILD ACCEPTANCE REQUIRED |
| CallKit UUID mapping (Dart side) | REAL |
| Android `ConnectionService` | NOT IMPLEMENTED / NATIVE BUILD ACCEPTANCE REQUIRED |
| PushKit/FCM VoIP wake integration (native) | NOT IMPLEMENTED / NATIVE BUILD ACCEPTANCE REQUIRED |
| Multi-Home isolation | REAL (unchanged) |
| Multiple door stations | REAL (unchanged) |
| Security (credential handling, call authorization) | REAL (Dart layer); native layer NOT APPLICABLE THIS PHASE |
| Diagnostics UI | NOT IMPLEMENTED |
| Tests (Dart-layer) | REAL |
| Native build | NOT IMPLEMENTED (environment cannot build; reconfirmed once) |
| Real SIP E2E | REAL-WORLD ACCEPTANCE TEST REQUIRED |
| Real Android acceptance | REAL-WORLD ACCEPTANCE TEST REQUIRED |
| Real iOS acceptance | REAL-WORLD ACCEPTANCE TEST REQUIRED |
| Visual call UI | NOT APPLICABLE THIS PHASE |
| **VIDEO** | **NOT IMPLEMENTED** |
| **DOOR RELEASE** | **NOT IMPLEMENTED** |
| **UNLOCK** | **NOT IMPLEMENTED** |

## Regression gate (this phase)

- `flutter analyze`: clean (0 issues) — `shared`, `mobile`, `shared_ui`, `touchpanel`.
- Tests: `shared` 191/191, `mobile` 90/90 (+7 new), `shared_ui` 7/7, `touchpanel` 23/23. Zero
  regressions.
- Web builds: `apps/new/mobile` and `apps/new/touchpanel` both succeed.
- Android native build: attempted once, failed with the pre-existing Gradle loopback error
  (unrelated to this phase's changes — same failure mode since Phase 13.1).
- iOS native build: not attempted (no macOS/Xcode).
- No `services/*`, `cloud/*`, or `packages/*` file was modified this phase — no backend test run
  was required.

## Stop condition

Stopping after Phase 13.6, as instructed. Not starting the video phase. Confirmed not implemented,
touched, or designed: video, camera streaming, H.264/H.265, SIP video, door release, unlock, relay
control, security automation, a new cloud relay, or any unrelated Hub change.

# Phase 13.6A — Native SIP Enablement + First Real Voice Call — Final Report

## 1. Licensing result

**PRODUCTION HARDENING REQUIRED**, now re-verified directly against pjsip.org and the pjproject
GitHub repository's own license metadata (`GPL-2.0`, dual-licensed commercially via Teluu) rather
than re-derived from the prior report alone. Codec set (PCMU/PCMA/G.722/Opus) confirmed
patent/royalty-clean; G.729/AMR/G.722.1 confirmed to carry separate patent or proprietary
obligations and remain excluded from the planned build configuration. Commercial license: **not
yet procured.** Full detail: `PHASE_13_6A_SIP_LICENSING.md`.

## 2. Environment result

Two independent, previously-undocumented Android toolchain gaps found this phase, in addition to
the known Gradle loopback-socket failure: no `cmdline-tools` component and **no NDK installed at
all** on this machine. iOS: categorically unavailable (Windows machine, no macOS/Xcode). Full
detail, including exact `flutter doctor -v` output and the single reconfirmed build-failure
attempt: `PHASE_13_6A_SIP_BUILD.md`.

## 3. PJSIP version

**PJSIP 2.15.x** (current stable line) targeted for a future real build. **Not compiled or linked
this phase** — no toolchain available.

## 4. Build strategy

Fully specified in `PHASE_13_6A_SIP_BUILD.md`: source build from `pjproject`'s own repository
(preferred, reproducible path), `pjsua2` C++ layer, PCMU/PCMA/G.722/Opus only, OpenSSL for
TLS/SRTP, `arm64-v8a`/`armeabi-v7a`/`x86_64` (Android) and `arm64`/simulator slices (iOS). **No
binary of any kind — precompiled or source-built — was produced or committed this phase.**

## 5. Android implementation

**NOT IMPLEMENTED / NATIVE BUILD ACCEPTANCE REQUIRED.** No Kotlin native bridge code was written
(see `PHASE_13_6A_SIP_NATIVE_IMPLEMENTATION.md` for why: no NDK to compile against, no `pjsua2`
AAR present, no way to verify a single line of it). Design unchanged and reaffirmed from Phase
13.6.

## 6. iOS implementation

**NOT IMPLEMENTED / NATIVE BUILD ACCEPTANCE REQUIRED.** Same reasoning; no macOS/Xcode exists.
Design unchanged and reaffirmed from Phase 13.6.

## 7. Dart/native bridge

**REAL, extended this phase.** `NativeSipEngine` (from Phase 13.6) gained `initialize()`/`stop()`
methods, calling two new MethodChannel methods on the same `com.supremeos/sip` channel, matching
this phase's explicit lifecycle requirement (`initialize/start/register/unregister/stop/dispose`).
`SipEngine`'s abstract contract and `SipService` gained the matching `initialize()`/`shutdown()`
methods — the smallest change that satisfies the requirement, with no redesign of the existing
account/call/multi-Home logic. `MockSipEngine` updated to match. All changes are additive and
non-breaking. Tests: `shared` 192/192 (new "engine lifecycle" group), `mobile` 90/90 (updated
`native_sip_engine_test.dart`).

## 8. SIP registration

**REAL** at the domain/wire-format layer (unchanged logic from 13.5/13.6, now reachable through
the new `initialize()` lifecycle entry point). **Real REGISTER against an actual SIP server: NOT
IMPLEMENTED** — no native engine exists to perform one (§5–6).

## 9. Incoming INVITE

**REAL** at the domain/wire-format layer (unchanged from 13.5/13.6). **A real physical INVITE:
BACKEND CONTRACT MISSING** — no native engine exists to receive one.

## 10. CallKit

**Dart-side UUID mapping: REAL** (unchanged, Phase 13.5). **Native CallKit integration: NOT
IMPLEMENTED / NATIVE BUILD ACCEPTANCE REQUIRED.**

## 11. ConnectionService

**NOT IMPLEMENTED / NATIVE BUILD ACCEPTANCE REQUIRED.** Design (OS presentation only, never owns
SupremeOS state) unchanged from Phase 13.6.

## 12. RTP

**NOT IMPLEMENTED.** No native media engine exists.

## 13. SRTP

**NOT IMPLEMENTED.** Same reason; planned to be enabled per-account for `SipTransport.tls`
accounts once a native engine exists (design unchanged from Phase 13.6).

## 14. Codec

Vocabulary modeled and licensing-cleared (§1): PCMU, PCMA, G.722, Opus. Negotiation: **NOT
IMPLEMENTED** (requires the native media engine).

## 15. Audio

**NOT IMPLEMENTED.** No microphone capture, RTP transmission, remote audio reception, or
speaker/earpiece playback exists. **No synthetic, generated, or mocked audio was used or is
claimed as evidence of anything** — the phase brief's explicit prohibition on this is honored by
simply not attempting the claim.

## 16. Network recovery

**NOT APPLICABLE.** No real transport exists yet to lose or recover. Design (SIP media and Hub
control transport remain separate; existing `ConnectionManager` unaffected) unchanged.

## 17. Multi-Home

**REAL, unchanged and still fully tested** (Phase 13.5's isolation tests, 19→20 tests in
`sip_service_test.dart` after this phase's lifecycle-test addition, all passing). No
`globalSipAccount`/`globalCurrentHome`/`globalCurrentDoorStation` exists anywhere in this code —
verified by inspection, not merely asserted.

## 18. Multiple door stations

**REAL, unchanged and still fully tested** (Phase 13.5's `SipDoorStationConfig`/`doorStationFor`
logic and isolation test, unmodified this phase).

## 19. Security

**REAL** for everything actually built: `SipCredentials` redaction, `SipService` never retaining
credentials beyond the single `registerAccount` call, `NativeSipEngine` sending the password over
the channel exactly once and never in an event frame, CallKit-UUID map refusing to map an unknown
call, authorization checks on `answer`/`hangup`/`setMuted`/`setSpeakerOn` — all unchanged from
Phase 13.6 and still covered by passing tests. Native-layer secure storage, and native
push/notification/Intent-extra credential exposure: **NOT APPLICABLE THIS PHASE** — no native
code of that kind was written.

## 20. Tests

New this phase: one `SipService` "engine lifecycle" test (`shared`); `NativeSipEngine`'s existing
tests extended to cover `initialize()`/`stop()`. Full regression: `shared` 192/192, `mobile`
90/90, `shared_ui` 7/7, `touchpanel` 23/23. `flutter analyze` clean (0 issues), all four packages.
Zero regressions; no existing test was removed or weakened.

## 21. Android native build

**Attempted once this phase** (`flutter build apk --debug`), per the explicit instruction not to
repeatedly retry a known failure. Failed with the same `java.io.IOException: Unable to establish
loopback connection` seen in every prior phase since 13.1. Additionally confirmed (new this
phase): no NDK or `cmdline-tools` installed at all, an independent blocker. **Classification:
NATIVE BUILD ACCEPTANCE REQUIRED.**

## 22. iOS native build

**Not attempted.** No macOS/Xcode exists on this machine — a hardware/OS precondition, not
something any in-session action could satisfy. **Classification: NATIVE BUILD ACCEPTANCE
REQUIRED.**

## 23. Real SIP server test

**Not performed.** No SIP server was stood up or reached this session — doing so before a native
engine exists to register against would produce nothing to actually test. Full reasoning:
`PHASE_13_6A_SIP_REAL_E2E.md`. **Classification: REAL-WORLD ACCEPTANCE TEST REQUIRED.**

## 24. Real Android test

**Not performed.** Blocked independently by §21 (no build) and §23 (nothing to test even with a
build). **Classification: REAL-WORLD ACCEPTANCE TEST REQUIRED.**

## 25. Real iOS test

**Not performed.** Blocked by §22. **Classification: REAL-WORLD ACCEPTANCE TEST REQUIRED.**

## 26. Two-way audio test

**Not performed; not fabricated.** No native audio path exists (§15). **Classification: NOT
IMPLEMENTED**, with **REAL-WORLD ACCEPTANCE TEST REQUIRED** for the eventual real test once a
native engine and real device/server are available.

## 27. Evidence

None claimed beyond what is directly reproducible and included in this phase's own documents:
`flutter doctor -v` output, the exact single build-failure transcript, the `sw_vers`-equivalent
confirmation that no macOS exists (this machine reports `Windows Version 25H2` via `flutter
doctor` — the OS itself is the evidence iOS native development is impossible here), and the
sourced licensing citations in `PHASE_13_6A_SIP_LICENSING.md`. No device screenshot, log capture,
SIP trace, or audio recording is presented as real-device/real-SIP evidence, because none was
produced.

## 28. Remaining blockers

1. PJSIP commercial license not procured (business/legal action, §1).
2. No Android NDK/`cmdline-tools` installed on this machine, independent of the Gradle loopback
   issue (§2, §21) — both must be resolved for Android native compilation to even begin.
3. No macOS/Xcode available (§22) — categorical for this machine; requires different hardware or
   a macOS CI runner.
4. No real SIP test server or endpoint reachable from this session (§23).
5. The native Kotlin/Swift PJSIP bridge itself remains unwritten — a real engineering task gated
   on #2/#3 (nothing to compile/verify against without a working toolchain) and #1 (should not
   ship a PJSIP-linked build, even internally, before the licensing question is closed with
   counsel/Teluu).

## 29. Classification matrix

| Area | Classification |
|---|---|
| SIP licensing (re-verified against primary sources) | REAL (analysis); underlying commercial license: PRODUCTION HARDENING REQUIRED |
| Build environment inspection (Gate 2) | REAL |
| PJSIP build strategy (Gate 3) | REAL (documented plan only — nothing compiled) |
| `SipEngine`/`SipService` lifecycle extension (`initialize`/`stop`/`shutdown`) | REAL |
| `NativeSipEngine` Dart↔native wire-format bridge | REAL |
| Native Kotlin/Swift PJSIP bridge | NOT IMPLEMENTED / NATIVE BUILD ACCEPTANCE REQUIRED |
| PJSIP compiled/linked | NOT IMPLEMENTED |
| SIP registration (domain/wire-format logic) | REAL |
| SIP registration (real REGISTER against a real server) | NOT IMPLEMENTED |
| Incoming INVITE (domain/wire-format logic) | REAL |
| Incoming INVITE (real, from a physical endpoint) | BACKEND CONTRACT MISSING |
| CallKit UUID mapping (Dart) | REAL |
| CallKit native integration | NOT IMPLEMENTED / NATIVE BUILD ACCEPTANCE REQUIRED |
| Android `ConnectionService` | NOT IMPLEMENTED / NATIVE BUILD ACCEPTANCE REQUIRED |
| RTP | NOT IMPLEMENTED |
| SRTP | NOT IMPLEMENTED |
| Codec vocabulary/licensing | REAL |
| Codec negotiation | NOT IMPLEMENTED |
| Real audio (mic/speaker/mute/route) | NOT IMPLEMENTED |
| Network loss/recovery (real transport) | NOT APPLICABLE THIS PHASE |
| Multi-Home isolation | REAL |
| Multiple door stations | REAL |
| Security (credential handling, authorization) | REAL (Dart layer); native layer NOT APPLICABLE THIS PHASE |
| Tests (Dart layer) | REAL |
| Android native build | NOT IMPLEMENTED / NATIVE BUILD ACCEPTANCE REQUIRED |
| iOS native build | NOT IMPLEMENTED / NATIVE BUILD ACCEPTANCE REQUIRED |
| Real SIP server test | REAL-WORLD ACCEPTANCE TEST REQUIRED |
| Real Android device test | REAL-WORLD ACCEPTANCE TEST REQUIRED |
| Real iOS device test | REAL-WORLD ACCEPTANCE TEST REQUIRED |
| Two-way audio (real) | NOT IMPLEMENTED / REAL-WORLD ACCEPTANCE TEST REQUIRED |
| **VIDEO** | **NOT IMPLEMENTED** |
| **DOOR RELEASE** | **NOT IMPLEMENTED** |
| **UNLOCK** | **NOT IMPLEMENTED** |
| **DTMF SECURITY** | **NOT IMPLEMENTED** |

## Regression gate (this phase)

- `flutter analyze`: clean (0 issues) — `shared`, `mobile`, `shared_ui`, `touchpanel`.
- Tests: `shared` 192/192, `mobile` 90/90, `shared_ui` 7/7, `touchpanel` 23/23. Zero regressions;
  no existing test removed.
- Web builds: `apps/new/mobile` and `apps/new/touchpanel` both succeed.
- Android native build: attempted once, failed (pre-existing Gradle loopback error, plus a newly
  documented missing-NDK/cmdline-tools gap).
- iOS native build: not attempted (no macOS/Xcode).
- No `services/*`, `cloud/*`, or `packages/*` file was modified this phase.

## Milestone status

**The primary objective — a first real SupremeOS SIP voice call — was not achieved this phase.**
This is not concealed or softened: every precondition for it (a compiled native SIP engine, a
working Android or iOS build, a real device, a real SIP server) was independently verified as
unmet in this specific sandboxed environment, and the phase brief's own instruction is unambiguous
that a smaller amount of real functionality is preferable to a larger amount of simulated
functionality. What this phase delivers instead is: a source-verified licensing position, a fully
specified and licensing-aligned build strategy, a real (tested) Dart-side engine contract extended
to meet this phase's exact lifecycle requirement, and an honest, itemized list of exactly what
infrastructure (a working macOS+Xcode environment, a properly provisioned Android NDK/toolchain,
a real device, a real SIP server, a procured commercial license) is required before the milestone
can be attempted for real.

## Stop condition

Stopping after this report, as instructed. Not starting Phase 13.7. Confirmed not implemented,
touched, or designed beyond what is explicitly documented above: video, camera, H.264/H.265, SIP
video, door release, unlock, relay control, DTMF-based security, security automation, a new cloud
relay, or any unrelated Hub change.

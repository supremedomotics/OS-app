# Phase 13.6A — Native SIP Implementation Status

## What exists after this phase

```
SupremeOS (Dart)
    │
    ▼
SipService          (apps/new/shared — extended this phase with initialize()/shutdown())
    │
    ▼
SipEngine (abstract) (apps/new/shared — extended this phase with initialize()/stop())
    │
    ├── MockSipEngine     (test/dev only — updated for the new lifecycle methods)
    │
    └── NativeSipEngine   (apps/new/mobile/lib/sip/native_sip_engine.dart — REAL, tested,
    │                       extended this phase with initialize/stop channel calls)
    │       com.supremeos/sip MethodChannel + com.supremeos/sip/events EventChannel
    ▼
[Native Kotlin/Swift PJSIP bridge]   ← DOES NOT EXIST — see "Why no native code was written" below
    ▼
PJSIP/PJSUA2                          ← NOT COMPILED — no NDK/Xcode toolchain available (Gate 2)
```

## Contract change this phase (the "smallest necessary change" the brief allows)

The Phase 13.6 `SipEngine` contract had `registerAccount`/`unregisterAccount`/`answer`/`hangup`/
`setMuted`/`setSpeakerOn`/`dispose` but no explicit engine-level `initialize`/`stop`, which this
phase's own brief requires ("Required native lifecycle: initialize, start, register, unregister,
stop, dispose"). Added:

- `SipEngine.initialize()` — starts the underlying SIP endpoint/media stack once per process,
  before any account is registered. A real implementation's initialization failure propagates as
  a thrown exception (not swallowed), since there is no per-Home account yet to attribute a
  failure to.
- `SipEngine.stop()` — tears down the endpoint (implicitly unregistering every account), distinct
  from `dispose()` (which additionally closes this Dart object's own streams and cannot be
  undone) — `stop` leaves the object reusable via another `initialize()` call, matching real
  app-background/foreground/process-recreation cycles.
- `SipService.initialize()`/`SipService.shutdown()` — the caller-facing counterparts, added with
  the same minimal footprint (no redesign of `SipService`'s existing per-Home account/call
  handling, which is unchanged).
- `MockSipEngine` and `NativeSipEngine` both updated to implement the two new methods —
  `NativeSipEngine`'s versions add `initialize`/`stop` MethodChannel calls to the existing wire
  format, with the same `MissingPluginException`-degrades-honestly behavior as every other method.

This is additive and non-breaking: no existing `SipService`/`SipEngine` caller or test needed to
change beyond adding the two new lifecycle calls where a real caller would invoke them (app
startup/teardown) — nothing in the Phase 13.5/13.6 domain model, `CallSession`/`MobileRuntime`
integration, multi-Home isolation, or CallKit-UUID mapping was touched.

## Why no native (Kotlin/Swift/C++) code was written this phase

Gate 2 (this phase's own build-environment inspection, see `PHASE_13_6A_SIP_BUILD.md`) found:

1. The Gradle loopback-socket failure persists (re-confirmed once, not repeatedly).
2. **New finding this phase**: the Android SDK on this machine has no `cmdline-tools` component
   and no NDK installed at all — independently of #1, there is no C/C++ toolchain available to
   compile PJSIP or any native bridge code against.
3. No macOS/Xcode exists on this Windows machine — categorically no iOS native development is
   possible here.

Writing Kotlin code that calls a `pjsua2` Android AAR that isn't present, against an NDK that
isn't installed, in a Gradle environment that can't even run `assembleDebug` for the *existing*
pure-Dart/Kotlin app — or Swift code for a platform this machine cannot target in any way — would
produce source text with **zero verification**: it could not be compiled, could not be
type-checked against the real `pjsua2` API surface, and could not be tested even at the level
`NativeSipEngine`'s own channel-mock tests achieve. This directly conflicts with the phase brief's
explicit "never call native source = native acceptance" instruction and this project's standing
"never fabricate" rule (`CLAUDE.md`). The responsible action, consistent with "implement only what
can be honestly implemented and classify the remainder," is to deliver the fully real,
independently-verified Dart-side contract (above) and document the native side's exact required
shape (`PHASE_13_6_SIP_NATIVE_ARCHITECTURE.md`'s wire-format tables, unchanged and still
accurate) rather than ship unverifiable filler.

## What a real native implementation must still do (unchanged from Phase 13.6, reaffirmed)

- Android: one `pjsua2::Endpoint` per process (constructed on `initialize`, destroyed on `stop`),
  one `pjsua2::Account` per registered Home, a `callId`-keyed `Call` map, `ConnectionService` for
  OS call presentation only.
- iOS: PushKit wakes native Swift code before Dart is assumed alive, which owns the `pjsua2`
  endpoint/account/call objects and immediately reports to CallKit; Dart is synchronized in once
  the Flutter engine is running.
- Both: every native callback (`onRegState`, `onIncomingCall`, `onCallState`, `onCallMediaState`)
  translated into a `com.supremeos/sip/events` frame matching `NativeSipEngine`'s parser exactly —
  this parser was not changed this phase beyond the two new lifecycle event types implicitly
  covered by the existing `registrationStatus`/`call` frame shapes (an `initialize`/`stop` call
  itself does not need its own event type; it is a direct method-call/response, not an
  asynchronous native-originated event).

## Classification

**NATIVE BUILD ACCEPTANCE REQUIRED** for the entire native (Kotlin/Swift/PJSIP-linked) layer —
unchanged from Phase 13.6, now with two additional, independently-verified environmental blockers
documented (missing NDK/cmdline-tools) beyond the previously-known Gradle loopback issue.
**REAL** for the Dart-side `SipEngine`/`SipService`/`NativeSipEngine` contract, including this
phase's lifecycle extension, fully covered by passing tests (`shared` 192/192 including the new
"engine lifecycle" test group, `mobile` 90/90 including the updated `native_sip_engine_test.dart`).

# Phase 13.6 — SIP End-to-End Test

Documents the real E2E test topology this phase's brief requires, and states plainly why it was
not executed this session — per the brief's own instruction to classify honestly rather than
fabricate evidence.

## Test topology (required, not built)

```
SIP test server / registrar (e.g. Asterisk, FreeSWITCH, or a real door-station's own
built-in SIP proxy)
        │
        ├── known SIP endpoint acting as the "door station" (a softphone, or a real
        │   door-station unit — Akuvox/Fanvil/2N/DoorBird/Comelit)
        │
        └── SupremeOS Mobile, installed on a real Android or iOS device, registered
            as the Home's own SIP account
```

## What this requires that this session does not have

1. **A native SIP engine actually linked into a build.** This phase designed and wired the
   Dart-side contract (`NativeSipEngine`, `com.supremeos/sip`) but did not link `pjsua2` natively
   (see `PHASE_13_6_SIP_NATIVE_ARCHITECTURE.md` — no native build environment, no procured
   commercial license yet). Without a native engine actually speaking SIP, there is nothing to
   REGISTER or receive an INVITE with.
2. **A real Android or iOS device or working emulator/simulator with SIP connectivity.**
   Unchanged since Phase 13.0: this Windows machine has no macOS/Xcode (iOS blocked entirely);
   `flutter build apk --debug` fails with `java.io.IOException: Unable to establish loopback
   connection` (re-confirmed this phase, same error, same command); `adb` is not on `PATH` even
   for the two registered emulators (`Medium_Phone_API_36.1`, `Pixel_9_Pro`).
3. **A SIP test server and a known SIP endpoint reachable from that device.** Neither exists in
   this sandboxed session — there is no LAN, no door station, and no registrar configured for this
   environment to reach even if the device/native-build gaps above were closed.

Given all three preconditions are unmet, **no attempt was made to fabricate a partial or simulated
E2E result** — the phase brief explicitly prohibits treating a mock SIP engine, a unit test, or a
web build as equivalent to real SIP E2E, and this document exists specifically to avoid that
substitution.

## What WAS verified this phase (and is not being overstated as more than it is)

- `NativeSipEngine`'s wire-format contract against a **mocked** MethodChannel/EventChannel
  (`apps/new/mobile/test/native_sip_engine_test.dart`, 7 tests) — proves the Dart-side plumbing is
  internally correct and resilient to malformed/unknown frames. This is unit-test coverage of Dart
  code, **not** SIP signaling, **not** RTP, **not** E2E.
- `SipService`'s full call/registration state-machine logic against `MockSipEngine`
  (`apps/new/shared/test/sip_service_test.dart`, from Phase 13.5, still passing — 19 tests) — same
  caveat: domain-logic correctness, not real SIP.
- The Android build was attempted once this phase (`flutter build apk --debug`) specifically to
  reconfirm, rather than assume, that the pre-existing Gradle loopback-socket failure is still
  present. It is. No repeated attempts were made after that single, deliberate confirmation, per
  the phase brief's explicit "do not waste time repeatedly pretending these are solved" instruction.

## Minimum real SIP test (not performed — sequence documented for whoever runs it)

REGISTER → authenticated registration (401 challenge → authenticated REGISTER → 200 OK) →
incoming INVITE → 100 Trying → 180 Ringing → CallKit/ConnectionService call presentation → user
answers → 200 OK → ACK → RTP/SRTP established → two-way audio → mute/unmute → hangup → BYE →
native/media/CallSession cleanup.

## What is required to actually run this

- A real Android device (physical preferred) or a working Android emulator with a resolved Gradle
  loopback issue, **or** a macOS machine with Xcode for iOS.
- A native PJSIP build actually linked per `PHASE_13_6_SIP_NATIVE_ARCHITECTURE.md`, which in turn
  requires the commercial license question in `PHASE_13_6_SIP_LICENSING.md` to be resolved before
  any such build is distributed (even for internal testing, if that testing produces a
  redistributable binary — an internal-only debug build's licensing posture should still be
  confirmed with counsel/Teluu rather than assumed safe).
- A reachable SIP test server and a real or software door-station SIP endpoint on the same test
  network as that device.

## Classification

**REAL-WORLD ACCEPTANCE TEST REQUIRED** — not attempted, not fabricated, not simulated as a
substitute for the real thing. See `PHASE_13_6_FINAL_REPORT.md`'s classification matrix for how
this interacts with every other area of this phase's work.

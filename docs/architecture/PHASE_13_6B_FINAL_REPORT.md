# Phase 13.6B — Native Build Environment Readiness — Final Report

## 1. Environment before phase

Per Phase 13.6/13.6A: Gradle loopback-socket failure (symptom only, no root cause), "no
`cmdline-tools`, no NDK," "adb not on `PATH`," "no usable Android device" (implied), no
macOS/Xcode. This phase re-inspected all of these directly rather than assuming the prior reports
were complete.

## 2. Android toolchain

Flutter 3.47.4 / Dart 3.13.3, AGP 9.1.0, Kotlin Gradle Plugin 2.4.0, Gradle 9.3.1. Android Studio
found installed at **`E:\Androidstudio`** (a non-default drive/path prior phases' searches missed
entirely). Full detail: `PHASE_13_6B_NATIVE_BUILD.md` §1.

## 3. JDK

**OpenJDK 21.0.8**, the JetBrains Runtime bundled with the `E:\Androidstudio` install — Flutter's
own auto-detected choice. This is very likely a contributing factor to §12's root cause (a
JDK-21-era Windows NIO implementation detail), though no alternate JDK exists on this machine to
test that hypothesis against.

## 4. Gradle

9.3.1, unchanged. Not the source of the failure itself (the failure is in JDK-level socket
handling the Gradle client JVM invokes, not Gradle's own logic).

## 5. Android SDK

Present at `%LOCALAPPDATA%\Android\sdk`; `platforms` (android-36), `build-tools` (36.1.0), and
`platform-tools` all present and correct.

## 6. cmdline-tools

**Still absent.** Not installed this phase — see §12's conclusion for why installing it was not
pursued given the deeper blocker found.

## 7. NDK

**Still absent**, for the same reason.

## 8. CMake

**Still absent** (ships via `cmdline-tools`).

## 9. ADB

**Corrected finding: present and fully functional.** `adb.exe` exists at
`...\sdk\platform-tools\adb.exe`; once referenced (or added to `PATH`), `adb devices` and
`adb emu kill` both worked correctly this phase. Prior phases' "not on `PATH`" framing was
technically accurate but understated — the binary itself works.

## 10. Physical Android device

No physical device was connected this phase. **An Android emulator (`Pixel_9_Pro`, Android 16)
was launched, reached a fully booted `device` state via `adb` within ~60 seconds, and was cleanly
shut down** — a genuine, previously-undocumented working device layer. It could not be used to
run SupremeOS itself, because no APK exists to install on it (§11/§12).

## 11. Android build result

**Still fails.** `flutter build apk --debug` was run multiple times this phase (each attempt
targeted at gathering more diagnostic information, not blindly retrying) — every attempt reached
the identical `java.io.IOException: Unable to establish loopback connection`. **Classification:
NATIVE BUILD ACCEPTANCE REQUIRED** — the plain, non-PJSIP app cannot currently be compiled on this
machine, so no PJSIP-specific blame is warranted; the failure predates and is unrelated to any SIP
work.

## 12. Gradle loopback diagnosis

**Root cause identified this phase** (not previously documented): the Gradle client JVM's
`Selector.open()` call, on this JDK/Windows combination, routes through
`sun.nio.ch.WEPollSelectorProvider`, which builds its internal self-pipe using an **AF_UNIX domain
socket**; the actual failing call is `UnixDomainSockets.connect0` → `SocketException: Invalid
argument: connect`. Two targeted fixes were attempted and both failed, ruling out IPv4/IPv6
preference as the cause (full stack trace and diagnostic sequence: `PHASE_13_6B_NATIVE_BUILD.md`
§9). The sandbox this session runs commands in was also ruled out (`dangerouslyDisableSandbox`
produced an identical failure). The remaining plausible causes are security/endpoint-protection
software or a Windows network-stack condition intercepting local AF_UNIX socket creation on this
specific machine, or a JDK-distribution-specific bug with no alternate JDK on this machine to test
against. Resolving it further requires either investigating this machine's specific
security/network software (an IT action, and the phase brief explicitly forbids weakening security
controls to force a build through) or building on a different machine/JDK/CI runner.

## 13. iOS/macOS status

**Unchanged: categorically unavailable.** This is a Windows machine. No Mac became available
during this session. Static inspection only of `apps/new/mobile/ios/`'s existing structure — no
build attempted, none claimed. **Classification: NATIVE BUILD ACCEPTANCE REQUIRED.**

## 14. PJSIP build requirements

Unchanged from Phase 13.6A: PJSIP 2.15.x, `pjsua2`, PCMU/PCMA/G.722/Opus only, OpenSSL,
`arm64-v8a`/`armeabi-v7a`/`x86_64` (Android), `arm64`+simulator (iOS). **Not compiled** — no
toolchain exists to compile it against (§§6–7, 13), and attempting a `PJSIP BUILD EXPERIMENT`
against a Gradle setup that cannot even build the existing plain app (§11) would produce no
useful signal. Full detail: `PHASE_13_6B_NATIVE_BUILD.md` §14.

## 15. PJSIP licensing status

**PRODUCTION HARDENING REQUIRED, unchanged.** `PJSIP COMMERCIAL LICENSE = NOT PROCURED.` No
license activity occurred this phase (none was needed — no PJSIP code was compiled or linked).

## 16. SIP test lab readiness

**Specification documented, nothing stood up.** Topology, transport, ports, codec, and
credential-handling approach fully specified in `PHASE_13_6B_NATIVE_BUILD.md` §16, matching the
existing LAN-first, no-Tunnel-Broker-for-SIP-media architecture decision from Phase 13.6. No SIP
server, test account, or endpoint was created this phase.

## 17. Build reproducibility

`docs/architecture/PHASE_13_6B_NATIVE_BUILD.md` is the reproducible reference document: exact
versions, environment variables (or lack thereof), the full diagnostic sequence for the loopback
failure, verification commands, and a known-failures/troubleshooting table. A new engineer can
follow its §17 command list to reproduce every finding in this report.

## 18. Files changed

- **Added**: `docs/architecture/PHASE_13_6B_NATIVE_BUILD.md`,
  `docs/architecture/PHASE_13_6B_FINAL_REPORT.md`, `tools/check-native-build-health.ps1`.
- **Temporarily modified, then fully reverted and verified restored**:
  `apps/new/mobile/android/gradle.properties` (one diagnostic JVM-flag experiment, §12; confirmed
  byte-for-byte identical to its original content afterward).
- **No other file was modified.** No `SipEngine`/`SipService`/`CallSession`/`MobileRuntime`/Hub/
  Push/CallKit architecture was touched, per this phase's explicit architecture-freeze
  requirement (§20 of the phase brief) — nothing required a change.

## 19. Tests

No Dart source changed this phase, so no new tests were needed. Full regression re-run to confirm
health: `shared` 192/192, `mobile` 90/90, `shared_ui` 7/7, `touchpanel` 23/23. All passing, zero
regressions.

## 20. Analyze result

`flutter analyze`: clean (0 issues) — `shared`, `mobile`, `shared_ui`, `touchpanel`.

## 21. Web builds

`apps/new/mobile` and `apps/new/touchpanel` `flutter build web`: both succeed.

## 22. Remaining blockers

1. Gradle client-JVM AF_UNIX loopback-socket failure (§12) — root cause now understood precisely,
   not resolved; needs either a security/network-software investigation on this specific machine
   or a different build machine/JDK.
2. `cmdline-tools`/NDK/CMake still not installed — a real but secondary blocker; installing them
   would not by itself fix #1, so was deliberately not pursued this phase (see §12's reasoning).
3. No macOS/Xcode — categorical for this machine.
4. PJSIP commercial license not procured (§15).
5. No real SIP test server/endpoint stood up (§16 is a specification only).

## 23. Classification matrix

| Area | Classification |
|---|---|
| Flutter/Dart toolchain | REAL |
| Android SDK (platforms/build-tools/platform-tools/license) | REAL |
| `adb` functional | REAL/BUILD VERIFIED |
| Android emulator boot | REAL/BUILD VERIFIED |
| `cmdline-tools`/NDK/CMake | NOT IMPLEMENTED (not installed) |
| Normal SupremeOS Android APK build | ENVIRONMENT BLOCKED (root cause identified, §12) |
| Gradle loopback root-cause diagnosis | REAL (diagnosis complete; underlying fix: ENVIRONMENT BLOCKED) |
| iOS/macOS build environment | ENVIRONMENT BLOCKED (categorical — no macOS on this machine) |
| PJSIP build requirements documentation | REAL |
| PJSIP compiled | NOT IMPLEMENTED |
| PJSIP commercial license | PRODUCTION HARDENING REQUIRED |
| SIP test lab specification | REAL (specification only — nothing stood up) |
| Build reproducibility documentation | REAL |
| Build health check script | REAL/BUILD VERIFIED (run this phase, output matches documented findings) |
| Existing test suites | REAL/BUILD VERIFIED (192/90/7/23, zero regressions) |
| Web builds (mobile, touchpanel) | REAL/BUILD VERIFIED |
| **REAL SIP VOICE** | **NOT IMPLEMENTED** |
| **VIDEO** | **NOT IMPLEMENTED** |
| **DOOR RELEASE** | **NOT IMPLEMENTED** |
| **UNLOCK** | **NOT IMPLEMENTED** |
| **DTMF SECURITY** | **NOT IMPLEMENTED** |
| **PJSIP COMMERCIAL LICENSE** | **NOT PROCURED** |

## Success criteria (from the phase brief) — self-assessment

1. Android environment fully diagnosed — **yes**, including two new corrected findings (adb works,
   emulator boots) and one new root-cause finding (the AF_UNIX loopback mechanism).
2. Missing Android tooling installed where possible — **not done**; installing `cmdline-tools`/NDK
   would not resolve the actual blocker (§12), so was deliberately deferred rather than performed
   for its own sake.
3. Normal SupremeOS Android build works, OR exact blocker documented — **blocker documented in
   full technical depth**, build does not work.
4. Physical Android device available/tested where possible — **an emulator was tested** (no
   physical device was connected to this machine this session); documented honestly as an
   emulator, not conflated with physical-device testing.
5. iOS/macOS requirements fully documented — **yes**, unchanged from prior phases, restated.
6. PJSIP native build requirements documented — **yes**, unchanged from Phase 13.6A.
7. SIP test topology documented — **yes**, specification only.
8. Reproducible native build instructions exist — **yes**,
   `PHASE_13_6B_NATIVE_BUILD.md`.
9. Existing SupremeOS tests remain green — **yes**, 192/90/7/23, zero regressions.
10. No fake SIP implementation introduced — **confirmed**; no SIP code was touched this phase at
    all.

## Stop condition

Stopping after this report, as instructed. Not starting native SIP implementation (Phase
13.6C/13.6D) — the environment is not genuinely ready (§22). Not starting video or door release.

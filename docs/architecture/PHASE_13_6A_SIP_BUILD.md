# Phase 13.6A — Build Environment (Gate 2) and PJSIP Build Strategy (Gate 3)

## Gate 2 — Build environment, actually inspected this session

### Flutter/Dart

```
Flutter 3.47.4 • channel stable
Framework revision 9584c6713b (2026-09-10)
Engine revision 06a2e2a110
Dart 3.13.3
```
(`flutter --version`, run this session.)

### Android toolchain — `flutter doctor -v` output, run this session

```
[!] Android toolchain - develop for Android devices (Android SDK version 36.1.0)
    • Android SDK at C:\Users\Murs_Legion\AppData\Local\Android\sdk
    • Emulator version 36.2.12.0 (build_id 14214601)
    X cmdline-tools component is missing.
    X Android license status unknown.
```

This is **new, previously-undocumented information**: beyond the known Gradle loopback-socket
failure, this machine's Android SDK install is missing the `cmdline-tools` component entirely and
has never accepted the SDK licenses. Checked directly (`Get-ChildItem` on
`%LOCALAPPDATA%\Android\sdk\ndk` and `...\cmdline-tools`): **both directories are empty/absent —
no NDK is installed at all.** This means native PJSIP compilation for Android is blocked at the
toolchain level independently of, and in addition to, the Gradle loopback issue — even if the
loopback error were fixed, there is currently no NDK on this machine to compile PJSIP's C/C++
source against.

No JDK is reachable on `PATH` in the Bash shell (`java: command not found`); Android Studio's
bundled JBR was checked at its default path and also not present, meaning this environment has no
independently verified JDK to run Gradle's own toolchain outside of whatever Flutter's own tooling
locates internally.

### Project's declared Android build configuration (from source, not assumed)

```
Android Gradle Plugin (AGP): 9.1.0        (android/settings.gradle.kts)
Kotlin Gradle Plugin:        2.4.0        (android/settings.gradle.kts)
Gradle wrapper:              9.3.1-all    (android/gradle/wrapper/gradle-wrapper.properties)
compileSdk / minSdk / ndkVersion: inherited from Flutter's own `flutter.compileSdkVersion` /
                                   `flutter.minSdkVersion` / `flutter.ndkVersion` (Flutter-managed,
                                   not hardcoded in this project's build.gradle.kts)
```

### Android build attempt (Gate 2's required single attempt)

```
$ flutter build apk --debug
Running Gradle task 'assembleDebug'...
FAILURE: Build failed with an exception.
* What went wrong:
java.io.IOException: Unable to establish loopback connection
```

Identical failure mode to every prior phase since 13.1 — re-confirmed once, not repeatedly
retried, per this phase's explicit instruction. Combined with the missing `cmdline-tools`/NDK
finding above, there are now **two independent, compounding blockers** for any Android native
build on this specific machine.

### iOS toolchain

This machine is Windows 11 (`Windows Version: 25H2`, per `flutter doctor`). macOS, Xcode, and a
physical iPhone are categorically unavailable — this is a hardware/OS precondition, not a
configuration issue a retry or environment fix on this machine could ever satisfy. No iOS build
was attempted, per this phase's own instruction not to pretend otherwise.

### Available devices (per `flutter doctor -v`)

Windows (desktop), Chrome (web), Edge (web) only. No physical or emulated Android/iOS device is
actually usable — the two registered AVDs (`Medium_Phone_API_36.1`, `Pixel_9_Pro`, per prior
phases) remain unusable because `adb` is still not resolvable on `PATH` in this environment
(re-confirmed: `which adb` → not found).

### What would resolve this (stated once, not chased further this phase)

- Install the Android `cmdline-tools` and NDK components (`sdkmanager --install "cmdline-tools;
  latest" "ndk;<version>"`) and run `flutter doctor --android-licenses`.
- Resolve the Gradle loopback-socket restriction (environment/firewall/sandbox-policy issue on
  this specific machine — not a project misconfiguration, since the same project's Dart-only
  tests, web builds, and `flutter analyze` all work correctly).
- Add `adb` to `PATH` (Android Studio's `platform-tools` directory) to make the existing AVDs
  usable.
- For iOS: a macOS machine with Xcode, or a CI runner (e.g. GitHub Actions `macos-latest`) that
  can build and archive the iOS target.

None of these were performed — they are infrastructure/administrative actions on this specific
workstation, outside what a single engineering session inside this sandbox can resolve.

## Gate 3 — PJSIP build strategy

### Target version

**PJSIP 2.15.x** (the current stable release line as of this phase, per `docs.pjsip.org`'s
"latest"/"2.15.1" documentation surfaced during the licensing verification in
`PHASE_13_6A_SIP_LICENSING.md`) — includes `pjlib`, `pjlib-util`, `pjnath`, `pjmedia`, `pjsip`, and
the `pjsua2` C++ convenience layer this integration targets (per the Phase 13.5 decision to bind
against `PJSUA2`, not the lower-level `pjsua`/`pjsip` C APIs directly).

### Build configuration (planned, not yet executed — no NDK/Xcode available this session)

- **Codecs compiled in**: G.711 (PCMU/PCMA, built into `pjmedia` core, no separate flag), G.722
  (bundled, public domain), Opus (external, must be linked at build time via `--with-opus`).
  **Explicitly excluded via build configuration**: G.729 (`--without-g729`-equivalent — simply not
  linking `bcg729`), AMR (not linking OpenCore AMR), G.722.1/Siren (not linking, and it requires a
  separate Polycom license regardless). This directly implements the licensing document's
  recommendation as an actual build-time exclusion, not a runtime-only decision.
- **SRTP**: `pjmedia`'s bundled `libSRTP` (BSD-3), enabled for TLS-transport accounts.
- **TLS backend**: OpenSSL (Apache-style license, GPL-compatible per its own grant) —
  `--with-ssl=openssl` at PJSIP configure time.
- **Architectures**:
  - Android: `arm64-v8a` (primary target — the overwhelming majority of in-market Android
    devices), `armeabi-v7a` (older-device support, evaluate against SupremeOS's actual minimum
    supported Android version once decided), `x86_64` (emulator/testing only, not for
    distribution).
  - iOS: `arm64` (device), `arm64`/`x86_64` simulator slices as an `.xcframework`, per Apple's
    current toolchain requirements.
- **Minimum OS versions**: match SupremeOS Mobile's own existing `minSdk`/iOS deployment target
  (Flutter-managed on Android per `flutter.minSdkVersion`; not independently re-decided by this
  SIP integration — no reason for PJSIP to impose a stricter floor than the rest of the app).
- **Compiler/toolchain**: Android NDK's `clang` (via `ndk-build`/CMake, PJSIP's own supported
  Android build path); iOS: Xcode's `clang` via PJSIP's provided `configure-iphone` script.
- **Patches**: none identified as required for this voice-only, PCMU/PCMA/G.722/Opus-only
  configuration — PJSIP's mainline Android/iOS build scripts are the documented, supported path
  for exactly this shape of integration; a patched build should only be introduced if a specific,
  documented problem requires one, not preemptively.

### Provenance policy

**No precompiled PJSIP binary has been added to this repository.** Nothing was copied in from an
unknown or unverified third-party source. Since no NDK/Xcode toolchain is available in this
session to actually compile PJSIP from source, **no native artifact of any kind (source-built or
precompiled) was produced or committed this phase** — only the documented plan above. If a future
session with a working toolchain builds PJSIP from source (the strongly preferred, reproducible
path — building `pjproject`'s own tagged release from `https://github.com/pjsip/pjproject` with
the configuration above), that build's exact commit/tag, configure flags, and toolchain versions
must be recorded in this document's successor. A precompiled binary should be treated as a last
resort only, and even then must record: exact source, version, a checksum, its license, and full
build provenance, per this phase's own instruction — none of that was needed or used this phase
since no binary was introduced at all.

## Summary

Both gates were executed honestly: the environment was inspected (finding two independent,
previously-undocumented Android toolchain gaps beyond the known Gradle issue), the build was
attempted exactly once and failed with the same reconfirmed error, and the PJSIP build strategy is
fully specified and licensing-aligned but was **not executed** — there is no toolchain in this
session capable of compiling it. See `PHASE_13_6A_FINAL_REPORT.md` for the classification this
produces across the rest of the phase's scope.

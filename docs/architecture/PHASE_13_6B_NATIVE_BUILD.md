# Phase 13.6B — Native Build Environment Readiness

Documents the actual state of this workstation's native Android/iOS build environment, what was
found, what was fixed, and exactly what remains blocked and why — so a new engineer (or a future
session) can reproduce this diagnosis without re-discovering it from scratch.

## 1. Required software / versions (as actually found on this machine)

| Component | Found version | Source |
|---|---|---|
| Flutter | 3.47.4 (stable) | `flutter --version` |
| Dart | 3.13.3 | `flutter --version` |
| Windows | 11 Pro, build 10.0.26200 (25H2) | `flutter doctor -v` |
| Android Studio | installed at **`E:\Androidstudio`** (not the default `C:\Program Files\Android\Android Studio` — this is why prior phases' searches missed it) | discovered via `flutter build apk -v` daemon-launch command line |
| Bundled JDK (JetBrains Runtime) | **OpenJDK 21.0.8** at `E:\Androidstudio\jbr\bin\java.exe` | same verbose build output |
| Gradle | 9.3.1 (`-all` distribution) | `android/gradle/wrapper/gradle-wrapper.properties` |
| Android Gradle Plugin | 9.1.0 | `android/settings.gradle.kts` |
| Kotlin Gradle Plugin | 2.4.0 | `android/settings.gradle.kts` |
| Android SDK | at `C:\Users\Murs_Legion\AppData\Local\Android\sdk`, platform `android-36` (36.1.0), build-tools `36.1.0` present | direct directory inspection |
| `android-sdk-license` | **already accepted** (a license marker file exists) | direct directory inspection — corrects `flutter doctor`'s "license status unknown," which is a `cmdline-tools`-detection artifact, not evidence the license was never accepted |
| `platform-tools` (adb) | **present and functional** at `...\sdk\platform-tools\adb.exe` | verified this phase — see §4 |
| `cmdline-tools` | **absent** | direct directory inspection, unchanged from Phase 13.6/13.6A |
| NDK | **absent** | direct directory inspection, unchanged |
| CMake | **absent** (ships via `cmdline-tools`/SDK Manager packages, which aren't installed) | inferred from `cmdline-tools` absence |
| `JAVA_HOME` / `ANDROID_HOME` env vars | **unset** in the shell session used for direct `gradlew` invocation | `echo $JAVA_HOME`/`$ANDROID_HOME` both empty; Flutter's own tooling locates the SDK/JDK independently (via its own `local.properties`/Android Studio detection), which is why `flutter build` gets further than a bare `gradlew.bat` invocation (§3) |

## 2. Environment variables

`local.properties` (Flutter/Gradle-managed, not manually edited) already correctly points at:
```
sdk.dir=C:\Users\Murs_Legion\AppData\Local\Android\sdk
flutter.sdk=C:\Users\Murs_Legion\flutter
```
No `JAVA_HOME`/`ANDROID_HOME` shell environment variables are required for Flutter's own build
path (it resolves the JDK via the Android Studio installation it detects, and the SDK via
`local.properties`) — they are only needed for a bare `gradlew.bat` invocation outside Flutter's
tooling (confirmed by reproducing the "JAVA_HOME is not set" error directly from `gradlew.bat`, a
different and less informative failure than `flutter build apk` reaches).

## 3. Android SDK packages — corrected status

The previous two phases' documented status ("no NDK, no cmdline-tools") is **confirmed still
true**, but two related facts were previously either wrong or incomplete and are corrected here:

- **`adb` is not "missing" — it is present and functional**, just not on this shell's `PATH`. Once
  added to `PATH` (`.../sdk/platform-tools`), `adb devices` runs correctly. Prior phases'
  "adb not on PATH" framing was technically true but read as "adb doesn't work here," which this
  phase disproves directly (§4).
- **The Android SDK license is already accepted** (an `android-sdk-license` marker file exists in
  `sdk/licenses/`). `flutter doctor`'s "Android license status unknown" is specifically a
  consequence of the missing `cmdline-tools` component (which is what `flutter doctor
  --android-licenses` itself needs to even check/re-accept licenses), not evidence licenses were
  never accepted.

`cmdline-tools` and the NDK genuinely do not exist on this machine. Installing them requires
either Android Studio's own SDK Manager UI (not scriptable from this session) or downloading
Google's official `commandlinetools-win-*.zip` and running `sdkmanager` from it — this was **not**
attempted this phase: doing so blind, without knowing whether the deeper Gradle daemon bug (§9)
would even let a subsequent build succeed, risked a large, slow download that would not move the
needle on the actual blocker. See §9's conclusion for why this call was made.

## 4. `cmdline-tools`, `adb`

- `sdkmanager`/`avdmanager`: **absent** (part of `cmdline-tools`, not installed).
- `adb`: **present, verified working this phase**:
  ```
  $ adb devices
  List of devices attached
  ```
  (empty list is correct — no device/emulator was running at that exact moment; see §10 for a
  successful emulator boot immediately after).

## 5. NDK

**Absent.** No NDK version is installed, so no NDK version selection was necessary or possible
this phase. Once `cmdline-tools` is installed, the NDK version should be selected to match: (a)
this project's AGP 9.1.0 / Gradle 9.3.1 compatibility requirements, and (b) whatever NDK version
PJSIP's own Android build documentation recommends at the time a real PJSIP integration begins —
not "the newest available," per this phase's own instruction. This decision is deferred to the
phase that actually performs the PJSIP build, since picking a specific NDK version now, with
nothing to build against it, would be guessing.

## 6. CMake

**Absent**, for the same reason as the NDK (ships as an SDK Manager package under
`cmdline-tools`). Expected future native build chain, unchanged from Phase 13.6's architecture
document: `Flutter → Gradle → Android Gradle Plugin → CMake/NDK (for PJSIP's native library) →
linked into the app's `.so``. Not implemented or exercised this phase.

## 7. JDK version

**OpenJDK 21.0.8**, the JetBrains Runtime bundled with the Android Studio installation at
`E:\Androidstudio\jbr`. This is Flutter's own auto-detected choice (Flutter's own JDK
auto-discovery order: bundled-with-latest-Android-Studio → `JAVA_HOME` → `PATH`) — confirmed by
reading the actual daemon-launch command line Flutter constructs (§9 has the full command). No
JDK conflict was found; only one JDK is reachable on this machine at all, so there is nothing to
conflict with. This JDK version is a plausible root-cause factor in §9's finding, discussed there.

## 8. Gradle version

**9.3.1** (`gradle-wrapper.properties`, `-all` distribution). Not changed this phase.

## 9. Gradle loopback failure — actual root cause identified (new this phase)

Prior phases documented only the surface symptom (`java.io.IOException: Unable to establish
loopback connection`). This phase captured the **full stack trace** via `flutter build apk --debug
-v`, which prior phases had not done:

```
Caused by: java.io.IOException: Unable to establish loopback connection
    at java.base/sun.nio.ch.WEPollSelectorImpl.<init>
    at java.base/sun.nio.ch.WEPollSelectorProvider.openSelector
    at java.base/java.nio.channels.Selector.open
    at org.gradle.internal.remote.internal.inet.SocketConnection$SocketInputStream.<init>
    at org.gradle.internal.remote.internal.inet.SocketConnection.<init>
    at org.gradle.launcher.daemon.client.DefaultDaemonConnector.connectToDaemon
Caused by: java.net.SocketException: Invalid argument: connect
    at java.base/sun.nio.ch.UnixDomainSockets.connect0 (Native Method)
    at java.base/sun.nio.ch.UnixDomainSockets.connect
    at java.base/sun.nio.ch.SocketChannelImpl.connect
    at java.base/sun.nio.ch.PipeImpl$Initializer$LoopbackConnector.run
```

**Exact mechanism**: this JDK build's `java.nio.channels.Selector.open()` on Windows uses
`WEPollSelectorProvider`, which internally builds its self-pipe using an **AF_UNIX domain socket**
(a JDK-on-Windows implementation detail introduced in recent OpenJDK releases, replacing the older
classic TCP-loopback-socketpair emulation). The actual failing native call —
`UnixDomainSockets.connect0` returning `Invalid argument` — is the Gradle **client** process (the
`gradlew`-launched JVM that talks to the daemon) failing to complete this internal AF_UNIX
self-pipe connection at OS level. This is a client-side JVM/OS interaction, not a firewall
rule Gradle itself surfaces a clearer error for.

**Diagnostic steps taken this phase (each with a real, reproducible result):**

1. Re-ran the build once, confirmed identical failure (baseline reconfirmation).
2. Ran with `dangerouslyDisableSandbox: true` — **identical failure**, ruling out this session's
   own tool-level command sandboxing as the cause; this is a genuine OS/JDK-level condition on the
   underlying Windows machine itself, not an artifact of how this session executes commands.
3. Ran `gradlew.bat` directly (bypassing Flutter's tooling) — got a *different*, more basic error
   ("JAVA_HOME is not set"), confirming Flutter's own JDK auto-detection is what gets far enough
   to reach the real bug; this ruled out "no JDK at all" as the cause.
4. Attempted `-Djava.net.preferIPv4Stack=true` via `gradle.properties`' `org.gradle.jvmargs` —
   **no effect** (this only affects the daemon JVM's own args, not the client JVM that fails
   before the daemon is even reached — the fix was misapplied to the wrong process, which this
   report states honestly rather than implying it was tried correctly and simply didn't work).
   Reverted this change immediately after testing; `gradle.properties` is confirmed byte-for-byte
   restored (`git status`/diff check performed).
5. Attempted `-Djava.net.preferIPv4Stack=true` via `GRADLE_OPTS`/`JAVA_TOOL_OPTIONS` environment
   variables (correctly targeting the client JVM this time, confirmed via the "Picked up
   JAVA_TOOL_OPTIONS" log line) — **still failed identically**, ruling out an IPv4/IPv6 preference
   mismatch as the cause.

**Conclusion**: this is consistent with a known class of JDK-on-Windows bugs/environment
interactions affecting the newer `WEPollSelectorProvider`'s AF_UNIX-based self-pipe — commonly
triggered by security/endpoint-protection software, VPN client network-filter drivers, or
specific Windows network-stack configurations intercepting or rejecting local AF_UNIX socket
creation, independent of ordinary IPv4/IPv6 loopback routing (which the two targeted fixes above
already ruled out). Resolving it conclusively requires either: (a) identifying and adjusting
whatever security/network software on this specific Windows machine is intercepting AF_UNIX socket
creation (an IT/security action outside this session's scope, and the phase brief explicitly
forbids weakening security controls to force a build through), or (b) using a different JDK
distribution/version on this machine not affected by this `WEPollSelectorProvider` code path (an
alternative JDK was not available to test — this machine has exactly one reachable JDK, see §1),
or (c) building on a different machine/CI runner entirely.

## 10. Physical/emulated Android device — corrected status (new finding this phase)

**An Android emulator successfully boots and is fully usable on this machine.** This corrects
every prior phase's blanket "no working Android device" framing:

```
$ flutter emulators --launch Pixel_9_Pro
$ adb devices
emulator-5554   device
$ adb -s emulator-5554 shell getprop ro.build.version.release
16
```

The emulator (`Pixel_9_Pro`, Android 16) booted to a fully interactive `device` state within
~60 seconds and was cleanly shut down afterward (`adb emu kill`) — no leftover process, no
persistent state introduced. **This device cannot currently be used to test SupremeOS** because no
APK can be built to install on it (§9's Gradle failure blocks that step regardless of the device
being available) — but the device/emulator layer of the stack is genuinely healthy, which is new,
useful, and previously-undocumented information: the blocker is squarely in Gradle's build
process, not in device availability.

## 11. Android release/debug/native-library packaging (design note, not implemented)

Once a native SIP library exists, it packages the same way any NDK-built `.so` does in a Flutter/
Gradle Android project: as `src/main/jniLibs/<abi>/lib*.so` (for a prebuilt library) or via a
Gradle `externalNativeBuild { cmake { ... } }` block (for a source build) inside `android/app/
build.gradle.kts` — this requires no change to SupremeOS's existing Gradle module structure or
Flutter plugin architecture, and applies identically across debug/profile/release build types
(Gradle's native-library packaging is build-type-agnostic by default). Not implemented this phase
— nothing to package yet.

## 12. macOS/Xcode requirements

This machine is Windows — categorically no iOS native compilation is possible here, stated plainly
per this phase's explicit instruction not to pretend otherwise. What a macOS environment would
need, for the record (unchanged from Phase 13.6's own documentation, restated here for
completeness):

- macOS (a recent version compatible with the Xcode version below).
- Xcode (current stable, matching Flutter 3.47.4's supported range).
- Swift (ships with Xcode).
- CocoaPods or Swift Package Manager (this project's `ios/Podfile` presence, if any, determines
  which — not re-inspected this phase since it cannot be exercised without macOS regardless).
- An Apple Developer account, for code signing and for the PushKit/CallKit entitlements Phase
  13.4 already established as required capabilities.
- A physical iPhone for real-device VoIP push testing (the iOS Simulator does not support PushKit
  VoIP push delivery).

## 13. iOS project — static inspection only

No Mac exists in this session, so only a static inspection of the existing `apps/new/mobile/ios/`
project structure was performed (file presence, not a build). **Classification: NATIVE BUILD
ACCEPTANCE REQUIRED** — unchanged from every prior phase; this phase adds nothing new here since
no Mac became available during this session.

## 14. PJSIP build prerequisites (restated from Phase 13.6A, unchanged)

PJSIP 2.15.x, `pjsua2` C++ layer, GPLv2/Teluu-commercial dual license (§15), codecs PCMU/PCMA/
G.722/Opus only (G.729/AMR/G.722.1 excluded at build-config time), OpenSSL for TLS/SRTP,
`arm64-v8a`/`armeabi-v7a`/`x86_64` (Android), `arm64`+simulator slices (iOS). **Not compiled this
phase** — no NDK/Xcode toolchain exists to compile it against (§§5, 12). No `PJSIP BUILD
EXPERIMENT` was attempted, since attempting one against a Gradle toolchain that cannot complete
even a plain `assembleDebug` for the existing pure-Kotlin/Dart app (§9) would not produce a
meaningful signal about PJSIP specifically — the failure would be indistinguishable from the
already-diagnosed Gradle daemon bug.

## 15. Licensing

Reviewed `PHASE_13_6A_SIP_LICENSING.md` — status unchanged: **PJSIP commercial license = NOT
PROCURED.** No license was purchased or authorized this phase; none of this phase's environment
work required one (no PJSIP code was compiled or linked). **Classification: PRODUCTION HARDENING
REQUIRED**, carried forward unmodified.

## 16. SIP test lab — specification (not implemented)

Unchanged in shape from Phase 13.6's own E2E test document, restated here as the forward-looking
specification this phase is scoped to produce (not execute):

```
SIP test server (e.g. a controlled local Asterisk/FreeSWITCH instance, or an approved lab SIP
  server) — transport: UDP or TLS (TLS preferred, matching SupremeOS's `SipTransport.tls`
  door-station convention); port: 5060 (UDP) / 5061 (TLS) standard SIP ports; RTP port range:
  a documented range (e.g. 10000-20000) opened on the test server/LAN, per PJSIP's own
  `pjsua2::TransportConfig` RTP port-range setting
    │
    ├── Android SupremeOS (first target device — the emulator confirmed working in §10, or a
    │     physical device once a build can be produced)
    │
    ├── iPhone SupremeOS (once macOS/Xcode access exists)
    │
    └── a real SIP door station unit (final validation step, once the above two succeed)
```

Codec: PCMU or PCMA (per §14's licensing-clean set) for the initial test — whichever the chosen
test SIP server/softphone endpoint negotiates by default. Authentication: a dedicated **test-only**
SIP account, never a production credential, and never committed to source control (a placeholder
`.env`/local-only credentials file, matching this project's existing `PairedHomeAuthorizationStore`
credential-handling convention). NAT: none assumed for the initial LAN-only test — this matches
the existing architecture decision (Phase 13.6's native architecture doc) that SIP media stays
LAN-first and does not traverse the Tunnel Broker. **Nothing in this specification was executed
this phase** — no server was stood up, no test account was created, no device was registered.

## 17. Verification commands (for a future session/engineer to re-run)

```bash
# Flutter/Dart
flutter --version
flutter doctor -v

# Android SDK inventory (adjust path if a different machine)
ls "$LOCALAPPDATA/Android/sdk"                 # expect: platforms, build-tools, platform-tools,
                                                #   licenses (cmdline-tools/ndk currently absent)
"$LOCALAPPDATA/Android/sdk/platform-tools/adb.exe" devices

# Emulator boot check
flutter emulators
flutter emulators --launch Pixel_9_Pro
adb devices                                    # expect "device" status after ~60s boot
adb -s emulator-5554 emu kill                  # clean shutdown

# Build attempt (expect the AF_UNIX loopback failure documented in §9 until resolved)
cd apps/new/mobile
flutter build apk --debug -v 2>&1 | grep -A5 "Unable to establish loopback"

# Regression (must stay green regardless of native build status)
cd apps/new/shared && flutter analyze && flutter test
cd ../mobile && flutter analyze && flutter test
cd ../shared_ui && flutter analyze && flutter test
cd ../touchpanel && flutter analyze && flutter test
```

## Known failures / troubleshooting summary

| Symptom | Cause | Status |
|---|---|---|
| `assembleDebug` fails: "Unable to establish loopback connection" | `WEPollSelectorProvider`'s AF_UNIX self-pipe failing at OS level in the Gradle client JVM (OpenJDK 21.0.8, JetBrains Runtime, on this specific Windows machine) | Root cause identified this phase; not resolved — requires security-software/JDK-distribution investigation outside this session's scope, or a different build machine |
| `flutter doctor`: "Android license status unknown" | `cmdline-tools` missing (needed for `flutter doctor` to check/re-accept licenses), NOT evidence the license was never accepted | Corrected this phase — license file exists |
| "adb not on PATH" | True for the default shell PATH, but the binary exists and works once referenced directly or added to PATH | Corrected this phase — verified functional |
| No usable Android device | Was assumed in prior phases; **false** — an emulator boots and reaches a fully usable `device` state in ~60s | Corrected this phase |
| No NDK / no `cmdline-tools` | Genuinely absent from this SDK install | Unchanged, confirmed again this phase |
| No macOS/Xcode | Categorical (Windows machine) | Unchanged |

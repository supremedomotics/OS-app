# Phase 13.6C — Android Native Build Recovery

## 1. Initial environment

Unchanged from Phase 13.6B at session start: Flutter 3.47.4, Dart 3.13.3, Android Studio at
`E:\Androidstudio`, Android SDK present (platforms/build-tools/platform-tools/license), no
`cmdline-tools`/NDK/CMake, `adb` functional once referenced directly, `Pixel_9_Pro` emulator boots,
no macOS/Xcode, all Flutter tests green, Gradle build fails with the AF_UNIX loopback error.

## 2. JDKs discovered

**Exactly one JDK existed on this machine at the start of this phase**: JetBrains Runtime (JBR)
21.0.8, bundled with Android Studio at `E:\Androidstudio\jbr`. No system-wide `java`/`javac` on
`PATH`, no `JAVA_HOME` set. Verified directly: `E:\Androidstudio\jbr\bin\java.exe -version` →
`openjdk version "21.0.8"`, implementor `JetBrains s.r.o.`.

This phase additionally installed **Eclipse Temurin JDK 17.0.20.1+1** (official Adoptium release,
downloaded from `github.com/adoptium/temurin17-binaries`) to `C:\Users\Murs_Legion\jdk17\`, per
Step 4's explicit instruction to test a supported alternative JDK — justified below (§13).

## 3. Flutter-selected JDK

Flutter's own JDK auto-discovery (documented order: Android-Studio-bundled JDK →
`JAVA_HOME` → `PATH`) selects `E:\Androidstudio\jbr\bin\java.exe` (JBR 21.0.8) by default,
confirmed via `flutter build apk -v`'s own logged `executing: E:\Androidstudio\jbr\bin\java
-version` line. `flutter config --jdk-dir` was used to temporarily redirect this to the newly
installed JDK 17 for a controlled experiment (§8–9), then reverted (§13) once proven not to fix
the actual failure.

## 4. Android Studio JDK

`E:\Androidstudio\jbr` — JetBrains Runtime 21.0.8 (Temurin-family OpenJDK build maintained by
JetBrains for Android Studio/IntelliJ). This is the only Android-Studio-provided JDK on this
machine (no other Android Studio JDK version is bundled or cached here).

## 5. Gradle investigation

Gradle wrapper: **9.3.1** (`gradle-wrapper.properties`, unchanged, not modified this phase).
Android Gradle Plugin: **9.1.0**. Kotlin Gradle Plugin: **2.4.0**. The project's own
`app/build.gradle.kts` sets `compileOptions { sourceCompatibility = JavaVersion.VERSION_17;
targetCompatibility = JavaVersion.VERSION_17 }` — the project's OWN declared Java compatibility
target is already 17, not 21, which is what motivated testing JDK 17 as the Gradle JVM (§13) as a
principled, project-aligned experiment rather than an arbitrary version guess.

## 6. AGP/Gradle compatibility

AGP 9.1.0 + Gradle 9.3.1 is a matched, current, officially supported pairing (AGP 9.x requires a
recent Gradle 9.x release; 9.3.1 satisfies that). Both officially support running on JDK 17 or
JDK 21 as the build JVM — this combination was not the source of the failure (confirmed in §11).
No version was upgraded or downgraded this phase; only the JVM Gradle itself runs on was tested at
two different versions.

## 7. Android SDK status

Present, unchanged: `platforms` (android-36/36.1.0), `build-tools` (36.1.0), `platform-tools`
(`adb.exe`, confirmed working — `adb version` → `Android Debug Bridge version 1.0.41`), SDK
license already accepted (`licenses/android-sdk-license` exists).

## 8. cmdline-tools status

**Still absent.** Not installed this phase. Per Step 8's explicit instruction ("if PJSIP is not
being compiled in this phase, do not install NDK/CMake merely because the future SIP phase may
need them... Install them only if the current Android build requires them") — the current,
non-PJSIP debug build does not require `cmdline-tools`/NDK/CMake at all (this project has no
native (C/C++) code to compile; Flutter's own toolchain, Kotlin, and the Android SDK
platform/build-tools already installed are sufficient for a normal Kotlin+Dart APK). Installing
them would not have addressed the actual blocker (§11–12) and was correctly not pursued.

## 9. NDK status

**Still absent**, same reasoning as §8 — not required for this build, not installed.

## 10. CMake status

**Still absent**, same reasoning.

## 11. Exact Gradle error

Identical to Phase 13.6B's finding, reconfirmed at the start of this phase:
```
java.io.IOException: Unable to establish loopback connection
Caused by: java.net.SocketException: Invalid argument: connect
    at sun.nio.ch.UnixDomainSockets.connect0 (Native Method)
```
Reached via `WEPollSelectorProvider`'s or `WindowsSelectorImpl`'s internal self-pipe
(`sun.nio.ch.PipeImpl`) — see §12 for how this phase narrowed it further.

## 12. Root cause — decisively isolated this phase

Phase 13.6B identified the failing code path (`WEPollSelectorProvider`'s AF_UNIX self-pipe) but
left open whether it was JDK-21-specific, Gradle-specific, or something broader. This phase ran
four independent, isolating experiments (§13) that together prove:

**This is not a JDK version issue, not a Gradle issue, not a Flutter/AGP issue, and not specific
to the `Selector`/`Pipe` abstraction at all. It is a machine-level failure of the raw AF_UNIX
`connect()` syscall itself.** A ten-line, dependency-free Java program that does nothing but:
```java
ServerSocketChannel.open(StandardProtocolFamily.UNIX).bind(addr);   // succeeds
SocketChannel.open(StandardProtocolFamily.UNIX).connect(addr);      // fails, same exact error
```
reproduces the identical `SocketException: Invalid argument: connect` from `UnixDomainSockets
.connect0`, entirely outside Gradle, Flutter, Android, or even `java.nio.channels.Selector`. The
socket **binds** successfully (proving Unix-domain-socket support exists and the filesystem path
is valid) but **connecting** to that exact, valid, already-bound socket fails at the OS syscall
level. This is consistent with a security/EDR product or a Windows-build-specific AF_UNIX
`connect()` defect on this specific machine — not something any JDK version, Gradle version, or
Android/Flutter project configuration change can work around, because the failure occurs below
all of those layers, in the raw platform socket call every JVM ships with no alternative
implementation for.

## 13. Experiments performed

| # | Experiment | Configuration | Result |
|---|---|---|---|
| 1 | Baseline reconfirmation | JBR 21.0.8 (default), unchanged project | Failed — same error, reconfirmed once (not repeated blindly) |
| 2 | `org.gradle.java.home` in `android/gradle.properties` → JDK 17 | Project-scoped Gradle property | **No effect** — proven ineffective: this setting only controls the Gradle *daemon* JVM, but the failure occurs in the Gradle *client/wrapper* JVM Flutter itself launches, which this property does not affect. Reverted immediately (confirmed via `git diff`, clean). |
| 3 | `flutter config --jdk-dir` → JDK 17 (Temurin 17.0.20.1+1, official Adoptium release) | Global Flutter JDK selection, confirmed via verbose log that both the version-check AND the Gradle daemon launch now used JDK 17 | **Failed identically** — same exact stack trace, now with resolved line numbers (`PipeImpl.java:103` etc., since Temurin ships debug info JBR strips), confirming a genuinely different JDK build was used and still failed the same way. Disproves "JDK 21 specifically" as the cause. |
| 4 | Isolated `Selector.open()` in a bare 5-line Java program, JDK 17, no Gradle/Flutter/Android involved at all | `java -cp . T` | **Failed identically** — proves this is not Gradle/AGP/Flutter-specific at all; any JVM code path that opens a `Selector` on this machine fails. |
| 5 | Force the legacy `WindowsSelectorProvider` via the standard JDK SPI override (`-Djava.nio.channels.spi.SelectorProvider=sun.nio.ch.WindowsSelectorProvider`) | JDK 17, isolated test program | **Failed identically**, but now via `WindowsSelectorImpl` instead of `WEPollSelectorImpl` — proves the AF_UNIX self-pipe mechanism is used by BOTH selector implementations on this JDK build, not only the newer WEPoll one. |
| 6 | Bare `ServerSocketChannel`/`SocketChannel` AF_UNIX bind+connect, no `Selector`/`Pipe` involved at all | JDK 17, isolated test program | **Bind succeeds, connect fails** with the identical `SocketException` — the single most decisive experiment: isolates the failure to the raw AF_UNIX `connect()` syscall itself, below every Java abstraction layer this investigation had tested so far. |

Each experiment changed exactly one variable from the previous baseline, per Step 6's instruction,
and each result is a real, reproduced command output (no experiment's result is inferred or
assumed).

## 14. Successful configuration, if any

**None found.** No JDK version, `SelectorProvider` implementation, or Flutter/Gradle configuration
produced a working build, because the failure sits below all of those — at the OS/security-layer
AF_UNIX `connect()` syscall.

## 15. Unsuccessful configurations

All four configurations tested in §13 (experiments 2, 3, 5, 6 as configuration changes; 1 and 4
as diagnostic baselines) failed to produce a working build or a working raw AF_UNIX connection.

## 16. Final environment

Identical to the initial state (§1) — every experimental change was reverted:
- `apps/new/mobile/android/gradle.properties`: confirmed byte-for-byte identical to before this
  phase (`git diff` clean).
- `flutter config --jdk-dir`: unset (confirmed via `flutter config` no longer listing a value).
- The downloaded Temurin JDK 17 (`C:\Users\Murs_Legion\jdk17\`) was left on disk (harmless,
  outside the repository, not referenced by any project configuration) rather than deleted, since
  a future session may reuse it for further diagnosis without re-downloading 190MB.

## 17. APK build result

**Failed**, identical to the pre-phase baseline, reconfirmed with the environment fully reverted.
**Classification: ENVIRONMENT BLOCKED.**

## 18. Emulator result

Not exercised this phase beyond the confirmation already established in Phase 13.6B (the
`Pixel_9_Pro`/Android 16 emulator boots correctly) — there was no APK to install on it this phase,
so no new emulator-side action was performed. Re-verifying the emulator boots was not repeated
since nothing in this phase's Android-toolchain investigation could have affected it.

## 19. Regression results

`shared` 192/192, `mobile` 90/90, `shared_ui` 7/7, `touchpanel` 23/23 — exactly matching the
documented baseline, zero regressions. `flutter analyze` clean (0 issues), all four packages.
`flutter build web` succeeds for `apps/new/mobile` and `apps/new/touchpanel`.

## 20. Files changed

- **Added**: `docs/architecture/PHASE_13_6C_ANDROID_BUILD_RECOVERY.md` (this document).
- **Temporarily modified, then fully reverted and confirmed clean via `git diff`**:
  `apps/new/mobile/android/gradle.properties` (one experimental line, added and removed within
  this phase).
- **Global machine state, reverted**: `flutter config --jdk-dir` (set, then unset).
- **No other file was modified.** No SIP code, no `SipEngine`/`SipService` architecture, no
  `MobileRuntime`, no Hub/auth/cloud code was touched — nothing in this phase's investigation
  required any of it, per the phase's explicit scope boundary.

## 21. Remaining blockers

1. **The actual blocker is a machine-level AF_UNIX `connect()` failure**, not a Gradle, JDK,
   Flutter, or Android-project configuration issue — decisively isolated this phase (§12–13).
   Resolving it requires investigating this specific Windows machine's security/EDR software or
   Windows networking stack for AF_UNIX interception — outside what any project-level
   configuration change can fix, and outside the scope this phase was authorized to pursue (Step
   11 explicitly forbids weakening security controls).
2. `cmdline-tools`/NDK/CMake remain uninstalled — correctly not pursued, since they are not the
   blocker and are not required for the current (non-native, non-PJSIP) build.
3. No macOS/Xcode — categorical, unchanged.
4. A future PJSIP integration is unaffected by whether this specific AF_UNIX bug is fixed on THIS
   machine — a different build machine (or resolving the security-software interception on this
   one) would unblock ordinary Android builds regardless of SIP work.

## What would actually resolve this (for a future session/engineer, not pursued here)

- Identify and adjust whatever security/EDR software on this specific Windows machine intercepts
  local AF_UNIX socket `connect()` calls (an IT/security investigation, not a code change).
- Build on a different machine (a colleague's machine, a cloud CI runner, or a fresh Windows
  install) where this AF_UNIX condition does not exist — the two isolated test programs in §13
  (experiments 4 and 6) are the fastest possible way to confirm whether a candidate replacement
  machine has the same problem, in under a minute, before attempting a full Flutter build there.

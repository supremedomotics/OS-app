# Phase 13.6C — Android Native Build Recovery — Final Report

## 1. Initial state

Unchanged from Phase 13.6B: Android SDK present (platforms/build-tools/platform-tools/license),
`cmdline-tools`/NDK/CMake absent, `adb` functional, `Pixel_9_Pro` emulator boots, no macOS/Xcode,
all tests green, Gradle build failing with the AF_UNIX loopback error. Full detail:
`PHASE_13_6C_ANDROID_BUILD_RECOVERY.md` §1.

## 2. JDK investigation

One JDK existed at phase start: JetBrains Runtime 21.0.8 (bundled with Android Studio at
`E:\Androidstudio`). This phase additionally installed Eclipse Temurin JDK 17.0.20.1+1 (official
Adoptium release) to test the project's own declared Java-17 compatibility target as an
alternative Gradle JVM. Full detail: §2.

## 3. Flutter Java selection

Flutter auto-selects the Android-Studio-bundled JBR 21.0.8 by default (confirmed via verbose
build log). `flutter config --jdk-dir` was used to redirect this to JDK 17 for a controlled
experiment, then reverted once proven not to fix the actual failure. Full detail: §3.

## 4. Android Studio JDK

`E:\Androidstudio\jbr` — JetBrains Runtime 21.0.8. Full detail: §4.

## 5. Gradle investigation

Gradle 9.3.1, AGP 9.1.0, Kotlin 2.4.0. The project's own `compileOptions` already target
`JavaVersion.VERSION_17`, which is what motivated testing JDK 17 as a principled, project-aligned
experiment. Full detail: §5.

## 6. AGP/Gradle compatibility

A current, officially-supported, matched pairing; supports both JDK 17 and 21 as the build JVM.
Not the source of the failure. Full detail: §6.

## 7. Android SDK status

Present and correct (platforms, build-tools, platform-tools, accepted license) — unchanged from
Phase 13.6B.

## 8. cmdline-tools status

Still absent. Correctly not installed this phase — not required for this (non-native) build, per
this phase's own explicit "do not install NDK/CMake merely because a future SIP phase may need
them" instruction.

## 9. NDK status

Still absent, same reasoning as §8.

## 10. CMake status

Still absent, same reasoning.

## 11. Root cause of AF_UNIX failure — decisively identified this phase

**This is not a JDK-version, Gradle, AGP, or Flutter-project issue.** Through four progressively
more isolating experiments (§13 of the companion document), this phase proved the failure is a
**machine-level defect in the raw AF_UNIX socket `connect()` syscall itself** — reproduced with a
bare 10-line Java program using nothing but `java.nio.channels.SocketChannel` and
`StandardProtocolFamily.UNIX`, entirely outside Gradle/Flutter/Android/even `Selector`. A socket
**binds** successfully; **connecting** to that exact valid socket fails with `SocketException:
Invalid argument: connect` at `sun.nio.ch.UnixDomainSockets.connect0` (a native call). This
occurs identically under JetBrains Runtime 21.0.8 and Eclipse Temurin 17.0.20.1, and under both
the modern `WEPollSelectorProvider` and the legacy `WindowsSelectorProvider` — ruling out JDK
vendor, JDK version, and selector-implementation choice as variables. The remaining plausible
causes are a security/EDR product on this specific machine intercepting AF_UNIX `connect()`
calls, or a Windows-build-specific AF_UNIX stack defect — both are outside what any project-level
Gradle/JDK/Flutter configuration can fix, and outside this phase's authorized scope to pursue
further (Step 11 explicitly forbids weakening security software). Full evidence table: companion
document §13.

## 12. Experiments performed

Six, each changing exactly one variable: (1) baseline reconfirmation, (2) `org.gradle.java.home`
in `gradle.properties` → JDK 17 (no effect — wrong process, only affects the daemon not the
failing client JVM), (3) `flutter config --jdk-dir` → JDK 17 (failed identically, ruling out JDK
21 specifically), (4) isolated `Selector.open()` with no Gradle/Flutter/Android involved (failed
identically, ruling out Gradle/AGP), (5) forced legacy `WindowsSelectorProvider` via the standard
JDK SPI override (failed identically, ruling out the selector implementation choice), (6) bare
AF_UNIX bind+connect with no `Selector`/`Pipe` at all (bind succeeds, connect fails — the
decisive, final isolation). Full detail and exact commands/output: companion document §13.

## 13. Final selected configuration

**No configuration change resolved the build** — every experimental change (§12) was reverted;
the final repository state is byte-for-byte identical to the pre-phase baseline
(`git diff apps/new/mobile/android/gradle.properties` clean; `flutter config --jdk-dir` unset).

## 14. Android APK result

**Failed.** `ENVIRONMENT BLOCKED` — the root cause (§11) is a machine-level condition, not
anything in this project's Flutter/Android/Gradle configuration.

## 15. Pixel 9 Pro emulator result

Not re-exercised this phase (no APK existed to install); its ability to boot was already
established in Phase 13.6B and nothing this phase's investigation could have changed that.
`REAL-WORLD ACCEPTANCE TEST REQUIRED` remains the honest status for actually running SupremeOS on
it, since no build exists to test.

## 16. Regression results

`shared` 192/192, `mobile` 90/90, `shared_ui` 7/7, `touchpanel` 23/23 — exactly matching the
documented baseline, zero regressions. `flutter analyze` clean (0 issues) on all four packages.
`flutter build web` succeeds for `apps/new/mobile` and `apps/new/touchpanel`.

## 17. Files changed

Added: `docs/architecture/PHASE_13_6C_ANDROID_BUILD_RECOVERY.md`,
`docs/architecture/PHASE_13_6C_FINAL_REPORT.md`. `apps/new/mobile/android/gradle.properties` was
temporarily modified and fully reverted within this phase (confirmed via `git diff`). No SIP,
architecture, Hub, auth, or cloud code was touched. A Temurin JDK 17 install was left on disk at
`C:\Users\Murs_Legion\jdk17\` (outside the repository, unreferenced by any project config) for
potential reuse in future diagnosis.

## 18. Remaining blockers

1. The actual, now-precisely-identified blocker: a machine-level AF_UNIX `connect()` failure on
   this specific Windows machine, most likely caused by security/EDR software or a Windows AF_UNIX
   stack defect — requires an IT/security investigation of this machine, or building on a
   different machine, neither of which is a code or configuration change.
2. `cmdline-tools`/NDK/CMake remain uninstalled (correctly — not required for this build).
3. No macOS/Xcode — categorical, unchanged.

## 19. Classification matrix

| Area | Classification |
|---|---|
| JDK investigation (both installed JDKs tested) | REAL |
| Root-cause isolation (6 controlled experiments) | REAL |
| AF_UNIX `connect()` machine-level defect | REAL (finding); underlying fix: ENVIRONMENT BLOCKED |
| Android SDK/platform-tools/adb | REAL |
| `cmdline-tools`/NDK/CMake | NOT IMPLEMENTED (correctly not installed — not required) |
| Android APK build | ENVIRONMENT BLOCKED |
| Pixel 9 Pro emulator boot | DEVICE VERIFIED (established Phase 13.6B, unchanged) |
| SupremeOS running on Pixel 9 Pro emulator | REAL-WORLD ACCEPTANCE TEST REQUIRED (no APK to install) |
| iOS/macOS | NATIVE BUILD ACCEPTANCE REQUIRED |
| Existing test suites | BUILD VERIFIED (192/90/7/23, zero regressions) |
| Web builds (mobile, touchpanel) | BUILD VERIFIED |
| Experimental changes reverted | REAL (confirmed via `git diff`) |
| **REAL SIP VOICE** | **NOT IMPLEMENTED** |
| **PJSIP** | **NOT IMPLEMENTED** |
| **VIDEO** | **NOT IMPLEMENTED** |
| **DOOR RELEASE** | **NOT IMPLEMENTED** |
| **UNLOCK** | **NOT IMPLEMENTED** |
| **DTMF SECURITY** | **NOT IMPLEMENTED** |

## Success criteria — self-assessment

The build remains blocked. Per this phase's own stop rule, this is acceptable **because the exact
blocker is now identified and documented** at a level of precision (a machine-level AF_UNIX
`connect()` syscall failure, isolated below Gradle/Flutter/AGP/JDK-version/selector-implementation
entirely) that no prior phase reached. No configuration hack was left in place to mask this; no
native functionality was fabricated; no SIP/video/door-release work was started; all regressions
remain at zero.

## Stop condition

Stopping after this report, as instructed. Not starting Phase 13.6D, PJSIP, SIP, video, or door
release automatically.

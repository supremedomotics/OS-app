# Phase 13.6B — native build health check. Read-only: reports READY/MISSING for each
# component this repo's future native SIP work needs; never installs or modifies anything.
# Usage: powershell -File tools/check-native-build-health.ps1

function Check($label, [bool]$condition, $detail = "") {
    $status = if ($condition) { "READY" } else { "MISSING" }
    $color = if ($condition) { "Green" } else { "Red" }
    Write-Host ("{0,-28} {1}" -f $label, $status) -ForegroundColor $color -NoNewline
    if ($detail) { Write-Host "  ($detail)" } else { Write-Host "" }
}

Write-Host "SupremeOS native build health check (read-only)`n"

# Flutter / Dart
$flutterVersion = (flutter --version 2>$null | Select-String "Flutter ") -replace "Flutter ", "" | Select-Object -First 1
Check "Flutter" ($null -ne $flutterVersion) $flutterVersion

# Android SDK root (Flutter's default on Windows)
$sdkRoot = "$env:LOCALAPPDATA\Android\sdk"
Check "Android SDK" (Test-Path $sdkRoot) $sdkRoot
Check "  platforms" (Test-Path "$sdkRoot\platforms" -PathType Container -ErrorAction SilentlyContinue) ""
Check "  build-tools" (Test-Path "$sdkRoot\build-tools" -PathType Container -ErrorAction SilentlyContinue) ""
Check "  platform-tools (adb)" (Test-Path "$sdkRoot\platform-tools\adb.exe") ""
Check "  cmdline-tools" (Test-Path "$sdkRoot\cmdline-tools") "required for sdkmanager/NDK install"
Check "  NDK" (Test-Path "$sdkRoot\ndk") "required to compile PJSIP"
Check "  SDK license accepted" (Test-Path "$sdkRoot\licenses\android-sdk-license") ""

# JDK — Flutter's own auto-detected bundled JDK (Android Studio's JBR), not a shell env var
$jbr = Get-ChildItem "C:\Program Files\Android\Android Studio\jbr\bin\java.exe","E:\Androidstudio\jbr\bin\java.exe" `
    -ErrorAction SilentlyContinue | Select-Object -First 1
Check "JDK (Android Studio JBR)" ($null -ne $jbr) $(if ($jbr) { $jbr.FullName } else { "" })

# macOS/Xcode — never true on Windows; stated honestly, not probed further
Check "macOS/Xcode" $false "this script only runs where PowerShell/Windows is present"

Write-Host "`nThis script reports status only. It does not install, modify, or repair anything."
Write-Host "See docs/architecture/PHASE_13_6B_NATIVE_BUILD.md for the full diagnosis and next steps."

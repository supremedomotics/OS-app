<#
  Golden Master verification: capture the Golden Master and Flutter at every profile and surface,
  then compare. Output (default build/golden-master): gm/ flutter/ diff/ report.html report.json.

    tools/golden-master-verify/run.ps1                       # everything
    tools/golden-master-verify/run.ps1 -Profiles phone-portrait,desktop
    tools/golden-master-verify/run.ps1 -GmFile "G:\Downloads\SupremeOS-10.html"

  Needs: Node 22+, Chrome or Edge (CHROME_PATH to override), Flutter. Nothing is installed, and no
  project file is changed; Chrome runs with a private temporary profile.
#>
param(
  [string]$GmFile = 'G:\Downloads\SupremeOS-10.html',
  [string]$Out = '',
  [string[]]$Profiles = @(),
  [switch]$SkipGm,
  [switch]$SkipFlutter
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $Out) { $Out = Join-Path $root 'build\golden-master' }
New-Item -ItemType Directory -Force $Out | Out-Null
$prof = if ($Profiles.Count) { $Profiles -join ',' } else { '' }

if (-not $SkipGm) {
  Write-Host "== Golden Master ($GmFile)"
  $a = @('capture-gm.mjs', '--gm', $GmFile, '--out', $Out)
  if ($prof) { $a += @('--profiles', $prof) }
  Push-Location $PSScriptRoot; node @a; Pop-Location
  if ($LASTEXITCODE) { throw 'Golden Master capture failed' }
}
if (-not $SkipFlutter) {
  Write-Host "== Flutter (apps/new/mobile)"
  $env:GMV_OUT = $Out
  if ($prof) { $env:GMV_PROFILES = $prof } else { Remove-Item Env:GMV_PROFILES -ErrorAction SilentlyContinue }
  # Flutter's toolchain needs a temp dir its Java/Dart children may use.
  if (-not $env:TEMP -or $env:TEMP -like '*AppData*') { $env:TEMP = 'C:\t'; $env:TMP = 'C:\t' }
  Push-Location (Join-Path $root 'apps\new\mobile')
  flutter test test/golden_master/capture_test.dart --tags golden-master
  $code = $LASTEXITCODE
  Pop-Location
  if ($code) { Write-Warning 'Flutter capture reported failures; comparing what was captured.' }
}
Write-Host "== Compare"
Push-Location $PSScriptRoot; node compare.mjs --out $Out; node typography.mjs --out $Out; Pop-Location
Write-Host "Report: $Out\report.html   Type and position: $Out\typography.md"

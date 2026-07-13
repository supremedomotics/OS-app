#Requires -Version 5.1
<#
.SYNOPSIS
    Single source of truth for "what URL is SupremeOS reachable at right now" (§ CLAUDE.md —
    URL discovery workflow). Mirrors discover-supremeos-url.js exactly; use whichever fits the
    calling context. Every browser-test entry point should call this instead of re-deriving the
    URL itself — the LAN IP is whatever this machine's active adapter currently has, never a
    value to hardcode or cache across runs.

.OUTPUTS
    Prints ONLY the result JSON to stdout (pipeable/parseable) via Write-Output; all diagnostics
    go to Write-Host (stderr-equivalent for interactive display, does not pollute stdout capture).
    Exit code 0 + healthy:true on success; non-zero + healthy:false otherwise.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Write-Diag {
    param([string]$Message)
    Write-Host $Message -ForegroundColor DarkGray
}

function Write-Result {
    param([hashtable]$Result)
    Write-Output ($Result | ConvertTo-Json -Compress)
}

function Test-DockerRunning {
    try {
        docker info *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Test-ProxyHealthy {
    try {
        $status = docker ps --filter "name=supreme-hub-proxy" --format "{{.Status}}" 2>$null
        return [bool]($status -and $status.Trim().ToLower().StartsWith('up'))
    } catch {
        return $false
    }
}

# Adapter names to ignore per requirement — Hyper-V/WSL/VirtualBox/Docker virtual switches and
# loopback never carry real LAN traffic; link-local (169.254.x.x) is excluded separately below
# since it's an address range, not an adapter name.
$script:ExcludeAdapterPattern = 'Hyper-V|vEthernet|WSL|VirtualBox|VBoxNet|Docker|Loopback'

function Get-LanIPv4 {
    # Requiring a default gateway is the reliable signal — real LAN adapters have one; virtual
    # host-only adapters (VirtualBox, Hyper-V, WSL) generally don't. Name/description exclusion
    # alone is insufficient: a VirtualBox host-only adapter has been observed surfacing as a
    # generic "Ethernet N" alias with nothing to pattern-match on.
    $configs = Get-NetIPConfiguration | Where-Object {
        $_.NetAdapter.Status -eq 'Up' -and
        $_.IPv4Address -and
        $_.IPv4DefaultGateway -and
        $_.InterfaceAlias -notmatch $script:ExcludeAdapterPattern -and
        $_.NetAdapter.InterfaceDescription -notmatch $script:ExcludeAdapterPattern
    }
    foreach ($c in $configs) {
        $ip = $c.IPv4Address.IPAddress
        if ($ip -and -not $ip.StartsWith('169.254.')) {
            return @{ Name = $c.InterfaceAlias; Address = $ip }
        }
    }
    return $null
}

# Windows PowerShell 5.1 has no -SkipCertificateCheck on Invoke-WebRequest; trust the internal
# CA's self-signed cert (§ Caddyfile) via the legacy ICertificatePolicy hook instead.
Add-Type -TypeDefinition @"
using System.Net;
using System.Security.Cryptography.X509Certificates;
public class DiscoverSupremeOSTrustAllCertsPolicy : ICertificatePolicy {
    public bool CheckValidationResult(ServicePoint sp, X509Certificate cert, WebRequest req, int problem) { return true; }
}
"@ -ErrorAction SilentlyContinue
[System.Net.ServicePointManager]::CertificatePolicy = New-Object DiscoverSupremeOSTrustAllCertsPolicy
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

function Invoke-Probe {
    param([string]$Url)
    try {
        return Invoke-WebRequest -Uri $Url -TimeoutSec 4 -UseBasicParsing
    } catch {
        return $null
    }
}

function Test-EndpointHealthy {
    param([string]$Base)

    $root = Invoke-Probe "$Base/"
    if (-not $root -or $root.StatusCode -ne 200) { return $false }

    $html = $root.Content
    $scriptMatch = [regex]::Match($html, '<script[^>]+src="([^"]+)"')
    $cssMatch = [regex]::Match($html, '<link[^>]+href="([^"]+\.css)"')
    if (-not $scriptMatch.Success -or -not $cssMatch.Success) { return $false }

    $js = Invoke-Probe "$Base$($scriptMatch.Groups[1].Value)"
    if (-not $js -or $js.StatusCode -ne 200) { return $false }

    $css = Invoke-Probe "$Base$($cssMatch.Groups[1].Value)"
    if (-not $css -or $css.StatusCode -ne 200) { return $false }

    $healthz = Invoke-Probe "$Base/healthz"
    if (-not $healthz -or $healthz.StatusCode -ne 200) { return $false }

    $setup = Invoke-Probe "$Base/v1/setup/status"
    if (-not $setup -or $setup.StatusCode -ne 200) { return $false }

    return $true
}

if (-not (Test-DockerRunning)) {
    Write-Diag 'Docker Desktop is not running.'
    Write-Result @{ url = $null; protocol = $null; host = $null; port = $null; healthy = $false; error = 'docker-not-running' }
    exit 1
}

if (-not (Test-ProxyHealthy)) {
    Write-Diag 'supreme-hub-proxy container is not running/healthy.'
    Write-Result @{ url = $null; protocol = $null; host = $null; port = $null; healthy = $false; error = 'proxy-unhealthy' }
    exit 1
}

$lan = Get-LanIPv4
if ($lan) {
    Write-Diag "Active LAN adapter: $($lan.Name) -> $($lan.Address)"
} else {
    Write-Diag 'Warning: no real LAN adapter detected (excluding Hyper-V/WSL/VirtualBox/Docker/link-local); localhost candidates only.'
}

$candidates = @()
if ($lan) { $candidates += @{ protocol = 'https'; host = $lan.Address; port = '443' } }
$candidates += @{ protocol = 'https'; host = 'localhost'; port = '443' }
if ($lan) { $candidates += @{ protocol = 'http'; host = $lan.Address; port = '80' } }
$candidates += @{ protocol = 'http'; host = 'localhost'; port = '80' }

foreach ($c in $candidates) {
    $base = "$($c.protocol)://$($c.host)"
    Write-Diag "Probing $base ..."
    if (Test-EndpointHealthy $base) {
        Write-Result @{ url = $base; protocol = $c.protocol; host = $c.host; port = $c.port; healthy = $true }
        exit 0
    }
}

Write-Diag 'No healthy SupremeOS endpoint found.'
Write-Result @{ url = $null; protocol = $null; host = $null; port = $null; healthy = $false; error = 'no-healthy-endpoint' }
exit 1

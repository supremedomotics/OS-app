#!/usr/bin/env node
'use strict';

/**
 * Single source of truth for "what URL is SupremeOS reachable at right now" (§ CLAUDE.md —
 * URL discovery workflow). Every browser-test entry point (Playwright MCP, ad hoc scripts,
 * future CI) should call this instead of re-deriving the URL itself — the LAN IP is
 * whatever this machine's active adapter currently has, never a value to hardcode or cache
 * across runs.
 *
 * Prints ONLY the result JSON to stdout (pipeable/parseable); all diagnostics go to stderr.
 * Exit code 0 + healthy:true on success; non-zero + healthy:false otherwise.
 */

const https = require('https');
const http = require('http');
const { execSync, execFileSync } = require('child_process');

function diag(...args) {
  console.error(...args);
}

function printResult(result) {
  console.log(JSON.stringify(result));
}

function dockerRunning() {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function proxyHealthy() {
  try {
    const out = execSync(
      'docker ps --filter "name=supreme-hub-proxy" --format "{{.Status}}"',
      { timeout: 5000 }
    ).toString().trim();
    return out.toLowerCase().startsWith('up');
  } catch {
    return false;
  }
}

// Adapter names/descriptions to ignore per requirement — Hyper-V/WSL/VirtualBox/Docker
// virtual switches and loopback never carry real LAN traffic. `os.networkInterfaces()` only
// exposes Windows' generic connection name (e.g. "Ethernet 2"), NOT the underlying driver
// description — a VirtualBox host-only adapter can be named "Ethernet 2" with nothing in its
// connection name to exclude on, and *was* observed picking that adapter incorrectly during
// development. Requiring a default gateway (real LAN adapters have one; virtual host-only
// adapters generally don't) is the reliable signal, so this shells out to
// Get-NetIPConfiguration for its real adapter metadata (InterfaceDescription included)
// instead of reimplementing weaker detection in pure Node — same logic the .ps1 sibling uses,
// kept in one place conceptually rather than two drifting heuristics.
const EXCLUDE_ADAPTER = /hyper-v|vethernet|wsl|virtualbox|vboxnet|docker|loopback/i;

function detectLanIPv4() {
  try {
    const psScript =
      "Get-NetIPConfiguration | Where-Object { $_.NetAdapter.Status -eq 'Up' -and $_.IPv4Address -and $_.IPv4DefaultGateway } " +
      "| Select-Object -First 5 InterfaceAlias, @{N='Address';E={$_.IPv4Address.IPAddress}}, @{N='Description';E={$_.NetAdapter.InterfaceDescription}} " +
      "| ConvertTo-Json -Compress";
    // PowerShell's cold-start can take several seconds on first invocation in a session —
    // 8s timed out in practice during development; 15s gives real headroom without hanging
    // the whole discovery run if PowerShell is genuinely unavailable.
    const raw = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { timeout: 15000 }
    ).toString().trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const c of list) {
      if (!c || !c.Address) continue;
      if (EXCLUDE_ADAPTER.test(c.InterfaceAlias || '') || EXCLUDE_ADAPTER.test(c.Description || '')) continue;
      if (c.Address.startsWith('169.254.')) continue; // link-local
      return { name: c.InterfaceAlias, address: c.Address };
    }
    return null;
  } catch {
    return null;
  }
}

function fetchPath(base, path) {
  return new Promise((resolve) => {
    const isHttps = base.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request(
      {
        hostname: base.hostname,
        port: base.port || (isHttps ? 443 : 80),
        path,
        method: 'GET',
        rejectUnauthorized: false, // internal-CA self-signed cert (§ Caddyfile)
        timeout: 4000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

// Status-only probe for asset/health checks that don't need the body — the JS bundle alone is
// ~1MB (per the app's own build output), and buffering + discarding megabytes per health check
// is wasted work; this resolves the instant headers arrive and drains+discards the body stream
// afterward so the socket closes cleanly (leaving it unconsumed can hang the connection).
function probeStatus(base, path) {
  return new Promise((resolve) => {
    const isHttps = base.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request(
      {
        hostname: base.hostname,
        port: base.port || (isHttps ? 443 : 80),
        path,
        method: 'GET',
        rejectUnauthorized: false,
        timeout: 4000,
      },
      (res) => {
        resolve(res.statusCode);
        res.resume(); // drain and discard the body so the socket closes cleanly
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

async function endpointHealthy(base) {
  const root = await fetchPath(base, '/');
  if (!root || root.status !== 200) return false;

  const scriptMatch = root.body.match(/<script[^>]+src="([^"]+)"/);
  const cssMatch = root.body.match(/<link[^>]+href="([^"]+\.css)"/);
  if (!scriptMatch || !cssMatch) return false;

  const jsStatus = await probeStatus(base, scriptMatch[1]);
  if (jsStatus !== 200) return false;

  const cssStatus = await probeStatus(base, cssMatch[1]);
  if (cssStatus !== 200) return false;

  const healthzStatus = await probeStatus(base, '/healthz');
  if (healthzStatus !== 200) return false;

  const setupStatus = await probeStatus(base, '/v1/setup/status');
  if (setupStatus !== 200) return false;

  return true;
}

// NOTE: uses `process.exitCode = N; return;` rather than `process.exit(N)` throughout —
// process.exit() can truncate a console.log() write that's still in flight when stdout is
// piped (not a TTY), which is exactly how every caller of this script consumes it. Setting
// exitCode and letting main() return lets the event loop drain the pending write first.

async function main() {
  if (!dockerRunning()) {
    diag('Docker Desktop is not running.');
    printResult({ url: null, protocol: null, host: null, port: null, healthy: false, error: 'docker-not-running' });
    process.exitCode = 1;
    return;
  }

  if (!proxyHealthy()) {
    diag('supreme-hub-proxy container is not running/healthy.');
    printResult({ url: null, protocol: null, host: null, port: null, healthy: false, error: 'proxy-unhealthy' });
    process.exitCode = 1;
    return;
  }

  const lan = detectLanIPv4();
  if (lan) {
    diag(`Active LAN adapter: ${lan.name} -> ${lan.address}`);
  } else {
    diag('Warning: no real LAN adapter detected (excluding Hyper-V/WSL/VirtualBox/Docker/link-local); localhost candidates only.');
  }

  const candidates = [];
  if (lan) candidates.push({ protocol: 'https:', host: lan.address, port: '443' });
  candidates.push({ protocol: 'https:', host: 'localhost', port: '443' });
  if (lan) candidates.push({ protocol: 'http:', host: lan.address, port: '80' });
  candidates.push({ protocol: 'http:', host: 'localhost', port: '80' });

  for (const c of candidates) {
    const base = new URL(`${c.protocol}//${c.host}`);
    diag(`Probing ${base.href} ...`);
    if (await endpointHealthy(base)) {
      printResult({ url: base.href.replace(/\/$/, ''), protocol: c.protocol.replace(':', ''), host: c.host, port: c.port, healthy: true });
      process.exitCode = 0;
      return;
    }
  }

  diag('No healthy SupremeOS endpoint found.');
  printResult({ url: null, protocol: null, host: null, port: null, healthy: false, error: 'no-healthy-endpoint' });
  process.exitCode = 1;
}

main();

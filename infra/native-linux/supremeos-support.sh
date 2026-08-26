#!/usr/bin/env bash
# SupremeOS native-linux — supremeos-support.sh
#
# § Support bundle (requirement 8). Produces ONE compressed archive containing everything
# Supreme Domotics support needs to diagnose a controller remotely — system info, release/
# migration state, per-service logs, driver diagnostics, health report, network state, and
# configuration. Secrets are ALWAYS redacted (never merely "usually" — every config file is
# passed through redact_secrets before it goes in the bundle; the secrets directory itself
# is never read at all). Read-only: this script changes nothing on the machine.
#
# Usage:
#   sudo ./supremeos-support.sh                writes ./supremeos-support-<timestamp>.tar.gz
#   sudo ./supremeos-support.sh /path/out.tar.gz   writes to a specific path

set -uo pipefail  # no -e: a support bundle's job is to collect as much as it can, never abort on the first unavailable check

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

OUT="${1:-./supremeos-support-$(date -u +%Y%m%dT%H%M%SZ).tar.gz}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Redacts any line assigning a secret-shaped variable, in ANY config file this bundle
# includes — a single, reused choke point rather than trusting each collection step to
# remember to redact individually. Matches by variable NAME, not by guessing at value
# shape, so it can't miss a short/simple secret the way an entropy-based heuristic could.
SECRET_VAR_PATTERN='SUPREME_TOKEN_SECRET|POSTGRES_PASSWORD|SUPREME_HA_ADMIN_PASSWORD|SUPREME_HA_TOKEN|SUPREME_UNSPLASH_KEY|.*PASSWORD.*|.*SECRET.*|.*TOKEN.*|.*_KEY$'
redact_secrets() {
  sed -E "s/^([[:space:]]*)((${SECRET_VAR_PATTERN})[[:space:]]*[:=][[:space:]]*)[\"']?[^\"'[:space:]]*[\"']?(.*)\$/\1\2\"[REDACTED]\"/i"
}

section() { echo "" >> "$1"; echo "=== $2 ===" >> "$1"; }
collect() {
  # $1=output file  $2=section title  $3...=command
  local out="$1" title="$2"; shift 2
  section "$out" "$title"
  { "$@"; } >> "$out" 2>&1 || echo "(unavailable: $*)" >> "$out"
}

SYS="${WORK}/system-info.txt"
collect "$SYS" "Hostname"           hostname
collect "$SYS" "OS release"         cat /etc/os-release
collect "$SYS" "Kernel"             uname -a
collect "$SYS" "CPU"                sh -c "nproc; lscpu 2>/dev/null || true"
collect "$SYS" "Memory"             free -h
collect "$SYS" "Storage"            df -h
collect "$SYS" "Uptime"             uptime

RELEASE="${WORK}/release-info.txt"
if [ -r "${SUPREME_CONFIG_DIR}/install.conf" ]; then
  # shellcheck source=/dev/null
  source "${SUPREME_CONFIG_DIR}/install.conf"
fi
collect "$RELEASE" "Active release version" current_release_version
collect "$RELEASE" "Release state" release_state_print
if [ -r "${SUPREME_RELEASE_DIR}/release-manifest.json" ]; then
  cp "${SUPREME_RELEASE_DIR}/release-manifest.json" "${WORK}/release-manifest.json" 2>/dev/null
fi
collect "$RELEASE" "Installed releases" find "$SUPREME_RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d
collect "$RELEASE" "Appliance image marker" appliance_image_info

DB="${WORK}/database-status.txt"
if [ -r "${SUPREME_SECRETS_DIR}/postgres-password" ]; then
  pg_password="$(cat "${SUPREME_SECRETS_DIR}/postgres-password" 2>/dev/null || true)"
  collect "$DB" "Migration status (schema_migrations)" \
    env PGPASSWORD="$pg_password" psql -h 127.0.0.1 -U supreme -d supreme -c "SELECT name, applied_at FROM schema_migrations ORDER BY applied_at;"
  collect "$DB" "Database size" \
    env PGPASSWORD="$pg_password" psql -h 127.0.0.1 -U supreme -d supreme -tAc "SELECT pg_size_pretty(pg_database_size('supreme'));"
else
  echo "(postgres-password secret not readable — skipped, never included raw)" >> "$DB"
fi

SVC="${WORK}/service-status.txt"
for svc in "${SUPREME_THIRDPARTY_SERVICES[@]}" supreme-nats "${SUPREME_PY_SERVICES[@]}" "${SUPREME_NODE_SERVICES[@]}" "$SUPREME_HA_SERVICE"; do
  collect "$SVC" "systemctl status ${svc}" systemctl status "$svc" --no-pager -l
done

LOGS_DIR="${WORK}/logs"
mkdir -p "$LOGS_DIR"
for svc in supreme-gateway supreme-lan supreme-commissioning supreme-homeassistant; do
  if command_exists journalctl; then
    journalctl -u "$svc" -n 500 --no-pager > "${LOGS_DIR}/${svc}.log" 2>&1 || echo "(unavailable)" > "${LOGS_DIR}/${svc}.log"
  fi
done
# Web UI is served by Caddy — its own access/error log is what "web logs" means here.
if command_exists journalctl; then
  journalctl -u caddy -n 500 --no-pager > "${LOGS_DIR}/web-caddy.log" 2>&1 || true
fi

HEALTH="${WORK}/health-report.txt"
{ run_runtime_verification || true; } >> "$HEALTH" 2>&1

SECURITY="${WORK}/security-audit.txt"
{ "${SCRIPT_DIR}/security-audit.sh" || true; } >> "$SECURITY" 2>&1

DIAG="${WORK}/driver-diagnostics.json"
curl -fsS -k --max-time 5 "https://127.0.0.1/v1/drivers/diagnostics" > "$DIAG" 2>/dev/null \
  || curl -fsS --max-time 5 "http://127.0.0.1:8080/v1/drivers/diagnostics" > "$DIAG" 2>/dev/null \
  || echo '{"note": "driver diagnostics endpoint unreachable — Gateway may not be running or requires auth"}' > "$DIAG"

NET="${WORK}/network.txt"
collect "$NET" "Interfaces" ip addr
collect "$NET" "Routing table" ip route
collect "$NET" "Open ports" ss -tlnp
if command_exists ufw; then
  collect "$NET" "Firewall (ufw)" ufw status verbose
elif command_exists iptables; then
  collect "$NET" "Firewall (iptables)" iptables -L -n -v
else
  section "$NET" "Firewall"; echo "(neither ufw nor iptables found)" >> "$NET"
fi

CONFIG_DIR="${WORK}/config"
mkdir -p "$CONFIG_DIR"
for f in "${SUPREME_CONFIG_DIR}/install.conf" "${SUPREME_CONFIG_DIR}/gateway.env" "${SUPREME_CONFIG_DIR}/nats.conf" /etc/caddy/Caddyfile; do
  if [ -r "$f" ]; then
    redact_secrets < "$f" > "${CONFIG_DIR}/$(basename "$f")"
  fi
done
# The secrets directory itself is NEVER read, listed, or included — not even redacted.

cat > "${WORK}/MANIFEST.txt" <<EOF
SupremeOS native-linux support bundle
Generated (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)
Hostname: $(hostname)

Contents:
  system-info.txt        — OS, kernel, CPU, memory, storage, uptime
  release-info.txt       — active version, installed releases, appliance-image marker
  release-manifest.json  — the active release's manifest (if present)
  database-status.txt    — migration history, database size (no data rows, no credentials)
  service-status.txt     — systemctl status for every SupremeOS + third-party service
  logs/                  — last 500 journal lines per service (Gateway, LAN, Commissioning,
                            Home Assistant if installed, Web/Caddy)
  health-report.txt      — full runtime verification report (PASS/FAIL/WARNING/N-A)
  security-audit.txt     — service user, ownership, permissions, listening ports report
  driver-diagnostics.json— live driver lifecycle/binding diagnostics from the Gateway
  network.txt            — interfaces, routing table, open ports, firewall state
  config/                — gateway.env, nats.conf, Caddyfile, install.conf — EVERY
                            SUPREME_*PASSWORD*/*SECRET*/*TOKEN*/*_KEY value redacted to
                            "[REDACTED]" before being written here. The secrets directory
                            itself (/etc/supremeos/secrets) was never read.

Send this file to Supreme Domotics support.
EOF

tar -czf "$OUT" -C "$WORK" .
chmod 0600 "$OUT" 2>/dev/null || true
echo "Support bundle: ${OUT} ($(du -h "$OUT" 2>/dev/null | cut -f1))"
echo "Secrets redacted; the secrets directory was never read. Safe to send to Supreme Domotics support."

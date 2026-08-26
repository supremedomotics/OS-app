#!/usr/bin/env bash
# SupremeOS native-linux — health-check.sh
#
# Read-only. Checks every SupremeOS-owned and third-party service this deployment installs,
# reports PASS/FAIL/NOT EVALUATED per service (never a fabricated PASS for something that
# couldn't actually be checked — e.g. no live systemd in a container), and exits non-zero
# if anything genuinely failed. Safe to run from cron/a monitoring agent.

set -uo pipefail  # deliberately no -e: this script's whole job is to keep checking after one failure

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

FAILED=0
NOT_EVALUATED=0

pass() { echo "  PASS       $*"; }
fail() { echo "  FAIL       $*"; FAILED=$((FAILED + 1)); }
not_evaluated() { echo "  NOT EVAL   $*"; NOT_EVALUATED=$((NOT_EVALUATED + 1)); }

check_service() {
  local unit="$1"
  if ! systemd_is_live; then
    not_evaluated "${unit} — systemd is not live in this environment (see docs/architecture/Native-Linux-Deployment.md)"
    return
  fi
  if systemctl is-active --quiet "$unit"; then
    pass "${unit} is active"
  else
    fail "${unit} is NOT active ($(systemctl is-active "$unit" 2>&1 || true)) — see: journalctl -u ${unit} -n 50"
  fi
}

check_tcp() {
  local label="$1" host="$2" port="$3"
  if command_exists nc; then
    if nc -z -w2 "$host" "$port" 2>/dev/null; then
      pass "${label} reachable at ${host}:${port}"
    else
      fail "${label} NOT reachable at ${host}:${port}"
    fi
  elif command_exists bash; then
    if timeout 2 bash -c "exec 3<>/dev/tcp/${host}/${port}" 2>/dev/null; then
      pass "${label} reachable at ${host}:${port}"
    else
      fail "${label} NOT reachable at ${host}:${port}"
    fi
  else
    not_evaluated "${label} at ${host}:${port} — neither nc nor /dev/tcp available to check"
  fi
}

check_http() {
  local label="$1" url="$2"
  local body
  if body="$(curl -fsS -k --max-time 5 "$url" 2>&1)"; then
    pass "${label} responded: ${url} — ${body:0:120}"
  else
    fail "${label} did NOT respond at ${url}"
  fi
}

echo "=== SupremeOS native-linux health check ==="
echo ""
echo "--- Third-party services ---"
for svc in "${SUPREME_THIRDPARTY_SERVICES[@]}"; do
  check_service "$svc"
done

echo ""
echo "--- SupremeOS services ---"
for svc in "${SUPREME_NODE_SERVICES[@]}"; do
  check_service "$svc"
done
for svc in "${SUPREME_PY_SERVICES[@]}"; do
  check_service "$svc"
done
check_service "supreme-nats"

echo ""
echo "--- Network reachability (loopback — matches this deployment's binding policy) ---"
check_tcp "PostgreSQL" 127.0.0.1 5432
check_tcp "Redis" 127.0.0.1 6379
check_tcp "NATS" 127.0.0.1 4222
check_tcp "Mosquitto" 127.0.0.1 1883
check_tcp "Gateway" 127.0.0.1 8080
check_tcp "Caddy (HTTPS)" 127.0.0.1 443

echo ""
echo "--- API endpoints ---"
check_http "Gateway /healthz (direct)" "http://127.0.0.1:8080/healthz"
check_http "Edge /healthz (via Caddy)" "https://127.0.0.1/healthz"

echo ""
echo "=== Summary ==="
echo "Failed: ${FAILED}   Not evaluated: ${NOT_EVALUATED}"
if [ "$FAILED" -gt 0 ]; then
  echo "Result: UNHEALTHY"
  exit 1
elif [ "$NOT_EVALUATED" -gt 0 ]; then
  echo "Result: INCOMPLETE — some checks could not run in this environment."
  exit 0
else
  echo "Result: HEALTHY"
  exit 0
fi

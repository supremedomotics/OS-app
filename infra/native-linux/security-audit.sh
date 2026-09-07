#!/usr/bin/env bash
# SupremeOS native-linux — security-audit.sh
#
# § Runtime security audit (requirement 9). Read-only — verifies service user, file
# ownership, directory/executable permissions, writable paths, listening ports, and
# exposed interfaces against what THIS deployment actually declares (SUPREME_USER,
# 0700/0640 secrets, loopback-only bindings) — never a generic hardening checklist
# unrelated to what's actually installed here. Reuses the rc_pass/rc_fail/rc_warn/
# rc_not_applicable primitives lib/common.sh already defines for runtime verification —
# same report shape, different subject.

set -uo pipefail  # no -e: an audit's job is to keep checking after one failure

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

RUNTIME_CHECK_FAILED=0
RUNTIME_CHECK_WARNING=0
RUNTIME_CHECK_NOT_EVALUATED=0

echo "=== SupremeOS native-linux security audit ==="
echo ""

echo "--- Service user ---"
for svc in "${SUPREME_NODE_SERVICES[@]}" "${SUPREME_PY_SERVICES[@]}" supreme-nats; do
  unit_file="/etc/systemd/system/${svc}.service"
  if [ -r "$unit_file" ]; then
    user="$(grep -m1 '^User=' "$unit_file" | cut -d= -f2)"
    if [ "$user" = "$SUPREME_USER" ]; then
      rc_pass "${svc} runs as ${user} (not root)"
    else
      rc_fail "${svc} User= is '${user:-unset}', expected '${SUPREME_USER}'"
    fi
  else
    rc_not_evaluated "${svc} — unit file not installed"
  fi
done

echo ""
echo "--- File ownership ---"
for path in "$SUPREME_APP_DIR" "$SUPREME_DATA_DIR"; do
  if [ -d "$path" ]; then
    owner="$(stat -c '%U:%G' "$path" 2>/dev/null || echo unknown)"
    if [ "$owner" = "${SUPREME_USER}:${SUPREME_GROUP}" ]; then
      rc_pass "${path} owned by ${owner}"
    else
      rc_fail "${path} owned by ${owner}, expected ${SUPREME_USER}:${SUPREME_GROUP}"
    fi
  else
    rc_not_evaluated "${path} does not exist"
  fi
done
if [ -d "$SUPREME_SECRETS_DIR" ]; then
  owner="$(stat -c '%U:%G' "$SUPREME_SECRETS_DIR" 2>/dev/null || echo unknown)"
  [ "$owner" = "root:${SUPREME_GROUP}" ] && rc_pass "${SUPREME_SECRETS_DIR} owned by ${owner}" || rc_fail "${SUPREME_SECRETS_DIR} owned by ${owner}, expected root:${SUPREME_GROUP}"
fi

echo ""
echo "--- Directory / secrets permissions ---"
if [ -d "$SUPREME_SECRETS_DIR" ]; then
  mode="$(stat -c '%a' "$SUPREME_SECRETS_DIR" 2>/dev/null)"
  [ "$mode" = "750" ] && rc_pass "${SUPREME_SECRETS_DIR} is 0750" || rc_fail "${SUPREME_SECRETS_DIR} is 0${mode}, expected 0750"
  for f in "${SUPREME_SECRETS_DIR}"/*; do
    [ -e "$f" ] || continue
    mode="$(stat -c '%a' "$f" 2>/dev/null)"
    if [ "$mode" = "640" ] || [ "$mode" = "600" ]; then
      rc_pass "$(basename "$f") is 0${mode}"
    else
      rc_fail "$(basename "$f") is 0${mode}, expected 0640 or 0600"
    fi
  done
fi
if [ -r "${SUPREME_CONFIG_DIR}/gateway.env" ]; then
  mode="$(stat -c '%a' "${SUPREME_CONFIG_DIR}/gateway.env" 2>/dev/null)"
  [ "$mode" = "640" ] && rc_pass "gateway.env is 0640" || rc_warn "gateway.env is 0${mode}, expected 0640"
fi

echo ""
echo "--- Executable / writable path audit ---"
if [ -d "$SUPREME_APP_DIR" ]; then
  world_writable="$(find "$SUPREME_APP_DIR" -xdev -type f -perm -002 2>/dev/null | head -20)"
  if [ -z "$world_writable" ]; then
    rc_pass "No world-writable files under ${SUPREME_APP_DIR}"
  else
    rc_fail "World-writable files found under ${SUPREME_APP_DIR}: $(echo "$world_writable" | tr '\n' ' ')"
  fi
  suid_files="$(find "$SUPREME_APP_DIR" -xdev -type f -perm -4000 2>/dev/null | head -20)"
  if [ -z "$suid_files" ]; then
    rc_pass "No setuid files under ${SUPREME_APP_DIR}"
  else
    rc_warn "Setuid files found under ${SUPREME_APP_DIR} (verify these are expected): $(echo "$suid_files" | tr '\n' ' ')"
  fi
fi

echo ""
echo "--- Listening ports & exposed interfaces ---"
if command_exists ss; then
  # Every port this deployment is EXPECTED to bind, and whether loopback-only is required.
  declare -A expected_loopback_only=(
    [5432]=1 [6379]=1 [4222]=1 [1883]=1 [8080]=1 [9100]=1 [8123]=1
  )
  declare -A expected_public=( [443]=1 [80]=1 )
  while read -r line; do
    port="$(echo "$line" | grep -oE ':[0-9]+ ' | head -1 | tr -d ': ')"
    [ -n "$port" ] || continue
    addr="$(echo "$line" | awk '{print $4}')"
    if [ -n "${expected_loopback_only[$port]:-}" ]; then
      case "$addr" in
        127.0.0.1:*|\[::1\]:*) rc_pass "Port ${port} bound to loopback only (${addr})" ;;
        *) rc_fail "Port ${port} is expected loopback-only but bound to ${addr} — this exposes an internal service off-box." ;;
      esac
    elif [ -n "${expected_public[$port]:-}" ]; then
      rc_pass "Port ${port} (${addr}) — expected public (Caddy edge)"
    else
      rc_warn "Unexpected listening port ${port} (${addr}) — not part of SupremeOS's declared port layout, verify what's using it."
    fi
  done < <(ss -ltn 2>/dev/null | tail -n +2)
else
  rc_not_evaluated "Listening ports — ss not available"
fi

echo ""
echo "=== Security audit summary ==="
echo "Failed: ${RUNTIME_CHECK_FAILED}   Warnings: ${RUNTIME_CHECK_WARNING}   Not evaluated: ${RUNTIME_CHECK_NOT_EVALUATED}"
if [ "$RUNTIME_CHECK_FAILED" -gt 0 ]; then
  echo "Result: ISSUES FOUND"
  exit 1
else
  echo "Result: OK"
  exit 0
fi

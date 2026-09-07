#!/usr/bin/env bash
# SupremeOS native-linux — logs.sh
#
# Thin journalctl wrapper so "where are the logs" has one obvious answer regardless of
# which service: every SupremeOS process (Node, Python, and the third-party services this
# deployment configures) logs to the systemd journal, not to files under this tree — there
# is no separate /var/log/supremeos to go stale or fill the disk unmanaged.
#
# Usage:
#   ./logs.sh                    list available services
#   ./logs.sh <service>          tail the last 100 lines
#   ./logs.sh <service> -f       follow (like tail -f)
#   ./logs.sh <service> --since "1 hour ago"

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

ALL_SERVICES=("${SUPREME_THIRDPARTY_SERVICES[@]}" "${SUPREME_NODE_SERVICES[@]}" "${SUPREME_PY_SERVICES[@]}" "supreme-nats")

usage() {
  echo "Usage: $0 <service> [journalctl args...]"
  echo ""
  echo "Available services:"
  for s in "${ALL_SERVICES[@]}"; do echo "  - $s"; done
  echo ""
  echo "Examples:"
  echo "  $0 supreme-gateway              last 100 lines"
  echo "  $0 supreme-gateway -f           follow live"
  echo "  $0 supreme-lan --since '1 hour ago'"
  echo "  $0 all                          interleaved view of every SupremeOS-owned service"
}

if [ $# -eq 0 ]; then
  usage
  exit 0
fi

SERVICE="$1"
shift

if ! systemd_is_live; then
  log_warn "systemd is not live in this environment — journalctl has nothing to show here. This works on the actual target machine."
fi

if [ "$SERVICE" = "all" ]; then
  # SupremeOS-owned only (not postgres/redis/mosquitto/caddy's own noisy logs) — the
  # cross-service view most useful for tracing one request through gateway → lan/commissioning.
  exec journalctl -u supreme-gateway -u supreme-lan -u supreme-commissioning -u supreme-nats -n 100 "$@"
fi

case " ${ALL_SERVICES[*]} " in
  *" ${SERVICE} "*) ;;
  *)
    log_error "Unknown service '${SERVICE}'."
    usage
    exit 1
    ;;
esac

exec journalctl -u "$SERVICE" -n 100 "$@"

#!/usr/bin/env bash
# SupremeOS native-linux — health-check.sh
#
# Read-only. Runs the same runtime-verification checklist install.sh's production mode
# uses (lib/common.sh's run_runtime_verification — one implementation, two callers, never
# two ideas of "healthy"). Reports PASS/FAIL/NOT EVALUATED per check (never a fabricated
# PASS for something that couldn't actually be checked — e.g. no live systemd in a
# container), and exits non-zero if anything genuinely failed. Safe to run from cron/a
# monitoring agent.

set -uo pipefail  # deliberately no -e: this script's whole job is to keep checking after one failure

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

echo "=== SupremeOS native-linux health check ==="
echo ""
echo "--- Release state ---"
release_state_print
echo ""

if [ -r "${SUPREME_CONFIG_DIR}/install.conf" ]; then
  # shellcheck source=/dev/null
  source "${SUPREME_CONFIG_DIR}/install.conf"
else
  echo "  NOT EVAL   install.conf not found — has install.sh been run on this machine?"
fi

if run_runtime_verification; then
  echo "Result: HEALTHY"
  exit 0
elif [ "$RUNTIME_CHECK_FAILED" -eq 0 ]; then
  echo "Result: INCOMPLETE — some checks could not run in this environment."
  exit 0
else
  echo "Result: UNHEALTHY"
  exit 1
fi

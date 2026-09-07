#!/usr/bin/env bash
# SupremeOS native-linux — apply-casambi-credentials.sh
#
# § Casambi fleet-wide env-var default — applies (or rotates) this deployment's Casambi
# Cloud fleet account on an ALREADY-INSTALLED hub, without a full install.sh/update.sh run
# and without the real credential ever touching this git repository.
#
# On a BRAND-NEW machine, install.sh itself already does this automatically (its own
# collect_answers() calls the same load_casambi_credentials_file() this script uses) — you
# only need THIS script for a hub that's already up and running, to apply a credentials
# file that didn't exist yet at first install time, or to pick up a rotated value.
#
# Usage:
#   sudo ./apply-casambi-credentials.sh [path-to-credentials-file]
#     Default path: /etc/supremeos/casambi-fleet-credentials
#     (see config/casambi-fleet-credentials.example for the format and how to provision one)
#
# What it does: loads the credentials file, rewrites ONLY the 4 SUPREME_CASAMBI_* lines in
# the existing /etc/supremeos/install.conf (every other line untouched), re-renders
# gateway.env from the current template, and restarts supreme-gateway so the change takes
# effect immediately. Idempotent — safe to re-run any time the credentials file changes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/deploy-steps.sh
source "${SCRIPT_DIR}/lib/deploy-steps.sh"

CREDS_FILE="${1:-$SUPREME_CASAMBI_CREDENTIALS_FILE}"
ANSWERS_FILE="${SUPREME_CONFIG_DIR}/install.conf"

main() {
  require_root

  [ -r "$ANSWERS_FILE" ] || die "No ${ANSWERS_FILE} — this machine has never had install.sh run successfully. Run install.sh first (it will pick up ${CREDS_FILE} automatically if present)."
  [ -r "$CREDS_FILE" ] || die "No readable credentials file at ${CREDS_FILE}. Copy config/casambi-fleet-credentials.example there, fill in real values, chmod 0600, then re-run."

  log_step "Loading Casambi fleet credentials from ${CREDS_FILE}"
  load_casambi_credentials_file "$CREDS_FILE"
  SUPREME_CASAMBI_API_KEY="${SUPREME_CASAMBI_API_KEY:-}"
  SUPREME_CASAMBI_EMAIL="${SUPREME_CASAMBI_EMAIL:-}"
  SUPREME_CASAMBI_PASSWORD="${SUPREME_CASAMBI_PASSWORD:-}"
  SUPREME_CASAMBI_NETWORK_ID="${SUPREME_CASAMBI_NETWORK_ID:-}"
  if [ -z "$SUPREME_CASAMBI_API_KEY" ] || [ -z "$SUPREME_CASAMBI_EMAIL" ] || [ -z "$SUPREME_CASAMBI_PASSWORD" ]; then
    die "${CREDS_FILE} is missing SUPREME_CASAMBI_API_KEY/EMAIL/PASSWORD (NETWORK_ID is optional) — nothing applied."
  fi

  log_step "Updating ${ANSWERS_FILE}"
  local tmp
  tmp="$(mktemp)"
  # Every line except the 4 Casambi keys, preserved exactly as-is, then the 4 keys
  # appended fresh from the credentials file just loaded — so this never disturbs any
  # other install-time answer (domain, backend, HA settings, secrets, ...).
  grep -v '^SUPREME_CASAMBI_' "$ANSWERS_FILE" > "$tmp" || true
  {
    echo "SUPREME_CASAMBI_API_KEY=\"${SUPREME_CASAMBI_API_KEY}\""
    echo "SUPREME_CASAMBI_EMAIL=\"${SUPREME_CASAMBI_EMAIL}\""
    echo "SUPREME_CASAMBI_PASSWORD=\"${SUPREME_CASAMBI_PASSWORD}\""
    echo "SUPREME_CASAMBI_NETWORK_ID=\"${SUPREME_CASAMBI_NETWORK_ID}\""
  } >> "$tmp"
  chmod 0640 "$tmp"
  chown "root:${SUPREME_GROUP}" "$tmp" 2>/dev/null || true
  mv "$tmp" "$ANSWERS_FILE"
  log_info "Casambi fleet credentials written to ${ANSWERS_FILE} (values not logged)."

  log_step "Re-rendering gateway.env"
  load_answers # sources the just-updated install.conf + secrets into this shell
  render_template "${SCRIPT_DIR}/config/gateway.env.template" "${SUPREME_CONFIG_DIR}/gateway.env"
  chown "root:${SUPREME_GROUP}" "${SUPREME_CONFIG_DIR}/gateway.env"
  chmod 0640 "${SUPREME_CONFIG_DIR}/gateway.env"

  log_step "Restarting supreme-gateway"
  systemctl restart supreme-gateway
  log_info "Done — supreme-gateway is running with the updated Casambi fleet account."
}

main "$@"

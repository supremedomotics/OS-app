#!/usr/bin/env bash
# SupremeOS native-linux — update.sh
#
# Pulls the latest workspace code from wherever this script is being run from, rebuilds it,
# regenerates config from the current templates/answers, and restarts only the SupremeOS-
# owned services (never Postgres/Redis/Mosquitto, which don't need restarting for an
# application code update, and never touches infra/hub-compose/'s Docker deployment).
#
# Usage:
#   sudo ./update.sh              # rebuild, verify, restart
#   sudo ./update.sh --no-verify  # skip typecheck/test (equivalent to SUPREME_SKIP_TESTS=1)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/deploy-steps.sh
source "${SCRIPT_DIR}/lib/deploy-steps.sh"

if [ "${1:-}" = "--no-verify" ]; then
  SUPREME_SKIP_TESTS=1
fi

render_config() {
  log_step "Re-rendering configuration from current templates"
  render_template "${SCRIPT_DIR}/config/gateway.env.template" "${SUPREME_CONFIG_DIR}/gateway.env"
  chown "root:${SUPREME_GROUP}" "${SUPREME_CONFIG_DIR}/gateway.env"
  chmod 0640 "${SUPREME_CONFIG_DIR}/gateway.env"
  render_template "${SCRIPT_DIR}/config/nats.conf.template" "${SUPREME_CONFIG_DIR}/nats.conf"
  render_template "${SCRIPT_DIR}/config/Caddyfile.template" /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile || die "Regenerated Caddyfile failed validation — see caddy's own error above. Old config left in place is NOT guaranteed; check /etc/caddy/Caddyfile before relying on it."
  render_template "${SCRIPT_DIR}/systemd/supreme-gateway.service" /etc/systemd/system/supreme-gateway.service
  render_template "${SCRIPT_DIR}/systemd/supreme-commissioning.service" /etc/systemd/system/supreme-commissioning.service
  render_template "${SCRIPT_DIR}/systemd/supreme-nats.service" /etc/systemd/system/supreme-nats.service
  cp "${SUPREME_REPO_DIR}/infra/systemd/supreme-lan.service" /etc/systemd/system/supreme-lan.service
  if systemd_is_live; then systemctl daemon-reload; fi
}

restart_services() {
  log_step "Restarting SupremeOS-owned services"
  # Order matches dependency direction: the bus/broker before the services that talk to
  # it, the Gateway last (it's the one thing every client actually connects to).
  systemctl_restart supreme-nats
  systemctl_restart supreme-commissioning
  systemctl_restart supreme-lan
  systemctl_restart supreme-gateway
  if systemd_is_live; then systemctl reload caddy 2>/dev/null || systemctl restart caddy; fi
}

main() {
  require_root
  load_answers
  sync_repo
  build_workspace
  verify_workspace
  render_config
  restart_services
  wait_for_health
  log_step "Update complete"
}

wait_for_health() {
  if ! systemd_is_live; then
    log_warn "systemd is not live in this environment — skipping the health wait. Run ./health-check.sh once restarted for real."
    return
  fi
  local attempt
  for attempt in $(seq 1 60); do
    : "$attempt"
    if curl -fsS -k "https://127.0.0.1/healthz" >/dev/null 2>&1 || curl -fsS "http://127.0.0.1:8080/healthz" >/dev/null 2>&1; then
      log_info "Gateway is healthy after restart."
      return
    fi
    sleep 2
  done
  log_warn "Gateway did not report healthy within 120s after update. Run: sudo ./health-check.sh and sudo ./logs.sh supreme-gateway"
}

main "$@"

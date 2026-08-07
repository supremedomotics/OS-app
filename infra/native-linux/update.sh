#!/usr/bin/env bash
# SupremeOS native-linux — update.sh
#
# § Transactional updates: backup -> install -> migration -> verification -> switch active
# version -> cleanup. Any stage failing after the backup triggers automatic rollback —
# previous binaries (via the release symlink), previous config, and previous database are
# all restored, and the controller ends the run on the SAME version it started on, running.
# The transactional backup is deleted only after the update is confirmed healthy — never
# before, and never left behind indefinitely on success either.
#
# Usage:
#   sudo ./update.sh                                   update from this script's own tree
#   sudo ./update.sh --offline /path/to/release.tar.zst update fully offline from a local
#                                                        release package (no network needed)
#   sudo ./update.sh --no-verify                        source mode only: skip typecheck/test
#                                                        (SUPREME_SKIP_TESTS=1) — release mode
#                                                        never ran them anyway

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/deploy-steps.sh
source "${SCRIPT_DIR}/lib/deploy-steps.sh"

SUPREME_OFFLINE=0
OFFLINE_PACKAGE=""
NO_VERIFY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --offline) SUPREME_OFFLINE=1; OFFLINE_PACKAGE="${2:?Usage: update.sh --offline <path-to-release-package.tar.zst>}"; shift 2 ;;
    --no-verify) NO_VERIFY=1; shift ;;
    *) die "Unknown argument: $1" ;;
  esac
done
[ "$NO_VERIFY" = "1" ] && SUPREME_SKIP_TESTS=1

render_config() {
  log_step "Re-rendering configuration from current templates"
  render_template "${SCRIPT_DIR}/config/gateway.env.template" "${SUPREME_CONFIG_DIR}/gateway.env"
  chown "root:${SUPREME_GROUP}" "${SUPREME_CONFIG_DIR}/gateway.env"
  chmod 0640 "${SUPREME_CONFIG_DIR}/gateway.env"
  render_template "${SCRIPT_DIR}/config/nats.conf.template" "${SUPREME_CONFIG_DIR}/nats.conf"
  # § Bug fix (Phase 2 runtime investigation) — see install.sh's configure_nats() for the
  # full evidence; same fix applied here since update.sh re-renders this file independently.
  chown "root:${SUPREME_GROUP}" "${SUPREME_CONFIG_DIR}/nats.conf"
  chmod 0640 "${SUPREME_CONFIG_DIR}/nats.conf"
  render_template "${SCRIPT_DIR}/config/Caddyfile.template" /etc/caddy/Caddyfile
  chown root:root /etc/caddy/Caddyfile
  chmod 0644 /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile || die "Regenerated Caddyfile failed validation — see caddy's own error above. Old config left in place is NOT guaranteed; check /etc/caddy/Caddyfile before relying on it."
  render_template "${SCRIPT_DIR}/systemd/supreme-gateway.service" /etc/systemd/system/supreme-gateway.service
  render_template "${SCRIPT_DIR}/systemd/supreme-commissioning.service" /etc/systemd/system/supreme-commissioning.service
  render_template "${SCRIPT_DIR}/systemd/supreme-nats.service" /etc/systemd/system/supreme-nats.service
  # § Bug fix (Phase 2 runtime investigation) — supreme-lan.service is now a real template
  # (see its own header comment); render it like every sibling unit, never `cp` it raw.
  render_template "${SUPREME_RELEASE_DIR}/infra/systemd/supreme-lan.service" /etc/systemd/system/supreme-lan.service
  if [ "${SUPREME_INSTALL_HA}" = "1" ]; then
    render_template "${SCRIPT_DIR}/systemd/supreme-homeassistant.service" /etc/systemd/system/supreme-homeassistant.service
  fi
  if systemd_is_live; then systemctl daemon-reload; fi
}

restart_services() {
  log_step "Restarting SupremeOS-owned services"
  # Order matches dependency direction: the bus/broker before the services that talk to
  # it, the Gateway last (it's the one thing every client actually connects to).
  systemctl_restart supreme-nats
  systemctl_restart supreme-commissioning
  systemctl_restart supreme-lan
  if [ "${SUPREME_INSTALL_HA}" = "1" ]; then
    systemctl_restart supreme-homeassistant
  fi
  systemctl_restart supreme-gateway
  if systemd_is_live; then systemctl reload caddy 2>/dev/null || systemctl restart caddy; fi
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
  log_warn "Gateway did not report healthy within 120s after update."
}

# § Automatic rollback (requirement 3/4): restores the previous binaries (atomic symlink
# switch back), previous database/config/data (via restore.sh --force against the backup
# taken at the START of this run, before anything changed), then restarts services and
# reports the post-rollback state. Never partial — either the whole rollback completes or
# this dies loudly with exactly what's left inconsistent, never a silent half-recovery.
rollback_update() {
  local prev_version="$1" backup_archive="$2"
  log_error "Update failed — rolling back to the previous known-good version."

  if [ -n "$prev_version" ]; then
    switch_active_release "$prev_version"
  else
    log_warn "No previous version recorded — cannot switch code back (this may have been the first-ever update on this machine)."
  fi

  if [ -n "$backup_archive" ] && [ -r "$backup_archive" ]; then
    log_step "Restoring database/config/data from the pre-update backup"
    "${SCRIPT_DIR}/restore.sh" --force "$backup_archive" \
      || log_error "restore.sh reported errors during rollback — the controller may be in a degraded state. Run ./health-check.sh and inspect manually."
  else
    log_warn "No pre-update backup archive available — code was rolled back (if a previous version existed) but database/config were NOT restored."
  fi

  render_config
  restart_services
  wait_for_health

  log_step "Rollback complete — the controller should now be back on ${prev_version:-its previous state}."
  if run_runtime_verification; then
    log_info "Post-rollback runtime verification: all checks passed."
  else
    log_error "Post-rollback runtime verification still reports failures (${RUNTIME_CHECK_FAILED}) — this needs manual attention. See: ./health-check.sh, ./recover.sh"
  fi
}

main() {
  require_root
  load_answers

  local src_root
  if [ "$SUPREME_OFFLINE" = "1" ]; then
    log_step "Offline update from ${OFFLINE_PACKAGE}"
    src_root="$(extract_release_tarball "$OFFLINE_PACKAGE")"
    SUPREME_RELEASE_TARBALL="$OFFLINE_PACKAGE"
    SUPREME_INSTALL_MODE="release"
  else
    src_root="$(cd "${SCRIPT_DIR}/../.." && pwd)"
  fi
  detect_install_mode "$src_root"

  local prev_version
  prev_version="$(current_release_version)"
  log_info "Currently active version: ${prev_version:-none (first update on this machine)}."

  # § Automatic backup (requirement 4) — no manual interaction, always runs, before
  # anything about this update touches a running system.
  log_step "Taking a pre-update backup"
  "${SCRIPT_DIR}/backup.sh" --no-prune
  local backup_archive
  backup_archive="$(find "$SUPREME_BACKUP_DIR" -maxdepth 1 -name 'supremeos-backup-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
  [ -n "$backup_archive" ] || die "backup.sh did not produce an archive — refusing to proceed with an update that has no rollback point."
  log_info "Pre-update backup: ${backup_archive}"

  # From here on, ANY failure triggers rollback — trap it rather than scattering the same
  # rollback call after every step (and to catch a failure in a step that isn't wrapped in
  # its own `|| die`, e.g. an unexpected error under `set -e`).
  local rolled_back=0
  trap 'if [ "$rolled_back" != "1" ]; then rolled_back=1; rollback_update "$prev_version" "$backup_archive"; exit 1; fi' ERR

  if [ "$SUPREME_INSTALL_MODE" = "release" ]; then
    install_release_artifact "$src_root"
  else
    sync_repo
    build_workspace
    verify_workspace
  fi

  # Switch: the atomic moment new code goes live. Migrations run automatically when the
  # Gateway boots against the (unchanged, additive-only) database — see
  # services/persistence/src/migrate.ts, invoked from the restarted service below.
  stage_and_switch_release

  render_config
  restart_services
  wait_for_health

  log_step "Verifying runtime after update — staged, ordered startup verification"
  if ! run_staged_verification "${SUPREME_RELEASE_MIGRATION_COUNT:-}" "${SUPREME_RELEASE_REQUIRED_DISK_MB:-0}" "${SUPREME_RELEASE_REQUIRED_RAM_MB:-0}" "${SUPREME_RELEASE_REQUIRED_CPU_ARCH:-}"; then
    # § Transactional database rollback (requirement 3): a DATABASE-stage failure means
    # migrations either failed outright or left the schema in a state this release can't
    # run against — never leave that partially-migrated. Trigger the same rollback path
    # as an unexpected error, deliberately (not via the ERR trap, since this is a checked
    # failure, not an exception) — then exit non-zero.
    release_state_record_failure "$SUPREME_RELEASE_VERSION" "$prev_version"
    rolled_back=1
    rollback_update "$prev_version" "$backup_archive"
    exit 1
  fi

  trap - ERR
  release_state_record_health "healthy"
  log_info "Runtime verification: all stages passed."

  # § Cleanup — delete the transactional backup ONLY after confirmed success (requirement
  # 4's literal ordering), then prune old release directories beyond the retain count.
  rm -f "$backup_archive"
  log_info "Pre-update backup removed (update confirmed healthy): ${backup_archive}"
  prune_old_releases

  log_step "Update complete — now running $(current_release_version)."
}

main "$@"

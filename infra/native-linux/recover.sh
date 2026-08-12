#!/usr/bin/env bash
# SupremeOS native-linux — recover.sh
#
# § Recovery mode (requirement 7). Detects a broken installation, repairs what a repair
# can fix (systemd unit state, ownership/permissions, regenerated config), optionally
# restores the latest backup, then re-verifies and restarts. Safe to run any time — every
# step is idempotent, and nothing here touches the database unless --restore-backup is
# explicitly passed (a repair should never be more destructive than the problem it fixes).
#
# Usage:
#   sudo ./recover.sh                    detect + repair permissions/services, re-verify
#   sudo ./recover.sh --restore-backup   also restore the most recent backup.sh archive

set -uo pipefail  # no -e: recover.sh's job is to keep going and report, not abort on step 1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/deploy-steps.sh
source "${SCRIPT_DIR}/lib/deploy-steps.sh"

RESTORE_BACKUP=0
[ "${1:-}" = "--restore-backup" ] && RESTORE_BACKUP=1

ISSUES_FOUND=0
ISSUES_FIXED=0

note_issue() { echo "  ISSUE      $*"; ISSUES_FOUND=$((ISSUES_FOUND + 1)); }
note_fixed() { echo "  FIXED      $*"; ISSUES_FIXED=$((ISSUES_FIXED + 1)); }

detect_and_repair() {
  log_step "Detecting installation state"

  [ -r "${SUPREME_CONFIG_DIR}/install.conf" ] || { log_error "No ${SUPREME_CONFIG_DIR}/install.conf — this machine has never had install.sh run successfully. recover.sh cannot fix a missing install; run install.sh."; exit 1; }
  # shellcheck source=/dev/null
  source "${SUPREME_CONFIG_DIR}/install.conf"
  load_secrets 2>/dev/null || { log_error "Secrets missing or unreadable at ${SUPREME_SECRETS_DIR} — cannot proceed without them. If a backup exists, re-run with --restore-backup."; exit 1; }

  log_step "Repairing ownership and permissions"
  if [ -d "$SUPREME_APP_DIR" ]; then
    chown -R "${SUPREME_USER}:${SUPREME_GROUP}" "$SUPREME_APP_DIR" 2>/dev/null && note_fixed "Ownership of ${SUPREME_APP_DIR}"
  fi
  # § Bug fix (Phase 2 runtime investigation): `chown -R` above fixes ownership but not the
  # MODE bit — a releases dir left at 700 by a leaked umask (see install.sh's
  # persist_secrets()) stays untraversable by the supreme user even after this chown.
  if [ -d "$SUPREME_RELEASES_DIR" ]; then
    chmod 0750 "$SUPREME_RELEASES_DIR" 2>/dev/null && note_fixed "Permissions on ${SUPREME_RELEASES_DIR}"
  fi
  if [ -d "$SUPREME_DATA_DIR" ]; then
    chown -R "${SUPREME_USER}:${SUPREME_GROUP}" "$SUPREME_DATA_DIR" 2>/dev/null && note_fixed "Ownership of ${SUPREME_DATA_DIR}"
  fi
  if [ -d "$SUPREME_SECRETS_DIR" ]; then
    chmod 0700 "$SUPREME_SECRETS_DIR" 2>/dev/null
    chmod 0640 "${SUPREME_SECRETS_DIR}"/* 2>/dev/null
    chown -R "root:${SUPREME_GROUP}" "$SUPREME_SECRETS_DIR" 2>/dev/null && note_fixed "Permissions on ${SUPREME_SECRETS_DIR}"
  fi

  log_step "Checking the active release"
  if [ ! -e "$SUPREME_RELEASE_DIR" ]; then
    note_issue "${SUPREME_RELEASE_DIR} (the active-release symlink) is missing or broken."
    local newest
    newest="$(find "$SUPREME_RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
    if [ -n "$newest" ]; then
      switch_active_release "$newest"
      note_fixed "Re-pointed ${SUPREME_RELEASE_DIR} at the most recent known-good release: ${newest}"
    else
      log_error "No release directories found under ${SUPREME_RELEASES_DIR} either — this needs a fresh install.sh, recover.sh cannot rebuild code from nothing."
    fi
  fi

  log_step "Regenerating configuration from current templates (never trusts possibly-corrupt on-disk config)"
  local CADDY_REGEN_FAILED=0
  render_template "${SCRIPT_DIR}/config/gateway.env.template" "${SUPREME_CONFIG_DIR}/gateway.env" \
    && note_fixed "Regenerated gateway.env" || note_issue "Failed to regenerate gateway.env from template — on-disk copy left untouched."
  chown "root:${SUPREME_GROUP}" "${SUPREME_CONFIG_DIR}/gateway.env" 2>/dev/null
  chmod 0640 "${SUPREME_CONFIG_DIR}/gateway.env" 2>/dev/null
  render_template "${SCRIPT_DIR}/config/nats.conf.template" "${SUPREME_CONFIG_DIR}/nats.conf" \
    && note_fixed "Regenerated nats.conf" || note_issue "Failed to regenerate nats.conf from template — on-disk copy left untouched."
  # § Bug fix (Phase 2 runtime investigation) — see install.sh's configure_nats() for the
  # full evidence (a leaked umask left this file root:root 600, unreadable by
  # supreme-nats.service's User=supreme).
  chown "root:${SUPREME_GROUP}" "${SUPREME_CONFIG_DIR}/nats.conf" 2>/dev/null
  chmod 0640 "${SUPREME_CONFIG_DIR}/nats.conf" 2>/dev/null

  # § A regenerated-but-invalid Caddyfile must never be left live: the service-restart loop
  # below unconditionally restarts caddy, and restarting it against a config already known
  # to fail validation would take down the HTTPS edge entirely — worse than the problem this
  # script is trying to fix. Render into a scratch file, validate there, and only replace the
  # live Caddyfile if validation passes.
  local caddyfile_scratch
  caddyfile_scratch="$(mktemp)"
  render_template "${SCRIPT_DIR}/config/Caddyfile.template" "$caddyfile_scratch"
  if command_exists caddy && caddy validate --config "$caddyfile_scratch" >/dev/null 2>&1; then
    cp "$caddyfile_scratch" /etc/caddy/Caddyfile
    note_fixed "Regenerated + validated Caddyfile"
  else
    CADDY_REGEN_FAILED=1
    note_issue "Regenerated Caddyfile failed validation — left the existing /etc/caddy/Caddyfile in place. Inspect ${caddyfile_scratch} manually."
  fi
  [ "$CADDY_REGEN_FAILED" = "1" ] || rm -f "$caddyfile_scratch"

  log_step "Repairing systemd unit files"
  render_template "${SCRIPT_DIR}/systemd/supreme-gateway.service" /etc/systemd/system/supreme-gateway.service
  render_template "${SCRIPT_DIR}/systemd/supreme-commissioning.service" /etc/systemd/system/supreme-commissioning.service
  render_template "${SCRIPT_DIR}/systemd/supreme-nats.service" /etc/systemd/system/supreme-nats.service
  if [ -r "${SUPREME_RELEASE_DIR}/infra/systemd/supreme-lan.service" ]; then
    # § Bug fix (Phase 2 runtime investigation) — render, don't cp raw (see the file's own
    # header comment for the path-mismatch this used to bake in unmodified).
    render_template "${SUPREME_RELEASE_DIR}/infra/systemd/supreme-lan.service" /etc/systemd/system/supreme-lan.service
  fi
  if [ "${SUPREME_INSTALL_HA:-0}" = "1" ]; then
    render_template "${SCRIPT_DIR}/systemd/supreme-homeassistant.service" /etc/systemd/system/supreme-homeassistant.service
  fi
  if systemd_is_live; then
    systemctl daemon-reload
    note_fixed "systemd unit files re-rendered + daemon-reload"
  fi

  # § Bug fix (Phase 4 Redis investigation) — /run is tmpfs; a controller that's been
  # running a while (this is a repair run, not a fresh install) may have had redis-server
  # restarted or reinstalled since the last reboot with /run/redis still missing. See
  # ensure_redis_runtime_dir()'s own comment in lib/common.sh for the full trace.
  ensure_redis_runtime_dir && note_fixed "Ensured /run/redis exists with correct ownership"

  if [ "$RESTORE_BACKUP" = "1" ]; then
    log_step "Restoring the most recent backup"
    local latest
    latest="$(find "$SUPREME_BACKUP_DIR" -maxdepth 1 -name 'supremeos-backup-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
    if [ -n "$latest" ]; then
      "${SCRIPT_DIR}/restore.sh" --force "$latest" && note_fixed "Restored from backup: ${latest}"
    else
      note_issue "No backup archive found under ${SUPREME_BACKUP_DIR} — nothing to restore."
    fi
  fi

  log_step "Resetting failed-unit state and restarting services"
  if systemd_is_live; then
    systemctl reset-failed 2>/dev/null || true
    for svc in "${SUPREME_THIRDPARTY_SERVICES[@]}"; do
      systemctl_restart "$svc" 2>/dev/null || note_issue "Could not restart ${svc} — see: journalctl -u ${svc} -n 50"
    done
    # § NATS deployment contract — recover.sh must never assume the executable it's about
    # to invoke already exists (that assumption is exactly the original production bug).
    # nats_ensure_ready() (lib/common.sh) is the ONE authoritative validate/repair/start/
    # readiness mechanism: it reinstalls the pinned package if the executable/version/
    # symlink/ExecStart is broken, converges the JetStream directory's ownership without
    # ever touching its contents, then blocks on real readiness.
    # Run in a subshell: nats_ensure_ready() calls die() (exit 1) on unrecoverable
    # failure, which recover.sh's own "keep going and report" contract (see header) must
    # survive — a subshell contains that exit to just this one step, not the whole script.
    if (nats_ensure_ready) 2>/dev/null; then
      note_fixed "supreme-nats validated/repaired and ready"
    else
      note_issue "supreme-nats could not be brought to a ready state — see: journalctl -u supreme-nats -n 50"
    fi
    for svc in "${SUPREME_PY_SERVICES[@]}" "${SUPREME_NODE_SERVICES[@]}"; do
      systemctl_restart "$svc" 2>/dev/null || note_issue "Could not restart ${svc} — see: journalctl -u ${svc} -n 50"
    done
    if [ "${SUPREME_INSTALL_HA:-0}" = "1" ]; then
      systemctl_restart "$SUPREME_HA_SERVICE" 2>/dev/null || note_issue "Could not restart ${SUPREME_HA_SERVICE}"
    fi
    note_fixed "Services restarted"
  else
    log_warn "systemd is not live in this environment — cannot restart real services here."
  fi
}

main() {
  require_root
  detect_and_repair

  log_step "Runtime verification"
  run_runtime_verification "" || true

  echo ""
  echo "=== Recovery summary ==="
  echo "Issues found: ${ISSUES_FOUND}   Repairs applied: ${ISSUES_FIXED}   Runtime failures: ${RUNTIME_CHECK_FAILED}"
  if [ "$RUNTIME_CHECK_FAILED" -eq 0 ]; then
    echo "Result: RECOVERED"
    exit 0
  else
    echo "Result: STILL UNHEALTHY — see the FAIL lines above. Consider: sudo ./recover.sh --restore-backup, or sudo ./supremeos-support to generate a bundle for Supreme Domotics support."
    exit 1
  fi
}

main "$@"

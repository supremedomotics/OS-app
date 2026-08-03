#!/usr/bin/env bash
# SupremeOS native-linux — uninstall.sh
#
# Default behavior is DELIBERATELY conservative: stops and removes only the systemd units
# and app code this deployment owns, leaves config/secrets/data in place, and does not
# touch shared third-party packages (Postgres, Redis, Mosquitto, Caddy, NATS) since they
# may be serving other purposes on this box. Re-running install.sh afterward picks the
# existing config/secrets back up exactly where it left off.
#
# Usage:
#   sudo ./uninstall.sh                 stop + remove SupremeOS units and app code only
#   sudo ./uninstall.sh --purge         also remove config/secrets/data and third-party
#                                       packages this installer added (Postgres/Redis/
#                                       Mosquitto/Caddy/NATS) — backups are STILL preserved
#   sudo ./uninstall.sh --purge --purge-backups
#                                       --purge AND delete /var/backups/supremeos too
#   Add --force to either mode to skip the interactive confirmation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

PURGE=0
PURGE_BACKUPS=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --purge-backups) PURGE_BACKUPS=1 ;;
    --force) FORCE=1 ;;
    *) die "Unknown argument: $arg" ;;
  esac
done

confirm() {
  [ "$FORCE" -eq 1 ] && return
  if [ "$PURGE" -eq 1 ]; then
    log_warn "This will PERMANENTLY remove SupremeOS's app code, config, secrets, and data,"
    log_warn "and uninstall Postgres/Redis/Mosquitto/Caddy/NATS from this machine."
    if [ "$PURGE_BACKUPS" -eq 1 ]; then
      log_warn "It will ALSO delete every backup under ${SUPREME_BACKUP_DIR}."
    else
      log_warn "Backups under ${SUPREME_BACKUP_DIR} will be PRESERVED."
    fi
  else
    log_warn "This stops and removes SupremeOS's systemd units and app code."
    log_warn "Config, secrets, and data under ${SUPREME_CONFIG_DIR} / ${SUPREME_DATA_DIR} are PRESERVED."
  fi
  read -r -p "Type 'yes' to continue: " answer
  [ "$answer" = "yes" ] || die "Uninstall cancelled."
}

stop_and_remove_units() {
  log_step "Stopping and removing SupremeOS systemd units"
  local units=(supreme-gateway supreme-lan supreme-commissioning supreme-homeassistant supreme-nats)
  for u in "${units[@]}"; do
    if systemd_is_live && systemctl list-unit-files "${u}.service" >/dev/null 2>&1; then
      systemctl disable --now "$u" 2>/dev/null || true
    fi
    rm -f "/etc/systemd/system/${u}.service"
  done
  systemctl daemon-reload 2>/dev/null || true
}

remove_app_code() {
  log_step "Removing app code (${SUPREME_APP_DIR})"
  rm -rf "$SUPREME_APP_DIR"
}

purge_config_and_data() {
  log_step "Purging config, secrets, and data"
  rm -rf "$SUPREME_CONFIG_DIR" "$SUPREME_DATA_DIR"
  if [ "$PURGE_BACKUPS" -eq 1 ]; then
    log_warn "Deleting all backups under ${SUPREME_BACKUP_DIR}"
    rm -rf "$SUPREME_BACKUP_DIR"
  else
    log_info "Backups preserved at ${SUPREME_BACKUP_DIR}"
  fi
}

purge_thirdparty_packages() {
  log_step "Removing third-party packages this installer added"
  export DEBIAN_FRONTEND=noninteractive
  systemctl disable --now caddy 2>/dev/null || true
  systemctl disable --now mosquitto 2>/dev/null || true
  systemctl disable --now redis-server 2>/dev/null || true
  systemctl disable --now postgresql 2>/dev/null || true
  apt-get remove -y -qq caddy mosquitto mosquitto-clients redis-server postgresql postgresql-contrib 2>&1 \
    | tee /dev/stderr | grep -qi "^E:" && log_warn "apt-get reported errors removing some packages — review above."
  dpkg -r nats-server 2>/dev/null || log_warn "nats-server package not found or already removed."
  rm -f /usr/local/bin/nats-server
  log_info "Third-party packages removed. Run 'apt-get autoremove' if you also want their now-unused dependencies gone."
}

remove_system_user() {
  log_step "Removing the ${SUPREME_USER} system account"
  userdel "$SUPREME_USER" 2>/dev/null || log_warn "Could not remove user '${SUPREME_USER}' — it may still own files, or may not exist."
  groupdel "$SUPREME_GROUP" 2>/dev/null || true
}

main() {
  require_root
  confirm
  stop_and_remove_units
  remove_app_code
  if [ "$PURGE" -eq 1 ]; then
    purge_config_and_data
    purge_thirdparty_packages
    remove_system_user
    log_step "Purge complete. SupremeOS has been fully removed from this machine."
  else
    log_step "Uninstall complete. Config/secrets/data preserved — re-run install.sh to reinstall in place."
  fi
}

main "$@"

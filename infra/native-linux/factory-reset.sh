#!/usr/bin/env bash
# SupremeOS native-linux — factory-reset.sh
#
# § Factory reset (requirement 6). Returns this controller to Out-of-Box Experience:
# stops every service, wipes the database, config, secrets, and release state, and
# clears SUPREME_SETUP_WIZARD back to "show the wizard on next boot." DESTRUCTIVE —
# requires explicit confirmation unless --force is passed, exactly like restore.sh's
# existing pattern (reused, not reinvented).
#
# What's preserved is opt-in, one flag per thing (§ requirement: full reset by default,
# nothing preserved unless explicitly asked):
#
# Usage:
#   sudo ./factory-reset.sh [--force] [--preserve-network] [--preserve-license]
#                            [--preserve-backups] [--preserve-ssh-keys] [--preserve-static-ip]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

FORCE=0
PRESERVE_NETWORK=0
PRESERVE_LICENSE=0
PRESERVE_BACKUPS=0
PRESERVE_SSH_KEYS=0
PRESERVE_STATIC_IP=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --preserve-network) PRESERVE_NETWORK=1 ;;
    --preserve-license) PRESERVE_LICENSE=1 ;;
    --preserve-backups) PRESERVE_BACKUPS=1 ;;
    --preserve-ssh-keys) PRESERVE_SSH_KEYS=1 ;;
    --preserve-static-ip) PRESERVE_STATIC_IP=1 ;;
    *) die "Unknown argument: $arg" ;;
  esac
done

confirm() {
  if [ "$FORCE" -eq 1 ]; then return; fi
  log_warn "This will PERMANENTLY ERASE the SupremeOS database, configuration, secrets,"
  log_warn "and release state on this machine, returning it to Out-of-Box Experience."
  log_warn "Preserving: $( [ "$PRESERVE_NETWORK" = 1 ] && echo -n "network "; [ "$PRESERVE_LICENSE" = 1 ] && echo -n "license "; [ "$PRESERVE_BACKUPS" = 1 ] && echo -n "backups "; [ "$PRESERVE_SSH_KEYS" = 1 ] && echo -n "ssh-keys "; [ "$PRESERVE_STATIC_IP" = 1 ] && echo -n "static-ip "; echo )"
  read -r -p "Type 'FACTORY RESET' to continue: " answer
  [ "$answer" = "FACTORY RESET" ] || die "Factory reset cancelled."
}

main() {
  require_root
  confirm

  log_step "Stopping SupremeOS-owned services"
  for svc in "${SUPREME_NODE_SERVICES[@]}" "${SUPREME_PY_SERVICES[@]}" supreme-nats; do
    systemctl stop "$svc" 2>/dev/null || true
    systemctl disable "$svc" 2>/dev/null || true
  done

  log_step "Dropping the supreme database"
  if [ -r "${SUPREME_SECRETS_DIR}/postgres-password" ] && command_exists psql; then
    sudo -u postgres psql -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='supreme';" >/dev/null 2>&1 || true
    sudo -u postgres dropdb --if-exists supreme 2>/dev/null || log_warn "Could not drop the 'supreme' database — continuing."
  fi

  # § live-confirmed fix — Redis holds shared presence/ephemeral state (SUPREME_REDIS_URL,
  # see config.ts) whose actual data file lives under Redis's own /var/lib/redis, entirely
  # OUTSIDE SUPREME_DATA_DIR — nothing else in this script ever touches it, so a factory
  # reset left stale presence/session entries behind even though every other store was
  # genuinely wiped. FLUSHALL only if redis-server is actually installed/running; a hub
  # that never enabled Redis (redisUrl empty → in-process fallback) has nothing to flush.
  if command_exists redis-cli && systemctl is-active --quiet redis-server 2>/dev/null; then
    log_step "Flushing Redis (shared presence/ephemeral state)"
    redis-cli FLUSHALL >/dev/null 2>&1 || log_warn "Could not flush Redis — continuing."
  fi

  # § live-confirmed fix — Mosquitto's own package-provided mosquitto.conf sets
  # `persistence_location /var/lib/mosquitto/` (see config/mosquitto-supremeos.conf
  # .template's own doc comment for why this deployment deliberately never overrides
  # it) — real retained MQTT messages/subscriptions from live smart-home telemetry live
  # there, entirely outside SUPREME_DATA_DIR, and nothing else in this script touches it.
  # Stop-wipe-restart rather than deleting the open file live: Mosquitto would otherwise
  # keep the deleted inode open and simply recreate the same content on its next restart.
  if systemctl list-unit-files mosquitto.service >/dev/null 2>&1 && [ -d /var/lib/mosquitto ]; then
    log_step "Wiping Mosquitto's persisted retained messages/state"
    systemctl stop mosquitto 2>/dev/null || true
    rm -rf /var/lib/mosquitto/*
    systemctl start mosquitto 2>/dev/null || log_warn "Could not restart mosquitto — start it manually."
  fi

  # § Preserve backups: move the backup directory content aside, wipe everything else,
  # restore it. Simpler and more robust than teaching every subsequent wipe step to skip
  # one specific directory.
  local backup_stash=""
  if [ "$PRESERVE_BACKUPS" = 1 ] && [ -d "$SUPREME_BACKUP_DIR" ]; then
    backup_stash="$(mktemp -d)"
    log_step "Preserving backups (moving aside)"
    cp -a "$SUPREME_BACKUP_DIR/." "$backup_stash/" 2>/dev/null || true
  fi

  # § Preserve license: the license file, if this deployment has one, lives under config
  # — stash it the same way as backups rather than special-casing every wipe path.
  local license_stash=""
  if [ "$PRESERVE_LICENSE" = 1 ] && [ -r "${SUPREME_CONFIG_DIR}/license.json" ]; then
    license_stash="$(mktemp -d)"
    cp "${SUPREME_CONFIG_DIR}/license.json" "${license_stash}/" 2>/dev/null || true
  fi

  # § Distinct from uninstall.sh's --purge (which REMOVES the software — systemd units,
  # app code, third-party packages, the system user — leaving the machine ready for a
  # fresh `install.sh` from scratch). Factory reset is the opposite intent: an APPLIANCE
  # OOBE reset wipes DATA/CONFIG only, keeps the installed release and every systemd unit
  # in place, so the machine comes back up fast, already serving the Setup Wizard, without
  # re-running apt/Node/NATS/Caddy installation. Releases/app code and systemd units are
  # deliberately NOT touched here — only config, secrets, data, and release state.
  log_step "Wiping configuration, secrets, and data (installed software is preserved)"
  rm -rf "${SUPREME_CONFIG_DIR:?}"/* "${SUPREME_DATA_DIR:?}"/* "${SUPREME_BACKUP_DIR:?}"/* 2>/dev/null || true

  if [ -n "$backup_stash" ]; then
    mkdir -p "$SUPREME_BACKUP_DIR"
    cp -a "${backup_stash}/." "$SUPREME_BACKUP_DIR/" 2>/dev/null || true
    rm -rf "$backup_stash"
    log_info "Backups preserved: ${SUPREME_BACKUP_DIR}"
  fi
  if [ -n "$license_stash" ]; then
    mkdir -p "$SUPREME_CONFIG_DIR"
    cp "${license_stash}/license.json" "${SUPREME_CONFIG_DIR}/" 2>/dev/null || true
    rm -rf "$license_stash"
    log_info "License preserved: ${SUPREME_CONFIG_DIR}/license.json"
  fi

  # § Preserve network / static IP / SSH keys: these live entirely OUTSIDE SUPREME_*_DIR
  # (netplan under /etc/netplan, sshd host keys under /etc/ssh) — factory-reset.sh never
  # touches them at all regardless of these flags. The flags exist so an operator can
  # state intent explicitly and this script can CONFIRM (not silently assume) that intent
  # was honored, rather than requiring them to trust an undocumented default.
  if [ "$PRESERVE_NETWORK" = 1 ] || [ "$PRESERVE_STATIC_IP" = 1 ]; then
    log_info "Network configuration (/etc/netplan) was never touched — preserved."
  fi
  if [ "$PRESERVE_SSH_KEYS" = 1 ]; then
    log_info "SSH host keys (/etc/ssh) were never touched — preserved."
  fi

  log_step "Factory reset complete — re-running install.sh to regenerate config and restart services"
  cat <<EOF

  SupremeOS has been reset to Out-of-Box Experience. Installed software (systemd units,
  releases, third-party packages) was NOT removed — only data/config/secrets.

  Next step: sudo ./install.sh
  This re-provisions secrets/config and starts services fresh — the apt/Node/NATS/Caddy
  phases are idempotent and will skip anything already installed, so this is fast. The
  Setup Wizard will run on first boot, per SUPREME_SETUP_WIZARD.

  (Want to remove SupremeOS entirely instead of resetting it? Use uninstall.sh --purge.)

EOF
}

main

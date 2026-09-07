#!/usr/bin/env bash
# SupremeOS native-linux — restore.sh
#
# Restores a backup.sh archive: database, config (including secrets), and data directory.
# DESTRUCTIVE — replaces the current `supreme` database and every file under
# /etc/supremeos and /var/lib/supremeos with what the archive contains. Requires explicit
# confirmation unless --force is passed (for scripted disaster-recovery runbooks that have
# already confirmed intent elsewhere).
#
# Usage:
#   sudo ./restore.sh /var/backups/supremeos/supremeos-backup-20260803T120000Z.tar.gz
#   sudo ./restore.sh --force <archive>     skip the interactive confirmation

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

FORCE=0
if [ "${1:-}" = "--force" ]; then
  FORCE=1
  shift
fi
ARCHIVE="${1:-}"
[ -n "$ARCHIVE" ] || die "Usage: $0 [--force] <backup-archive.tar.gz>"
[ -r "$ARCHIVE" ] || die "Cannot read archive: $ARCHIVE"

confirm() {
  if [ "$FORCE" -eq 1 ]; then return; fi
  log_warn "This will REPLACE the current 'supreme' database and every file under"
  log_warn "${SUPREME_CONFIG_DIR} and ${SUPREME_DATA_DIR} with the contents of:"
  log_warn "  ${ARCHIVE}"
  read -r -p "Type 'yes' to continue: " answer
  [ "$answer" = "yes" ] || die "Restore cancelled."
}

main() {
  require_root
  confirm

  # Not `local` — the EXIT trap below fires after main() returns, by which point a
  # local would already be out of scope, and set -u would reject it as unbound.
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  log_step "Extracting archive"
  tar -xzf "$ARCHIVE" -C "$work"
  [ -f "${work}/MANIFEST.txt" ] && cat "${work}/MANIFEST.txt"

  log_step "Stopping SupremeOS-owned services"
  for svc in "${SUPREME_NODE_SERVICES[@]}" "${SUPREME_PY_SERVICES[@]}" supreme-nats mosquitto; do
    systemctl stop "$svc" 2>/dev/null || true
  done

  if [ -f "${work}/supreme.pgdump" ]; then
    log_step "Restoring the supreme database"
    systemctl start postgresql 2>/dev/null || true
    [ -r "${SUPREME_SECRETS_DIR}/postgres-password" ] || die "No ${SUPREME_SECRETS_DIR}/postgres-password on this machine — restore config first, or run install.sh, before restoring the database."
    local pg_password
    pg_password="$(cat "${SUPREME_SECRETS_DIR}/postgres-password")"
    sudo -u postgres psql -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='supreme';" >/dev/null 2>&1 || true
    sudo -u postgres dropdb --if-exists supreme
    sudo -u postgres createdb supreme --owner=supreme
    PGPASSWORD="$pg_password" pg_restore -h 127.0.0.1 -U supreme -d supreme --no-owner --role=supreme "${work}/supreme.pgdump" \
      || log_warn "pg_restore reported errors — review the output above before trusting this restore."
    log_info "Database restored."
  else
    log_warn "No supreme.pgdump in this archive — skipping database restore."
  fi

  # § Zero-window atomic swap, not rm-then-cp: a delete-then-recreate here would leave a
  # window (the full duration of the cp) where secrets/config or data are entirely absent
  # if the copy is interrupted (disk full, power loss). Build the new content into a sibling
  # directory first, then swap via `mv` (atomic on the same filesystem) — the exact pattern
  # stage_release_version() in lib/common.sh already uses for the same reason.
  if [ -d "${work}/config" ]; then
    log_step "Restoring configuration (including secrets)"
    local config_building="${SUPREME_CONFIG_DIR}.restoring-new" config_previous="${SUPREME_CONFIG_DIR}.restoring-previous"
    rm -rf "$config_building" "$config_previous"
    cp -a "${work}/config" "$config_building"
    chown -R "root:${SUPREME_GROUP}" "$config_building"
    chmod 0700 "${config_building}/secrets" 2>/dev/null || true
    chmod 0640 "${config_building}/secrets"/* 2>/dev/null || true
    mv "$SUPREME_CONFIG_DIR" "$config_previous"
    mv "$config_building" "$SUPREME_CONFIG_DIR"
    rm -rf "$config_previous"
  fi

  if [ -d "${work}/data" ]; then
    log_step "Restoring data directory"
    local data_building="${SUPREME_DATA_DIR}.restoring-new" data_previous="${SUPREME_DATA_DIR}.restoring-previous"
    rm -rf "$data_building" "$data_previous"
    cp -a "${work}/data" "$data_building"
    chown -R "${SUPREME_USER}:${SUPREME_GROUP}" "$data_building"
    mv "$SUPREME_DATA_DIR" "$data_previous"
    mv "$data_building" "$SUPREME_DATA_DIR"
    rm -rf "$data_previous"
  fi

  log_step "Restarting services"
  systemctl daemon-reload
  for svc in supreme-nats mosquitto "${SUPREME_PY_SERVICES[@]}" "${SUPREME_NODE_SERVICES[@]}"; do
    systemctl restart "$svc" 2>/dev/null || log_warn "Could not restart $svc — check: journalctl -u $svc"
  done
  systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true

  log_step "Restore complete — run ./health-check.sh to confirm everything came back up."
}

main "$@"

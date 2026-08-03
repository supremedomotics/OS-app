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

  local work
  work="$(mktemp -d)"
  log_step "Extracting archive"
  tar -xzf "$ARCHIVE" -C "$work"
  [ -f "${work}/MANIFEST.txt" ] && cat "${work}/MANIFEST.txt"

  log_step "Stopping SupremeOS-owned services"
  for svc in "${SUPREME_NODE_SERVICES[@]}" "${SUPREME_PY_SERVICES[@]}"; do
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

  if [ -d "${work}/config" ]; then
    log_step "Restoring configuration (including secrets)"
    rm -rf "${SUPREME_CONFIG_DIR:?}"/*
    cp -a "${work}/config/." "$SUPREME_CONFIG_DIR/"
    chown -R "root:${SUPREME_GROUP}" "$SUPREME_CONFIG_DIR"
    chmod 0700 "$SUPREME_SECRETS_DIR"
    chmod 0640 "${SUPREME_SECRETS_DIR}"/* 2>/dev/null || true
  fi

  if [ -d "${work}/data" ]; then
    log_step "Restoring data directory"
    rm -rf "${SUPREME_DATA_DIR:?}"/*
    cp -a "${work}/data/." "$SUPREME_DATA_DIR/"
    chown -R "${SUPREME_USER}:${SUPREME_GROUP}" "$SUPREME_DATA_DIR"
  fi

  rm -rf "$work"

  log_step "Restarting services"
  systemctl daemon-reload
  for svc in supreme-nats "${SUPREME_PY_SERVICES[@]}" "${SUPREME_NODE_SERVICES[@]}"; do
    systemctl restart "$svc" 2>/dev/null || log_warn "Could not restart $svc — check: journalctl -u $svc"
  done
  systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true

  log_step "Restore complete — run ./health-check.sh to confirm everything came back up."
}

main "$@"

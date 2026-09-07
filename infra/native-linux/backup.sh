#!/usr/bin/env bash
# SupremeOS native-linux — backup.sh
#
# Produces ONE timestamped, self-contained archive under /var/backups/supremeos containing
# everything restore.sh needs to bring a machine back: a real `pg_dump` of the `supreme`
# database, the config directory (including secrets — the archive itself is locked to
# root-only, mode 0600), and the data directory (NATS JetStream store, Mosquitto
# persistence, Home Assistant config if installed, Matter/AppleTV state).
#
# Usage:
#   sudo ./backup.sh                 create a backup, keep the last SUPREME_BACKUP_RETAIN (default 7)
#   sudo ./backup.sh --no-prune      create a backup, never delete old ones

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

SUPREME_BACKUP_RETAIN="${SUPREME_BACKUP_RETAIN:-7}"
PRUNE=1
[ "${1:-}" = "--no-prune" ] && PRUNE=0

main() {
  require_root
  [ -r "${SUPREME_SECRETS_DIR}/postgres-password" ] || die "No ${SUPREME_SECRETS_DIR}/postgres-password found — has install.sh been run?"

  local ts work archive
  ts="$(date -u +"%Y%m%dT%H%M%SZ")"
  work="$(mktemp -d)"
  # § Bug fix — `work` is local to main(); the EXIT trap fires once the whole SCRIPT
  # exits, which is after main() has already returned and `work` has gone out of scope.
  # Under `set -u` that made the trap itself die with "work: unbound variable" on every
  # run, right after a successful backup — `${work:-}` (the same not-set-yet guard this
  # codebase already uses throughout, e.g. lib/common.sh) makes the trap a safe no-op if
  # `work` is ever unset when it fires, instead of promoting cleanup into a failure.
  trap 'if [ -n "${work:-}" ]; then rm -rf "$work"; fi' EXIT
  archive="${SUPREME_BACKUP_DIR}/supremeos-backup-${ts}.tar.gz"
  mkdir -p "$SUPREME_BACKUP_DIR"

  log_step "Dumping the supreme database"
  local pg_password
  pg_password="$(cat "${SUPREME_SECRETS_DIR}/postgres-password")"
  if PGPASSWORD="$pg_password" pg_dump -h 127.0.0.1 -U supreme -d supreme -F custom -f "${work}/supreme.pgdump" 2>"${work}/pg_dump.log"; then
    log_info "Database dump written ($(du -h "${work}/supreme.pgdump" | cut -f1))."
  else
    log_error "pg_dump failed — see below. Continuing to back up config/data anyway; DO NOT treat this backup as complete."
    cat "${work}/pg_dump.log" >&2
  fi

  log_step "Copying config and data directories"
  mkdir -p "${work}/config" "${work}/data"
  # Config includes secrets on purpose — restore.sh needs the SAME token secret and DB
  # password back, or every existing session/token becomes invalid on restore.
  cp -a "${SUPREME_CONFIG_DIR}/." "${work}/config/" 2>/dev/null || log_warn "Could not copy ${SUPREME_CONFIG_DIR} in full — check permissions."
  cp -a "${SUPREME_DATA_DIR}/." "${work}/data/" 2>/dev/null || log_warn "Could not copy ${SUPREME_DATA_DIR} in full — check permissions."

  cat > "${work}/MANIFEST.txt" <<EOF
SupremeOS native-linux backup
Created (UTC): ${ts}
Hostname: $(hostname)
Contents:
  supreme.pgdump   — pg_dump of the 'supreme' database (custom format; restore with pg_restore)
  config/          — ${SUPREME_CONFIG_DIR} (includes secrets — treat this archive as a secret)
  data/            — ${SUPREME_DATA_DIR} (NATS JetStream, Mosquitto persistence, Home Assistant config, Matter/AppleTV state)
EOF

  log_step "Archiving to ${archive}"
  tar -czf "$archive" -C "$work" .
  rm -rf "$work"
  chmod 0600 "$archive"
  chown root:root "$archive"
  log_info "Backup complete: ${archive} ($(du -h "$archive" | cut -f1))"

  if [ "$PRUNE" -eq 1 ]; then
    prune_old_backups
  fi
}

prune_old_backups() {
  log_step "Pruning backups beyond the last ${SUPREME_BACKUP_RETAIN}"
  # Newest-first (mtime), so `tail -n +N` cleanly selects "everything past the retain
  # count" — `find -printf` + sort handles unusual filenames correctly, unlike `ls`.
  mapfile -t old < <(find "$SUPREME_BACKUP_DIR" -maxdepth 1 -name 'supremeos-backup-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | cut -d' ' -f2- | tail -n "+$((SUPREME_BACKUP_RETAIN + 1))")
  if [ "${#old[@]}" -eq 0 ]; then
    log_info "Nothing to prune (${SUPREME_BACKUP_RETAIN} or fewer backups exist)."
    return
  fi
  for f in "${old[@]}"; do
    log_info "Removing old backup: $f"
    rm -f "$f"
  done
}

main "$@"

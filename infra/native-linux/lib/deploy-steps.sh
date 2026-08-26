# SupremeOS native-linux — deployment steps shared between install.sh (first bring-up) and
# update.sh (pull latest code, rebuild, restart). Kept in one file so the two scripts can
# never silently diverge on HOW the workspace is synced/built/verified — only WHEN each is
# called differs between them.
#
# Requires lib/common.sh already sourced (SCRIPT_DIR, SUPREME_REPO_DIR, SUPREME_USER, log_*,
# die) — not sourced from here to keep the source order explicit at each call site.

load_secrets() {
  # Loads the two generated secrets from disk into SUPREME_TOKEN_SECRET/POSTGRES_PASSWORD.
  # Dies rather than silently generating new ones on the render path (install.sh's
  # collect_answers is the ONLY place allowed to mint a fresh secret) — a missing secrets
  # file here means "install.sh has never completed successfully," which the caller needs
  # to know, not paper over with a brand-new password Postgres was never told about.
  [ -r "${SUPREME_SECRETS_DIR}/token-secret" ] || die "No token secret at ${SUPREME_SECRETS_DIR}/token-secret — run install.sh first."
  [ -r "${SUPREME_SECRETS_DIR}/postgres-password" ] || die "No DB password at ${SUPREME_SECRETS_DIR}/postgres-password — run install.sh first."
  SUPREME_TOKEN_SECRET="$(cat "${SUPREME_SECRETS_DIR}/token-secret")"
  POSTGRES_PASSWORD="$(cat "${SUPREME_SECRETS_DIR}/postgres-password")"
}

load_answers() {
  local answers_file="${SUPREME_CONFIG_DIR}/install.conf"
  [ -r "$answers_file" ] || die "No ${answers_file} found — run install.sh first."
  # shellcheck source=/dev/null
  source "$answers_file"
  load_secrets
}

sync_repo() {
  log_step "Syncing the SupremeOS source tree into ${SUPREME_REPO_DIR}"
  local src
  src="$(cd "${SCRIPT_DIR}/../.." && pwd)"
  if [ "$src" = "$SUPREME_REPO_DIR" ]; then
    log_info "Already running from ${SUPREME_REPO_DIR} — nothing to sync."
  else
    rsync -a --delete \
      --exclude 'node_modules' --exclude '.git' --exclude 'dist' --exclude '.turbo' \
      --exclude '*.tsbuildinfo' \
      "${src}/" "${SUPREME_REPO_DIR}/"
    log_info "Synced from ${src} to ${SUPREME_REPO_DIR}."
  fi
  ln -sfn "$SUPREME_REPO_DIR" "$SUPREME_RELEASE_DIR"
  chown -R "${SUPREME_USER}:${SUPREME_GROUP}" "$SUPREME_REPO_DIR"
}

build_workspace() {
  log_step "Building the complete SupremeOS workspace"
  cd "$SUPREME_REPO_DIR"
  run_as_supreme pnpm install --frozen-lockfile
  run_as_supreme pnpm turbo run build
  log_info "Workspace build complete."
}

verify_workspace() {
  if [ "${SUPREME_SKIP_TESTS:-0}" = "1" ]; then
    log_warn "SUPREME_SKIP_TESTS=1 — skipping typecheck/test verification. Not recommended."
    return
  fi
  log_step "Verifying the workspace (typecheck + test) — same suite as CI/main"
  cd "$SUPREME_REPO_DIR"
  run_as_supreme pnpm turbo run typecheck test \
    || die "Workspace verification failed — see the failing task's own output above. Refusing to deploy an unverified build. Re-run with SUPREME_SKIP_TESTS=1 only if you have already verified this build elsewhere."
  log_info "typecheck + test: all green."
}

render_template() {
  # $1=template path, $2=output path. Every ___PLACEHOLDER___ token is replaced from this
  # function's own environment — the templates and this substitution list are meant to be
  # read side by side (grep '___' on a template to see exactly what it needs).
  local tmpl="$1" out="$2"
  sed \
    -e "s|___SUPREME_APP_DIR___|${SUPREME_APP_DIR}|g" \
    -e "s|___SUPREME_CONFIG_DIR___|${SUPREME_CONFIG_DIR}|g" \
    -e "s|___SUPREME_SECRETS_DIR___|${SUPREME_SECRETS_DIR}|g" \
    -e "s|___SUPREME_DATA_DIR___|${SUPREME_DATA_DIR}|g" \
    -e "s|___SUPREME_USER___|${SUPREME_USER}|g" \
    -e "s|___SUPREME_GROUP___|${SUPREME_GROUP}|g" \
    -e "s|___SUPREME_DOMAIN___|${SUPREME_DOMAIN}|g" \
    -e "s|___SUPREME_BACKEND___|${SUPREME_BACKEND}|g" \
    -e "s|___SUPREME_SYSTEM_NAME___|${SUPREME_SYSTEM_NAME}|g" \
    -e "s|___SUPREME_UNSPLASH_KEY___|${SUPREME_UNSPLASH_KEY}|g" \
    -e "s|___SUPREME_TZ___|${SUPREME_TZ}|g" \
    -e "s|___SUPREME_SETUP_WIZARD___|${SUPREME_SETUP_WIZARD}|g" \
    -e "s|___SUPREME_TOKEN_SECRET___|${SUPREME_TOKEN_SECRET}|g" \
    -e "s|___POSTGRES_PASSWORD___|${POSTGRES_PASSWORD}|g" \
    -e "s|___SUPREME_HUB_VERSION___|${SUPREME_HUB_VERSION}|g" \
    -e "s|___SUPREME_LOG_LEVEL___|${SUPREME_LOG_LEVEL}|g" \
    "$tmpl" > "$out"
}

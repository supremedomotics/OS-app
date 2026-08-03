#!/usr/bin/env bash
# SupremeOS native-linux installer.
#
# § Production Architecture Direction (ADR 0022) — turns a clean Ubuntu 24.04 LTS machine
# into a fully operational SupremeOS controller, running every production component as a
# native systemd service instead of a Docker container. This is a PARALLEL deployment
# architecture: infra/hub-compose/ (Docker) is not modified, still fully supported for
# development and CI, and this script never touches it.
#
# Usage:
#   sudo ./install.sh                                   install from this script's own tree
#   sudo ./install.sh --offline /path/to/release.tar.zst install fully offline from a local
#                                                         release package (USB drive, copied
#                                                         file — no network access required
#                                                         for the package itself; apt/Node/
#                                                         NATS/Caddy installation is skipped
#                                                         entirely on an official appliance
#                                                         image, see is_official_appliance_image)
#
# Every install-time answer can be supplied non-interactively via environment variables
# (see the "Answers" section below); anything left unset is prompted for on a real TTY, or
# falls back to the same documented default infra/hub-compose/.env.example uses when running
# non-interactively (CI, `curl | bash`-style automation).
#
# Idempotent: safe to re-run. Re-running reuses secrets/config already written to
# /etc/supremeos and only starts/restarts what changed — it does not regenerate secrets or
# recreate the database on a second run (see update.sh for the "pull latest code, rebuild,
# restart" workflow this script's initial run sets up). Interrupted mid-run? Just re-run —
# every completed phase is checkpointed and skipped (see lib/common.sh's run_phase).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/deploy-steps.sh
source "${SCRIPT_DIR}/lib/deploy-steps.sh"

# § Offline installation: `--offline <package>` points directly at a local release tarball
# (USB drive, scp'd file) — no download, no network dependency for the package itself. The
# tarball is extracted once, here, before mode detection runs against the extracted tree.
SUPREME_OFFLINE=0
OFFLINE_PACKAGE=""
if [ "${1:-}" = "--offline" ]; then
  SUPREME_OFFLINE=1
  OFFLINE_PACKAGE="${2:?Usage: install.sh --offline <path-to-release-package.tar.zst>}"
  [ -r "$OFFLINE_PACKAGE" ] || { echo "ERROR: cannot read ${OFFLINE_PACKAGE}" >&2; exit 1; }
fi

# Pinned, checksum-verified releases (§ supply-chain integrity — never an unauthenticated
# `curl | bash`, every third-party binary here is fetched from its vendor's own GitHub
# release and checked against a hash independently confirmed against that same release's
# own published checksum manifest before this script was written).
NATS_VERSION="2.10.24"
NATS_DEB_SHA256="1978312aff8d667796cdac9f1edba2bd78676e596181963934780ac34ace8486"
CADDY_VERSION="2.8.4"
CADDY_DEB_SHA512="b2f101291ef1a9359717a6349b90ac44d43e3087b87f975f3d4eb5eb22d6bd8af0b1a3a85d7aa9a9b8ba2ad0fbc2ad165c8631c57e0dbf4ca3df986ee728e205"

# ── Answers ─────────────────────────────────────────────────────────────────────────────
# Every field .env.example documents, plus the two purely-deployment questions Docker never
# had to ask (domain, whether to install Home Assistant at all). Persisted to
# /etc/supremeos/install.conf on first run so update.sh/backup.sh/health-check.sh don't
# need to re-derive or re-ask any of this.
ANSWERS_FILE="${SUPREME_CONFIG_DIR}/install.conf"

prompt_default() {
  # $1=varname $2=prompt $3=default. Only prompts on a real TTY; otherwise silently takes
  # the default, so this script works identically run by hand or piped into a provisioning
  # tool. Never prompts for a value already set in the environment (re-run safe).
  local varname="$1" prompt="$2" default="$3" current
  current="${!varname:-}"
  if [ -n "$current" ]; then return; fi
  if [ -t 0 ] && [ "${SUPREME_UNATTENDED:-0}" != "1" ]; then
    read -r -p "${prompt} [${default}]: " current || true
  fi
  printf -v "$varname" '%s' "${current:-$default}"
}

prompt_yesno() {
  local varname="$1" prompt="$2" default="$3" current
  current="${!varname:-}"
  if [ -n "$current" ]; then return; fi
  if [ -t 0 ] && [ "${SUPREME_UNATTENDED:-0}" != "1" ]; then
    read -r -p "${prompt} [y/N default ${default}]: " current || true
    case "${current,,}" in y|yes) current=1 ;; n|no) current=0 ;; *) current="$default" ;; esac
  else
    current="$default"
  fi
  printf -v "$varname" '%s' "$current"
}

# § ADR-0023 Provider architecture: the only backends this installer may ever produce.
# "mock" is valid input (unattended/CI installs may set it explicitly) but is never a
# prompted default and never the production default — see collect_answers below.
SUPREME_VALID_BACKENDS=(native ha mock)

is_valid_backend() {
  local candidate="$1" valid
  for valid in "${SUPREME_VALID_BACKENDS[@]}"; do
    [ "$candidate" = "$valid" ] && return 0
  done
  return 1
}

# § requirement: validate hostname/domain/timezone/passwords/backend BEFORE installation
# begins — fail early with a clear error rather than discovering a bad value mid-install
# (e.g. apt/npm already partially run). Backend itself is validated inline in
# collect_answers (it's derived, not free text); this covers the remaining free-text answers.
validate_answers() {
  [ -n "${SUPREME_SYSTEM_NAME// }" ] || die "System name must not be empty."

  if [ "$SUPREME_DOMAIN" != "localhost" ] \
    && ! [[ "$SUPREME_DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]]; then
    die "Invalid domain '${SUPREME_DOMAIN}' — use 'localhost' or a real DNS domain (e.g. home.example.com)."
  fi

  if [ -d /usr/share/zoneinfo ] && [ ! -e "/usr/share/zoneinfo/${SUPREME_TZ}" ]; then
    die "Invalid timezone '${SUPREME_TZ}' — must match a /usr/share/zoneinfo entry (e.g. America/New_York, UTC). See: timedatectl list-timezones"
  fi

  if [ "$SUPREME_INSTALL_HA" = "1" ]; then
    [ -n "${SUPREME_HA_ADMIN_USER// }" ] || die "Home Assistant admin username must not be empty."
    [ "${#SUPREME_HA_ADMIN_PASSWORD}" -ge 8 ] || die "Home Assistant admin password must be at least 8 characters."
  fi

  log_info "Answers validated: backend=${SUPREME_BACKEND}, domain=${SUPREME_DOMAIN}, tz=${SUPREME_TZ}, install_ha=${SUPREME_INSTALL_HA}."
}

collect_answers() {
  log_step "Collecting installation answers"
  if [ -r "$ANSWERS_FILE" ]; then
    log_info "Existing ${ANSWERS_FILE} found — reusing prior answers (re-run/upgrade)."
    # shellcheck source=/dev/null
    source "$ANSWERS_FILE"
  fi

  prompt_default SUPREME_SYSTEM_NAME "System name" "Supreme Residence"
  prompt_default SUPREME_DOMAIN "Domain (leave 'localhost' for LAN-only, self-signed access)" "localhost"
  prompt_default SUPREME_TZ "Timezone" "$(cat /etc/timezone 2>/dev/null || echo UTC)"

  # § ADR-0023 Provider architecture: Home Assistant is an OPTIONAL provider, never a
  # required backend — this is the ONLY Home Assistant question on the "No" path.
  # Answering "No" here must skip every HA-specific prompt entirely (username, password,
  # a separate backend question) and silently configure the native-first production
  # default. There is no standalone "Backend [mock]" prompt in the normal flow anymore.
  prompt_yesno SUPREME_INSTALL_HA "Install headless Home Assistant Core?" 1

  # Auto-derive the backend from the HA answer — never a standalone question. An
  # already-set SUPREME_BACKEND (explicit environment override, e.g. an unattended/CI
  # install that wants "mock") is respected rather than silently overwritten, but is
  # validated below exactly like the derived value is.
  if [ -z "${SUPREME_BACKEND:-}" ]; then
    if [ "$SUPREME_INSTALL_HA" = "1" ]; then
      SUPREME_BACKEND="ha"
    else
      SUPREME_BACKEND="native"
    fi
  fi

  if [ "$SUPREME_INSTALL_HA" = "1" ]; then
    prompt_default SUPREME_HA_ADMIN_USER "Home Assistant admin username" "admin"
    prompt_default SUPREME_HA_ADMIN_PASSWORD "Home Assistant admin password" "$(generate_secret)"
  else
    SUPREME_HA_ADMIN_USER=""
    SUPREME_HA_ADMIN_PASSWORD=""
  fi

  # Never silently continue with an invalid backend, whether it came from the
  # derivation above, an environment override, or a hand-edited ANSWERS_FILE
  # (§ requirement: reject invalid input, fail early with a clear error).
  if ! is_valid_backend "$SUPREME_BACKEND"; then
    die "Invalid SUPREME_BACKEND '${SUPREME_BACKEND}' — must be one of: ${SUPREME_VALID_BACKENDS[*]}. Fix the environment variable or ${ANSWERS_FILE} and re-run."
  fi

  prompt_default SUPREME_SETUP_WIZARD "Show the Setup Wizard on first boot (1) or seed a demo owner (0)" "1"
  prompt_default SUPREME_LOG_LEVEL "Log level" "info"
  prompt_default SUPREME_HUB_VERSION "Hub version string" "0.4.0"
  SUPREME_HA_TOKEN="${SUPREME_HA_TOKEN:-}"
  SUPREME_UNSPLASH_KEY="${SUPREME_UNSPLASH_KEY:-}"

  # Secrets: generated once, never prompted for, never logged. update.sh's config re-render
  # reuses these exact values via lib/deploy-steps.sh's load_secrets() — this is the only
  # place allowed to mint a NEW one, when neither file exists yet.
  if [ -r "${SUPREME_SECRETS_DIR}/token-secret" ] && [ -r "${SUPREME_SECRETS_DIR}/postgres-password" ]; then
    load_secrets
  else
    SUPREME_TOKEN_SECRET="$(generate_secret)"
    POSTGRES_PASSWORD="$(generate_secret)"
  fi

  validate_answers

  mkdir -p "$SUPREME_CONFIG_DIR"
  cat > "$ANSWERS_FILE" <<EOF
# SupremeOS native-linux — persisted install answers. Regenerated by install.sh; hand-edit
# only the non-secret fields above SUPREME_TOKEN_SECRET, then re-run install.sh or update.sh.
SUPREME_SYSTEM_NAME="${SUPREME_SYSTEM_NAME}"
SUPREME_DOMAIN="${SUPREME_DOMAIN}"
SUPREME_TZ="${SUPREME_TZ}"
SUPREME_INSTALL_HA="${SUPREME_INSTALL_HA}"
SUPREME_BACKEND="${SUPREME_BACKEND}"
SUPREME_HA_ADMIN_USER="${SUPREME_HA_ADMIN_USER}"
SUPREME_HA_ADMIN_PASSWORD="${SUPREME_HA_ADMIN_PASSWORD}"
SUPREME_HA_TOKEN="${SUPREME_HA_TOKEN}"
SUPREME_SETUP_WIZARD="${SUPREME_SETUP_WIZARD}"
SUPREME_LOG_LEVEL="${SUPREME_LOG_LEVEL}"
SUPREME_HUB_VERSION="${SUPREME_HUB_VERSION}"
SUPREME_UNSPLASH_KEY="${SUPREME_UNSPLASH_KEY}"
EOF
  chmod 0640 "$ANSWERS_FILE"
}

# ── Steps ───────────────────────────────────────────────────────────────────────────────

create_system_user() {
  log_step "Creating the ${SUPREME_USER} system account"
  if ! getent group "$SUPREME_GROUP" >/dev/null; then
    groupadd --system "$SUPREME_GROUP"
  fi
  if ! id "$SUPREME_USER" >/dev/null 2>&1; then
    useradd --system --gid "$SUPREME_GROUP" --home-dir "$SUPREME_APP_DIR" \
      --no-create-home --shell /usr/sbin/nologin "$SUPREME_USER"
    log_info "Created system user '${SUPREME_USER}' (no login shell, no password)."
  else
    log_info "System user '${SUPREME_USER}' already exists — reusing."
  fi
}

create_directories() {
  log_step "Creating directory layout"
  mkdir -p "$SUPREME_APP_DIR" "$SUPREME_REPO_DIR" "$SUPREME_CONFIG_DIR" "$SUPREME_SECRETS_DIR" \
    "$SUPREME_DATA_DIR"/{nats,matter,homeassistant,appletv} "$SUPREME_BACKUP_DIR" \
    "${SUPREME_APP_DIR}/venvs"
  chown -R "${SUPREME_USER}:${SUPREME_GROUP}" "$SUPREME_APP_DIR" "$SUPREME_DATA_DIR" "$SUPREME_BACKUP_DIR"
  chmod 0750 "$SUPREME_APP_DIR" "$SUPREME_DATA_DIR" "$SUPREME_BACKUP_DIR"
  chmod 0700 "$SUPREME_SECRETS_DIR"
  chown "root:${SUPREME_GROUP}" "$SUPREME_SECRETS_DIR"
}

persist_secrets() {
  # Written once ANY time collect_answers generated a fresh value; re-writing an identical
  # value on every run is harmless and keeps this idempotent without extra bookkeeping.
  umask 077
  echo -n "$SUPREME_TOKEN_SECRET" > "${SUPREME_SECRETS_DIR}/token-secret"
  echo -n "$POSTGRES_PASSWORD" > "${SUPREME_SECRETS_DIR}/postgres-password"
  chown "root:${SUPREME_GROUP}" "${SUPREME_SECRETS_DIR}"/*
  chmod 0640 "${SUPREME_SECRETS_DIR}"/*
}

install_apt_dependencies() {
  log_step "Installing OS package dependencies"
  export DEBIAN_FRONTEND=noninteractive
  # § Offline installation: `apt-get update` needs a reachable archive — offline installs
  # rely on the operator having pre-seeded a local apt cache/mirror (a standard offline-apt
  # prerequisite this script cannot fabricate); skipping the refresh uses whatever package
  # index is already on disk.
  if [ "$SUPREME_OFFLINE" != "1" ]; then
    apt-get update -qq
  else
    log_warn "SUPREME_OFFLINE=1 — skipping 'apt-get update'. Requires a pre-seeded local apt cache/mirror with every package below already available."
  fi
  apt-get install -y -qq \
    curl ca-certificates gnupg lsb-release git rsync jq build-essential pkg-config \
    postgresql postgresql-contrib \
    redis-server \
    mosquitto mosquitto-clients \
    python3 python3-venv python3-pip python3-dev \
    libffi-dev libssl-dev
  log_info "Base OS packages installed."
}

install_node() {
  log_step "Installing Node.js ${SUPREME_NODE_MAJOR}.x"
  if command_exists node && [ "$(node -p 'process.versions.node.split(".")[0]')" = "$SUPREME_NODE_MAJOR" ]; then
    log_info "Node.js $(node -v) already installed — skipping."
  elif [ "$SUPREME_OFFLINE" = "1" ]; then
    die "SUPREME_OFFLINE=1 but Node.js ${SUPREME_NODE_MAJOR}.x is not already installed — the NodeSource setup script requires network access. Pre-install Node.js ${SUPREME_NODE_MAJOR}.x (or use an official SupremeOS appliance image, which ships it already) before an offline install."
  else
    curl -fsSL "https://deb.nodesource.com/setup_${SUPREME_NODE_MAJOR}.x" | bash -
    apt-get install -y -qq nodejs
  fi
  corepack enable
  # Pin the exact pnpm version this repo's own package.json declares under
  # `packageManager`, when present, so native and Docker deployments resolve dependencies
  # identically — never a silently different pnpm resolving the same lockfile differently.
  local pinned
  pinned="$(node -p "require('${SUPREME_REPO_DIR}/package.json').packageManager || ''" 2>/dev/null || true)"
  if [ -n "$pinned" ]; then
    corepack prepare "$pinned" --activate
  fi
  log_info "node $(node -v), pnpm $(pnpm -v 2>/dev/null || echo 'via corepack')"
}

install_nats() {
  log_step "Installing NATS JetStream ${NATS_VERSION}"
  if command_exists nats-server && nats-server --version 2>/dev/null | grep -q "$NATS_VERSION"; then
    log_info "nats-server ${NATS_VERSION} already installed — skipping."
    return
  fi
  local tmp deb_path
  tmp="$(mktemp -d)"
  if [ "$SUPREME_OFFLINE" = "1" ]; then
    deb_path="${SUPREME_NATS_DEB_PATH:?SUPREME_OFFLINE=1 requires SUPREME_NATS_DEB_PATH pointing at a local nats-server-v${NATS_VERSION}-amd64.deb (no network download in offline mode)}"
    [ -r "$deb_path" ] || die "SUPREME_NATS_DEB_PATH=${deb_path} is not readable."
    cp "$deb_path" "${tmp}/nats-server.deb"
  else
    curl -fsSL "https://github.com/nats-io/nats-server/releases/download/v${NATS_VERSION}/nats-server-v${NATS_VERSION}-amd64.deb" -o "${tmp}/nats-server.deb"
  fi
  echo "${NATS_DEB_SHA256}  ${tmp}/nats-server.deb" | sha256sum -c - \
    || die "nats-server .deb checksum mismatch — refusing to install a package that doesn't match the pinned, verified hash."
  dpkg -i "${tmp}/nats-server.deb"
  rm -rf "$tmp"
  log_info "nats-server $(nats-server --version) installed and checksum-verified."
}

install_caddy() {
  log_step "Installing Caddy ${CADDY_VERSION}"
  if command_exists caddy && caddy version 2>/dev/null | grep -q "v${CADDY_VERSION}"; then
    log_info "caddy ${CADDY_VERSION} already installed — skipping."
    return
  fi
  local tmp deb_path
  tmp="$(mktemp -d)"
  if [ "$SUPREME_OFFLINE" = "1" ]; then
    deb_path="${SUPREME_CADDY_DEB_PATH:?SUPREME_OFFLINE=1 requires SUPREME_CADDY_DEB_PATH pointing at a local caddy_${CADDY_VERSION}_linux_amd64.deb (no network download in offline mode)}"
    [ -r "$deb_path" ] || die "SUPREME_CADDY_DEB_PATH=${deb_path} is not readable."
    cp "$deb_path" "${tmp}/caddy.deb"
  else
    curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_amd64.deb" -o "${tmp}/caddy.deb"
  fi
  echo "${CADDY_DEB_SHA512}  ${tmp}/caddy.deb" | sha512sum -c - \
    || die "caddy .deb checksum mismatch — refusing to install a package that doesn't match the pinned, verified hash."
  dpkg -i "${tmp}/caddy.deb"
  rm -rf "$tmp"
  log_info "caddy $(caddy version) installed and checksum-verified (ships its own caddy.service unit)."
}

install_commissioning_venv() {
  log_step "Installing the commissioning service's Python environment"
  local venv="${SUPREME_APP_DIR}/venvs/commissioning"
  sudo -u "$SUPREME_USER" python3 -m venv "$venv"
  sudo -u "$SUPREME_USER" "${venv}/bin/pip" install --quiet --upgrade pip
  # Exactly the three packages services/commissioning-py/Dockerfile installs — no more.
  sudo -u "$SUPREME_USER" "${venv}/bin/pip" install --quiet fastapi "uvicorn[standard]" pydantic
  log_info "Commissioning venv ready at ${venv}."
}

install_homeassistant_venv() {
  if [ "${SUPREME_INSTALL_HA}" != "1" ]; then
    log_info "Home Assistant install skipped (SUPREME_INSTALL_HA=0 / SUPREME_BACKEND=${SUPREME_BACKEND})."
    return
  fi
  log_step "Installing Home Assistant Core (this can take several minutes — large dependency tree)"
  local venv="${SUPREME_APP_DIR}/venvs/homeassistant"
  local ha_config="${SUPREME_DATA_DIR}/homeassistant"
  sudo -u "$SUPREME_USER" python3 -m venv "$venv"
  sudo -u "$SUPREME_USER" "${venv}/bin/pip" install --quiet --upgrade pip wheel
  sudo -u "$SUPREME_USER" "${venv}/bin/pip" install --quiet homeassistant
  mkdir -p "$ha_config"
  chown "${SUPREME_USER}:${SUPREME_GROUP}" "$ha_config"
  # Seed configuration.yaml BEFORE first start so it never briefly listens on all
  # interfaces waiting for a human to edit the default file — matches the Docker
  # deployment's hard requirement that HA is never reachable off-box.
  if [ ! -f "${ha_config}/configuration.yaml" ]; then
    cat > "${ha_config}/configuration.yaml" <<'EOF'
# SupremeOS-managed. Headless, SIL-internal only — see supreme-homeassistant.service.
default_config:
http:
  server_host: 127.0.0.1
EOF
    chown "${SUPREME_USER}:${SUPREME_GROUP}" "${ha_config}/configuration.yaml"
  fi
  log_info "Home Assistant Core venv ready at ${venv}. Config: ${ha_config}."
}

configure_postgres() {
  log_step "Configuring PostgreSQL"
  systemctl_enable_now postgresql

  # Actively confirm Postgres is reachable BEFORE touching it — `systemctl enable --now`
  # reporting success does not guarantee the server has finished starting yet, and every
  # SQL call below silently produces nothing useful against a server that isn't up (the
  # exact failure mode this loop exists to catch instead of masking).
  local attempt
  for attempt in $(seq 1 30); do
    : "$attempt"
    sudo -u postgres pg_isready >/dev/null 2>&1 && break
    sleep 1
  done
  sudo -u postgres pg_isready >/dev/null 2>&1 || die "PostgreSQL is not accepting connections after 30s — see: journalctl -u postgresql -n 50"

  # Idempotent role/db creation — CREATE ROLE/DATABASE have no IF NOT EXISTS in Postgres,
  # so check first rather than swallow the "already exists" error (which would also hide
  # a REAL failure, e.g. wrong socket path, on a re-run). Every mutating statement is
  # checked explicitly — none of this is allowed to fail silently into a false "ready".
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='supreme'" | grep -q 1; then
    sudo -u postgres psql -c "CREATE ROLE supreme WITH LOGIN PASSWORD '${POSTGRES_PASSWORD}';" || die "Failed to create the 'supreme' Postgres role."
  else
    sudo -u postgres psql -c "ALTER ROLE supreme WITH PASSWORD '${POSTGRES_PASSWORD}';" || die "Failed to update the 'supreme' Postgres role's password."
  fi
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='supreme'" | grep -q 1; then
    sudo -u postgres psql -c "CREATE DATABASE supreme OWNER supreme;" || die "Failed to create the 'supreme' database."
  fi

  # The one check that actually matters: can the Gateway's own DATABASE_URL log in?
  PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U supreme -d supreme -c "SELECT 1;" >/dev/null 2>&1 \
    || die "Created role/database, but a login as 'supreme' over TCP (127.0.0.1:5432) still fails — check pg_hba.conf allows password auth from localhost."
  log_info "Database 'supreme' ready and reachable (schema migrations apply automatically when the gateway starts)."
}

configure_redis() {
  log_step "Configuring Redis"
  # Matches the Docker deployment's `redis-server --save "" --appendonly no` — no
  # persistence, since Redis here holds only ephemeral presence/session data, never
  # data that would need to survive a restart uninterrupted.
  sed -i \
    -e 's/^save .*/save ""/' \
    -e 's/^appendonly .*/appendonly no/' \
    -e 's/^bind .*/bind 127.0.0.1 -::1/' \
    /etc/redis/redis.conf
  grep -q '^save ""' /etc/redis/redis.conf || echo 'save ""' >> /etc/redis/redis.conf
  grep -q '^appendonly no' /etc/redis/redis.conf || echo 'appendonly no' >> /etc/redis/redis.conf
  systemctl_enable_now redis-server
}

configure_mosquitto() {
  log_step "Configuring Mosquitto"
  render_template "${SCRIPT_DIR}/config/mosquitto-supremeos.conf.template" /etc/mosquitto/conf.d/supremeos.conf
  systemctl_enable_now mosquitto
  if systemd_is_live; then systemctl restart mosquitto; fi
}

configure_nats() {
  log_step "Configuring supreme-nats"
  render_template "${SCRIPT_DIR}/config/nats.conf.template" "${SUPREME_CONFIG_DIR}/nats.conf"
  render_template "${SCRIPT_DIR}/systemd/supreme-nats.service" /etc/systemd/system/supreme-nats.service
  if systemd_is_live; then systemctl daemon-reload; fi
  systemctl_enable_now supreme-nats
}

configure_caddy() {
  log_step "Configuring Caddy edge proxy"
  render_template "${SCRIPT_DIR}/config/Caddyfile.template" /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile || die "Generated Caddyfile failed validation — see caddy's own error above."
  systemctl_enable_now caddy
  if systemd_is_live; then systemctl reload caddy 2>/dev/null || systemctl restart caddy; fi
}

configure_gateway_env() {
  log_step "Rendering Gateway environment"
  render_template "${SCRIPT_DIR}/config/gateway.env.template" "${SUPREME_CONFIG_DIR}/gateway.env"
  chown "root:${SUPREME_GROUP}" "${SUPREME_CONFIG_DIR}/gateway.env"
  chmod 0640 "${SUPREME_CONFIG_DIR}/gateway.env"
}

install_systemd_units() {
  log_step "Installing systemd units"
  render_template "${SCRIPT_DIR}/systemd/supreme-gateway.service" /etc/systemd/system/supreme-gateway.service
  render_template "${SCRIPT_DIR}/systemd/supreme-commissioning.service" /etc/systemd/system/supreme-commissioning.service
  # supreme-lan: install the repo's OWN, pre-existing native unit unmodified (§ requirement
  # — do not create a parallel/competing definition for a service that already has a
  # documented native-linux deployment target). Only the placeholder substitution (none
  # today — that file hardcodes /opt/supreme already) would ever apply here.
  cp "${SUPREME_REPO_DIR}/infra/systemd/supreme-lan.service" /etc/systemd/system/supreme-lan.service
  if [ "${SUPREME_INSTALL_HA}" = "1" ]; then
    render_template "${SCRIPT_DIR}/systemd/supreme-homeassistant.service" /etc/systemd/system/supreme-homeassistant.service
  fi
  if systemd_is_live; then systemctl daemon-reload; fi
}

# § requirement 8: `supremeos-support` becomes a real, system-wide command — a thin
# wrapper so `sudo supremeos-support` works from anywhere, not just `sudo ./supremeos-
# support.sh` from this directory. Symlinked (not copied) so it always runs the version
# shipped with whatever release is currently active.
install_cli_commands() {
  log_step "Installing CLI commands (supremeos-support)"
  ln -sfn "${SUPREME_RELEASE_DIR}/infra/native-linux/supremeos-support.sh" /usr/local/bin/supremeos-support
  chmod +x "${SUPREME_RELEASE_DIR}/infra/native-linux/supremeos-support.sh" 2>/dev/null || true
  log_info "Installed: supremeos-support (run 'sudo supremeos-support' any time)."
}

start_services() {
  log_step "Enabling and starting SupremeOS services"
  systemctl_enable_now supreme-commissioning
  systemctl_enable_now supreme-lan
  if [ "${SUPREME_INSTALL_HA}" = "1" ]; then
    systemctl_enable_now supreme-homeassistant
  fi
  systemctl_enable_now supreme-gateway
}

wait_for_health() {
  log_step "Waiting for the Gateway to report healthy"
  if ! systemd_is_live; then
    log_warn "systemd is not running as PID 1 in this environment — cannot observe real service state here. This step is meaningful only on the actual target machine; see docs/architecture/Native-Linux-Deployment.md's verification-scope section."
    return
  fi
  local attempt
  for attempt in $(seq 1 60); do
    : "$attempt" # counter only
    if curl -fsS -k "https://127.0.0.1/healthz" >/dev/null 2>&1 || curl -fsS "http://127.0.0.1:8080/healthz" >/dev/null 2>&1; then
      log_info "Gateway is healthy."
      return
    fi
    sleep 2
  done
  log_warn "Gateway did not report healthy within 120s. Check: sudo ./health-check.sh and sudo ./logs.sh supreme-gateway"
}

print_summary() {
  log_step "SupremeOS native-linux installation complete"
  local os_pretty="Ubuntu 24.04 LTS"
  if [ -r /etc/os-release ]; then
    # shellcheck source=/dev/null
    os_pretty="$(. /etc/os-release && echo "${PRETTY_NAME:-Ubuntu 24.04 LTS}")"
  fi
  local backend_display="Native"
  [ "$SUPREME_BACKEND" = "ha" ] && backend_display="Native + Home Assistant"
  [ "$SUPREME_BACKEND" = "mock" ] && backend_display="Mock (test/CI only — never use in production)"
  local mode_display="Development (source checkout, full test suite verified)"
  [ "$SUPREME_INSTALL_MODE" = "release" ] && mode_display="Production (release ${SUPREME_RELEASE_VERSION:-unknown}, runtime-verified)"
  cat <<EOF

  SupremeOS Native Installation

  Target OS:          ${os_pretty}
  Install mode:        ${mode_display}
  Backend:             ${backend_display}
  Deployment:          Systemd
  Container Runtime:   Not Used

  System name:    ${SUPREME_SYSTEM_NAME}
  Access:         https://${SUPREME_DOMAIN}/   (installer portal: https://${SUPREME_DOMAIN}/installer/)
  Config:         ${SUPREME_CONFIG_DIR}
  Secrets:        ${SUPREME_SECRETS_DIR}  (mode 0700 — back these up, see backup.sh)
  Data:           ${SUPREME_DATA_DIR}
  App:            ${SUPREME_APP_DIR}  (current -> $(readlink -f "$SUPREME_RELEASE_DIR" 2>/dev/null || echo "$SUPREME_REPO_DIR"))

  Next steps:
    - ./health-check.sh          confirm every service is healthy
    - ./logs.sh <service>        tail a service's journal
    - Visit https://${SUPREME_DOMAIN}/ to run the Setup Wizard (if enabled).

EOF
}

run_verify_runtime() {
  log_step "Verifying runtime (production mode) — staged, ordered startup verification"
  if run_staged_verification "${SUPREME_RELEASE_MIGRATION_COUNT:-}" "${SUPREME_RELEASE_REQUIRED_DISK_MB:-0}" "${SUPREME_RELEASE_REQUIRED_RAM_MB:-0}" "${SUPREME_RELEASE_REQUIRED_CPU_ARCH:-}"; then
    log_info "Runtime verification: all stages passed."
    release_state_record_health "healthy"
  else
    release_state_record_health "unhealthy"
    die "Runtime verification FAILED at the stage shown above (${RUNTIME_CHECK_FAILED} check(s)) — later stages did not run. Run ./health-check.sh for a full re-check once fixed; this install phase will be re-run (not skipped) next time."
  fi
}

main() {
  require_root

  # § Offline installation: extract the supplied package BEFORE any other detection, then
  # treat its contents exactly like a normal release tree from here on — no code path
  # downstream needs to know whether the bytes came from the network or a USB drive.
  local src_root
  if [ "$SUPREME_OFFLINE" = "1" ]; then
    log_step "Offline install from ${OFFLINE_PACKAGE}"
    src_root="$(extract_release_tarball "$OFFLINE_PACKAGE")"
    SUPREME_RELEASE_TARBALL="$OFFLINE_PACKAGE"
    SUPREME_INSTALL_MODE="release"
  else
    src_root="$(cd "${SCRIPT_DIR}/../.." && pwd)"
  fi

  # § Future SupremeOS image: an official appliance image has Node/pnpm/NATS/Caddy already
  # provisioned at image-build time (SUPREME_IMAGE_MARKER present) — skip OS/toolchain
  # installation entirely and jump straight to configure+migrate+start+verify, per
  # requirement 9. A dev/CI-installed Ubuntu box (no marker) gets the full install.
  local on_appliance_image=0
  is_official_appliance_image && on_appliance_image=1

  if [ "$on_appliance_image" = "1" ]; then
    log_info "Official SupremeOS appliance image detected ($(appliance_image_info | tr '\n' ' ')) — skipping package/dependency/toolchain installation."
  else
    require_ubuntu_24_04
  fi

  # § CI/Production verification split: everything downstream branches on this. A git
  # checkout (SUPREME_INSTALL_MODE=source) keeps the full developer build+typecheck+test
  # suite; a signed release artifact (=release) never recompiles or re-tests — see
  # docs/architecture/Native-Linux-Deployment.md's "Deployment modes" section.
  detect_install_mode "$src_root"
  if [ "$on_appliance_image" = "1" ] && [ "$SUPREME_INSTALL_MODE" != "release" ]; then
    die "Running on an official SupremeOS appliance image but ${src_root} is not a release artifact — an appliance image must always install from a signed release, never a source checkout."
  fi

  # Structured logs (§ requirement): every run appends to its own timestamped log AND to
  # stdout, so an interrupted install leaves a complete record of what actually happened up
  # to the point it stopped — not just whatever scrolled past in a lost SSH session.
  mkdir -p "$SUPREME_LOG_DIR"
  local logfile="${SUPREME_LOG_DIR}/install-$(date -u +%Y%m%dT%H%M%SZ).log"
  exec > >(tee -a "$logfile") 2>&1
  log_info "Logging to ${logfile}. Re-run this script any time — completed phases are skipped (see ${SUPREME_STATE_FILE})."

  run_phase "collect_answers" collect_answers
  run_phase "create_system_user" create_system_user
  run_phase "create_directories" create_directories
  run_phase "persist_secrets" persist_secrets

  if [ "$on_appliance_image" != "1" ]; then
    run_phase "install_apt_dependencies" install_apt_dependencies
    run_phase "install_node" install_node
    run_phase "install_nats" install_nats
    run_phase "install_caddy" install_caddy
  fi

  if [ "$SUPREME_INSTALL_MODE" = "release" ]; then
    run_phase "install_release_artifact" install_release_artifact "$src_root"
  else
    run_phase "sync_repo" sync_repo
    run_phase "build_workspace" build_workspace
    run_phase "verify_workspace" verify_workspace
  fi

  # § Transactional updates: the moment code actually goes live — a snapshot into its own
  # immutable versioned directory, then one atomic symlink switch. Nothing before this
  # point touched a path a running service could be reading.
  run_phase "stage_and_switch_release" stage_and_switch_release

  if [ "$on_appliance_image" != "1" ]; then
    run_phase "install_commissioning_venv" install_commissioning_venv
    run_phase "install_homeassistant_venv" install_homeassistant_venv
  fi
  run_phase "configure_postgres" configure_postgres
  run_phase "configure_redis" configure_redis
  run_phase "configure_mosquitto" configure_mosquitto
  run_phase "configure_nats" configure_nats
  run_phase "configure_gateway_env" configure_gateway_env
  run_phase "configure_caddy" configure_caddy
  run_phase "install_systemd_units" install_systemd_units
  run_phase "install_cli_commands" install_cli_commands
  run_phase "start_services" start_services
  run_phase "wait_for_health" wait_for_health

  # Runtime verification is the production-mode replacement for the developer test suite
  # (§ requirement: "verify release integrity, migration success, ... If all runtime checks
  # pass, deployment succeeds") — always runs, in BOTH modes, since "the Gateway answers
  # /healthz" is never a substitute for "every dependency it needs is actually reachable".
  # A first install has no previous version to roll back to — a failure here means fix and
  # re-run (checkpointing skips everything already done); update.sh's transactional
  # rollback is what handles "this WAS working, an upgrade broke it."
  run_phase "verify_runtime" run_verify_runtime

  run_phase "prune_old_releases" prune_old_releases

  print_summary
}

main "$@"

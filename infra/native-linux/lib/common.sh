#!/usr/bin/env bash
# SupremeOS native-linux deployment — shared shell library.
#
# Sourced by every script in infra/native-linux/ (install.sh, update.sh, uninstall.sh,
# backup.sh, restore.sh, health-check.sh, logs.sh) so the directory layout, service list,
# and logging conventions are defined in exactly ONE place. Changing where SupremeOS lives
# on disk means editing this file, not seven scripts in lockstep.
#
# This file only DEFINES things (variables, functions) — it never runs an action on its
# own, so `source lib/common.sh` is always side-effect-free and safe from any script.

set -uo pipefail

# ── Paths ───────────────────────────────────────────────────────────────────────────────
# Mirrors the directory convention infra/systemd/supreme-lan.service already established
# for the native deployment target (§ Production Architecture Direction, ADR 0022) — this
# is that same convention extended to every other component, not a new one invented here.
SUPREME_APP_DIR="${SUPREME_APP_DIR:-/opt/supreme}"
SUPREME_CONFIG_DIR="${SUPREME_CONFIG_DIR:-/etc/supremeos}"
SUPREME_SECRETS_DIR="${SUPREME_SECRETS_DIR:-/etc/supremeos/secrets}"
SUPREME_DATA_DIR="${SUPREME_DATA_DIR:-/var/lib/supremeos}"
SUPREME_BACKUP_DIR="${SUPREME_BACKUP_DIR:-/var/backups/supremeos}"
SUPREME_RELEASE_DIR="${SUPREME_APP_DIR}/current"
SUPREME_REPO_DIR="${SUPREME_APP_DIR}/repo"
SUPREME_USER="${SUPREME_USER:-supreme}"
SUPREME_GROUP="${SUPREME_GROUP:-supreme}"

# systemd units this deployment owns. `supreme-lan` is intentionally NOT redefined here —
# it installs the repo's own infra/systemd/supreme-lan.service unmodified (§ requirement:
# "do not modify" the existing native-linux precedent for the LAN service).
SUPREME_NODE_SERVICES=(supreme-gateway supreme-lan)
SUPREME_PY_SERVICES=(supreme-commissioning)
# Third-party services this deployment configures but does not author the unit for
# (shipped by their own Ubuntu/vendor packages): postgresql, redis-server, mosquitto, caddy.
SUPREME_THIRDPARTY_SERVICES=(postgresql redis-server mosquitto caddy)

# ── Logging ─────────────────────────────────────────────────────────────────────────────
# Plain, greppable, timestamped — every script's stdout is safe to redirect to a log file
# without losing information (no reliance on TTY color codes surviving a pipe).
_supreme_ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log_info()  { echo "[$(_supreme_ts)] INFO  $*"; }
log_warn()  { echo "[$(_supreme_ts)] WARN  $*" >&2; }
log_error() { echo "[$(_supreme_ts)] ERROR $*" >&2; }
log_step()  { echo ""; echo "[$(_supreme_ts)] === $* ==="; }

die() {
  log_error "$*"
  exit 1
}

# ── Environment checks ──────────────────────────────────────────────────────────────────

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "This script must be run as root (use sudo). Re-run as: sudo $0"
  fi
}

# Confirms Ubuntu 24.04 specifically rather than merely "some Linux" — the package names,
# repo URLs, and systemd unit assumptions below are verified against 24.04's real apt
# repos and are not guaranteed to resolve identically on another release.
require_ubuntu_24_04() {
  if [ ! -r /etc/os-release ]; then
    die "Cannot read /etc/os-release — unable to confirm this is Ubuntu 24.04 LTS."
  fi
  # shellcheck source=/dev/null
  . /etc/os-release
  if [ "${ID:-}" != "ubuntu" ] || [ "${VERSION_ID:-}" != "24.04" ]; then
    log_warn "This installer targets Ubuntu 24.04 LTS specifically. Detected: ${PRETTY_NAME:-unknown}."
    if [ "${SUPREME_FORCE_OS:-0}" != "1" ]; then
      die "Refusing to continue on an unverified OS. Set SUPREME_FORCE_OS=1 to override at your own risk."
    fi
    log_warn "SUPREME_FORCE_OS=1 set — continuing on an unverified OS anyway."
  fi
}

# True (0) only when systemd is genuinely running as PID 1 and reachable over D-Bus — false
# in a container without systemd as init, which install.sh and health-check.sh both need to
# tell apart from "systemd is present but the unit failed to start". Never assumed true;
# every caller checks this before trusting `systemctl is-active` as a real signal.
systemd_is_live() {
  systemctl is-system-running >/dev/null 2>&1
  local rc=$?
  # is-system-running exits non-zero for "degraded"/"starting" too — those still mean a
  # LIVE systemd, just not fully settled. Only "Failed to connect to bus"/no PID 1 means dead.
  [ "$rc" -ne 1 ] || return 1
  return 0
}

command_exists() { command -v "$1" >/dev/null 2>&1; }

# Enables and starts a unit, but ONLY when systemd is genuinely live — never attempts (and
# never dies on) a systemctl call that can't possibly succeed in an environment with no
# real PID 1 (e.g. this repo's own CI/test sandboxes). On a live systemd, failure to
# actually enable/start IS fatal — a silently-not-running service is exactly the kind of
# fabricated success this deployment's own scripts must never produce.
systemctl_enable_now() {
  local unit="$1"
  if ! systemd_is_live; then
    log_warn "systemd is not live in this environment — skipping 'systemctl enable --now ${unit}'. This runs for real on the actual target machine."
    return 0
  fi
  systemctl enable --now "$unit" || die "Failed to enable/start ${unit} — see: journalctl -u ${unit} -n 50"
}

# Same guard for update.sh's restart-an-already-installed-unit case.
systemctl_restart() {
  local unit="$1"
  if ! systemd_is_live; then
    log_warn "systemd is not live in this environment — skipping 'systemctl restart ${unit}'."
    return 0
  fi
  systemctl restart "$unit" || die "Failed to restart ${unit} — see: journalctl -u ${unit} -n 50"
}

# Runs a command as the supreme user with root's OWN resolved PATH forwarded explicitly.
# `sudo -u` alone substitutes sudo's `secure_path` for the target user, which does not
# necessarily include wherever `node`/`pnpm` actually live — that location varies by HOW
# Node was installed (NodeSource's own packages land in /usr/bin, on secure_path by
# default, but this is not guaranteed on every base image/environment this script might
# run in). Forwarding PATH explicitly removes that assumption entirely rather than hoping
# it holds on the target machine.
run_as_supreme() {
  # Forwards PATH (see above) plus every proxy/custom-CA variable a network install might
  # need — the exact same concern infra/hub-compose's Dockerfiles already handle via their
  # own `ca-certs/` + NODE_EXTRA_CA_CERTS pattern for pnpm/pip behind a TLS-intercepting
  # corporate proxy. `sudo -u` drops the calling environment by default; only forward vars
  # that are actually set in root's environment, so a machine with none of this configured
  # behaves exactly as if this array didn't exist.
  local -a env_args=("PATH=$PATH")
  local var
  for var in NODE_EXTRA_CA_CERTS HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy npm_config_https_proxy npm_config_proxy npm_config_noproxy npm_config_ca npm_config_cafile; do
    if [ -n "${!var:-}" ]; then
      env_args+=("${var}=${!var}")
    fi
  done
  sudo -u "$SUPREME_USER" env "${env_args[@]}" "$@"
}

# ── Secrets ─────────────────────────────────────────────────────────────────────────────

# 32 bytes of real randomness from the kernel CSPRNG, hex-encoded — matches
# SUPREME_TOKEN_SECRET's documented minimum (">= 32 chars", .env.example) with margin.
# Never a placeholder string; a script that cannot read /dev/urandom fails loudly instead
# of silently seeding a weak or fixed secret.
generate_secret() {
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# ── Version/config source of truth ──────────────────────────────────────────────────────
# The Node major version this repo's own Dockerfiles pin (gateway.Dockerfile,
# web-homeowner.Dockerfile, web-installer.Dockerfile all use `node:22-slim`) — kept as one
# constant here so native and Docker deployments track the same runtime without this file
# and the Dockerfiles silently drifting apart.
SUPREME_NODE_MAJOR="22"

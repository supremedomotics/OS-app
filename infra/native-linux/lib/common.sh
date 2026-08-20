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
# § Transactional updates: every install/update stages into SUPREME_REPO_DIR (unchanged —
# sync_repo()/install_release_artifact() are not rewritten), then a KNOWN-GOOD build is
# snapshotted into its own immutable, versioned directory here. SUPREME_RELEASE_DIR
# ("current") is a symlink into ONE of these — switching versions is one atomic `ln -sfn`,
# never an in-place overwrite of code a running service might be mid-read of.
SUPREME_RELEASES_DIR="${SUPREME_APP_DIR}/releases"
SUPREME_RELEASE_RETAIN="${SUPREME_RELEASE_RETAIN:-3}"
SUPREME_USER="${SUPREME_USER:-supreme}"
SUPREME_GROUP="${SUPREME_GROUP:-supreme}"

# systemd units this deployment owns. `supreme-lan` is intentionally NOT redefined here —
# it's the repo's own infra/systemd/supreme-lan.service (a real template, rendered like
# every sibling unit — see that file's own header comment for the Phase 2 path-mismatch
# fix), not a competing definition invented in infra/native-linux/systemd/.
SUPREME_NODE_SERVICES=(supreme-gateway supreme-lan)
SUPREME_PY_SERVICES=(supreme-commissioning)
# Third-party services this deployment configures but does not author the unit for
# (shipped by their own Ubuntu/vendor packages): postgresql, redis-server, mosquitto, caddy.
SUPREME_THIRDPARTY_SERVICES=(postgresql redis-server mosquitto caddy)
# Present only when Home Assistant was installed (optional — see install.sh).
SUPREME_HA_SERVICE=supreme-homeassistant

# § UI-triggered update (§ web-homeowner Settings > Software update, "Update now") — the ONE
# root-level action the unprivileged supreme-gateway process (User=supreme, see
# systemd/supreme-gateway.service) may ever trigger. update.sh itself still requires real root
# (require_root at the top of its main()) — this sudoers rule does not weaken that, it only lets
# the gateway user hand off to sudo for this EXACT command, no arguments, no shell.
SUPREME_UPDATE_SCRIPT="${SUPREME_REPO_DIR}/infra/native-linux/update.sh"
SUPREME_UPDATE_LOG="${SUPREME_DATA_DIR}/update.log"
SUPREME_UPDATE_LOCK_FILE="/run/supremeos-update.lock"
SUPREME_UPDATE_SUDOERS_FILE="/etc/sudoers.d/supremeos-update"

# Provisions the exact-command, NOPASSWD sudoers rule the gateway needs to launch update.sh via
# `sudo systemd-run` (services/gateway/src/system-update-runner.ts's buildUpdateTriggerArgv() —
# the two must stay byte-for-byte in sync, each documents the other). No wildcards beyond the
# fixed unit name/path already baked into both sides, and no shell metacharacters are reachable
# from anything request-controlled — the gateway never accepts a request field into this command.
# Idempotent (safe to call from both install.sh and update.sh's render_config(), so an
# already-provisioned host and an upgrading older one converge on the same file) and
# visudo-validated before being trusted — a malformed sudoers file can lock out `sudo` entirely
# on some configurations, so this never writes directly to the live file without a syntax check.
configure_update_sudoers() {
  local tmp
  tmp="$(mktemp)"
  # § Bug fix (live deployment) — sudoers requires ',', ':', '=', and '\' inside a command's
  # arguments to be backslash-escaped (see `man sudoers`, "Command" grammar); an unescaped ':'
  # in `append:${SUPREME_UPDATE_LOG}` made visudo treat the rule as ending mid-line and expect
  # a new Host_List next ("syntax error: expected host name"), refusing to install the file —
  # confirmed live. Escaping is a sudoers-FILE-parsing concern only: `sudo`/systemd-run receive
  # the real, unescaped argv exactly as execFile() built it (see system-update-runner.ts's
  # buildUpdateTriggerArgv doc comment) — the backslashes here are stripped by sudoers' own
  # parser and never become part of the string actually matched or executed, so this cannot
  # create a mismatch with the fixed argv the gateway invokes.
  # A literal backslash built via a variable, not written directly in the substitution's
  # replacement text — `${x//pat/\Y}` strips a backslash preceding a non-special character
  # like ':'/'=' during bash's own word expansion (confirmed empirically: it silently produces
  # NO escaping at all, the exact bug being fixed here), so the replacement must already
  # CONTAIN a real backslash character rather than ask bash to insert one inline.
  local bs='\'
  local escaped_cmd="/usr/bin/systemd-run --unit=supreme-update --collect --property=Type=oneshot --property=StandardOutput=append:${SUPREME_UPDATE_LOG} --property=StandardError=inherit -- ${SUPREME_UPDATE_SCRIPT}"
  escaped_cmd="${escaped_cmd//${bs}/${bs}${bs}}"
  escaped_cmd="${escaped_cmd//,/${bs},}"
  escaped_cmd="${escaped_cmd//:/${bs}:}"
  escaped_cmd="${escaped_cmd//=/${bs}=}"
  cat > "$tmp" <<EOF
# Managed by SupremeOS (infra/native-linux/lib/common.sh's configure_update_sudoers). Do not
# hand-edit — install.sh/update.sh regenerate this file on every run.
#
# Lets ${SUPREME_USER} (the gateway's own service user, never root) launch update.sh as a
# detached, --collect'ed transient systemd unit — WITHOUT ever making the gateway process itself
# run as root. update.sh's own require_root guard is unchanged; this only authorizes handing off
# to sudo for this one exact invocation, matching services/gateway/src/system-update-runner.ts's
# buildUpdateTriggerArgv() field-for-field. No wildcard, no user-supplied argument. The ',', ':',
# and '=' below are backslash-escaped per sudoers' own command-argument syntax — this changes
# nothing about what actually runs, only how the sudoers parser reads this line (see comment
# above this function's cat block for the full explanation).
${SUPREME_USER} ALL=(root) NOPASSWD: ${escaped_cmd}
EOF
  chmod 0440 "$tmp"
  if command_exists visudo; then
    visudo -cf "$tmp" || die "Generated sudoers rule for ${SUPREME_UPDATE_SUDOERS_FILE} failed visudo syntax validation — refusing to install it. See ${tmp}."
  else
    log_warn "visudo not available — installing ${SUPREME_UPDATE_SUDOERS_FILE} without a syntax pre-check."
  fi
  mv "$tmp" "$SUPREME_UPDATE_SUDOERS_FILE"
  chown root:root "$SUPREME_UPDATE_SUDOERS_FILE"
  chmod 0440 "$SUPREME_UPDATE_SUDOERS_FILE"
  log_info "Provisioned ${SUPREME_UPDATE_SUDOERS_FILE} (UI-triggered update trigger, ${SUPREME_USER} only)."
}

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
#
# § Bug fix (Phase 2 runtime investigation): the previous implementation trusted ONLY the
# exit code of `systemctl is-system-running` — but systemd's own exit-code contract does
# NOT distinguish "degraded" from "no bus reachable at all": both return exit code 1
# (verified: `man systemctl` documents is-system-running returns 0 only for "running", and
# every other state — degraded, maintenance, starting, stopping, AND the D-Bus-unreachable
# case — returns non-zero with no dedicated code of its own). Checking `rc -ne 1` as the
# "live" test therefore treated a perfectly healthy-but-degraded production system (real
# evidence: PID 1 = systemd, `is-system-running` prints "degraded", `postgresql.service` is
# genuinely active) identically to a container with no init process at all — the installer
# then skipped every `systemctl enable --now` call, so the Gateway/LAN/Commissioning never
# started and migrations never ran.
#
# Fixed to check two INDEPENDENT, unambiguous signals instead of one ambiguous exit code:
#   1. PID 1 is genuinely `systemd` (`ps -p 1 -o comm=`) — the one thing no container
#      without systemd as init, no WSL1, and no CI sandbox can fake.
#   2. `systemctl is-system-running`'s actual STDOUT (not exit code) is one of the known
#      "the bus is reachable and systemd is answering" words. "degraded"/"maintenance"/
#      "starting"/"stopping" all mean a live, queryable systemd — just not fully settled.
#      An unreachable bus prints nothing recognizable on stdout (an error goes to stderr
#      instead, or the command produces no output at all) and correctly falls through to
#      "not live".
systemd_is_live() {
  [ "$(ps -p 1 -o comm= 2>/dev/null)" = "systemd" ] || return 1
  local state
  state="$(systemctl is-system-running 2>/dev/null)"
  case "$state" in
    running|degraded|maintenance|starting|stopping) return 0 ;;
    *) return 1 ;;
  esac
}

command_exists() { command -v "$1" >/dev/null 2>&1; }

# § Bug fix (Phase 4 — Redis native-linux investigation, real Ubuntu 24.04 VM evidence):
# `/run` is tmpfs, wiped empty on every reboot. Ubuntu's redis-server package is
# responsible for recreating `/run/redis` itself (via its own package-provided systemd
# RuntimeDirectory=/tmpfiles.d mechanism) — but that mechanism only reliably fires at BOOT
# time, when systemd-tmpfiles-setup.service runs once, early. install.sh runs
# `apt-get install redis-server` mid-session on an already-booted machine, with no reboot
# anywhere in the installer's flow — the boot-time tmpfiles pass already happened before
# the package even existed on disk, so `/run/redis` is never created this session.
# `redis-server.service` runs as the unprivileged `User=redis`, which cannot create a
# directory under root-owned `/run` itself: `Can't open PID file ... Operation not
# permitted` — the exact reported symptom, and confirmed NOT caused by anything else in
# this deployment layer (a full grep of infra/native-linux/ found zero references to
# `/run`, `RuntimeDirectory`, `tmpfiles`, or any redis path anywhere outside this fix —
# and Phase 2/3's umask/CWD fixes cannot be the cause either: those affect only
# install.sh's own process, which exits long before any later, separately-booted systemd
# service invocation — systemd does not inherit an installer script's umask). See
# docs/architecture/Native-Linux-Deployment-Hardening-Phase4.md for the full investigation.
#
# Ships an idempotent tmpfiles.d rule so `/run/redis` is correct on every FUTURE boot too
# (not just once), and applies it immediately so the CURRENT session — the one that just
# installed the package and is about to start it, with no reboot — doesn't need one either.
ensure_redis_runtime_dir() {
  cat > /etc/tmpfiles.d/supremeos-redis.conf <<'EOF'
# SupremeOS-managed. Ensures /run/redis exists with correct ownership on every boot, even
# though it's normally the redis-server package's own responsibility — see
# docs/architecture/Native-Linux-Deployment-Hardening-Phase4.md for why this is still
# needed. Safe/idempotent alongside whatever the package's own tmpfiles rule (if any)
# already declares for the same path.
d /run/redis 0755 redis redis -
EOF
  if command_exists systemd-tmpfiles; then
    systemd-tmpfiles --create /etc/tmpfiles.d/supremeos-redis.conf \
      || log_warn "systemd-tmpfiles --create failed for /etc/tmpfiles.d/supremeos-redis.conf — /run/redis may still be missing this session; it will exist after the next reboot regardless."
  else
    log_warn "systemd-tmpfiles not available in this environment — /etc/tmpfiles.d/supremeos-redis.conf written but not applied (expected outside a real systemd target)."
  fi
}

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
  #
  # § Bug fix (pnpm/Corepack EACCES on the administrator's tree) — HOME/PNPM_HOME/
  # COREPACK_HOME are pinned explicitly rather than left to sudo's default HOME handling.
  # Whether plain `sudo -u supreme` sets HOME to supreme's own home directory (/opt/supreme,
  # per create_system_user's --home-dir) depends on the target machine's sudoers
  # (`always_set_home`/`set_home`, off by default on some distros) — if it doesn't, pnpm and
  # Corepack fall back to resolving paths from whatever HOME root's shell happened to have,
  # which supreme cannot read. Setting all three explicitly here removes that ambiguity:
  # every pnpm/Corepack invocation this helper runs always uses supreme's own,
  # installer-controlled cache locations, never an inherited or ambiguous default.
  local -a env_args=(
    "PATH=$PATH"
    "HOME=$SUPREME_APP_DIR"
    "PNPM_HOME=${SUPREME_APP_DIR}/.local/share/pnpm"
    "COREPACK_HOME=${SUPREME_APP_DIR}/.cache/node/corepack"
  )
  local var
  for var in NODE_EXTRA_CA_CERTS HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy npm_config_https_proxy npm_config_proxy npm_config_noproxy npm_config_ca npm_config_cafile COREPACK_ENABLE_DOWNLOAD_PROMPT; do
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

# ── NATS deployment contract (§ Native-Linux NATS hardening) ────────────────────────────
# Real production evidence: supreme-nats.service failed with `status=203/EXEC` because
# /usr/local/bin/nats-server (and later /usr/bin/nats-server) was missing, even though
# `dpkg -s nats-server` reported "Status: install ok installed". Inspecting the ACTUAL
# pinned .deb (nats-server-v2.10.24-amd64.deb — sha256 verified against NATS_DEB_SHA256
# below) shows it ships the real binary at /usr/bin/nats-server (a regular ELF file) and a
# symlink /usr/local/bin/nats-server -> /usr/bin/nats-server, both owned by the package. The
# systemd unit used to point ExecStart at the SYMLINK. dpkg's package database tracks
# "was this package installed", never "do these exact files still exist on disk right now"
# — if anything (autoremove, disk cleanup, an image snapshot restore, a hand-run `rm`) ever
# removes just the symlink, dpkg keeps reporting "install ok installed" while ExecStart
# resolves to nothing. SUPREME_NATS_BIN is the one canonical path — the real, non-symlink,
# dpkg-owned file — that every consumer (installer, systemd unit, updater, recovery,
# validator) agrees on from here on. Never redefined per-script; this is the ONE place.
NATS_VERSION="2.10.24"
NATS_DEB_SHA256="1978312aff8d667796cdac9f1edba2bd78676e596181963934780ac34ace8486"
# Overridable (like every SUPREME_*_DIR above) so the regression test suite can point
# these at scratch paths instead of the real host filesystem — production always gets the
# real defaults, nothing here changes for a real install/update/recover run.
SUPREME_NATS_BIN="${SUPREME_NATS_BIN:-/usr/bin/nats-server}"
# Shipped by the .deb itself (its own data.tar.gz contains this exact symlink) — kept valid
# for anything on the host that still expects the traditional /usr/local/bin location, but
# nothing in this deployment's own ExecStart/validation depends on it existing.
SUPREME_NATS_COMPAT_SYMLINK="${SUPREME_NATS_COMPAT_SYMLINK:-/usr/local/bin/nats-server}"
SUPREME_NATS_ARCH="${SUPREME_NATS_ARCH:-amd64}"
SUPREME_NATS_CONF="${SUPREME_CONFIG_DIR}/nats.conf"
# Matches config/nats.conf.template's own `store_dir: ___SUPREME_DATA_DIR___/nats` — one
# constant, so the validator and the template can never quietly drift apart.
SUPREME_NATS_STORE_DIR="${SUPREME_DATA_DIR}/nats"

NATS_VALIDATION_REASON=""

# TCP reachability without depending on rc_check_tcp's print-and-count side effects — a
# plain boolean primitive the NATS readiness check below can branch on directly.
_tcp_reachable() {
  local host="$1" port="$2"
  if command_exists nc; then
    nc -z -w2 "$host" "$port" 2>/dev/null
  elif command_exists bash; then
    timeout 2 bash -c "exec 3<>/dev/tcp/${host}/${port}" 2>/dev/null
  else
    return 1
  fi
}

# Downloads (or, offline, copies) + checksum-verifies + dpkg-installs the pinned nats-server
# .deb. The ONLY way nats-server ever lands on disk in this deployment — never an
# unauthenticated `curl | bash`, never a fallback to Ubuntu's own (unpinned, unverified)
# distro package. Idempotent: dpkg -i on an already-correct install is a safe no-op.
_nats_fetch_and_install_deb() {
  local tmp deb_path
  tmp="$(mktemp -d)"
  if [ "${SUPREME_OFFLINE:-0}" = "1" ]; then
    deb_path="${SUPREME_NATS_DEB_PATH:?SUPREME_OFFLINE=1 requires SUPREME_NATS_DEB_PATH pointing at a local nats-server-v${NATS_VERSION}-amd64.deb (no network download in offline mode)}"
    [ -r "$deb_path" ] || die "SUPREME_NATS_DEB_PATH=${deb_path} is not readable."
    cp "$deb_path" "${tmp}/nats-server.deb"
  else
    curl -fsSL "https://github.com/nats-io/nats-server/releases/download/v${NATS_VERSION}/nats-server-v${NATS_VERSION}-amd64.deb" -o "${tmp}/nats-server.deb" \
      || die "Failed to download nats-server v${NATS_VERSION} .deb."
  fi
  echo "${NATS_DEB_SHA256}  ${tmp}/nats-server.deb" | sha256sum -c - \
    || die "nats-server .deb checksum mismatch — refusing to install a package that doesn't match the pinned, verified hash."
  dpkg -i "${tmp}/nats-server.deb" || die "dpkg -i failed for the pinned nats-server .deb — see dpkg's own error above."
  rm -rf "$tmp"
  # § Original production bug, closed at the source: the .deb's own postinst ships the
  # compat symlink, but dpkg -i over an already-"installed" version does not reliably
  # re-run maintainer scripts identically on every dpkg version — recreate it explicitly
  # rather than assuming it exists after this call.
  if [ -x "$SUPREME_NATS_BIN" ] && { [ ! -e "$SUPREME_NATS_COMPAT_SYMLINK" ] || [ -L "$SUPREME_NATS_COMPAT_SYMLINK" ]; }; then
    ln -sfn "$SUPREME_NATS_BIN" "$SUPREME_NATS_COMPAT_SYMLINK"
  fi
}

# Pure read-only check — every one of the ten broken states this deployment must self-heal
# fails exactly one of these in a way distinguishable via NATS_VALIDATION_REASON. Never
# mutates anything; nats_ensure_ready() below is the only function allowed to repair.
nats_validate() {
  NATS_VALIDATION_REASON=""

  if [ ! -e "$SUPREME_NATS_BIN" ]; then
    NATS_VALIDATION_REASON="canonical executable missing: ${SUPREME_NATS_BIN}"; return 1
  fi
  if [ -L "$SUPREME_NATS_BIN" ]; then
    NATS_VALIDATION_REASON="${SUPREME_NATS_BIN} is a symlink, expected a real regular file (the pinned .deb ships it as one — something replaced it)"; return 1
  fi
  if [ ! -x "$SUPREME_NATS_BIN" ]; then
    NATS_VALIDATION_REASON="${SUPREME_NATS_BIN} exists but is not executable (permissions)"; return 1
  fi

  # Compat symlink, if present at all, must genuinely resolve to the canonical binary — a
  # dangling or wrongly-targeted one is reported, never silently ignored.
  if [ -L "$SUPREME_NATS_COMPAT_SYMLINK" ]; then
    local target
    target="$(readlink -f "$SUPREME_NATS_COMPAT_SYMLINK" 2>/dev/null || true)"
    if [ -z "$target" ] || [ "$target" != "$(readlink -f "$SUPREME_NATS_BIN")" ]; then
      NATS_VALIDATION_REASON="${SUPREME_NATS_COMPAT_SYMLINK} is a dangling or mistargeted symlink (expected -> ${SUPREME_NATS_BIN})"; return 1
    fi
  elif [ -e "$SUPREME_NATS_COMPAT_SYMLINK" ] && [ ! -x "$SUPREME_NATS_COMPAT_SYMLINK" ]; then
    NATS_VALIDATION_REASON="${SUPREME_NATS_COMPAT_SYMLINK} exists but is neither the expected symlink nor executable"; return 1
  fi

  local version_output
  if ! version_output="$("$SUPREME_NATS_BIN" --version 2>&1)"; then
    NATS_VALIDATION_REASON="${SUPREME_NATS_BIN} --version failed to run (binary present but fails to execute): ${version_output}"; return 1
  fi
  case "$version_output" in
    *"v${NATS_VERSION}"*) ;;
    *) NATS_VALIDATION_REASON="version mismatch — expected v${NATS_VERSION}, got: ${version_output}"; return 1 ;;
  esac

  local host_arch
  host_arch="$(uname -m)"
  [ "$host_arch" = "x86_64" ] && host_arch="amd64"
  if [ "$host_arch" != "$SUPREME_NATS_ARCH" ]; then
    NATS_VALIDATION_REASON="host architecture ${host_arch} does not match the pinned .deb's architecture ${SUPREME_NATS_ARCH}"; return 1
  fi

  if command_exists dpkg-query; then
    local dpkg_status
    dpkg_status="$(dpkg-query -W -f='${Status}' nats-server 2>/dev/null || true)"
    case "$dpkg_status" in
      *"install ok installed"*) ;;
      *) NATS_VALIDATION_REASON="dpkg package state for nats-server is '${dpkg_status:-not installed}', not 'install ok installed' — package is absent, half-installed, or removed-but-not-purged"; return 1 ;;
    esac
  fi

  local unit_file="${SUPREME_NATS_UNIT_FILE:-/etc/systemd/system/supreme-nats.service}"
  if [ -r "$unit_file" ]; then
    local exec_line
    exec_line="$(grep -m1 '^ExecStart=' "$unit_file" 2>/dev/null || true)"
    if [ -z "$exec_line" ]; then
      NATS_VALIDATION_REASON="${unit_file} has no ExecStart line"; return 1
    fi
    case "$exec_line" in
      "ExecStart=${SUPREME_NATS_BIN} "*) ;;
      *) NATS_VALIDATION_REASON="${unit_file}'s ExecStart does not resolve to the canonical ${SUPREME_NATS_BIN}: ${exec_line}"; return 1 ;;
    esac
  fi

  [ -r "$SUPREME_NATS_CONF" ] || { NATS_VALIDATION_REASON="NATS config missing: ${SUPREME_NATS_CONF}"; return 1; }

  # JetStream store_dir: existence + ownership only, NEVER content — this function never
  # writes to, reads inside, or otherwise touches what NATS has stored there.
  if [ ! -d "$SUPREME_NATS_STORE_DIR" ]; then
    NATS_VALIDATION_REASON="JetStream store_dir missing: ${SUPREME_NATS_STORE_DIR}"; return 1
  fi
  if command_exists stat; then
    local owner
    owner="$(stat -c '%U:%G' "$SUPREME_NATS_STORE_DIR" 2>/dev/null || echo "")"
    if [ -n "$owner" ] && [ "$owner" != "${SUPREME_USER}:${SUPREME_GROUP}" ]; then
      NATS_VALIDATION_REASON="JetStream store_dir ${SUPREME_NATS_STORE_DIR} is owned by ${owner}, expected ${SUPREME_USER}:${SUPREME_GROUP}"; return 1
    fi
  fi

  # The service user must actually be able to execute the binary — mirrors the unit's own
  # User=supreme, catching a permissions/ACL edge case a root-only `-x` test would miss.
  # Gated on systemd_is_live (same convention rc_check_service etc. already use): a real
  # `sudo -u` impersonation check is only meaningful against a real target host's real
  # accounts — on a non-systemd dev/CI sandbox (no real `supreme` user, and on Windows a
  # same-named `sudo.exe` that behaves nothing like Linux sudo) it would misfire.
  if systemd_is_live && command_exists sudo && id "$SUPREME_USER" >/dev/null 2>&1; then
    if ! sudo -u "$SUPREME_USER" test -x "$SUPREME_NATS_BIN" 2>/dev/null; then
      NATS_VALIDATION_REASON="${SUPREME_USER} cannot execute ${SUPREME_NATS_BIN} (permissions/ACL)"; return 1
    fi
  fi

  return 0
}

# "NATS ready" means the process is actually running, actually the right version, AND
# actually accepting a real TCP connection on 4222 — never merely "dpkg says installed" or
# "command -v succeeds".
nats_check_ready() {
  nats_validate || return 1
  if systemd_is_live && ! systemctl is-active --quiet supreme-nats; then
    NATS_VALIDATION_REASON="supreme-nats.service is not active"; return 1
  fi
  if systemd_is_live && ! _tcp_reachable 127.0.0.1 4222; then
    NATS_VALIDATION_REASON="port 4222 is not accepting connections"; return 1
  fi
  return 0
}

# The ONE authoritative NATS ensure/repair entry point — install.sh, update.sh, and
# recover.sh all call this instead of maintaining separate NATS logic. detect (nats_validate)
# -> repair (_nats_fetch_and_install_deb, reinstalling the pinned package) -> re-validate ->
# ensure the JetStream directory exists (never resets/deletes it) -> enable+start the
# service -> block until real readiness or fail loudly. Never continues silently past a
# failure — either it converges within the retry budget, or it `die`s with the exact reason.
nats_ensure_ready() {
  local attempt
  for attempt in 1 2; do
    if nats_validate; then
      log_info "nats-server ${NATS_VERSION}: validated OK (${SUPREME_NATS_BIN})."
      break
    fi
    log_warn "nats-server validation failed (attempt ${attempt}/2): ${NATS_VALIDATION_REASON} — repairing by reinstalling the pinned package."
    _nats_fetch_and_install_deb
    if [ "$attempt" = "2" ] && ! nats_validate; then
      die "nats-server still fails validation after repair: ${NATS_VALIDATION_REASON}"
    fi
  done

  # Existence + ownership only — mkdir -p is a no-op if it already exists, chown/chmod are
  # never recursive, so no existing JetStream stream data is ever touched.
  mkdir -p "$SUPREME_NATS_STORE_DIR"
  chown "${SUPREME_USER}:${SUPREME_GROUP}" "$SUPREME_NATS_STORE_DIR" 2>/dev/null || true
  chmod 0750 "$SUPREME_NATS_STORE_DIR" 2>/dev/null || true

  if ! systemd_is_live; then
    log_warn "systemd is not live in this environment — nats-server package/executable/config validated, but service start and readiness cannot be exercised here. This runs for real on the target machine."
    return 0
  fi

  systemctl daemon-reload
  systemctl_enable_now supreme-nats

  local waited
  for waited in $(seq 1 30); do
    : "$waited"
    if nats_check_ready; then
      log_info "supreme-nats is ready — active, version v${NATS_VERSION}, port 4222 accepting connections."
      return 0
    fi
    sleep 1
  done
  die "supreme-nats did not become ready within 30s: ${NATS_VALIDATION_REASON:-unknown reason}. See: journalctl -u supreme-nats -n 50"
}

# ── Install mode detection (§ CI/Production verification split) ────────────────────────
# The installer verifies what it's actually installing, not a fixed assumption:
#   "source"  — a git checkout (has .git). A developer workflow: full build + typecheck +
#               test, exactly as before. This is the ONLY mode allowed to run the ~800-test
#               developer suite, per its own requirement ("keep full verification").
#   "release" — a signed, pre-built release artifact (has release-manifest.json, produced
#               by package-release.sh in CI). Never recompiled, never re-tested — its own
#               CI pipeline (.github/workflows/release.yml) already ran build+typecheck+
#               test+integration+performance before signing it. The installer instead
#               verifies release integrity (checksum/signature), applies migrations, starts
#               services, and checks REAL runtime health — see run_runtime_verification().
# Detection is a plain fact check (file presence), never a guess, and always overridable
# via SUPREME_INSTALL_MODE for an operator who knows better (e.g. testing the release path
# from a git checkout that also happens to carry a stray manifest).
detect_install_mode() {
  local src="$1" # the source tree root install.sh is being run from
  if [ -n "${SUPREME_INSTALL_MODE:-}" ]; then
    case "$SUPREME_INSTALL_MODE" in
      source|release) log_info "Install mode: ${SUPREME_INSTALL_MODE} (explicit SUPREME_INSTALL_MODE override)."; return ;;
      *) die "Invalid SUPREME_INSTALL_MODE '${SUPREME_INSTALL_MODE}' — must be 'source' or 'release'." ;;
    esac
  fi
  if [ -r "${src}/release-manifest.json" ]; then
    SUPREME_INSTALL_MODE="release"
  elif [ -d "${src}/.git" ]; then
    SUPREME_INSTALL_MODE="source"
  else
    die "Cannot determine install mode: ${src} has neither a release-manifest.json (release artifact) nor a .git directory (source checkout). Set SUPREME_INSTALL_MODE=source|release explicitly to override."
  fi
  log_info "Install mode: ${SUPREME_INSTALL_MODE} (detected from ${src})."
}

# ── Phase checkpoints (§ resume-after-interruption) ─────────────────────────────────────
# One completed-phase name per line in SUPREME_STATE_FILE. Deliberately NOT a single
# "last completed step" pointer — an explicit set means a re-run after adding a new phase
# (e.g. an installer upgrade) correctly re-runs only the NEW phase, not every phase after
# whatever line number the old pointer happened to stop at.
SUPREME_STATE_FILE="${SUPREME_CONFIG_DIR}/install.state"
SUPREME_LOG_DIR="${SUPREME_CONFIG_DIR}/logs"

phase_done() {
  [ -r "$SUPREME_STATE_FILE" ] && grep -qxF "$1" "$SUPREME_STATE_FILE"
}

mark_phase_done() {
  mkdir -p "$(dirname "$SUPREME_STATE_FILE")"
  echo "$1" >> "$SUPREME_STATE_FILE"
}

# § Checkpoint validation (requirement: "the filesystem is the source of truth, checkpoint
# files are only hints"). Removes `name` and every phase recorded AFTER it in
# SUPREME_STATE_FILE — since phases are always appended in the single fixed order install.sh
# calls run_phase in, "everything after this line" IS "everything that depends on this
# phase's output," with no separate dependency graph to maintain.
invalidate_phase_and_dependents() {
  local name="$1"
  [ -r "$SUPREME_STATE_FILE" ] || return 0
  local tmp
  tmp="$(mktemp)"
  awk -v target="$name" '$0 == target { skipping = 1 } !skipping { print }' "$SUPREME_STATE_FILE" > "$tmp"
  mv "$tmp" "$SUPREME_STATE_FILE"
}

# Runs one named phase with a checkpoint: skipped (not even invoked) if already recorded
# complete in SUPREME_STATE_FILE, so re-running the installer after an interruption — a
# dropped SSH session mid-`apt-get`, a reboot mid-way — resumes from the first
# NOT-yet-completed phase instead of redoing everything already known-good. Structured,
# greppable log line per phase (name, elapsed seconds, exit status) regardless of outcome.
# SUPREME_FORCE_REDO=1 re-runs every phase even if checkpointed (e.g. after hand-editing
# config) — opt-in, never the default, so "resume" stays the normal behavior.
#
# § Checkpoint validation: a checkpoint recorded complete is only ever a HINT. If a
# `validate_phase_<name>` function exists, it is called before honoring the checkpoint — it
# must return 0 if the phase's actual on-disk artifacts still look correct, non-zero
# otherwise (e.g. uninstall.sh removed the repository sync_repo produced). A failed
# validation invalidates this phase AND every phase after it, then falls through to actually
# re-run — never requires the operator to delete install.state by hand. Phases with no
# validator function keep the original trust-the-checkpoint behavior unchanged.
run_phase() {
  local name="$1"; shift
  if [ "${SUPREME_FORCE_REDO:-0}" != "1" ] && phase_done "$name"; then
    if declare -f "validate_phase_${name}" >/dev/null 2>&1; then
      if "validate_phase_${name}"; then
        log_info "[phase] ${name}: already completed — skipping (artifact validated)."
        return 0
      fi
      log_warn "[phase] ${name}: checkpoint says complete, but its artifacts failed validation — invalidating this phase and every phase after it, then re-running."
      invalidate_phase_and_dependents "$name"
    else
      log_info "[phase] ${name}: already completed — skipping (SUPREME_FORCE_REDO=1 to re-run)."
      return 0
    fi
  fi
  local start end elapsed
  start="$(date +%s)"
  log_step "[phase] ${name}"
  if "$@"; then
    end="$(date +%s)"; elapsed=$((end - start))
    log_info "[phase] ${name}: OK (${elapsed}s)."
    mark_phase_done "$name"
  else
    end="$(date +%s)"; elapsed=$((end - start))
    log_error "[phase] ${name}: FAILED after ${elapsed}s. Fix the reported error and re-run — already-completed phases will be skipped."
    exit 1
  fi
}

# ── Runtime verification (§ Production verification strategy) ──────────────────────────
# The single source of truth for "is this deployment actually working" — used by BOTH
# health-check.sh (read-only, operator/cron-facing) and install.sh's production-mode
# post-install verification (§ requirement: verify runtime dependencies, DB connectivity,
# NATS, Mosquitto, PostgreSQL, Gateway, LAN Service, Commissioning, Web UI). One
# implementation, two callers — never let the installer's idea of "healthy" drift from
# health-check.sh's.
RUNTIME_CHECK_FAILED=0
RUNTIME_CHECK_NOT_EVALUATED=0

RUNTIME_CHECK_WARNING=0

rc_pass() { echo "  PASS       $*"; }
rc_fail() { echo "  FAIL       $*"; RUNTIME_CHECK_FAILED=$((RUNTIME_CHECK_FAILED + 1)); }
rc_warn() { echo "  WARNING    $*"; RUNTIME_CHECK_WARNING=$((RUNTIME_CHECK_WARNING + 1)); }
rc_not_applicable() { echo "  N/A        $*"; }
rc_not_evaluated() { echo "  NOT EVAL   $*"; RUNTIME_CHECK_NOT_EVALUATED=$((RUNTIME_CHECK_NOT_EVALUATED + 1)); }

rc_check_service() {
  local unit="$1"
  if ! systemd_is_live; then
    rc_not_evaluated "${unit} — systemd is not live in this environment"
    return
  fi
  if systemctl is-active --quiet "$unit"; then
    rc_pass "${unit} is active"
  else
    rc_fail "${unit} is NOT active ($(systemctl is-active "$unit" 2>&1 || true)) — see: journalctl -u ${unit} -n 50"
  fi
}

rc_check_tcp() {
  local label="$1" host="$2" port="$3"
  if command_exists nc; then
    if nc -z -w2 "$host" "$port" 2>/dev/null; then rc_pass "${label} reachable at ${host}:${port}"; else rc_fail "${label} NOT reachable at ${host}:${port}"; fi
  elif command_exists bash; then
    if timeout 2 bash -c "exec 3<>/dev/tcp/${host}/${port}" 2>/dev/null; then rc_pass "${label} reachable at ${host}:${port}"; else rc_fail "${label} NOT reachable at ${host}:${port}"; fi
  else
    rc_not_evaluated "${label} at ${host}:${port} — neither nc nor /dev/tcp available"
  fi
}

rc_check_http() {
  local label="$1" url="$2"
  local body
  if body="$(curl -fsS -k --max-time 5 "$url" 2>&1)"; then
    rc_pass "${label} responded: ${url} — ${body:0:120}"
  else
    rc_fail "${label} did NOT respond at ${url}"
  fi
}

# Real Postgres schema-migration state — not "did the process start" but "did the DB
# actually reach the version this release expects." Reads the same schema_migrations
# table services/persistence/src/migrate.ts writes to; never assumed from a log line.
rc_check_migrations() {
  local expected_count="${1:-}"
  if ! command_exists psql; then
    rc_not_evaluated "Migration state — psql not available to query it"
    return
  fi
  local applied
  if ! applied="$(PGPASSWORD="${POSTGRES_PASSWORD:-}" psql -h 127.0.0.1 -U supreme -d supreme -tAc \
    "SELECT count(*) FROM schema_migrations" 2>&1)"; then
    rc_fail "Migration state — could not query schema_migrations: ${applied}"
    return
  fi
  applied="$(echo "$applied" | tr -d '[:space:]')"
  if [ -n "$expected_count" ] && [ "$applied" != "$expected_count" ]; then
    rc_fail "Migration state — expected ${expected_count} applied migrations, found ${applied}"
  else
    rc_pass "Migration state — ${applied} migration(s) applied"
  fi
}

# ── Resource checks (§ requirement 10: disk, memory, CPU) ───────────────────────────────
# Real numbers, read from the kernel/filesystem — never assumed. Thresholds are WARNINGs,
# not FAILs: a controller that's merely tight on headroom should be flagged, not treated as
# broken (it may run fine indefinitely; it just has less margin than recommended).
rc_check_disk() {
  local path="$1" required_mb="${2:-0}"
  if ! command_exists df; then rc_not_evaluated "Disk space at ${path} — df not available"; return; fi
  local avail_kb avail_mb
  avail_kb="$(df -Pk "$path" 2>/dev/null | awk 'NR==2 {print $4}')"
  [ -n "$avail_kb" ] || { rc_not_evaluated "Disk space at ${path} — could not read"; return; }
  avail_mb=$((avail_kb / 1024))
  if [ "$required_mb" -gt 0 ] && [ "$avail_mb" -lt "$required_mb" ]; then
    rc_fail "Disk space at ${path} — ${avail_mb}MB free, release requires ${required_mb}MB"
  elif [ "$required_mb" -gt 0 ] && [ "$avail_mb" -lt $((required_mb * 2)) ]; then
    rc_warn "Disk space at ${path} — ${avail_mb}MB free, within 2x of the ${required_mb}MB requirement"
  else
    rc_pass "Disk space at ${path} — ${avail_mb}MB free"
  fi
}

rc_check_memory() {
  local required_mb="${1:-0}"
  if [ ! -r /proc/meminfo ]; then rc_not_evaluated "Memory — /proc/meminfo not readable"; return; fi
  local total_kb total_mb
  total_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  total_mb=$((total_kb / 1024))
  if [ "$required_mb" -gt 0 ] && [ "$total_mb" -lt "$required_mb" ]; then
    rc_fail "Memory — ${total_mb}MB total, release requires ${required_mb}MB"
  else
    rc_pass "Memory — ${total_mb}MB total"
  fi
}

rc_check_cpu() {
  local required_arch="${1:-}"
  local arch cores
  arch="$(uname -m)"
  cores="$(nproc 2>/dev/null || echo unknown)"
  if [ -n "$required_arch" ] && [ "$arch" != "$required_arch" ] \
    && ! { [ "$required_arch" = "amd64" ] && [ "$arch" = "x86_64" ]; }; then
    rc_fail "CPU architecture — this machine is ${arch}, release requires ${required_arch}"
  else
    rc_pass "CPU — ${arch}, ${cores} core(s)"
  fi
}

# Every TCP port this deployment binds, checked for "nothing ELSE already listening on it"
# — meaningful only BEFORE services start (install.sh runs this ahead of start_services);
# once SupremeOS itself owns the port, rc_check_tcp above (reachability) is the right check.
rc_check_port_available() {
  local label="$1" port="$2"
  if ! command_exists ss; then rc_not_evaluated "${label} port ${port} — ss not available"; return; fi
  local owner
  owner="$(ss -ltnp 2>/dev/null | awk -v p=":${port}$" '$4 ~ p {print}')"
  if [ -z "$owner" ]; then
    rc_pass "Port ${port} (${label}) is free"
  else
    rc_fail "Port ${port} (${label}) is already in use: ${owner}"
  fi
}

# Runs the full checklist (§ requirement 1, Production bullet list) and returns non-zero if
# anything genuinely failed. `expected_migration_count`/`release_version` are optional —
# supplied by install.sh in release mode (known from release-manifest.json), omitted by
# health-check.sh (which just reports current state, nothing to compare against).
run_runtime_verification() {
  local expected_migration_count="${1:-}" required_disk_mb="${2:-0}" required_ram_mb="${3:-0}" required_cpu_arch="${4:-}"
  RUNTIME_CHECK_FAILED=0
  RUNTIME_CHECK_NOT_EVALUATED=0
  RUNTIME_CHECK_WARNING=0

  echo "--- Host resources ---"
  rc_check_disk "$SUPREME_APP_DIR" "$required_disk_mb"
  rc_check_memory "$required_ram_mb"
  rc_check_cpu "$required_cpu_arch"

  echo ""
  echo "--- Third-party services ---"
  for svc in "${SUPREME_THIRDPARTY_SERVICES[@]}"; do rc_check_service "$svc"; done

  echo ""
  echo "--- SupremeOS services ---"
  for svc in "${SUPREME_NODE_SERVICES[@]}"; do rc_check_service "$svc"; done
  for svc in "${SUPREME_PY_SERVICES[@]}"; do rc_check_service "$svc"; done
  rc_check_service "supreme-nats"
  if [ "${SUPREME_INSTALL_HA:-0}" = "1" ]; then
    rc_check_service "$SUPREME_HA_SERVICE"
  else
    echo "  SKIPPED    ${SUPREME_HA_SERVICE} — Home Assistant was not installed"
  fi

  echo ""
  echo "--- Runtime dependencies (loopback — matches this deployment's binding policy) ---"
  rc_check_tcp "PostgreSQL" 127.0.0.1 5432
  rc_check_tcp "Redis" 127.0.0.1 6379
  rc_check_tcp "NATS" 127.0.0.1 4222
  rc_check_tcp "Mosquitto" 127.0.0.1 1883
  rc_check_tcp "Gateway" 127.0.0.1 8080
  rc_check_tcp "Caddy (HTTPS)" 127.0.0.1 443
  if [ "${SUPREME_INSTALL_HA:-0}" = "1" ]; then
    rc_check_tcp "Home Assistant (must be loopback-only)" 127.0.0.1 8123
  fi

  echo ""
  echo "--- Database migration state ---"
  rc_check_migrations "$expected_migration_count"

  echo ""
  echo "--- Application endpoints (Gateway / Commissioning / Web UI) ---"
  rc_check_http "Gateway /healthz (direct)" "http://127.0.0.1:8080/healthz"
  rc_check_http "Edge /healthz (via Caddy — proves Gateway + LAN + Commissioning wiring)" "https://127.0.0.1/healthz"
  rc_check_http "Web UI (via Caddy)" "https://127.0.0.1/"

  echo ""
  echo "=== Runtime verification summary ==="
  echo "Failed: ${RUNTIME_CHECK_FAILED}   Warnings: ${RUNTIME_CHECK_WARNING}   Not evaluated: ${RUNTIME_CHECK_NOT_EVALUATED}"
  [ "$RUNTIME_CHECK_FAILED" -eq 0 ]
}

# ── Staged health verification (§ requirement 2) ─────────────────────────────────────────
# The same checks run_runtime_verification already performs, reorganized into ORDERED
# startup stages — each with its own start/finish/duration and PASS/FAIL/WARNING/N-A
# outcome, and a failure stops every LATER stage from running (a broken database means
# checking messaging/network/services/protocols/web afterward would only produce a wall of
# secondary failures that bury the actual, single root cause). Built entirely on the
# existing rc_* primitives above — no new check logic, only new sequencing/reporting.
STAGE_RESULTS=()

# $1=stage name  $2=function name to call (a real function in THIS shell, sharing
# rc_*/RUNTIME_CHECK_* state directly — never a `bash -c` subshell, which would run
# without lib/common.sh sourced and lose every counter this whole scheme depends on).
_stage_run() {
  local name="$1" fn="$2"
  local before="$RUNTIME_CHECK_FAILED"
  local start end duration
  start="$(date -u +%s)"
  echo ""
  echo "=== Stage: ${name} (started $(date -u +%H:%M:%S)) ==="
  "$fn"
  end="$(date -u +%s)"
  duration=$((end - start))
  local outcome="PASS"
  [ "$RUNTIME_CHECK_FAILED" -gt "$before" ] && outcome="FAIL"
  STAGE_RESULTS+=("${name}|${outcome}|${duration}s")
  echo "--- Stage ${name}: ${outcome} (${duration}s) ---"
  [ "$outcome" = "PASS" ]
}

_stage_boot() {
  if systemd_is_live; then rc_pass "systemd is live (PID 1)"; else rc_warn "systemd is not live in this environment"; fi
}
_stage_core_os() {
  rc_check_cpu "$_STAGE_REQUIRED_CPU_ARCH"
  rc_check_memory "$_STAGE_REQUIRED_RAM_MB"
}
_stage_filesystem() {
  rc_check_disk "$SUPREME_APP_DIR" "$_STAGE_REQUIRED_DISK_MB"
  if [ -w "$SUPREME_DATA_DIR" ]; then rc_pass "Data directory writable"; else rc_fail "Data directory not writable: ${SUPREME_DATA_DIR}"; fi
  if [ -e "$SUPREME_RELEASE_DIR" ]; then rc_pass "Active release symlink resolves"; else rc_fail "Active release symlink missing/broken: ${SUPREME_RELEASE_DIR}"; fi
}
_stage_database() {
  rc_check_service postgresql
  rc_check_tcp "PostgreSQL" 127.0.0.1 5432
  rc_check_migrations "$_STAGE_EXPECTED_MIGRATION_COUNT"
}
_stage_messaging() {
  rc_check_service supreme-nats
  rc_check_tcp "NATS" 127.0.0.1 4222
  rc_check_service mosquitto
  rc_check_tcp "Mosquitto" 127.0.0.1 1883
  rc_check_service redis-server
  rc_check_tcp "Redis" 127.0.0.1 6379
}
_stage_network() {
  rc_check_service caddy
  rc_check_tcp "Caddy (HTTPS)" 127.0.0.1 443
}
_stage_supreme_services() {
  rc_check_service supreme-gateway
  rc_check_service supreme-lan
  rc_check_service supreme-commissioning
  if [ "${SUPREME_INSTALL_HA:-0}" = "1" ]; then rc_check_service supreme-homeassistant; else rc_not_applicable "Home Assistant (not installed)"; fi
}
_stage_protocols() {
  # § Bug fix — /v1/drivers/diagnostics requires an authenticated user (services/gateway/
  # src/routes/installer.ts), and even with a token, per-driver diagnostics don't exist
  # yet: ctx.installer (owner of driverDiagnostics()) is only constructed once a home is
  # commissioned (services/gateway/src/context.ts's setupRequired early-return runs BEFORE
  # initWithHome()). On a fresh install there is no protocol driver to report on — asserting
  # "drivers loaded" here was checking a claim that cannot yet be true.
  #
  # What DOES exist unconditionally at this point is the SIL backend/adapter connection
  # (ctx.sil.start() runs before the setupRequired check) — already surfaced, unauthenticated,
  # as `backendHealthy` on /healthz. That's the earliest honest signal this stage can verify;
  # real per-driver diagnostics belong in a later, authenticated, post-setup check.
  local body
  if body="$(curl -fsS -k --max-time 5 "http://127.0.0.1:8080/healthz" 2>&1)"; then
    case "$body" in
      *'"backendHealthy":true'*)
        rc_pass "Protocol/SIL backend connected (pre-setup; protocol drivers activate after Setup Wizard commissioning) — ${body:0:120}"
        ;;
      *)
        rc_fail "Protocol/SIL backend not connected (pre-setup) — /healthz reports: ${body:0:120}"
        ;;
    esac
  else
    rc_fail "Protocol/SIL backend check — /healthz did NOT respond at http://127.0.0.1:8080/healthz"
  fi
}
_stage_web_ui() {
  rc_check_http "Web UI (via Caddy)" "https://127.0.0.1/"
}
_stage_ready() {
  rc_check_http "Gateway /healthz (direct)" "http://127.0.0.1:8080/healthz"
  rc_check_http "Edge /healthz (via Caddy)" "https://127.0.0.1/healthz"
}

run_staged_verification() {
  _STAGE_EXPECTED_MIGRATION_COUNT="${1:-}"
  _STAGE_REQUIRED_DISK_MB="${2:-0}"
  _STAGE_REQUIRED_RAM_MB="${3:-0}"
  _STAGE_REQUIRED_CPU_ARCH="${4:-}"
  RUNTIME_CHECK_FAILED=0
  RUNTIME_CHECK_NOT_EVALUATED=0
  RUNTIME_CHECK_WARNING=0
  STAGE_RESULTS=()

  for stage in "BOOT:_stage_boot" "CORE OS:_stage_core_os" "FILESYSTEM:_stage_filesystem" \
    "DATABASE:_stage_database" "MESSAGING:_stage_messaging" "NETWORK:_stage_network" \
    "SUPREME SERVICES:_stage_supreme_services" "PROTOCOLS:_stage_protocols" "WEB UI:_stage_web_ui"; do
    _stage_run "${stage%%:*}" "${stage#*:}" || { _print_stage_summary; return 1; }
  done
  # READY always runs (even if it fails) so its own PASS/FAIL is visible — nothing comes
  # after it to protect from a wall of secondary failures.
  _stage_run "READY" _stage_ready

  _print_stage_summary
  [ "$RUNTIME_CHECK_FAILED" -eq 0 ]
}

_print_stage_summary() {
  echo ""
  echo "=== Staged verification summary ==="
  local s
  for s in "${STAGE_RESULTS[@]}"; do
    IFS='|' read -r name outcome duration <<< "$s"
    printf "  %-20s %-6s %s\n" "$name" "$outcome" "$duration"
  done
  echo "Failed: ${RUNTIME_CHECK_FAILED}   Warnings: ${RUNTIME_CHECK_WARNING}   Not evaluated: ${RUNTIME_CHECK_NOT_EVALUATED}"
}

# ── Versioned releases + atomic switch (§ Transactional updates) ────────────────────────
# The active release is ALWAYS reached through the SUPREME_RELEASE_DIR symlink — code is
# never modified in place under a version a running service might be reading. Switching
# versions is one atomic `ln -sfn` (POSIX guarantees a symlink replacement is atomic —
# readers see either the old or the new target, never a half-written one).

current_release_version() {
  if [ -L "$SUPREME_RELEASE_DIR" ]; then
    basename "$(readlink -f "$SUPREME_RELEASE_DIR")"
  else
    echo ""
  fi
}

# Snapshots the staged, already-verified build at SUPREME_REPO_DIR into its own immutable
# versioned directory — never the reverse (SUPREME_REPO_DIR stays the reusable staging
# area every sync_repo()/install_release_artifact() call writes into next time).
stage_release_version() {
  local version="$1"
  local target="${SUPREME_RELEASES_DIR}/${version}"
  local building="${target}.building"
  mkdir -p "$SUPREME_RELEASES_DIR"
  # § Bug fix (Phase 2 runtime investigation) — defense in depth, independent of whatever
  # the calling shell's umask happens to be: every service that reads staged code
  # (supreme-gateway/lan/commissioning) runs as User=supreme, so this directory must always
  # be traversable by that account regardless of how it was created. install.sh's
  # create_directories() also creates+owns this directory up front now (the primary fix),
  # but this is the one place that can recreate it standalone (e.g. after it's been removed
  # outside install.sh) — real evidence showed a leaked umask alone was enough to produce
  # `drwx------ root root` here, silently blocking every service with `status=200/CHDIR`.
  chown "${SUPREME_USER}:${SUPREME_GROUP}" "$SUPREME_RELEASES_DIR"
  chmod 0750 "$SUPREME_RELEASES_DIR"
  rm -rf "$building"
  cp -a "$SUPREME_REPO_DIR" "$building"
  chown -R "${SUPREME_USER}:${SUPREME_GROUP}" "$building"
  # Build into a sibling ".building" directory, then swap it into place with NO window
  # where $target is missing: rename the old one aside first (if present), rename the
  # new one in, THEN delete the old one. `mv` onto an existing directory nests inside it
  # rather than replacing it, so the old one must move out of the way first — but "moved
  # aside" is not "gone," unlike a naive rm-then-copy. Matters when $version happens to
  # already exist and be the current live symlink target (re-staging the same version,
  # e.g. SUPREME_FORCE_REDO=1) — a running service's files are never absent, even
  # momentarily.
  local old_aside="${target}.previous"
  rm -rf "$old_aside"
  [ -e "$target" ] && mv "$target" "$old_aside"
  mv "$building" "$target"
  rm -rf "$old_aside"
  grant_caddy_ui_access "$target"
  echo "$target"
}

# § Bug fix — Caddy (`caddy`, a distinct system account from its own apt package) must
# read the built UI to serve it, but $SUPREME_APP_DIR is 0750 supreme:supreme and every
# release directory inherits that ownership — Caddy has no path in by owner, group, or
# world bit. Adding caddy to $SUPREME_GROUP was considered and rejected: gateway.env and
# nats.conf are group-readable (0640 root:supreme, see configure_gateway_env()/
# configure_nats()) and gateway.env carries SUPREME_TOKEN_SECRET — group membership would
# hand caddy read access to those too, not just the UI. POSIX ACLs grant caddy exactly
# what it needs instead: execute-only (traversal, no listing) on every ancestor directory
# a request must pass through, and read+execute (recursive) on ONLY the two trees
# config/Caddyfile.template's file_server blocks actually serve
# (apps/web-homeowner/dist, apps/web-installer/dist) — nothing else in the release
# (services/, node_modules/, source, configs) is touched, and the 0750 base mode /
# supreme:supreme ownership are never changed.
#
# Idempotent (`setfacl -m` re-asserting an existing entry is a no-op, never broadens), and
# scoped to files that only exist because THIS release exists — when a release directory
# is later deleted (stage_release_version's own $old_aside cleanup, or
# prune_old_releases), its ACL entries are deleted with it. Nothing to leak, nothing to
# accumulate.
grant_caddy_ui_access() {
  local release_dir="$1"
  if ! command_exists setfacl; then
    log_warn "setfacl not available (acl package missing?) — Caddy will not be able to read the staged UI at ${release_dir}. Install the 'acl' package and re-run."
    return 0
  fi
  if ! id caddy >/dev/null 2>&1; then
    log_warn "caddy system user not found — skipping UI ACL grant for ${release_dir} (install_caddy should have created it before this runs)."
    return 0
  fi

  local ancestor
  for ancestor in "$SUPREME_APP_DIR" "$SUPREME_RELEASES_DIR" "$release_dir" \
    "${release_dir}/apps" "${release_dir}/apps/web-homeowner" "${release_dir}/apps/web-installer"; do
    [ -d "$ancestor" ] && setfacl -m u:caddy:--x "$ancestor"
  done

  local dist_dir
  for dist_dir in "${release_dir}/apps/web-homeowner/dist" "${release_dir}/apps/web-installer/dist"; do
    [ -d "$dist_dir" ] && setfacl -R -m u:caddy:rX "$dist_dir"
  done
}

switch_active_release() {
  local version="$1"
  local target="${SUPREME_RELEASES_DIR}/${version}"
  [ -d "$target" ] || die "Cannot switch to release '${version}' — ${target} does not exist."
  ln -sfn "$target" "$SUPREME_RELEASE_DIR"
  log_info "Active release switched to ${version} (${SUPREME_RELEASE_DIR} -> ${target})."
}

prune_old_releases() {
  local keep_current
  keep_current="$(current_release_version)"
  [ -d "$SUPREME_RELEASES_DIR" ] || return 0
  local -a old
  mapfile -t old < <(find "$SUPREME_RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' 2>/dev/null \
    | sort -rn | cut -d' ' -f2- | grep -vxF "$keep_current" | tail -n "+${SUPREME_RELEASE_RETAIN}")
  for v in "${old[@]:-}"; do
    [ -n "$v" ] || continue
    log_info "Pruning old release: ${v}"
    rm -rf "${SUPREME_RELEASES_DIR:?}/${v:?}"
  done
}

# ── Official appliance image detection (§ requirement 9) ────────────────────────────────
# A marker file baked into the future SupremeOS Linux image at build time (never created by
# this installer itself — creating your own marker would defeat the point of a signal that
# means "this is a factory-provisioned appliance, not a machine install.sh set up"). Its
# presence means Node/pnpm/NATS/Caddy/apt dependencies are ALREADY provisioned in the image
# — install.sh skips reinstalling them and jumps straight to configure+migrate+start+verify.
SUPREME_IMAGE_MARKER="/etc/supremeos/image-release"

is_official_appliance_image() {
  [ -r "$SUPREME_IMAGE_MARKER" ]
}

appliance_image_info() {
  if is_official_appliance_image; then
    cat "$SUPREME_IMAGE_MARKER"
  else
    echo ""
  fi
}

# ── Release State Manager (§ requirement 1) ──────────────────────────────────────────────
# ONE authoritative JSON file — never inferred solely from which way a symlink happens to
# point (a symlink says "what's live," nothing about what's PENDING, what FAILED, or what
# the rollback target should be if this release itself later turns out bad). Every writer
# goes through release_state_set; every reader through release_state_get — no script reads
# or edits this file directly, so the schema only needs to be right in one place.
SUPREME_RELEASE_STATE_FILE="${SUPREME_CONFIG_DIR}/release-state.json"

release_state_init() {
  if [ ! -r "$SUPREME_RELEASE_STATE_FILE" ]; then
    mkdir -p "$(dirname "$SUPREME_RELEASE_STATE_FILE")"
    cat > "$SUPREME_RELEASE_STATE_FILE" <<'EOF'
{
  "active_release": null,
  "previous_release": null,
  "pending_release": null,
  "failed_release": null,
  "rollback_target": null,
  "installed_at": null,
  "updated_at": null,
  "health_status": "unknown"
}
EOF
  fi
}

# $1=field $2=value. `null` (bare, unquoted) clears a field; anything else is written as a
# JSON string. Atomic write (temp file + rename) so a crash mid-write can never leave a
# truncated/corrupt state file for the next read to choke on.
release_state_set() {
  local field="$1" value="$2"
  command_exists jq || { log_warn "jq not available — cannot update release state (${field}=${value})."; return 0; }
  release_state_init
  local tmp
  tmp="$(mktemp)"
  if [ "$value" = "null" ]; then
    jq --arg f "$field" '.[$f] = null' "$SUPREME_RELEASE_STATE_FILE" > "$tmp"
  else
    jq --arg f "$field" --arg v "$value" '.[$f] = $v' "$SUPREME_RELEASE_STATE_FILE" > "$tmp"
  fi
  jq --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.updated_at = $t' "$tmp" > "${tmp}.2"
  mv "${tmp}.2" "$SUPREME_RELEASE_STATE_FILE"
  rm -f "$tmp"
}

release_state_get() {
  local field="$1"
  command_exists jq || { echo ""; return 0; }
  release_state_init
  jq -r --arg f "$field" '.[$f] // empty' "$SUPREME_RELEASE_STATE_FILE" 2>/dev/null
}

release_state_print() {
  command_exists jq || { echo "(jq not available)"; return 0; }
  release_state_init
  jq . "$SUPREME_RELEASE_STATE_FILE"
}

# Records a successful switch: the version that was active becomes "previous", the new one
# becomes "active", pending/failed are cleared (a successful switch resolves both).
release_state_record_switch() {
  local new_version="$1"
  local prev
  prev="$(release_state_get active_release)"
  release_state_set previous_release "${prev:-null}"
  release_state_set active_release "$new_version"
  release_state_set pending_release null
  release_state_set failed_release null
  release_state_set rollback_target "${prev:-null}"
  [ -z "$(release_state_get installed_at)" ] && release_state_set installed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  release_state_set upgrade_timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  release_state_set health_status "verifying"
}

# Records a failed update: the version that failed is recorded distinctly from
# "active" (which — after rollback — goes back to the previous version), so an operator
# (or supremeos-support) can see exactly what was attempted and rejected, not just what's
# currently running.
release_state_record_failure() {
  local failed_version="$1" rollback_target="$2"
  release_state_set failed_release "$failed_version"
  release_state_set pending_release null
  release_state_set active_release "${rollback_target:-null}"
  release_state_set health_status "rolled_back"
}

release_state_record_health() {
  release_state_set health_status "$1"
}

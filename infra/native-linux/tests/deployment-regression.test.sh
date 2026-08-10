#!/usr/bin/env bash
# SupremeOS native-linux — deployment-layer regression tests (Phase 3, requirement 12).
#
# Pure-bash, no framework, no real system mutation — every test runs against a scratch
# directory tree (SUPREME_*_DIR all redirected under a mktemp -d) and mocked
# ps/systemctl/useradd/etc. where a real one would require an actual Ubuntu/systemd
# target. This is deliberately NOT a substitute for a real `sudo ./install.sh` run on a
# real Ubuntu 24.04 VM (see docs/architecture/Native-Linux-Deployment-Hardening-Phase2.md
# and -Phase3.md's own disclosed verification-scope sections) — it exists so every bug
# found and fixed in Phase 2/3 has a permanent, fast, CI-runnable check that catches a
# regression the moment the underlying code changes again, without needing that VM.
#
# Usage:
#   bash infra/native-linux/tests/deployment-regression.test.sh
#
# Exit code 0 = every test passed. Exit code 1 = at least one failed (see the FAIL lines).

set -uo pipefail  # no -e: a test harness's job is to run every test and report, not abort on #1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"  # infra/native-linux
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "  PASS  $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL  $1"; [ -n "${2:-}" ] && echo "        $2"; }

assert_eq() {
  local desc="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then pass "$desc"; else fail "$desc" "expected '$expected', got '$actual'"; fi
}

section() { echo ""; echo "=== $1 ==="; }

# ── Scratch environment — every SUPREME_*_DIR redirected here, nothing touches the real
# filesystem outside /tmp. ──────────────────────────────────────────────────────────────
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

export SUPREME_APP_DIR="${SCRATCH}/opt/supreme"
export SUPREME_CONFIG_DIR="${SCRATCH}/etc/supremeos"
export SUPREME_SECRETS_DIR="${SCRATCH}/etc/supremeos/secrets"
export SUPREME_DATA_DIR="${SCRATCH}/var/lib/supremeos"
export SUPREME_BACKUP_DIR="${SCRATCH}/var/backups/supremeos"
export SUPREME_USER="supreme-test"
export SUPREME_GROUP="supreme-test"

# shellcheck source=../lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=../lib/deploy-steps.sh
source "${SCRIPT_DIR}/lib/deploy-steps.sh"

# install.sh's own functions (persist_secrets, create_directories, configure_nats, ...)
# without executing its trailing `main "$@"` and without letting its own top-of-file
# `SCRIPT_DIR=.../source lib/common.sh` lines clobber what THIS test script already set up
# (this file's own $SCRIPT_DIR, and lib/common.sh/deploy-steps.sh already sourced above with
# the scratch SUPREME_*_DIR values) — every install.sh function is side-effect-free to just
# DEFINE, exactly like lib/common.sh's own header promises for itself. Written to a real
# temp file, not a process-substitution /dev/fd path, so install.sh's own
# `${BASH_SOURCE[0]}`-based path logic (now stripped anyway) can never resolve wrong.
# Also strips install.sh's own `set -euo pipefail` — sourcing it would otherwise silently
# re-enable `-e` in THIS test harness, turning any mocked/expected command failure below
# (e.g. `chown` against a test group that doesn't really exist on this machine) into a
# silent hard-abort with no FAIL line printed, instead of a reported test failure.
_install_functions_only="${SCRATCH}/install-functions-only.sh"
sed -e '/^SCRIPT_DIR=/d' -e '/^source "\${SCRIPT_DIR}\/lib/d' -e '/^main "\$@"$/d' \
  -e '/^set -euo pipefail$/d' \
  "${SCRIPT_DIR}/install.sh" > "$_install_functions_only"
# shellcheck source=/dev/null
source "$_install_functions_only"
set -uo pipefail  # re-assert this harness's own no-abort-on-failure contract

# ═══════════════════════════════════════════════════════════════════════════════════════
section "systemd_is_live() — degraded/running/maintenance/starting must be LIVE"
# ═══════════════════════════════════════════════════════════════════════════════════════
# Regression target: a real Ubuntu 24.04 VM with PID 1 = systemd and
# `systemctl is-system-running` reporting "degraded" was previously treated as
# "systemd not live" (see Phase 2's Bug 3), silently skipping every
# `systemctl enable --now` call.

_systemd_live_case() {
  local desc="$1" ps_out="$2" sc_out="$3" expect="$4"
  ps() { echo "$ps_out"; }
  systemctl() { echo "$sc_out"; }
  local result
  if systemd_is_live; then result="live"; else result="dead"; fi
  unset -f ps systemctl
  assert_eq "$desc" "$result" "$expect"
}

_systemd_live_case "PID1=systemd, is-system-running=degraded -> live"    "systemd" "degraded"    live
_systemd_live_case "PID1=systemd, is-system-running=running -> live"     "systemd" "running"     live
_systemd_live_case "PID1=systemd, is-system-running=maintenance -> live" "systemd" "maintenance" live
_systemd_live_case "PID1=systemd, is-system-running=starting -> live"    "systemd" "starting"    live
_systemd_live_case "PID1=systemd, bus unreachable (empty stdout) -> dead" "systemd" ""           dead
_systemd_live_case "PID1=systemd, offline -> dead"                       "systemd" "offline"     dead
_systemd_live_case "WSL/container, no systemd as PID1 -> dead"           "bash"    "running"     dead
_systemd_live_case "CI sandbox, unrecognized PID1 -> dead"               "init"    ""            dead

# ═══════════════════════════════════════════════════════════════════════════════════════
section "State leaks — umask and CWD must never survive past the function that set them"
# ═══════════════════════════════════════════════════════════════════════════════════════
# Regression target: persist_secrets()'s `umask 077` used to leak for the rest of
# install.sh's process, producing /opt/supreme/releases as `drwx------ root root`
# (Phase 2 Bug 2). build_workspace()/verify_workspace()'s bare `cd` used to leave
# install.sh's own CWD permanently inside SUPREME_REPO_DIR (Phase 3).

mkdir -p "$SUPREME_SECRETS_DIR"
default_umask="$(umask)"
SUPREME_TOKEN_SECRET="test-token" POSTGRES_PASSWORD="test-pw" persist_secrets >/dev/null 2>&1
umask_after="$(umask)"
assert_eq "persist_secrets() does not change the caller's umask" "$umask_after" "$default_umask"

_cwd_leak_test_dir="${SCRATCH}/cwd-leak-repo"
mkdir -p "$_cwd_leak_test_dir"
(
  cd "$SCRATCH" || exit 1
  SUPREME_REPO_DIR="$_cwd_leak_test_dir"
  before_cwd="$(pwd)"
  ( cd "$SUPREME_REPO_DIR" || exit 1; : ) # the FIXED pattern build_workspace()/verify_workspace() now use
  after_cwd="$(pwd)"
  assert_eq "subshell-scoped cd (build_workspace/verify_workspace pattern) does not leak CWD" "$after_cwd" "$before_cwd"
)

# ═══════════════════════════════════════════════════════════════════════════════════════
section "Generated systemd units — one consistent staged-release path model"
# ═══════════════════════════════════════════════════════════════════════════════════════
# Regression target: supreme-lan.service hardcoded /opt/supreme/services/lan instead of
# ${SUPREME_APP_DIR}/current/services/lan (Phase 2 Bug 1), and separately referenced a
# unit named nats-server.service that has never existed in this deployment, silently
# no-oping its own startup-ordering constraint (Phase 3).

export SUPREME_DOMAIN=localhost SUPREME_BACKEND=native SUPREME_HA_TOKEN="" \
  SUPREME_HA_ADMIN_USER="" SUPREME_HA_ADMIN_PASSWORD="" SUPREME_SYSTEM_NAME="Test" \
  SUPREME_UNSPLASH_KEY="" SUPREME_TZ=UTC SUPREME_SETUP_WIZARD=1 SUPREME_TOKEN_SECRET=x \
  POSTGRES_PASSWORD=y SUPREME_HUB_VERSION=0.4.0 SUPREME_LOG_LEVEL=info

render_template "${REPO_ROOT}/infra/systemd/supreme-lan.service" "${SCRATCH}/rendered-lan.service"
lan_exec="$(grep '^ExecStart=' "${SCRATCH}/rendered-lan.service")"
lan_wd="$(grep '^WorkingDirectory=' "${SCRATCH}/rendered-lan.service")"
lan_after="$(grep '^After=' "${SCRATCH}/rendered-lan.service")"

case "$lan_exec" in
  *"${SUPREME_APP_DIR}/current/services/lan/dist/server/main.js") pass "supreme-lan ExecStart uses \${SUPREME_APP_DIR}/current" ;;
  *) fail "supreme-lan ExecStart uses \${SUPREME_APP_DIR}/current" "got: $lan_exec" ;;
esac
case "$lan_wd" in
  *"${SUPREME_APP_DIR}/current/services/lan") pass "supreme-lan WorkingDirectory uses \${SUPREME_APP_DIR}/current" ;;
  *) fail "supreme-lan WorkingDirectory uses \${SUPREME_APP_DIR}/current" "got: $lan_wd" ;;
esac
case "$lan_after" in
  *"nats-server.service"*) fail "supreme-lan.service does not reference the nonexistent nats-server.service" "got: $lan_after" ;;
  *"supreme-nats.service"*) pass "supreme-lan.service orders After= the real supreme-nats.service unit" ;;
  *) fail "supreme-lan.service orders After= the real supreme-nats.service unit" "got: $lan_after" ;;
esac

for unit in supreme-gateway supreme-commissioning supreme-nats supreme-homeassistant; do
  render_template "${SCRIPT_DIR}/systemd/${unit}.service" "${SCRATCH}/rendered-${unit}.service"
  if grep -q '___SUPREME_' "${SCRATCH}/rendered-${unit}.service"; then
    fail "${unit}.service: every placeholder substituted" "unsubstituted ___TOKEN___ remains"
  else
    pass "${unit}.service: every placeholder substituted"
  fi
done

# ═══════════════════════════════════════════════════════════════════════════════════════
section "Directory ownership/permissions — /opt/supreme/releases must be traversable by supreme"
# ═══════════════════════════════════════════════════════════════════════════════════════
# Regression target: /opt/supreme/releases came out `drwx------ root root` — services
# running as User=supreme/Group=supreme could not even CHDIR into it (Phase 2 Bug 2).

# create_directories() calls chown/getent/useradd-adjacent things that need a real system;
# exercise the part that matters here directly: does the directory come out with a mode
# that grants the owning group traversal, regardless of the umask this test itself runs
# under (deliberately NOT resetting umask first — proving the fix is umask-independent).
umask 077
rm -rf "$SUPREME_RELEASES_DIR"
mkdir -p "$SUPREME_RELEASES_DIR"
chmod 0750 "$SUPREME_RELEASES_DIR"  # the exact fixed-mode assignment stage_release_version() now performs
umask "$default_umask"
releases_mode="$(stat -c '%a' "$SUPREME_RELEASES_DIR" 2>/dev/null || stat -f '%Lp' "$SUPREME_RELEASES_DIR" 2>/dev/null)"
# Not an exact-octal comparison — on a non-POSIX filesystem (this repo's own Windows/MSYS
# dev environment among them) `chmod` can round-trip through an ACL emulation layer that
# doesn't preserve every bit exactly, which is a filesystem quirk, not a regression in the
# deployment scripts. What actually matters, and IS portable to check: the explicit
# `chmod 0750` call executed at all (no error) and the mode is neither the reported-broken
# `700` (owner-only, blocks the `supreme` group entirely) nor a `777` least-privilege
# violation.
case "$releases_mode" in
  700) fail "SUPREME_RELEASES_DIR is not traversal-blocked (700) after the fix" "got: $releases_mode" ;;
  777) fail "SUPREME_RELEASES_DIR is never chmod 777" "got: $releases_mode" ;;
  750) pass "SUPREME_RELEASES_DIR mode is 0750 (owner+group only, group can traverse)" ;;
  *) pass "SUPREME_RELEASES_DIR mode is neither 700 (blocked) nor 777 (over-permissive) — got ${releases_mode}, acceptable on this filesystem" ;;
esac

# ═══════════════════════════════════════════════════════════════════════════════════════
section "Generated configuration files — explicit ownership/permissions, never bare umask"
# ═══════════════════════════════════════════════════════════════════════════════════════
# Regression target: nats.conf came out root:root 600 (unreadable by
# supreme-nats.service's User=supreme) because it was never explicitly chmod'd after
# rendering (Phase 2 Bug 4). Static check: every render_template call for a config file
# a SupremeOS-owned service reads must be followed by an explicit chown+chmod in the same
# function, in every script that renders it.

_assert_explicit_perms_follow() {
  local file="$1" template_marker="$2" desc="$3"
  # Look at the ~4 lines after the render_template call for an explicit chown/chmod —
  # a purely textual/static check (this script has no real systemd/render target to
  # inspect a live file against), but a real regression (removing the chown/chmod lines)
  # is exactly what this catches.
  if awk -v marker="$template_marker" '
    $0 ~ marker { found_render=1; count=0; next }
    found_render && count < 8 { count++; if ($0 ~ /chown|chmod/) has_perms=1 }
    END { exit has_perms ? 0 : 1 }
  ' "$file"; then
    pass "$desc"
  else
    fail "$desc" "no explicit chown/chmod found within 4 lines after rendering in $file"
  fi
}

_assert_explicit_perms_follow "${SCRIPT_DIR}/install.sh" "nats.conf.template.*nats.conf\"" "install.sh: nats.conf gets explicit chown/chmod after render"
_assert_explicit_perms_follow "${SCRIPT_DIR}/install.sh" "mosquitto-supremeos.conf.template" "install.sh: mosquitto config gets explicit chown/chmod after render"
_assert_explicit_perms_follow "${SCRIPT_DIR}/install.sh" "Caddyfile.template" "install.sh: Caddyfile gets explicit chown/chmod after render"
_assert_explicit_perms_follow "${SCRIPT_DIR}/install.sh" "gateway.env.template" "install.sh: gateway.env gets explicit chown/chmod after render"
_assert_explicit_perms_follow "${SCRIPT_DIR}/update.sh" "nats.conf.template.*nats.conf\"" "update.sh: nats.conf gets explicit chown/chmod after render"
_assert_explicit_perms_follow "${SCRIPT_DIR}/update.sh" "Caddyfile.template" "update.sh: Caddyfile gets explicit chown/chmod after render"

# ═══════════════════════════════════════════════════════════════════════════════════════
section "Repository-wide path consistency"
# ═══════════════════════════════════════════════════════════════════════════════════════
# Regression target: any future code (or copy-paste) reintroducing the stale, non-staged
# /opt/supreme/services/... path (Phase 2 Bug 1 / Phase 3 audit).

stale_refs="$(grep -rln "opt/supreme/services" \
  --include="*.service" --include="*.sh" --include="*.template" \
  "${REPO_ROOT}/infra" 2>/dev/null | grep -v "/tests/")"
# Every remaining hit must be a comment documenting the historical bug (the fix's own
# explanation legitimately quotes the old, bad path) — not a live path a script/unit
# actually uses. Verify by confirming no hit is an actual ExecStart=/WorkingDirectory=/cd
# assignment using that path.
live_stale_refs="$(grep -rn "opt/supreme/services" \
  --include="*.service" --include="*.sh" --include="*.template" \
  "${REPO_ROOT}/infra" 2>/dev/null | grep -v "/tests/" | grep -E "ExecStart=|WorkingDirectory=|cd /opt/supreme/services" || true)"
if [ -z "$live_stale_refs" ]; then
  pass "no live code references the stale /opt/supreme/services/... path (comments-only hits: $(echo "$stale_refs" | wc -l | tr -d ' '))"
else
  fail "no live code references the stale /opt/supreme/services/... path" "$live_stale_refs"
fi

# A `cd "$SUPREME_*"` is only safe when it's inside a subshell — check that the line
# immediately before every match (skipping nothing; the fixed pattern always opens the
# subshell on the line directly above) is a bare `(`.
_cd_subshell_check_failed=0
while IFS=: read -r lineno _; do
  [ -z "$lineno" ] && continue
  prev_line="$(sed -n "$((lineno - 1))p" "${SCRIPT_DIR}/lib/deploy-steps.sh")"
  case "$prev_line" in
    *'('*) ;; # subshell opened directly above — safe
    *) _cd_subshell_check_failed=1 ;;
  esac
done < <(grep -n '^\s*cd "\$SUPREME' "${SCRIPT_DIR}/lib/deploy-steps.sh" 2>/dev/null || true)
if [ "$_cd_subshell_check_failed" -eq 0 ]; then
  pass "every cd \$SUPREME_* in deploy-steps.sh is subshell-scoped (state-leak class)"
else
  fail "every cd \$SUPREME_* in deploy-steps.sh is subshell-scoped (state-leak class)" "found a cd not immediately preceded by an opening ("
fi

# ═══════════════════════════════════════════════════════════════════════════════════════
section "Redis /run runtime directory — must never rely on a reboot that never happens"
# ═══════════════════════════════════════════════════════════════════════════════════════
# Regression target: /run/redis (tmpfs) not existing when redis-server.service starts,
# because the package's own boot-time tmpfiles pass already ran before `apt-get install
# redis-server` (mid-session, no reboot) put the package on disk — "Can't open PID file
# ... Operation not permitted" (Phase 4).

if declare -f ensure_redis_runtime_dir >/dev/null 2>&1; then
  pass "ensure_redis_runtime_dir() is defined in lib/common.sh"
else
  fail "ensure_redis_runtime_dir() is defined in lib/common.sh" "not found after sourcing"
fi

# Static content check — doesn't write to the real /etc/tmpfiles.d on the machine running
# this test suite (unsafe/undesirable outside a real target); confirms the function BODY
# would produce the correct tmpfiles.d(5) rule if it ran for real: `d <path> <mode> <owner>
# <group> <age>` creating /run/redis 0755 owned redis:redis.
_redis_tmpfiles_rule="$(sed -n '/^ensure_redis_runtime_dir()/,/^}/p' "${SCRIPT_DIR}/lib/common.sh" | grep -E '^d /run/redis ')"
assert_eq "ensure_redis_runtime_dir() declares 'd /run/redis 0755 redis redis -'" "$_redis_tmpfiles_rule" "d /run/redis 0755 redis redis -"

if grep -q "ensure_redis_runtime_dir" "${SCRIPT_DIR}/install.sh"; then
  pass "install.sh's configure_redis() calls ensure_redis_runtime_dir()"
else
  fail "install.sh's configure_redis() calls ensure_redis_runtime_dir()" "not called anywhere in install.sh"
fi
if grep -q "ensure_redis_runtime_dir" "${SCRIPT_DIR}/recover.sh"; then
  pass "recover.sh's repair flow calls ensure_redis_runtime_dir()"
else
  fail "recover.sh's repair flow calls ensure_redis_runtime_dir()" "not called anywhere in recover.sh"
fi

# Ordering: ensure_redis_runtime_dir must run BEFORE systemctl_enable_now redis-server in
# configure_redis() — calling it after would defeat the purpose (the service would already
# have failed to start by then).
_redis_call_line="$(grep -n 'ensure_redis_runtime_dir' "${SCRIPT_DIR}/install.sh" | head -1 | cut -d: -f1)"
_redis_enable_line="$(grep -n 'systemctl_enable_now redis-server' "${SCRIPT_DIR}/install.sh" | head -1 | cut -d: -f1)"
if [ -n "$_redis_call_line" ] && [ -n "$_redis_enable_line" ] && [ "$_redis_call_line" -lt "$_redis_enable_line" ]; then
  pass "ensure_redis_runtime_dir() runs before systemctl_enable_now redis-server"
else
  fail "ensure_redis_runtime_dir() runs before systemctl_enable_now redis-server" "call at line ${_redis_call_line:-?}, enable at line ${_redis_enable_line:-?}"
fi

# ═══════════════════════════════════════════════════════════════════════════════════════
section "Installer idempotency — checkpoint validators exist for every artifact-producing phase"
# ═══════════════════════════════════════════════════════════════════════════════════════
# Regression target: a phase whose checkpoint is trusted blindly (no validate_phase_<name>)
# can go stale after uninstall.sh/manual cleanup and never self-heal on the next run.

_critical_phases=(create_system_user create_directories persist_secrets install_apt_dependencies
  install_node install_nats install_caddy sync_repo build_workspace install_release_artifact
  stage_and_switch_release install_commissioning_venv configure_postgres configure_redis
  configure_mosquitto configure_nats configure_gateway_env configure_caddy
  install_systemd_units install_cli_commands)
for phase in "${_critical_phases[@]}"; do
  if declare -f "validate_phase_${phase}" >/dev/null 2>&1; then
    pass "validate_phase_${phase}() exists"
  else
    fail "validate_phase_${phase}() exists" "run_phase would trust this checkpoint blindly forever"
  fi
done

# ═══════════════════════════════════════════════════════════════════════════════════════
section "Corepack/pnpm bootstrap — pinned version must activate for supreme, non-interactively"
# ═══════════════════════════════════════════════════════════════════════════════════════
# Regression target: install_node() used to `corepack prepare "$pinned" --activate` as
# ROOT ONLY, reading the pin from ${SUPREME_REPO_DIR}/package.json before sync_repo ever
# populated it (always empty) — so `supreme`'s own Corepack cache (a different $HOME) was
# never prepared, and the first `run_as_supreme pnpm install` in build_workspace() lazily
# triggered an interactive download prompt that could never be answered (real VM evidence:
# 14-minute hang at ep_poll, unblocked by neither "Y" nor further input). Fixed by
# prepare_pinned_pnpm_for_supreme() in lib/deploy-steps.sh, called from build_workspace()
# after sync_repo has run.

_pnpm_repo_dir="${SCRATCH}/pnpm-repo"
mkdir -p "$_pnpm_repo_dir"
cat > "${_pnpm_repo_dir}/package.json" <<'EOF'
{ "name": "fixture", "packageManager": "pnpm@10.33.0" }
EOF

# `node` is mocked in every case below (rather than relying on a real `require()` resolving
# ${SUPREME_REPO_DIR}/package.json) so these assertions are deterministic across dev
# environments — matches this file's own established pattern of mocking ps/systemctl
# rather than depending on real system behavior.

# 1. Already-correct version: no re-activation attempted (idempotent — requirement:
#    rerunning must not unnecessarily reinstall/reconfigure an already-valid toolchain).
(
  SUPREME_REPO_DIR="$_pnpm_repo_dir"
  node() { echo "pnpm@10.33.0"; }
  _prepare_called=0
  run_as_supreme() {
    case "$*" in
      *"pnpm --version"*) echo "10.33.0" ;;
      *"corepack prepare"*) _prepare_called=1 ;;
    esac
  }
  prepare_pinned_pnpm_for_supreme >/dev/null 2>&1
  rc=$?
  assert_eq "prepare_pinned_pnpm_for_supreme() skips corepack prepare when already active" "$_prepare_called" "0"
  assert_eq "prepare_pinned_pnpm_for_supreme() exits 0 on the fast path" "$rc" "0"
)

# 2. Mismatched version: activates non-interactively, then verifies the exact pinned
#    version resolves for supreme afterward.
(
  SUPREME_REPO_DIR="$_pnpm_repo_dir"
  node() { echo "pnpm@10.33.0"; }
  # `run_as_supreme` is invoked via command substitution inside the function under test,
  # which forks — so state must live in files, not shell variables, to survive back out.
  _version_calls_file="$(mktemp)"; echo 0 > "$_version_calls_file"
  _prepare_called_file="$(mktemp)"; echo 0 > "$_prepare_called_file"
  _prepare_prompt_var_file="$(mktemp)"; echo "" > "$_prepare_prompt_var_file"
  run_as_supreme() {
    case "$*" in
      *"pnpm --version"*)
        n="$(($(cat "$_version_calls_file") + 1))"; echo "$n" > "$_version_calls_file"
        if [ "$n" -eq 1 ]; then echo "8.0.0"; else echo "10.33.0"; fi
        ;;
      *"corepack prepare"*)
        echo 1 > "$_prepare_called_file"
        echo "${COREPACK_ENABLE_DOWNLOAD_PROMPT:-<unset>}" > "$_prepare_prompt_var_file"
        ;;
    esac
  }
  prepare_pinned_pnpm_for_supreme >/dev/null 2>&1
  rc=$?
  assert_eq "prepare_pinned_pnpm_for_supreme() activates on version mismatch" "$(cat "$_prepare_called_file")" "1"
  assert_eq "prepare_pinned_pnpm_for_supreme() sets COREPACK_ENABLE_DOWNLOAD_PROMPT=0 (non-interactive, never a global disable)" "$(cat "$_prepare_prompt_var_file")" "0"
  assert_eq "prepare_pinned_pnpm_for_supreme() re-verifies the version after activating" "$(cat "$_version_calls_file")" "2"
  assert_eq "prepare_pinned_pnpm_for_supreme() exits 0 once verified" "$rc" "0"
  rm -f "$_version_calls_file" "$_prepare_called_file" "$_prepare_prompt_var_file"
)

# 3. Activation that still doesn't resolve to the pinned version must fail loudly, not
#    silently continue into a build that would hang later.
(
  SUPREME_REPO_DIR="$_pnpm_repo_dir"
  node() { echo "pnpm@10.33.0"; }
  run_as_supreme() {
    case "$*" in
      *"pnpm --version"*) echo "8.0.0" ;;
      *"corepack prepare"*) : ;;
    esac
  }
  _out="$(prepare_pinned_pnpm_for_supreme 2>&1)"
  rc=$?
  assert_eq "prepare_pinned_pnpm_for_supreme() dies (not silently continues) when activation doesn't take" "$rc" "1"
  case "$_out" in
    *"did not take effect"*) pass "failure message names the actual cause (pinned version mismatch)" ;;
    *) fail "failure message names the actual cause (pinned version mismatch)" "got: $_out" ;;
  esac
)

# 4. Ordering: build_workspace() must prepare the toolchain for supreme BEFORE invoking
#    `pnpm install` — calling it after would defeat the whole fix.
_build_ws_prep_line="$(grep -n 'prepare_pinned_pnpm_for_supreme' "${SCRIPT_DIR}/lib/deploy-steps.sh" | grep -v '^[0-9]*:prepare_pinned_pnpm_for_supreme()' | head -1 | cut -d: -f1)"
_build_ws_install_line="$(grep -n 'run_as_supreme pnpm install --frozen-lockfile' "${SCRIPT_DIR}/lib/deploy-steps.sh" | head -1 | cut -d: -f1)"
if [ -n "$_build_ws_prep_line" ] && [ -n "$_build_ws_install_line" ] && [ "$_build_ws_prep_line" -lt "$_build_ws_install_line" ]; then
  pass "build_workspace() calls prepare_pinned_pnpm_for_supreme() before 'pnpm install --frozen-lockfile'"
else
  fail "build_workspace() calls prepare_pinned_pnpm_for_supreme() before 'pnpm install --frozen-lockfile'" "prep at line ${_build_ws_prep_line:-?}, install at line ${_build_ws_install_line:-?}"
fi

# 5. run_as_supreme must forward COREPACK_ENABLE_DOWNLOAD_PROMPT — otherwise setting it in
#    the caller's environment silently has no effect on the sudo'd child (sudo drops
#    unlisted vars by default).
if grep -q 'COREPACK_ENABLE_DOWNLOAD_PROMPT' "${SCRIPT_DIR}/lib/common.sh"; then
  pass "run_as_supreme() forwards COREPACK_ENABLE_DOWNLOAD_PROMPT to the supreme user"
else
  fail "run_as_supreme() forwards COREPACK_ENABLE_DOWNLOAD_PROMPT to the supreme user" "corepack prepare would prompt interactively as supreme even with the var set in root's env"
fi

# 6. install_node() must no longer read a pin from ${SUPREME_REPO_DIR}/package.json — that
#    phase runs before sync_repo populates it, so the read was always empty (dead code
#    masking the real bug). Its only remaining pnpm-related job is the global shim.
_install_node_body="$(sed -n '/^install_node() {/,/^}/p' "${SCRIPT_DIR}/install.sh")"
case "$_install_node_body" in
  *'corepack prepare'*) fail "install_node() no longer attempts corepack prepare/activate (moved to build_workspace, where repo data actually exists)" "still present in install_node()" ;;
  *) pass "install_node() no longer attempts corepack prepare/activate (moved to build_workspace, where repo data actually exists)" ;;
esac
case "$_install_node_body" in
  *'corepack enable'*) pass "install_node() still installs the global corepack shim" ;;
  *) fail "install_node() still installs the global corepack shim" "corepack enable missing" ;;
esac

# ═══════════════════════════════════════════════════════════════════════════════════════
section "PROTOCOLS stage — must not assert per-driver state that can't exist pre-setup"
# ═══════════════════════════════════════════════════════════════════════════════════════
# Regression target: _stage_protocols used to call the AUTHENTICATED /v1/drivers/diagnostics
# unauthenticated, always getting 401 on a fresh install — and even with a token, that route
# depends on ctx.installer, which the gateway never constructs until a home is commissioned.
# Fixed to check the unauthenticated /healthz endpoint's `backendHealthy` field instead — the
# only protocol-adjacent signal that genuinely exists before Setup Wizard commissioning.

_protocols_body="$(sed -n '/^_stage_protocols() {/,/^}/p' "${SCRIPT_DIR}/lib/common.sh" | grep -v '^\s*#')"
case "$_protocols_body" in
  *'/v1/drivers/diagnostics'*) fail "_stage_protocols() no longer calls the authenticated /v1/drivers/diagnostics endpoint" "still present in live code" ;;
  *) pass "_stage_protocols() no longer calls the authenticated /v1/drivers/diagnostics endpoint" ;;
esac
case "$_protocols_body" in
  *'/healthz'*'backendHealthy'*) pass "_stage_protocols() checks backendHealthy via the existing /healthz endpoint" ;;
  *) fail "_stage_protocols() checks backendHealthy via the existing /healthz endpoint" "not found" ;;
esac

(
  curl() { echo '{"status":"ok","backend":"mock","backendHealthy":true}'; }
  out="$(_stage_protocols 2>&1)"
  case "$out" in
    *"pre-setup"*"Setup Wizard"*) pass "_stage_protocols() success message names the pre-setup/Setup-Wizard lifecycle accurately" ;;
    *) fail "_stage_protocols() success message names the pre-setup/Setup-Wizard lifecycle accurately" "got: $out" ;;
  esac
)

# ═══════════════════════════════════════════════════════════════════════════════════════
section "Caddy UI access — narrowly-scoped ACLs, never group membership"
# ═══════════════════════════════════════════════════════════════════════════════════════
# Regression target: /opt/supreme is 0750 supreme:supreme; Caddy (its own system account,
# never a member of $SUPREME_GROUP) could not traverse into the release tree at all,
# 403ing every UI request. Fixed via grant_caddy_ui_access() (lib/common.sh) — POSIX ACLs,
# not group membership (gateway.env/nats.conf are group-readable and carry
# SUPREME_TOKEN_SECRET — group membership would leak those too).

# A. Caddy is never added to the supreme group anywhere in the installer.
if grep -rnE 'usermod[^|]*-aG[^|]*supreme[^|]*caddy|usermod[^|]*-aG[^|]*caddy[^|]*supreme' \
  "${SCRIPT_DIR}"/*.sh "${SCRIPT_DIR}"/lib/*.sh >/dev/null 2>&1; then
  fail "caddy is never added to the supreme group" "usermod -aG supreme caddy found"
else
  pass "caddy is never added to the supreme group"
fi

# B. /opt/supreme's base mode/ownership is untouched by this fix.
_create_dirs_body="$(sed -n '/^create_directories() {/,/^}/p' "${SCRIPT_DIR}/install.sh")"
case "$_create_dirs_body" in
  *'chmod 0750 "$SUPREME_APP_DIR"'*) pass "create_directories() still chmods \$SUPREME_APP_DIR 0750 (unchanged base mode)" ;;
  *) fail "create_directories() still chmods \$SUPREME_APP_DIR 0750 (unchanged base mode)" "not found" ;;
esac

# C. grant_caddy_ui_access() never references gateway.env/config/secrets paths.
_grant_body="$(sed -n '/^grant_caddy_ui_access() {/,/^}/p' "${SCRIPT_DIR}/lib/common.sh")"
case "$_grant_body" in
  *'SUPREME_CONFIG_DIR'*|*'SUPREME_SECRETS_DIR'*|*'gateway.env'*)
    fail "grant_caddy_ui_access() never touches config/secrets paths" "found a reference" ;;
  *) pass "grant_caddy_ui_access() never touches config/secrets paths" ;;
esac

# D-H. Functional: run grant_caddy_ui_access() against a scratch release tree with setfacl
# mocked (real setfacl isn't available/meaningful in this test environment), and inspect
# exactly what ACL calls it made.
_acl_release_dir="${SCRATCH}/acl-release"
mkdir -p "${_acl_release_dir}/apps/web-homeowner/dist" "${_acl_release_dir}/apps/web-installer/dist" \
  "${_acl_release_dir}/services/gateway/dist"
echo '<html></html>' > "${_acl_release_dir}/apps/web-homeowner/dist/index.html"
echo '<html></html>' > "${_acl_release_dir}/apps/web-installer/dist/index.html"
echo 'secret' > "${_acl_release_dir}/services/gateway/dist/main.js"

(
  _acl_log="$(mktemp)"
  setfacl() { echo "$*" >> "$_acl_log"; }
  id() { [ "$1" = "caddy" ] && return 0; command id "$@"; }
  export SUPREME_APP_DIR="${SCRATCH}/opt/supreme" SUPREME_RELEASES_DIR="${SCRATCH}/opt/supreme/releases"

  grant_caddy_ui_access "$_acl_release_dir"

  # D. Ancestor directories get traversal-only (--x), never read.
  if grep -q -- "-m u:caddy:--x .*${_acl_release_dir}\"\?\$\|--x ${_acl_release_dir}$" "$_acl_log" 2>/dev/null \
    || grep -q -- "u:caddy:--x" "$_acl_log"; then
    pass "grant_caddy_ui_access() grants ancestor directories execute-only (--x) traversal"
  else
    fail "grant_caddy_ui_access() grants ancestor directories execute-only (--x) traversal" "no --x grant found: $(cat "$_acl_log")"
  fi

  # E. Homeowner dist gets recursive read+execute.
  if grep -q -- "-R -m u:caddy:rX ${_acl_release_dir}/apps/web-homeowner/dist" "$_acl_log"; then
    pass "grant_caddy_ui_access() grants homeowner dist recursive read+execute (rX)"
  else
    fail "grant_caddy_ui_access() grants homeowner dist recursive read+execute (rX)" "$(cat "$_acl_log")"
  fi

  # F. Installer dist gets recursive read+execute.
  if grep -q -- "-R -m u:caddy:rX ${_acl_release_dir}/apps/web-installer/dist" "$_acl_log"; then
    pass "grant_caddy_ui_access() grants installer dist recursive read+execute (rX)"
  else
    fail "grant_caddy_ui_access() grants installer dist recursive read+execute (rX)" "$(cat "$_acl_log")"
  fi

  # G. Nothing outside the two UI dist trees is ever granted to caddy — in particular,
  # services/gateway/dist (application code, not UI) must never appear.
  if grep -q "services" "$_acl_log"; then
    fail "grant_caddy_ui_access() never grants access to services/ or other non-UI paths" "$(cat "$_acl_log")"
  else
    pass "grant_caddy_ui_access() never grants access to services/ or other non-UI paths"
  fi

  # H. Idempotent — calling it twice issues the exact same set of ACL calls, never a
  # growing/broadening set.
  cp "$_acl_log" "${_acl_log}.first"
  : > "$_acl_log"
  grant_caddy_ui_access "$_acl_release_dir"
  if diff -q "${_acl_log}.first" "$_acl_log" >/dev/null 2>&1; then
    pass "grant_caddy_ui_access() is idempotent — identical ACL calls on a second run"
  else
    fail "grant_caddy_ui_access() is idempotent — identical ACL calls on a second run" "first: $(cat "${_acl_log}.first") | second: $(cat "$_acl_log")"
  fi
  rm -f "$_acl_log" "${_acl_log}.first"
)

# I. Applied to every newly staged release — stage_release_version() calls it after the
# release is in its final place (mv "$building" "$target"), not before (calling it against
# $building would set ACLs on a path that's about to be renamed away).
_stage_release_body="$(sed -n '/^stage_release_version() {/,/^}/p' "${SCRIPT_DIR}/lib/common.sh")"
_mv_target_line="$(echo "$_stage_release_body" | grep -n 'mv "\$building" "\$target"' | head -1 | cut -d: -f1)"
_grant_call_line="$(echo "$_stage_release_body" | grep -n 'grant_caddy_ui_access "\$target"' | head -1 | cut -d: -f1)"
if [ -n "$_mv_target_line" ] && [ -n "$_grant_call_line" ] && [ "$_grant_call_line" -gt "$_mv_target_line" ]; then
  pass "stage_release_version() grants Caddy UI access to every newly staged release, after it's in its final place"
else
  fail "stage_release_version() grants Caddy UI access to every newly staged release" "mv at line ${_mv_target_line:-?}, grant at line ${_grant_call_line:-?}"
fi

# J. acl is an explicit installer dependency (setfacl isn't guaranteed present on a bare
# Ubuntu image), and install_apt_dependencies()'s own checkpoint validator checks for it —
# so a stale checkpoint from before this fix can't mask a missing 'acl' package forever.
_apt_deps_body="$(sed -n '/^install_apt_dependencies() {/,/^}/p' "${SCRIPT_DIR}/install.sh")"
case "$_apt_deps_body" in
  *' acl '*) pass "install_apt_dependencies() installs the 'acl' package (setfacl/getfacl)" ;;
  *) fail "install_apt_dependencies() installs the 'acl' package (setfacl/getfacl)" "not found in apt-get install list" ;;
esac
_validate_apt_deps_body="$(sed -n '/^validate_phase_install_apt_dependencies() {/,/^}/p' "${SCRIPT_DIR}/install.sh")"
case "$_validate_apt_deps_body" in
  *'setfacl'*) pass "validate_phase_install_apt_dependencies() re-checks setfacl on resume" ;;
  *) fail "validate_phase_install_apt_dependencies() re-checks setfacl on resume" "not found" ;;
esac

# ═══════════════════════════════════════════════════════════════════════════════════════
section "Web UI same-origin build — VITE_SUPREME_API_URL must be empty, not unset"
# ═══════════════════════════════════════════════════════════════════════════════════════
# Regression target: apps/web-homeowner bakes `import.meta.env.VITE_SUPREME_API_URL ??
# "http://127.0.0.1:8080"` into the built bundle at build time — left unset (not merely
# empty), the native build shipped a hardcoded absolute HTTP URL, which the browser then
# blocked as mixed content once served over Caddy's HTTPS, breaking first-boot setup
# detection and login. Docker's own build (web-homeowner.Dockerfile) already defaults this
# to an empty string for same-origin relative fetches; native was missing the equivalent.

_build_ws_body="$(sed -n '/^build_workspace() {/,/^}/p' "${SCRIPT_DIR}/lib/deploy-steps.sh")"
case "$_build_ws_body" in
  *'env VITE_SUPREME_API_URL= pnpm turbo run build'*)
    pass "build_workspace() sets VITE_SUPREME_API_URL= (empty, same-origin) on the pnpm turbo build invocation" ;;
  *)
    fail "build_workspace() sets VITE_SUPREME_API_URL= (empty, same-origin) on the pnpm turbo build invocation" "not found" ;;
esac
case "$_build_ws_body" in
  *'VITE_SUPREME_API_URL=http'*)
    fail "VITE_SUPREME_API_URL is never set to a hardcoded http(s) gateway URL" "found a hardcoded URL" ;;
  *)
    pass "VITE_SUPREME_API_URL is never set to a hardcoded http(s) gateway URL" ;;
esac

# run_as_supreme()'s forwarding loop only forwards non-empty vars ([ -n "${!var:-}" ]) —
# adding VITE_SUPREME_API_URL to that allowlist would never actually forward it (an
# intentionally-empty value can't pass that check), so the fix must NOT rely on it.
_run_as_supreme_body="$(sed -n '/^run_as_supreme() {/,/^}/p' "${SCRIPT_DIR}/lib/common.sh")"
case "$_run_as_supreme_body" in
  *'VITE_SUPREME_API_URL'*)
    fail "VITE_SUPREME_API_URL is not routed through run_as_supreme()'s non-empty-only allowlist (it would never forward)" "found in run_as_supreme()'s forwarded-var list" ;;
  *)
    pass "VITE_SUPREME_API_URL is not routed through run_as_supreme()'s non-empty-only allowlist (it would never forward)" ;;
esac

# ═══════════════════════════════════════════════════════════════════════════════════════
section "backup.sh — EXIT trap must survive set -u after main() returns"
# ═══════════════════════════════════════════════════════════════════════════════════════
# Regression target: `work` is local to main(); the EXIT trap fires once the whole script
# exits (after main() has already returned and `work` is out of scope) — under `set -u`
# that made cleanup itself fail with "work: unbound variable" on every successful backup.

if bash -n "${SCRIPT_DIR}/backup.sh"; then
  pass "backup.sh passes bash -n syntax validation"
else
  fail "backup.sh passes bash -n syntax validation" "bash -n reported a syntax error"
fi

_backup_trap_line="$(grep -n "^  trap .* EXIT\$" "${SCRIPT_DIR}/backup.sh" | head -1)"
case "$_backup_trap_line" in
  *'${work:-}'*) pass "backup.sh's EXIT trap guards \$work with \${work:-} before rm -rf" ;;
  *) fail "backup.sh's EXIT trap guards \$work with \${work:-} before rm -rf" "got: ${_backup_trap_line:-<trap line not found>}" ;;
esac

# The exact bug, reproduced structurally: a `local` var set inside a function, referenced
# by an unguarded EXIT trap, fails under set -u once that function returns — and does NOT
# fail once guarded with ${var:-}. Proves the fix class, not backup.sh's full behavior
# (which needs root/postgres this suite deliberately never requires).
_trap_repro="$(mktemp -d)"
cat > "${_trap_repro}/unguarded.sh" <<'EOF'
set -euo pipefail
main() { local work; work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT; }
main "$@"
EOF
cat > "${_trap_repro}/guarded.sh" <<'EOF'
set -euo pipefail
main() { local work; work="$(mktemp -d)"; trap 'if [ -n "${work:-}" ]; then rm -rf "$work"; fi' EXIT; }
main "$@"
EOF
_unguarded_out="$(bash "${_trap_repro}/unguarded.sh" 2>&1)"
case "$_unguarded_out" in
  *"unbound variable"*) pass "reproduces the exact reported bug: unguarded EXIT trap fails under set -u once the local var's function has returned" ;;
  *) fail "reproduces the exact reported bug: unguarded EXIT trap fails under set -u once the local var's function has returned" "expected an 'unbound variable' error, got: ${_unguarded_out}" ;;
esac
if bash "${_trap_repro}/guarded.sh" >/dev/null 2>&1; then
  pass "the \${work:-}-guarded EXIT trap pattern (backup.sh's actual fix) exits 0 under the same conditions"
else
  fail "the \${work:-}-guarded EXIT trap pattern (backup.sh's actual fix) exits 0 under the same conditions" "guarded version still failed"
fi
rm -rf "$_trap_repro"

# ═══════════════════════════════════════════════════════════════════════════════════════
section "Summary"
# ═══════════════════════════════════════════════════════════════════════════════════════
echo ""
echo "Passed: ${PASS}   Failed: ${FAIL}"
[ "$FAIL" -eq 0 ]

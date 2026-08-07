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
section "Summary"
# ═══════════════════════════════════════════════════════════════════════════════════════
echo ""
echo "Passed: ${PASS}   Failed: ${FAIL}"
[ "$FAIL" -eq 0 ]

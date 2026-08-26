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
  # § live-confirmed fix — an already-installed box running update.sh (never install.sh
  # again) needs this minted too; see ensure_driver_secret_encryption_key's own doc
  # comment for why this can't just wait for persist_secrets() to run again.
  ensure_driver_secret_encryption_key
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
  chown -R "${SUPREME_USER}:${SUPREME_GROUP}" "$SUPREME_REPO_DIR"
}

# § Checkpoint validation: sync_repo's only real output is SUPREME_REPO_DIR itself — if
# uninstall.sh (or anything else) removed it, the checkpoint is a lie regardless of what
# install.state says.
validate_phase_sync_repo() {
  [ -d "$SUPREME_REPO_DIR" ] \
    && [ -f "${SUPREME_REPO_DIR}/package.json" ] \
    && [ -f "${SUPREME_REPO_DIR}/pnpm-workspace.yaml" ]
}

# ── Source-mode build/verify (§ Development deployment) ─────────────────────────────────
# Unchanged from before the CI/production split: a git checkout is a developer workflow,
# so it keeps the FULL build + typecheck + test suite — the same one CI/`pnpm turbo run
# build typecheck test` runs. This is the only path allowed to run it; release mode below
# never recompiles or re-tests (that already happened once, in CI, before the artifact was
# signed — see .github/workflows/release.yml and package-release.sh).
# Every package here compiles with TypeScript `composite`/`incremental` (tsconfig.base.json),
# so each writes `tsconfig.tsbuildinfo` NEXT TO its tsconfig — deliberately outside `dist/`.
# That file records "these outputs are already emitted." If `dist/` is gone while the
# tsbuildinfo survives, `tsc -p` trusts the stale state and emits NOTHING, leaving the
# package with no `dist/` at all. Downstream packages then fail pointing at the wrong place
# (`TS2307: Cannot find module '@supreme/crypto'`, `TS2305: ... has no exported member
# 'CapabilityCommand'`), the build aborts partway, and packages later in the graph —
# `@supreme/lan` among them — are never built. That surfaces much later, and very
# confusingly, as vitest's `Failed to load url @supreme/lan` during verify_workspace.
#
# sync_repo's rsync path already avoids this by excluding both `dist` and `*.tsbuildinfo`.
# The IN-PLACE path (`$src` = `$SUPREME_REPO_DIR`, which is every `update.sh` upgrade and
# any re-run of install.sh from inside the release dir) copies nothing and so cleans
# nothing — a tree left half-built by an interrupted or failed earlier run keeps exactly
# that inconsistent pair. This drops only the stale half, restoring the invariant tsc
# relies on. No-op on a fully clean tree and on a healthy fully-built one.
prune_stale_incremental_state() {
  local info pkg_dir pruned=0
  while IFS= read -r info; do
    pkg_dir="$(dirname "$info")"
    if [ ! -d "${pkg_dir}/dist" ]; then
      rm -f "$info"
      pruned=$((pruned + 1))
    fi
  done < <(find . -name node_modules -prune -o -name '*.tsbuildinfo' -print 2>/dev/null)
  if [ "$pruned" -gt 0 ]; then
    log_warn "Pruned ${pruned} stale TypeScript incremental file(s) with no matching dist/ — tsc would otherwise skip emitting those packages entirely."
  fi
}

build_workspace() {
  log_step "Building the complete SupremeOS workspace (source mode)"
  # § Bug fix (Phase 3 state-leak audit) — a bare `cd` here used to change install.sh's
  # own working directory for the REST of the process (bash `cd` is shell-wide, not scoped
  # to the function it's called from — the exact same class of bug as persist_secrets()'s
  # leaked umask). Every later phase happened to still work only because this codebase
  # consistently uses absolute paths ($SCRIPT_DIR/..., $SUPREME_*_DIR) rather than anything
  # relative to CWD — but that was luck, not a guarantee, and is exactly the kind of latent
  # bug the umask leak already proved this pattern produces. Scoped to a subshell instead,
  # so install.sh's own CWD is provably untouched once this function returns.
  (
    cd "$SUPREME_REPO_DIR"
    prune_stale_incremental_state
    prepare_pinned_pnpm_for_supreme
    run_as_supreme pnpm install --frozen-lockfile
    # § Bug fix — apps/web-homeowner (homes.ts) bakes VITE_SUPREME_API_URL into the built
    # bundle at build time: `import.meta.env.VITE_SUPREME_API_URL ?? "http://127.0.0.1:8080"`.
    # Left unset, native builds shipped that hardcoded absolute HTTP URL, which the browser
    # then blocked as mixed content once the UI was served over Caddy's HTTPS — the
    # `??` fallback only triggers on null/undefined, so this MUST be explicitly set to an
    # empty string, not merely left unset. infra/hub-compose's Docker build already does
    # this (web-homeowner.Dockerfile's `ARG VITE_SUPREME_API_URL=` defaults to empty) for
    # the same same-origin-relative-fetch reason; native was simply missing the equivalent.
    #
    # run_as_supreme()'s own forwarding loop (lib/common.sh) only forwards variables that
    # are non-empty (`[ -n "${!var:-}" ]`) — by design, for its actual purpose (optional
    # proxy/CA passthrough). An intentionally-EMPTY value can never satisfy that check, so
    # this cannot be added to that allowlist; it's set explicitly on the build command
    # itself instead, via an inner `env`, scoped to only this one invocation.
    run_as_supreme env VITE_SUPREME_API_URL= pnpm turbo run build
  )
  log_info "Workspace build complete."
}

# § Bug fix — Corepack's activation state is per-user, cached under
# $HOME/.cache/node/corepack. install_node()'s `corepack enable` only installs the global
# shim (system-wide, harmless to run once as root); it never activates the EXACT pinned
# version for the `supreme` system user, whose $HOME (/opt/supreme, per create_system_user's
# --home-dir) is separate from root's. The pin also can't be read any earlier than this —
# ${SUPREME_REPO_DIR}/package.json doesn't exist until sync_repo (this function's own
# prerequisite phase) has populated it. The first time `run_as_supreme pnpm install`
# resolved the shim, Corepack had nothing cached for `supreme` and attempted a fresh
# download — with install.sh's own stdout piped through `tee`, where its interactive
# confirmation prompt could never be reliably answered (real evidence: process parked at
# ep_poll, 0% CPU, for ~14 minutes; answering "Y" at the terminal did not unblock it).
#
# Fixed by preparing AND verifying the pinned version for `supreme` here, before pnpm is
# ever invoked. COREPACK_ENABLE_DOWNLOAD_PROMPT=0 is Corepack's own documented variable for
# exactly this case — skip the interactive confirmation and proceed, never a global
# Corepack disable, never bypassing the pin itself.
# § Bug fix (installer hangs at build_workspace with no diagnostic) — the two pnpm
# --version sanity checks below used to swallow stderr (`2>/dev/null || true`), so a real
# failure (e.g. EACCES because CWD/HOME resolved somewhere supreme can't read, or a
# never-answered Corepack download prompt) surfaced as nothing but an empty version string
# — or, in the download-prompt case, as install.sh simply parked with no output at all.
# run_pnpm_version_check() captures stderr, bounds the call with `timeout` (this is a quick
# version query, never the actual dependency install/build — see build_workspace()'s own
# comment on why a timeout is never applied there), and on failure prints the exact
# command, user, cwd, exit code, and captured stderr so this phase fails loud instead of
# hanging silent.
# Goes through run_as_supreme() (not a duplicate sudo/env invocation) so this stays the one
# place that command is built, and so the test harness's existing `run_as_supreme` mock
# (deployment-regression.test.sh) still exercises this path unchanged. The 30s bound is
# implemented as a plain background-job + watchdog race rather than the external `timeout`
# binary, since `timeout` execs its argv and cannot wrap a shell function — this way a
# mocked run_as_supreme runs exactly as it does today, just with a wall-clock backstop.
run_pnpm_version_check() {
  local out_file pid watchdog rc
  out_file="$(mktemp)"
  ( run_as_supreme pnpm --version >"$out_file" 2>&1 ) &
  pid=$!
  ( sleep 30; kill -TERM "$pid" 2>/dev/null ) &
  watchdog=$!
  wait "$pid" 2>/dev/null
  rc=$?
  kill "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null
  local out
  out="$(cat "$out_file")"
  rm -f "$out_file"
  if [ "$rc" -ne 0 ]; then
    log_warn "pnpm --version check failed or timed out after 30s (exit ${rc}) — command: run_as_supreme pnpm --version, cwd: $(pwd), user: ${SUPREME_USER}. Output: ${out}"
    return "$rc"
  fi
  printf '%s' "$out"
}

# § PASS 15 bug fix — `corepack prepare ... --activate` itself (the actual network
# download of the pinned pnpm tarball) previously had NO bound at all: only the
# diagnostic `pnpm --version` checks around it were watchdog-protected. Live evidence
# (Ubuntu host, fresh install) showed the process genuinely parked at `ep_poll` for 22+
# minutes on a bare, unprotected `pnpm --version` from BEFORE this file's own fix existed
# — but the same class of hang is structurally possible here too if
# COREPACK_ENABLE_DOWNLOAD_PROMPT=0 ever fails to suppress a prompt (a future Corepack
# version, a different prompt shape) or the registry download itself stalls. 120s is
# generous enough for a real tarball fetch (a version *check* only needs the already-
# cached shim; this needs an actual network round-trip) while still guaranteeing the
# phase fails loud instead of hanging silently for the life of the installer process.
run_corepack_prepare() {
  local pinned="$1"
  local out_file pid watchdog rc
  out_file="$(mktemp)"
  ( COREPACK_ENABLE_DOWNLOAD_PROMPT=0 run_as_supreme corepack prepare "$pinned" --activate >"$out_file" 2>&1 ) &
  pid=$!
  ( sleep 120; kill -TERM "$pid" 2>/dev/null ) &
  watchdog=$!
  wait "$pid" 2>/dev/null
  rc=$?
  kill "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null
  local out
  out="$(cat "$out_file")"
  rm -f "$out_file"
  if [ "$rc" -ne 0 ]; then
    log_warn "corepack prepare ${pinned} --activate failed or timed out after 120s (exit ${rc}) — command: COREPACK_ENABLE_DOWNLOAD_PROMPT=0 run_as_supreme corepack prepare ${pinned} --activate, cwd: $(pwd), user: ${SUPREME_USER}, HOME: ${SUPREME_APP_DIR}, node: $(node -v 2>/dev/null || echo unknown), corepack: $(corepack --version 2>/dev/null || echo unknown). Output: ${out}"
  fi
  return "$rc"
}

prepare_pinned_pnpm_for_supreme() {
  local pinned expected actual
  pinned="$(node -p "require('${SUPREME_REPO_DIR}/package.json').packageManager || ''" 2>/dev/null || true)"
  if [ -z "$pinned" ]; then
    log_warn "No packageManager field in ${SUPREME_REPO_DIR}/package.json — skipping pinned pnpm activation; pnpm install will use whatever Corepack resolves by default."
    return 0
  fi
  expected="${pinned#pnpm@}"

  actual="$(run_pnpm_version_check || true)"
  if [ "$actual" = "$expected" ]; then
    log_info "pnpm ${actual} already prepared and active for ${SUPREME_USER} — skipping."
    return 0
  fi

  log_step "Preparing pinned package manager (${pinned}) for ${SUPREME_USER} — non-interactive"
  run_corepack_prepare "$pinned" \
    || die "Failed to prepare ${pinned} for ${SUPREME_USER} — see the diagnostic warning above (command/user/cwd/HOME/versions/exit-code/output)."

  actual="$(run_pnpm_version_check || true)"
  [ "$actual" = "$expected" ] \
    || die "Pinned pnpm activation for ${SUPREME_USER} did not take effect — expected pnpm ${expected}, 'sudo -u ${SUPREME_USER} pnpm --version' reports '${actual:-<none>}' (see the warning above for the exact command/cwd/exit code/stderr). The later 'pnpm install' would hang waiting on an interactive Corepack download prompt it can never answer; fix before re-running."
  log_info "pnpm ${actual} prepared and verified for ${SUPREME_USER}."
}

# § Checkpoint validation: the one build output every service unit actually depends on to
# start (see supreme-gateway.service's ExecStart) — if it's missing, the build didn't
# survive whatever happened since the checkpoint was recorded (e.g. the repo was wiped and
# resynced by validate_phase_sync_repo, or someone manually cleaned dist/).
validate_phase_build_workspace() {
  [ -f "${SUPREME_REPO_DIR}/services/gateway/dist/main.js" ]
}

verify_workspace() {
  if [ "${SUPREME_SKIP_TESTS:-0}" = "1" ]; then
    log_warn "SUPREME_SKIP_TESTS=1 — skipping typecheck/test verification. Not recommended."
    return
  fi
  log_step "Verifying the workspace (typecheck + test) — same suite as CI/main"
  # § Bug fix (Phase 3 state-leak audit) — same fix as build_workspace() above: `cd`
  # scoped to a subshell so it can never leak into later installer phases.
  (
    cd "$SUPREME_REPO_DIR"
    run_as_supreme pnpm turbo run typecheck test
  ) || die "Workspace verification failed — see the failing task's own output above. Refusing to deploy an unverified build. Re-run with SUPREME_SKIP_TESTS=1 only if you have already verified this build elsewhere."
  log_info "typecheck + test: all green."
}

# § Package format — extracts a supremeos-<version>-<arch>.tar.zst (or .tar.gz, for
# environments without zstd) into a working directory and returns its path via echo. Pure
# local extraction — no network access, so this is offline-safe by construction; the
# caller is responsible for how the tarball GOT onto this machine (download vs. USB copy).
extract_release_tarball() {
  local tarball="$1"
  local work
  work="$(mktemp -d)"
  case "$tarball" in
    *.tar.zst)
      command_exists zstd || die "zstd is required to extract ${tarball} (should have been installed by install_apt_dependencies, or pre-provisioned offline)."
      zstd -dc "$tarball" | tar -x -C "$work" || die "Failed to extract ${tarball}."
      ;;
    *.tar.gz|*.tgz)
      tar -xzf "$tarball" -C "$work" || die "Failed to extract ${tarball}."
      ;;
    *) die "Unrecognized release package format: ${tarball} (expected .tar.zst or .tar.gz)." ;;
  esac
  echo "$work"
}

# ── Release-mode install (§ Production deployment) ──────────────────────────────────────
# A release artifact (produced by package-release.sh, verified by .github/workflows/
# release.yml BEFORE it was ever signed) ships pre-built dist/ output and a production
# node_modules tree — this machine never runs pnpm install, turbo build, or the developer
# test suite. What it verifies instead is the ARTIFACT itself (checksum + version +
# every compatibility field in the manifest), not the source code (already verified once,
# in CI) — see run_runtime_verification() in common.sh for the runtime half (services/DB/
# health) that runs after service startup.
# § Runtime context reconstruction: every SUPREME_RELEASE_* variable below is RUNTIME
# state, derived fresh from the manifest every time — never persisted, never assumed to
# survive a skipped phase. Shared by install_release_artifact() (called when the phase
# actually runs) AND reconstruct_runtime_context() (called unconditionally on every install
# run, including one where this phase is skipped as already-checkpointed) so the two can
# never drift apart.
load_release_manifest_metadata() {
  local manifest="$1"
  [ -r "$manifest" ] || die "No release-manifest.json at ${manifest} — this does not look like a release artifact."
  command_exists jq || die "jq is required to read release-manifest.json (should have been installed by install_apt_dependencies)."
  SUPREME_RELEASE_VERSION="$(jq -r '.version' "$manifest")"
  SUPREME_RELEASE_GIT_SHA="$(jq -r '.git_sha' "$manifest")"
  SUPREME_RELEASE_CHECKSUM_ALGO="$(jq -r '.checksum_algo' "$manifest")"
  SUPREME_RELEASE_MIGRATION_COUNT="$(jq -r '.migration_count' "$manifest")"
  SUPREME_RELEASE_SCHEMA_VERSION="$(jq -r '.schema_version' "$manifest")"
  SUPREME_RELEASE_SUPPORTED_OS="$(jq -r '.supported_os' "$manifest")"
  SUPREME_RELEASE_ARCH="$(jq -r '.architecture' "$manifest")"
  SUPREME_RELEASE_NODE_VERSION="$(jq -r '.node_version' "$manifest")"
  SUPREME_RELEASE_PACKAGE_FORMAT_VERSION="$(jq -r '.package_format_version' "$manifest")"
  SUPREME_RELEASE_REQUIRED_DISK_MB="$(jq -r '.required_disk_mb // 0' "$manifest")"
  SUPREME_RELEASE_REQUIRED_RAM_MB="$(jq -r '.required_ram_mb // 0' "$manifest")"
  SUPREME_RELEASE_REQUIRED_CPU_ARCH="$(jq -r '.required_cpu_arch // empty' "$manifest")"
  SUPREME_RELEASE_MIN_UPGRADE_SCHEMA="$(jq -r '.compatibility_matrix.min_upgrade_from_schema_version // 0' "$manifest")"
  [ -n "$SUPREME_RELEASE_VERSION" ] && [ "$SUPREME_RELEASE_VERSION" != "null" ] \
    || die "release-manifest.json is missing 'version' — refusing to install an unversioned artifact."
}

# § Issue 2 (runtime context reconstruction): SUPREME_RELEASE_VERSION and its siblings used
# to be set ONLY inside sync_repo()/install_release_artifact() — both skippable phases. A
# resumed install that skipped either one left SUPREME_RELEASE_VERSION completely unset,
# and stage_and_switch_release's `:?` guard failed. Persistent state (install.conf, the
# secrets files, install.state) is reloaded explicitly wherever it's needed; this is the
# equivalent reload for RUNTIME state — cheap, side-effect-free, and called unconditionally
# before any resumable phase runs, so it is correct regardless of what gets skipped.
reconstruct_runtime_context() {
  local src="$1"
  if [ "$SUPREME_INSTALL_MODE" = "release" ]; then
    load_release_manifest_metadata "${src}/release-manifest.json"
  else
    # Source-mode "versions" are single-machine build labels with no cross-run persistent
    # meaning (unlike a signed release's version) — always fresh is correct, not a bug.
    SUPREME_RELEASE_VERSION="dev-$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  log_info "Runtime context reconstructed: release version ${SUPREME_RELEASE_VERSION}."
}

install_release_artifact() {
  log_step "Verifying and staging release artifact into ${SUPREME_REPO_DIR}"
  local src="$1"
  local manifest="${src}/release-manifest.json"
  load_release_manifest_metadata "$manifest"

  log_info "Release ${SUPREME_RELEASE_VERSION} (git ${SUPREME_RELEASE_GIT_SHA:0:12}), schema ${SUPREME_RELEASE_SCHEMA_VERSION}, ${SUPREME_RELEASE_MIGRATION_COUNT} migration(s) expected."

  validate_release_manifest

  # Checksum verification against the standalone .sha256 sidecar package-release.sh writes
  # next to the tarball (the manifest INSIDE the tarball cannot contain the tarball's own
  # checksum — that byte doesn't exist yet when the manifest is written). Only meaningful
  # when the original tarball is available (SUPREME_RELEASE_TARBALL) — an already-extracted
  # directory with no tarball alongside it honestly skips this, never fakes "verified".
  if [ -n "${SUPREME_RELEASE_TARBALL:-}" ] && [ -r "$SUPREME_RELEASE_TARBALL" ]; then
    local sidecar="${SUPREME_RELEASE_TARBALL}.sha256"
    [ -r "$sidecar" ] || die "No checksum sidecar at ${sidecar} — refusing to install a release artifact with no verifiable checksum."
    local expected actual
    case "$SUPREME_RELEASE_CHECKSUM_ALGO" in
      sha256)
        expected="$(awk '{print $1}' "$sidecar")"
        actual="$(sha256sum "$SUPREME_RELEASE_TARBALL" | awk '{print $1}')"
        ;;
      *) die "Unsupported checksum algo '${SUPREME_RELEASE_CHECKSUM_ALGO}' in release manifest." ;;
    esac
    [ "$actual" = "$expected" ] \
      || die "Release tarball checksum mismatch: ${sidecar} says ${expected}, actual is ${actual}. Refusing to install a corrupted/tampered artifact."
    log_info "Tarball checksum verified (${SUPREME_RELEASE_CHECKSUM_ALGO})."
  else
    log_warn "No tarball path available to checksum — verifying manifest fields only, not tarball integrity. Pass SUPREME_RELEASE_TARBALL to verify the download itself."
  fi

  # § Mandatory release signing (requirement 4): SHA256 alone proves the bytes weren't
  # corrupted/truncated in transit — it proves NOTHING about who produced them (anyone
  # who intercepts the download can recompute a matching checksum for a tampered file).
  # A signature proves provenance. Ed25519 (`.ed25519.sig`, verified via `openssl
  # pkeyutl`) is preferred — small, fast, no GPG keyring/trust-model complexity; OpenPGP
  # (`.sig`, verified via `gpg --verify`) is supported as the alternative. Production
  # (release mode) REFUSES an unsigned release outright; only an explicit
  # SUPREME_ALLOW_UNSIGNED_RELEASE=1 override (documented, loud, never the default) can
  # install one — for local testing of the release pipeline itself, never for a real
  # customer deployment. See docs/architecture/Native-Linux-Deployment.md's "Release
  # signing & key management" section for how the keys themselves are managed.
  local signed=0
  if [ -n "${SUPREME_RELEASE_TARBALL:-}" ] && [ -r "${SUPREME_RELEASE_TARBALL}.ed25519.sig" ]; then
    local pubkey="${SUPREME_RELEASE_ED25519_PUBKEY:-${SCRIPT_DIR}/release-signing-ed25519.pub}"
    [ -r "$pubkey" ] || die "An Ed25519 signature (${SUPREME_RELEASE_TARBALL}.ed25519.sig) is present but no public key found at ${pubkey}. Set SUPREME_RELEASE_ED25519_PUBKEY or provision the key."
    command_exists openssl || die "openssl is required to verify the Ed25519 signature."
    openssl pkeyutl -verify -rawin -pubin -inkey "$pubkey" -sigfile "${SUPREME_RELEASE_TARBALL}.ed25519.sig" -in "$SUPREME_RELEASE_TARBALL" >/dev/null 2>&1 \
      || die "Ed25519 signature verification FAILED for ${SUPREME_RELEASE_TARBALL} — refusing to install an unsigned/tampered release."
    log_info "Ed25519 signature verified."
    signed=1
  elif [ -n "${SUPREME_RELEASE_TARBALL:-}" ] && [ -r "${SUPREME_RELEASE_TARBALL}.sig" ]; then
    command_exists gpg || die "A .sig file is present but gpg is not installed — cannot verify the release signature."
    gpg --verify "${SUPREME_RELEASE_TARBALL}.sig" "$SUPREME_RELEASE_TARBALL" \
      || die "GPG signature verification FAILED for ${SUPREME_RELEASE_TARBALL} — refusing to install an unsigned/tampered release."
    log_info "OpenPGP signature verified."
    signed=1
  fi

  if [ "$signed" != "1" ]; then
    if [ "${SUPREME_ALLOW_UNSIGNED_RELEASE:-0}" = "1" ]; then
      log_warn "SUPREME_ALLOW_UNSIGNED_RELEASE=1 — installing an UNSIGNED release. Never use this for a real customer deployment."
    else
      die "No valid Ed25519 or OpenPGP signature found for this release — production installs require a signed release (§ Mandatory Release Signing). Set SUPREME_ALLOW_UNSIGNED_RELEASE=1 only for local release-pipeline testing."
    fi
  fi

  rsync -a --delete --exclude '.git' "${src}/" "${SUPREME_REPO_DIR}/"
  chown -R "${SUPREME_USER}:${SUPREME_GROUP}" "$SUPREME_REPO_DIR"
  log_info "Release ${SUPREME_RELEASE_VERSION} staged into ${SUPREME_REPO_DIR} (not yet active — switch_active_release runs after verification)."
}

# § Checkpoint validation: confirms the staged copy is still there AND is still the same
# version reconstruct_runtime_context() just re-derived from the (possibly re-supplied)
# release source — a stale/mismatched staged copy is exactly as invalid as a missing one.
validate_phase_install_release_artifact() {
  [ -r "${SUPREME_REPO_DIR}/release-manifest.json" ] || return 1
  local staged_version
  staged_version="$(jq -r '.version' "${SUPREME_REPO_DIR}/release-manifest.json" 2>/dev/null || true)"
  [ -n "$staged_version" ] && [ "$staged_version" = "${SUPREME_RELEASE_VERSION:-}" ]
}

# § requirement 2/11: validate EVERY manifest field before installation, and reject
# unsupported upgrade paths outright — never a guess, never a soft warning for something
# that would actually break the running controller.
validate_release_manifest() {
  # OS: same check require_ubuntu_24_04 already applies to the HOST; this confirms the
  # ARTIFACT was actually built for it too — a release built for a different OS target
  # could ship binaries (native node_modules addons) that simply won't load here.
  if [ -r /etc/os-release ]; then
    local host_os
    # shellcheck source=/dev/null
    host_os="$(. /etc/os-release && echo "${ID}-${VERSION_ID}")"
    if [ -n "$SUPREME_RELEASE_SUPPORTED_OS" ] && [ "$SUPREME_RELEASE_SUPPORTED_OS" != "null" ] \
      && [ "$SUPREME_RELEASE_SUPPORTED_OS" != "$host_os" ]; then
      die "Release ${SUPREME_RELEASE_VERSION} was built for '${SUPREME_RELEASE_SUPPORTED_OS}', this host is '${host_os}' — refusing to install a mismatched OS target."
    fi
  fi

  # Architecture.
  local host_arch
  host_arch="$(uname -m)"
  [ "$host_arch" = "x86_64" ] && host_arch="amd64"
  if [ -n "$SUPREME_RELEASE_ARCH" ] && [ "$SUPREME_RELEASE_ARCH" != "null" ] && [ "$SUPREME_RELEASE_ARCH" != "$host_arch" ]; then
    die "Release ${SUPREME_RELEASE_VERSION} was built for '${SUPREME_RELEASE_ARCH}', this host is '${host_arch}' — refusing to install a mismatched architecture."
  fi

  # Package format version — this installer only understands format "1". A future,
  # incompatible package layout must be rejected with a clear message, not misread.
  if [ -n "$SUPREME_RELEASE_PACKAGE_FORMAT_VERSION" ] && [ "$SUPREME_RELEASE_PACKAGE_FORMAT_VERSION" != "null" ] \
    && [ "$SUPREME_RELEASE_PACKAGE_FORMAT_VERSION" != "1" ]; then
    die "Release ${SUPREME_RELEASE_VERSION} uses package format version '${SUPREME_RELEASE_PACKAGE_FORMAT_VERSION}', this installer only supports format '1'. Upgrade infra/native-linux/install.sh first."
  fi

  # Schema/migration compatibility (§ requirement 11): reject an older schema than what's
  # already running (a downgrade), and reject an upgrade the release itself doesn't claim
  # to support (compatibility_matrix.min_upgrade_from_schema_version).
  local current_schema
  current_schema="$(current_release_schema_version)"
  if [ -n "$current_schema" ]; then
    if [ "$SUPREME_RELEASE_SCHEMA_VERSION" -lt "$current_schema" ] 2>/dev/null; then
      die "Release ${SUPREME_RELEASE_VERSION} has schema ${SUPREME_RELEASE_SCHEMA_VERSION}, older than the currently-installed schema ${current_schema}. Downgrades are not supported — restore a backup from before the current version instead (see restore.sh)."
    fi
    if [ "$SUPREME_RELEASE_MIN_UPGRADE_SCHEMA" -gt "$current_schema" ] 2>/dev/null; then
      die "Release ${SUPREME_RELEASE_VERSION} requires upgrading from schema >= ${SUPREME_RELEASE_MIN_UPGRADE_SCHEMA}, this machine is on schema ${current_schema}. Install an intermediate release first — see the release notes for the supported upgrade path."
    fi
  fi

  # Resource requirements — real numbers, checked now (before touching anything) rather
  # than discovered mid-install. Full detail (disk/RAM/CPU) is re-verified as part of
  # run_runtime_verification() after the switch; this is the fail-fast pass.
  if [ "${SUPREME_RELEASE_REQUIRED_RAM_MB:-0}" -gt 0 ] 2>/dev/null && [ -r /proc/meminfo ]; then
    local total_mb
    total_mb=$(( $(awk '/^MemTotal:/ {print $2}' /proc/meminfo) / 1024 ))
    [ "$total_mb" -ge "$SUPREME_RELEASE_REQUIRED_RAM_MB" ] \
      || die "Release ${SUPREME_RELEASE_VERSION} requires ${SUPREME_RELEASE_REQUIRED_RAM_MB}MB RAM, this host has ${total_mb}MB."
  fi
  log_info "Release manifest validated: OS/arch/package-format/schema-compatibility/resources all OK."
}

# The schema version of whatever release is CURRENTLY active on this machine, read from
# its own release-manifest.json (source-mode installs have none — first install, or a dev
# machine, has no prior schema to compare against, so this returns empty, not zero, which
# would incorrectly look like "schema 0").
current_release_schema_version() {
  local current="${SUPREME_RELEASE_DIR}/release-manifest.json"
  if [ -r "$current" ] && command_exists jq; then
    jq -r '.schema_version // empty' "$current" 2>/dev/null
  else
    echo ""
  fi
}

# Snapshots whatever is staged in SUPREME_REPO_DIR into its own immutable versioned
# directory and atomically switches SUPREME_RELEASE_DIR to point there (§ Transactional
# updates: this is the ONE moment code actually goes live — everything before it only
# touched the staging area, never a path a running service reads).
stage_and_switch_release() {
  local version="${SUPREME_RELEASE_VERSION:?stage_and_switch_release requires SUPREME_RELEASE_VERSION to be set (reconstruct_runtime_context sets it every run, unconditionally — see lib/deploy-steps.sh)}"
  release_state_set pending_release "$version"
  stage_release_version "$version" >/dev/null
  switch_active_release "$version"
  release_state_record_switch "$version"
}

# § Checkpoint validation: the active-release symlink must exist, resolve to a real
# directory, and contain the one build output every service unit's ExecStart actually reads.
validate_phase_stage_and_switch_release() {
  [ -L "$SUPREME_RELEASE_DIR" ] || [ -d "$SUPREME_RELEASE_DIR" ] || return 1
  [ -f "${SUPREME_RELEASE_DIR}/services/gateway/dist/main.js" ] || return 1
  local active
  active="$(current_release_version)"
  [ -n "$active" ]
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
    -e "s|___SUPREME_CASAMBI_API_KEY___|${SUPREME_CASAMBI_API_KEY:-}|g" \
    -e "s|___SUPREME_CASAMBI_EMAIL___|${SUPREME_CASAMBI_EMAIL:-}|g" \
    -e "s|___SUPREME_CASAMBI_PASSWORD___|${SUPREME_CASAMBI_PASSWORD:-}|g" \
    -e "s|___SUPREME_CASAMBI_NETWORK_ID___|${SUPREME_CASAMBI_NETWORK_ID:-}|g" \
    -e "s|___SUPREME_TZ___|${SUPREME_TZ}|g" \
    -e "s|___SUPREME_SETUP_WIZARD___|${SUPREME_SETUP_WIZARD}|g" \
    -e "s|___SUPREME_TOKEN_SECRET___|${SUPREME_TOKEN_SECRET}|g" \
    -e "s|___POSTGRES_PASSWORD___|${POSTGRES_PASSWORD}|g" \
    -e "s|___SUPREME_HUB_VERSION___|${SUPREME_HUB_VERSION}|g" \
    -e "s|___SUPREME_LOG_LEVEL___|${SUPREME_LOG_LEVEL}|g" \
    -e "s|___SUPREME_UPDATE_SCRIPT___|${SUPREME_UPDATE_SCRIPT}|g" \
    -e "s|___SUPREME_UPDATE_LOG___|${SUPREME_UPDATE_LOG}|g" \
    "$tmpl" > "$out"
}

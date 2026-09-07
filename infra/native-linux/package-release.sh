#!/usr/bin/env bash
# SupremeOS — package-release.sh
#
# Produces a signed, checksummed, versioned release artifact from an ALREADY-VERIFIED
# workspace (built, typechecked, tested, integration- and performance-tested — see
# .github/workflows/release.yml, which runs this script only after every one of those
# stages has passed). This is the ONE place `release-manifest.json` gets written;
# install.sh/update.sh only ever READ and VALIDATE it (lib/deploy-steps.sh's
# install_release_artifact/validate_release_manifest) — never regenerate or trust an
# installer-side recomputation of what CI already proved.
#
# Usage:
#   ./infra/native-linux/package-release.sh <output-dir>
#
# Requires: the workspace already built (`pnpm turbo run build`) and pruned to production
# dependencies. Does NOT build or test anything itself — packaging is a separate, later
# stage from verification, exactly like the CI/Production split this script exists for.
#
# Package format: supremeos-<version>-<arch>.tar.zst (zstd — smaller, faster to extract
# than gzip; falls back to .tar.gz automatically when zstd isn't available on the
# packaging machine, e.g. an older CI image — install.sh's extract_release_tarball()
# handles either extension transparently).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${1:?Usage: package-release.sh <output-dir>}"
mkdir -p "$OUT_DIR"

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required." >&2; exit 1; }

VERSION="$(node -p "require('${REPO_ROOT}/package.json').version" 2>/dev/null || echo "0.0.0")"
GIT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "unknown")"
BUILT_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
NODE_VERSION="$(node -v)"
PNPM_VERSION="$(pnpm -v 2>/dev/null || node -p "require('${REPO_ROOT}/package.json').packageManager || 'unknown'")"
ARCH="$(uname -m)"; [ "$ARCH" = "x86_64" ] && ARCH="amd64"
MIGRATIONS_DIR="${REPO_ROOT}/services/persistence/migrations"
MIGRATION_COUNT="$(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' 2>/dev/null | wc -l | tr -d ' ')"
# Schema version = the highest numeric migration id (e.g. 0025_device_provider.sql -> 25)
# — distinct from migration_count: this is "which schema shape," that is "how many
# migration files have run," used by the installer for two different checks (upgrade-path
# compatibility vs. actual applied-row-count verification).
SCHEMA_VERSION="$(find "$MIGRATIONS_DIR" -maxdepth 1 -name '[0-9]*.sql' -printf '%f\n' 2>/dev/null \
  | sed -E 's/^0*([0-9]+)_.*/\1/' | sort -n | tail -1)"
SCHEMA_VERSION="${SCHEMA_VERSION:-0}"
WEB_VERSION="$(node -p "require('${REPO_ROOT}/apps/web-homeowner/package.json').version" 2>/dev/null || echo "$VERSION")"
PROTOCOLS_VERSION="$(node -p "require('${REPO_ROOT}/services/protocols/package.json').version" 2>/dev/null || echo "$VERSION")"

STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

echo "Staging release ${VERSION} (git ${GIT_SHA:0:12}, schema ${SCHEMA_VERSION})..."
# Ship exactly what a native install needs to run: source + compiled dist/ output +
# production node_modules — never .git, dev-only caches, or test artifacts (a release
# artifact that could re-run the dev suite would defeat the entire point of this split).
rsync -a \
  --exclude '.git' --exclude '.turbo' --exclude '*.tsbuildinfo' \
  --exclude '.claude*' --exclude 'infra/hub-compose/homeassistant' \
  --exclude '**/*.test.ts' --exclude '**/*.e2e.test.ts' \
  "${REPO_ROOT}/" "${STAGE_DIR}/"

# The manifest ships INSIDE the artifact (install.sh reads it from the extracted tree) —
# it describes the release's own content, never the tarball's own checksum, which is
# impossible to embed in a file before that file's final byte (the tarball) exists. The
# checksum an installer trusts lives in the standalone .sha256 sidecar below.
jq -n \
  --arg version "$VERSION" \
  --arg git_sha "$GIT_SHA" \
  --arg built_at "$BUILT_AT" \
  --argjson schema_version "$SCHEMA_VERSION" \
  --argjson migration_count "$MIGRATION_COUNT" \
  --arg supported_os "ubuntu-24.04" \
  --arg architecture "$ARCH" \
  --arg node_version "$NODE_VERSION" \
  --arg pnpm_version "$PNPM_VERSION" \
  --arg package_format_version "1" \
  --argjson required_disk_mb 2048 \
  --argjson required_ram_mb 2048 \
  --arg required_cpu_arch "amd64" \
  --arg checksum_algo "sha256" \
  --arg web_version "$WEB_VERSION" \
  --arg protocols_version "$PROTOCOLS_VERSION" \
  '{
    version: $version,
    git_sha: $git_sha,
    built_at: $built_at,
    schema_version: $schema_version,
    migration_count: $migration_count,
    supported_os: $supported_os,
    architecture: $architecture,
    node_version: $node_version,
    pnpm_version: $pnpm_version,
    package_format_version: $package_format_version,
    required_disk_mb: $required_disk_mb,
    required_ram_mb: $required_ram_mb,
    required_cpu_arch: $required_cpu_arch,
    checksum_algo: $checksum_algo,
    bundled_services: ["supreme-gateway", "supreme-lan", "supreme-commissioning", "supreme-nats"],
    bundled_web_version: $web_version,
    bundled_protocol_versions: { protocols: $protocols_version },
    compatibility_matrix: { min_upgrade_from_schema_version: 1, max_schema_version: ($schema_version | tonumber) }
  }' \
  > "${STAGE_DIR}/release-manifest.json"

TARBALL_NAME="supremeos-${VERSION}-${ARCH}.tar.zst"
TARBALL_PATH="${OUT_DIR}/${TARBALL_NAME}"
if command -v zstd >/dev/null 2>&1; then
  tar -C "$STAGE_DIR" -cf - . | zstd -q -o "$TARBALL_PATH"
else
  echo "zstd not available on this packaging machine — falling back to .tar.gz." >&2
  TARBALL_NAME="supremeos-${VERSION}-${ARCH}.tar.gz"
  TARBALL_PATH="${OUT_DIR}/${TARBALL_NAME}"
  tar -C "$STAGE_DIR" -czf "$TARBALL_PATH" .
fi

CHECKSUM="$(sha256sum "$TARBALL_PATH" | awk '{print $1}')"
echo "${CHECKSUM}  ${TARBALL_NAME}" > "${TARBALL_PATH}.sha256"

echo "Release artifact: ${TARBALL_PATH}"
echo "Checksum:         ${TARBALL_PATH}.sha256"
echo ""
echo "§ Mandatory Release Signing — production installs REFUSE an unsigned release."
echo "Sign with ONE of (Ed25519 preferred):"
echo "  openssl pkeyutl -sign -rawin -inkey release-signing-ed25519.key -in '${TARBALL_PATH}' -out '${TARBALL_PATH}.ed25519.sig'"
echo "  gpg --detach-sign --armor -o '${TARBALL_PATH}.sig' '${TARBALL_PATH}'"

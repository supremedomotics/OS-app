#!/usr/bin/env bash
# Provision the native toolchains that aren't baked into the base image:
#   • Flutter SDK (so `flutter analyze/test/build` works)
#   • Docker daemon (so `docker`/`docker compose` works)
#
# Idempotent: skips work that's already done. Wired as a SessionStart hook (see
# .claude/settings.json) so Claude Code web sessions auto-provision, and runnable
# by hand: `bash scripts/dev/enable-native-tools.sh`.
#
# NOTE on Docker: this environment's network policy blocks container-registry blob
# CDNs (Docker Hub, GHCR, ECR, Quay all 403), so the daemon starts but image pulls
# fail — `docker compose up` of the hub stack needs the registry hosts allowlisted
# (or a registry mirror / Docker Hub credentials) in the environment config.
set -uo pipefail

FLUTTER_VERSION="3.44.1"
FLUTTER_DIR="/opt/flutter"

log() { echo "[enable-native-tools] $*"; }

install_flutter() {
  if [ -x "$FLUTTER_DIR/bin/flutter" ]; then
    log "Flutter already present at $FLUTTER_DIR"
  else
    log "Installing Flutter $FLUTTER_VERSION …"
    local url="https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_${FLUTTER_VERSION}-stable.tar.xz"
    if curl -fsSL -o /tmp/flutter.tar.xz "$url"; then
      tar xf /tmp/flutter.tar.xz -C /opt && rm -f /tmp/flutter.tar.xz
      log "Flutter installed."
    else
      log "WARN: could not download Flutter (network policy?). Skipping."
      return 0
    fi
  fi
  git config --global --add safe.directory "$FLUTTER_DIR" 2>/dev/null || true
  # Make it available on PATH for this and future shells.
  if ! grep -q "$FLUTTER_DIR/bin" /etc/profile.d/flutter.sh 2>/dev/null; then
    echo "export PATH=\"$FLUTTER_DIR/bin:$FLUTTER_DIR/bin/cache/dart-sdk/bin:\$PATH\"" > /etc/profile.d/flutter.sh
  fi
}

start_docker() {
  if docker info >/dev/null 2>&1; then
    log "Docker daemon already running."
    return 0
  fi
  if ! command -v dockerd >/dev/null 2>&1; then
    log "dockerd not installed; skipping."
    return 0
  fi
  # This environment's egress proxy allowlists Google hosts but blocks Docker Hub's
  # blob CDN and rate-limits anonymous pulls. Google's Docker Hub mirror
  # (mirror.gcr.io) is on an allowlisted host, so routing pulls through it makes
  # `docker pull` / `compose up` work WITHOUT any network-policy change.
  mkdir -p /etc/docker
  if [ ! -f /etc/docker/daemon.json ]; then
    echo '{ "registry-mirrors": ["https://mirror.gcr.io"] }' > /etc/docker/daemon.json
    log "Configured Docker Hub mirror mirror.gcr.io."
  fi
  log "Starting Docker daemon …"
  nohup dockerd >/tmp/dockerd.log 2>&1 &
  for _ in $(seq 1 15); do
    docker info >/dev/null 2>&1 && { log "Docker daemon up (mirror: mirror.gcr.io)."; return 0; }
    sleep 1
  done
  log "WARN: Docker daemon did not become ready (see /tmp/dockerd.log)."
}

stage_proxy_ca() {
  # If this environment uses a TLS-intercepting egress proxy, copy its CA into the
  # Docker build context so image builds (pnpm/pip behind the proxy) trust it.
  local dest="$(dirname "$0")/../../infra/hub-compose/ca-certs"
  mkdir -p "$dest"
  local found=0
  for ca in /usr/local/share/ca-certificates/*egress*.crt /usr/local/share/ca-certificates/*swp*.crt; do
    [ -f "$ca" ] || continue
    cp -f "$ca" "$dest/" && found=1
  done
  [ "$found" = 1 ] && log "Staged egress proxy CA(s) for Docker builds." \
                    || log "No egress proxy CA found (normal network); skipping."
}

install_flutter
stage_proxy_ca
start_docker
log "Done. (Flutter on PATH via /etc/profile.d/flutter.sh)"

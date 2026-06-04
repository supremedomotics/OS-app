#!/usr/bin/env bash
# Build the gateway image and run it against a real Postgres container, then hit
# the API — a fast end-to-end proof that the Dockerized stack works (Dockerfile,
# image pulls, the pg persistence path). Uses SUPREME_BACKEND=mock so no HA is
# needed. Run after `enable-native-tools.sh` (which starts dockerd + the mirror).
#
#   bash scripts/dev/compose-smoke.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

NET=supreme-smoke
cleanup() { docker rm -f supreme-pg supreme-gw >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "▶ building gateway image…"
docker build -f infra/hub-compose/gateway.Dockerfile -t supreme-gateway:smoke .

docker network create "$NET" >/dev/null
echo "▶ starting postgres…"
docker run -d --name supreme-pg --network "$NET" \
  -e POSTGRES_USER=supreme -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=supreme \
  postgres:16-alpine >/dev/null
for _ in $(seq 1 30); do docker exec supreme-pg pg_isready -U supreme >/dev/null 2>&1 && break; sleep 1; done

echo "▶ starting gateway…"
docker run -d --name supreme-gw --network "$NET" -p 8080:8080 \
  -e SUPREME_BACKEND=mock \
  -e SUPREME_TOKEN_SECRET=dev-smoke-secret-dev-smoke-secret-123456 \
  -e DATABASE_URL=postgres://supreme:secret@supreme-pg:5432/supreme \
  supreme-gateway:smoke >/dev/null
for _ in $(seq 1 30); do curl -fsS localhost:8080/healthz >/dev/null 2>&1 && break; sleep 1; done

echo "▶ /healthz:" && curl -fsS localhost:8080/healthz && echo
echo "▶ login:" && curl -fsS -X POST localhost:8080/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"owner@supreme.local","password":"supreme-owner-demo-pass"}' \
  | grep -q '"status":"ok"' && echo "  login OK (token issued, persisted to Postgres)"
echo "✅ compose smoke passed"

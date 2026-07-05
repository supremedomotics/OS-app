#!/usr/bin/env bash
# Headlessly onboard a fresh Home Assistant and print an access token, so the
# gated SIL integration / upgrade-regression suite can run without manual clicks
# (readiness §2). Uses HA's stable onboarding REST flow.
#
#   HA_URL=http://127.0.0.1:8123 bash scripts/dev/ha-onboard.sh
#   SUPREME_HA_TEST_URL=ws://127.0.0.1:8123/api/websocket \
#   SUPREME_HA_TEST_TOKEN=$(HA_URL=http://127.0.0.1:8123 bash scripts/dev/ha-onboard.sh) \
#     pnpm --filter @supreme/integration-layer test
set -euo pipefail

HA_URL="${HA_URL:-http://127.0.0.1:8123}"
CLIENT_ID="${CLIENT_ID:-$HA_URL/}"
HA_USER="${HA_USER:-supreme}"
HA_PASS="${HA_PASS:-supreme-test-pass-0123456789}"

# 1. Wait for HA to accept onboarding requests.
for _ in $(seq 1 90); do
  if curl -fsS "$HA_URL/api/onboarding" >/dev/null 2>&1; then break; fi
  sleep 2
done

# 2. Create the owner user → returns an auth_code (one-time).
users_resp=$(curl -fsS -X POST "$HA_URL/api/onboarding/users" \
  -H 'content-type: application/json' \
  -d "{\"client_id\":\"$CLIENT_ID\",\"name\":\"Supreme\",\"username\":\"$HA_USER\",\"password\":\"$HA_PASS\",\"language\":\"en\"}")
auth_code=$(printf '%s' "$users_resp" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(JSON.parse(s).auth_code||"")})')
[ -n "$auth_code" ] || { echo "onboarding failed: $users_resp" >&2; exit 1; }

# 3. Exchange the auth_code for an access token.
token_resp=$(curl -fsS -X POST "$HA_URL/auth/token" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=$auth_code")
token=$(printf '%s' "$token_resp" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(JSON.parse(s).access_token||"")})')
[ -n "$token" ] || { echo "token exchange failed: $token_resp" >&2; exit 1; }

# 4. Best-effort: finish remaining onboarding steps so the instance is usable.
for step in core_config analytics integration; do
  curl -fsS -X POST "$HA_URL/api/onboarding/$step" -H "authorization: Bearer $token" \
    -H 'content-type: application/json' -d '{"client_id":"'"$CLIENT_ID"'"}' >/dev/null 2>&1 || true
done

printf '%s' "$token"

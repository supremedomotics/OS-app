# Supreme OS — On-call runbooks (§6)

Each alert in `alerts.yml` links here. Keep responses calm and local-first: most issues
do NOT affect in-home control, which runs on the hub.

## HubDown
The gateway hasn't been scrapable for 2m.
1. Is it the hub or the network? Check the relay tunnel status (the hub may be online
   but its monitoring path down). LAN users may be fine.
2. `docker compose -f infra/hub-compose/docker-compose.yml ps` — is `gateway` up?
   `docker compose logs gateway --tail 200`.
3. Check `/readyz` locally on the hub. If backend/DB unhealthy, see **HubNotReady**.
4. Restart: `docker compose restart gateway`. If it won't boot, check
   `assertSecureConfig` errors (missing/weak secrets in production).

## HubNotReady
`/readyz` returns 503 — a dependency is unhealthy.
1. `checks.backend` unhealthy → HA/SIL connection. Check `homeassistant` container +
   the HA token. The SIL buffers commands and reconnects; transient is OK.
2. `checks.database` unreachable → Postgres. Check `postgres` health + disk.
3. The hub keeps serving cached state where it can; prioritize the failing dependency.

## HighLatency
API p95 > 1s for 10m.
1. Check `supreme_process_resident_memory_bytes` / heap for pressure.
2. Correlate with backend latency (HA slow? a flaky bus driver retrying?).
3. Check `supreme_presence_online_users` + request rate for a load spike.

## Errors (5xx spike)
1. `docker compose logs gateway` — find the failing route. A driver throwing on a dead
   bus is common; the native engine isolates a dead driver but commands to it 5xx.
2. If one protocol bus is down, bound devices error until it recovers — expected.

## BruteForce
Sustained 429 on `/v1/auth/login`.
1. The rate-limiter is doing its job. Identify the source IP from access logs.
2. If a real attack, block at the edge/firewall; rotate any exposed credentials.
3. Confirm MFA is enrolled for privileged accounts.

## Push not delivering (relay)
1. `docker compose -f infra/cloud-compose/docker-compose.yml logs relay`.
2. Verify FCM/APNs/WebPush credentials in the relay env. The hub-side queue is
   best-effort; WSS delivery to connected clients is unaffected.

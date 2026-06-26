# Supreme OS — Security Review (branch `claude/supreme-os-architecture-VbMgU`)

> Focused review of the security-sensitive surfaces introduced on this branch:
> auth/token handling, the remote-access relay, persistence (SQL), push, drivers,
> and the cloud plane. Date: 2026-06-26.

## Summary

Two genuine findings were identified and **both have been fixed on this branch**
(commit `02934e7`). The remaining reviewed surface is solid; notable strengths are
listed below so future changes don't regress them.

| # | Severity | Area | Status |
|---|----------|------|--------|
| 1 | HIGH | Remote-access relay exposed internal-only endpoints | **Fixed** |
| 2 | MEDIUM | Push-token unregister not owner-scoped (IDOR) | **Fixed** |

---

## Finding 1 — Relay tunnel could reach internal-only endpoints (HIGH)

**Where:** `services/gateway/src/relay-tunnel.ts` (`proxyLocal`),
`cloud/relay/src/relay-server.ts` (`/v1/relay/:homeId/*`).

**Issue.** When remote access is enabled, the hub dials out to the cloud relay and
holds a WebSocket open. Off-LAN client requests arrive over that tunnel and the hub
forwards them to its **own local gateway** — which is correct for identity (the hub
re-validates every request exactly as on the LAN). But the tunnel **bypasses the
Caddy edge proxy** that, on the LAN/public edge, only exposes the public contract.
Internal-only endpoints (`/metrics`, `/readyz`) are intentionally unauthenticated
and are never published at the edge. Without a path allow-list on the tunnel path,
a remote client could request `/metrics` and have it served straight from the hub.

**Fix.** Mirror the edge contract at the tunnel boundary:
- `proxyLocal` now returns `404` for any path that isn't `/healthz` or `/v1/*`.
- Defense-in-depth: the cloud relay's `/v1/relay/:homeId/*` handler rejects the same
  set **before** forwarding, so a bad path never consumes a tunnel round-trip.

---

## Finding 2 — Push-token unregister was not owner-scoped / IDOR (MEDIUM)

**Where:** `services/gateway/src/routes/notifications.ts`
(`DELETE /v1/push/tokens/:token`), `services/persistence/src/repositories/push-token-repo.ts`,
`services/notifications/src/push.ts` (`IPushTokenStore`).

**Issue.** The delete handler removed a push token **by token string alone**
(`DELETE FROM device_clients WHERE push_token=$1`). Any authenticated user who
learned or guessed another user's token could unregister that user's device,
silently suppressing their push notifications (a denial-of-notification — relevant
for security alerts such as door/alarm events).

**Fix.** `IPushTokenStore.remove` now takes `(userId, token)`. The Postgres delete
is scoped (`... AND user_id=$2`), the in-memory store checks ownership before
deleting, and the route passes the authenticated caller's id. A user can only
unregister tokens they own.

---

## Surface reviewed and found solid

- **SQL.** All queries across the persistence repositories are parameterized
  (`$1,$2,…`); no string interpolation of user input into SQL was found.
- **Auth / tokens.** HS256 JWTs require a ≥32-char signing key (fail-closed
  `assertSecureConfig`), pin the issuer, and check token `kind` (access vs refresh);
  passwords use Argon2id with an anti-enumeration dummy verify; TOTP uses
  `node:crypto` with `timingSafeEqual`.
- **Secrets.** `secret()` reads `*_FILE` then env; CA bundles, model weights, and
  secrets are gitignored. No secrets are committed.
- **Relay auth.** The cloud relay authenticates the hub with a bearer token for both
  push (`POST /v1/push`) and the tunnel (`?token=`), rejecting mismatches.
- **Remote access shape.** Outbound-only tunnel (hub dials cloud); no inbound ports
  on the home; identity is always validated on the hub.

## Lower-priority hardening (not blocking)

- `packages/domain-model/src/ids.ts` uses `Math.random()` for ULID entropy. IDs are
  not used as security tokens (sessions/JWTs have their own CSPRNG-backed secrets),
  so this is not exploitable, but switching to `crypto.randomBytes` would remove it
  as an aggravating factor for any future code that treats an id as unguessable.

# Supreme Cloud

The optional, independently-scalable control plane for Supreme OS. **Nothing in-home depends
on it** (invariant I1): the hub runs all automation, control, and local identity offline. The
cloud adds identity, reachability, and ecosystem integrations on top.

See the full design in [`docs/architecture/supreme-cloud-blueprint.md`](../docs/architecture/supreme-cloud-blueprint.md)
and ADRs [0007](../docs/architecture/adr/0007-cloud-sole-identity-provider.md),
[0008](../docs/architecture/adr/0008-hub-identity-zero-touch-provisioning.md),
[0009](../docs/architecture/adr/0009-zero-trust-tunnel-broker.md).

## Microservices (catalog — blueprint §4)

Independently deployable, mesh-internal mTLS, schema-per-service. Status reflects the staged
rollout (§22): ✅ implemented · 🟡 in progress · ⬜ planned.

| Service | Dir | Status | Responsibility |
|---|---|---|---|
| Hub Registry | `cloud/hub-registry` | ✅ C0 | Zero-touch enrollment, device-cert issuance, claim/transfer, presence (HTTP + hub agent, end-to-end) |
| Identity | `cloud/identity` | ✅ C1 | Accounts, identities (email/phone/username), passkeys, federated login + identity-plane HTTP API |
| AuthN | `cloud/authn` | ✅ C1 | EdDSA JWT mint, rotating refresh + reuse-detection, sessions, JWKS |
| AuthZ | `cloud/authz` | ✅ C1 | RBAC role matrix + ABAC grant overlay policy decision point |
| Device Registry | `cloud/device-registry` | ✅ C1 | Client devices, push tokens, remote logout, approval, phone replacement |
| Tunnel Broker | `cloud/tunnel-broker` (supersedes `cloud/relay` tunnel) | ✅ C2 | Cert-authenticated, hub-initiated channels + off-LAN client routing (HTTP/WS; QUIC-ready) |
| Notification | `cloud/notification` | ✅ C3 | Targeted push fan-out (APNs/FCM/WebPush/Wear/Watch) + quiet hours + dedup + receipts |
| Voice | `cloud/voice` | ✅ C3 | Alexa/Google/Siri linking + capability→discovery + directive routing + state reporting |
| Matter Cloud | `cloud/matter` | ✅ C3 | Fabric/credential brokering + multi-admin + node commissioning |
| Firmware/OTA | `cloud/ota` | ✅ C3 | Signed manifests, channels, deterministic staged rollout, minVersion gating |
| Subscription/Licensing | `cloud/subscription` | ✅ C4 | Plans, entitlements, signed offline license tokens |
| Installer/Dealer | `cloud/dealer` (+ legacy `cloud/fleet`) | ✅ C4 | Orgs, technicians, sites, hub assignment, time-boxed remote service |
| Admin Console | `cloud/admin` | ✅ C4 | Feature flags (deterministic rollout) + audited, time-boxed impersonation |
| Telemetry/Analytics | `cloud/telemetry` | ✅ C4 | Opt-in, anonymized (pseudonymized) ingest + aggregation, retention-bounded |
| Audit | `cloud/audit` | ✅ C4 | Append-only, hash-chained, tamper-evident security log |

Shared building blocks live in `packages/`: **`@supreme/hub-identity`** (the enrollment
protocol + crypto, used by `hub-registry` and the hub agent), `@supreme/crypto`,
`@supreme/contracts`, `@supreme/domain-model`.

## Data model

`cloud/schema/` holds the cloud Postgres schema (`0001_cloud_core.sql`). The cloud stores the
identity + ownership graph; the hub stays authoritative for device/automation state
(invariant I2). They reconcile via the offline-sync log (blueprint §12).

## Foundational spine (implemented this phase — C0)

1. **Hub identity** — `@supreme/hub-identity`: UUIDv7 + Ed25519 device keypair, signed
   enrollment request (CSR-equivalent), Hub CA issuance (`DeviceCredential`, the dev stand-in
   for X.509), per-connection challenge auth, proximity-gated claim codes.
2. **Hub Registry** — `@supreme/hub-registry`: enroll → issue → claim → transfer → heartbeat →
   revoke, with a Postgres-swappable store seam. Anti-replay (single-use nonce) and anti-hijack
   (uuid bound to one device key) enforced. Exposed over HTTP (`cloud/hub-registry/src/server.ts`,
   `main.ts`, Dockerfile, compose `:8092`). 15 tests.
3. **Hub Agent** — `services/gateway/src/hub-agent.ts`: on boot the hub loads-or-generates its
   identity (sealed in the secrets store), enrolls with the registry, stores the credential, and
   surfaces a claim code — all **non-fatal** so the hub runs fully locally if the cloud is down.
   Wired into the gateway boot (`SUPREME_HUB_REGISTRY_URL`). End-to-end test
   (`hub-enrollment.e2e.test.ts`) proves identity → enroll → claim → home+owner, plus the
   cloud-unreachable path. C0 is end-to-end runnable.

## C1 identity plane (complete)

4. **AuthN** — `@supreme/cloud-authn`: EdDSA-signed access JWTs (audience-scoped to cloud or a
   specific hub) verified via published JWKS; opaque, device-bound, **rotating** refresh tokens
   with **reuse-detection family revocation**; remote-logout session revocation. 8 tests.
5. **Device Registry** — `@supreme/device-registry`: client-device lifecycle (register/list/
   rename/approve/delete), push tokens, last-seen/IP/geo, **remote logout** (wired to AuthN
   session revocation), and the **phone-replacement** flow. 7 tests.
6. **Identity** — `@supreme/cloud-identity`: accounts + identities (email/phone/username,
   case-insensitive, anti-enumeration), Argon2id credentials, **passkeys**, **federated login**
   (Apple/Google/Microsoft, account-linking by verified email). Ships the composed identity-plane
   HTTP API (`cloud/identity/src/server.ts`, `main.ts`, Dockerfile, compose `:8093`):
   register → login (issues tokens + registers the device) → refresh → logout → device
   management. 14 tests (incl. the full end-to-end server flow).
7. **AuthZ** — `@supreme/cloud-authz`: the policy decision point — per-home **RBAC role matrix**
   (blueprint §11) + **ABAC grant overlay** (deny-wins, resource-scoped, time-boxed). Pure logic,
   mirrors the hub's local enforcement so cloud + hub agree. 10 tests.

## C2 connectivity plane (complete)

8. **Tunnel Broker** — `@supreme/tunnel-broker`: the zero-trust, cert-authenticated evolution of
   the relay (ADR 0009). Hubs are keyed by `hubId` from a VERIFIED device credential and prove
   possession of their device key via a **challenge-response handshake** before the connection
   attaches; the broker is a transport (forwards request/response frames, the hub re-validates
   locally). Per-hub isolation, fail-closed client authorization seam, reconnect-supersede.
   HTTP/WS surface (`server.ts`, `main.ts`, Dockerfile, compose `:8094`); QUIC-ready framing.
   9 core tests.
9. **Hub tunnel client** — `services/gateway/src/tunnel-client.ts`: dials OUT to the broker,
   authenticates with the device credential, and proxies forwarded requests to the LOCAL
   gateway (identity + RBAC enforced locally, exactly as on the LAN). Auto-reconnects; wired
   into gateway boot once enrolled. End-to-end test (`broker-tunnel.e2e.test.ts`): hub dials
   out → off-LAN client routes a real login through the broker to the hub and back; fail-closed
   deny + hub-offline paths. 4 tests.

## C3 ecosystem plane (complete)

10. **Notification** — `@supreme/notification`: targeted push fan-out to an account's devices
    across platforms, per-account **quiet hours** (critical bypasses), **dedup/suppression**, and
    per-device **delivery receipts** (one provider failing never blocks the rest). 6 tests.
11. **Voice** — `@supreme/voice`: assistant **account-linking**, one Supreme capability model
    projected into **Alexa/Google/HomeKit** discovery vocabularies, **directive → Supreme command**
    normalization (the Tunnel Broker forwards to the hub), and **state reporting**. 10 tests.
12. **Matter Cloud** — `@supreme/matter-cloud`: fabric creation, **multi-admin** (share a home's
    fabric with Apple Home / Google), and node commissioning with operational-credential records.
    4 tests.
13. **Firmware/OTA** — `@supreme/ota`: signed release manifests per **channel** (stable/beta),
    **deterministic staged rollout** (a hub's eligibility is a stable hash of its id, so 0%→none,
    100%→all, partial→a stable proportional cohort), and `minVersion` skip-protection. 8 tests.

## C4 commercial plane (complete)

14. **Subscription/Licensing** — `@supreme/subscription`: plans → entitlements (local control is
    NEVER gated), and signed **offline-validatable license tokens** bound to a home/hub so an
    air-gapped install stays licensed. 7 tests.
15. **Installer/Dealer** — `@supreme/dealer`: orgs, technicians, customer sites, hub assignment,
    and **owner-granted, time-boxed, revocable remote service** (no standing tech access). 6 tests.
16. **Admin** — `@supreme/admin`: feature flags with deterministic percentage rollout, and
    **audited, time-boxed impersonation** (justification-required, emits an audit record). 6 tests.
17. **Telemetry** — `@supreme/telemetry`: strictly **opt-in**, pseudonymized ingest + aggregation,
    retention-bounded; a home that hasn't opted in contributes nothing. 4 tests.
18. **Audit** — `@supreme/cloud-audit`: append-only, **hash-chained, tamper-evident** log
    (any insert/delete/modify breaks the chain and is detected by `verify`). 4 tests.

## Flutter multi-home + transparent connection switching (complete)

The app (`apps/mobile`) now models the account→multi-home world (blueprint §16):
- `lib/cloud/multi_home.dart` — `CloudSession`, `HomeRef` (hubId/name/role/cloudRoute/localUrl/
  fingerprint), `HomeConnection`, a `LocalDiscovery` mDNS seam, a `CloudClient` (login + list
  homes), and Riverpod providers (`cloudSession`, `homes`, `activeHomeId`, `activeHome`,
  `homeConnection`, `connectionMode`). `homeConnectionProvider` prefers a verified LAN path and
  falls back to the cloud Tunnel Broker route.
- `providers.dart` — `hubBaseUrl`/`hubWsUrl` now DERIVE from the active home's connection, so
  every screen transparently follows home switches and local↔cloud transport changes; the SDK
  client reuses the cloud session token across homes (no re-login on switch).
- `screens/home_switcher.dart` — instant home switcher sheet + an app-bar button showing the
  active home and how it's reached (Local/Remote/Offline), wired into the dashboard header.
- Login hydrates the session + homes from the cloud edge when configured (`SUPREME_CLOUD_URL`),
  and is a no-op for local single-hub dev (local-first preserved).

Verified with `flutter analyze` (app + SDK): no issues.

All five planes (C0–C4) plus the multi-home client are now built, tested, and documented.

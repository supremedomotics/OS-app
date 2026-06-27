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
| Tunnel Broker | `cloud/tunnel-broker` (from `cloud/relay`) | ⬜ | QUIC/mTLS hub channels + off-LAN client routing |
| Notification | `cloud/notification` (from `cloud/relay`) | ⬜ | APNs/FCM/WebPush/Wear/Watch fan-out |
| Voice | `cloud/voice` | ⬜ | Alexa/Google/Siri/Shortcuts linking + state reporting |
| Matter Cloud | `cloud/matter` | ⬜ | Fabric/credential brokering, Matter-cloud APIs |
| Firmware/OTA | `cloud/ota` | ⬜ | Signed manifests, staged rollout |
| Subscription/Licensing | `cloud/licensing` (evolve) | 🟡 | Plans, entitlements, signed offline license tokens |
| Installer/Dealer | `cloud/fleet` (evolve) | 🟡 | Orgs, sites, hub assignment, remote service |
| Admin Console | `cloud/admin` | ⬜ | Internal ops, audited impersonation, flags |
| Telemetry/Analytics | `cloud/telemetry` | ⬜ | Opt-in metrics ingest + reporting |
| Audit | `cloud/audit` | ⬜ | Append-only, hash-chained security log |

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

Next: C2 connectivity — QUIC/mTLS **Tunnel Broker** (replaces the relay) + hub agent control
channel + transparent local(mDNS)/cloud switching in the app.

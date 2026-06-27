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
| Hub Registry | `cloud/hub-registry` | 🟡 core | Zero-touch enrollment, device-cert issuance, claim/transfer, presence |
| Identity | `cloud/identity` | ⬜ | Accounts, identities, passkeys, federated login records |
| AuthN | `cloud/authn` | ⬜ | Login flows, MFA, OAuth/OIDC, token mint + rotation |
| AuthZ | `cloud/authz` | ⬜ | RBAC/ABAC policy decision point for cloud APIs |
| Device Registry | `cloud/device-registry` | ⬜ | Client devices, push tokens, remote logout, approval |
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
2. **Hub Registry core** — `@supreme/hub-registry`: enroll → issue → claim → transfer →
   heartbeat → revoke, with a Postgres-swappable store seam. Anti-replay (single-use nonce)
   and anti-hijack (uuid bound to one device key) enforced.

Next: C1 identity plane (Identity/AuthN/Device Registry) and C2 connectivity (Tunnel Broker).

# Supreme Cloud — Enterprise Architecture Blueprint

> Ground-up redesign of the Supreme OS cloud plane for a premium, commercial, local-first
> smart-home platform. Status: **approved direction; implemented in phases (see §22).**
> This document supersedes the Phase-1 "optional relay" design in
> [`supreme-os-blueprint.md`](./supreme-os-blueprint.md) §13 for everything cloud-side.
> It does **not** change the local-first invariant — it strengthens it.

---

## 1. Core Philosophy & Invariants

Supreme OS is **Local First, Cloud Augmented**. The hub is the whole product; the cloud is
a fleet of optional, independently-scalable services that add identity, reachability, and
ecosystem integrations on top of a system that is fully functional with the internet cut.

These are **invariants** — every design decision below is subordinate to them, and any
future change that violates one is a regression:

- **I1 — Local automation never depends on the cloud.** Triggers, conditions, scenes,
  schedules, presence, wall panels, and on-LAN mobile control execute on the hub with zero
  cloud round-trips. The cloud is never on the control path for in-home use.
- **I2 — The cloud is a control-plane, not a data-plane for device state.** It brokers
  encrypted traffic, holds identity/authorization, and links ecosystems. It does **not**
  store or proxy live device telemetry except as explicitly opted-in (telemetry, backup).
- **I3 — Home Assistant is invisible and unauthenticated-by-users.** Users authenticate
  only with Supreme Cloud (off-LAN) or the hub's Supreme identity (on-LAN). HA has no user
  accounts, no exposed UI, and is never named in any client-facing surface or API.
- **I4 — The hub always dials out.** No inbound ports, port-forwarding, DDNS, VPN, or
  static IP is ever required. Cloud never connects *into* a home.
- **I5 — Zero Trust.** Every request is authenticated and authorized at every hop. No
  network position grants implicit trust. mTLS between planes; short-lived, rotating
  credentials; no ambient shared secrets.

### 1.1 What the cloud owns vs. what stays local

| Cloud-owned (control-plane) | Hub-owned (data-plane, always local) |
|---|---|
| User identity, authentication, authorization (off-LAN) | Device state, command execution, automation engine |
| Hub registry, device registry, fleet inventory | Rooms, devices, scenes, schedules, favorites, cameras |
| Remote tunnel brokering (transport only) | Local identity validation + RBAC enforcement |
| Push notification fan-out | Notification *generation* (events originate on the hub) |
| Voice/Matter cloud-to-cloud linking & state reporting | Voice/Matter command *execution* |
| Firmware/OTA distribution + signing metadata | Firmware *application* + rollback |
| Subscription, licensing, entitlements | Offline license validation (signed tokens) |
| Optional telemetry, analytics, cloud backup | The data those features summarize |

---

## 2. Macro Topology

```
                            ┌──────────────────────────── CLIENTS ───────────────────────────┐
                            │  Flutter mobile/tablet/watch · Wall panels · Web homeowner       │
                            │  Web Installer Portal · Dealer/Fleet dashboard                   │
                            └───────────────┬──────────────────────────────┬──────────────────┘
                 on-LAN: mDNS/DNS-SD direct │                              │ off-LAN: Supreme API (HTTP/3)
                 (transparent switch)       │                              │
                                            │              ┌───────────────▼───────────────────────────┐
                                            │              │             SUPREME CLOUD                   │
                                            │              │   (multi-region, multi-tenant, k8s)         │
                                            │              │                                             │
                                            │              │  Edge: Global Anycast · API GW · WAF        │
                                            │              │        HTTP/3+QUIC · TLS termination        │
                                            │              │  ┌──────────────── Mesh (mTLS) ──────────┐  │
                                            │              │  │ Identity · AuthN · AuthZ              │  │
                                            │              │  │ Hub Registry · Device Registry        │  │
                                            │              │  │ Tunnel Broker (control)               │  │
                                            │              │  │ Notification · Voice · Matter         │  │
                                            │              │  │ Firmware/OTA · Subscription/Licensing │  │
                                            │              │  │ Installer/Dealer · Admin · Telemetry  │  │
                                            │              │  └───────────────────────────────────────┘  │
                                            │              │  Data: Postgres(Citus) · Redis · NATS       │
                                            │              │        ScyllaDB(TS) · ClickHouse · S3 · KMS │
                                            │              └───────────────┬─────────────────────────────┘
                                            │   mTLS, hub-initiated QUIC    │  (control + brokered data planes)
                                            │   persistent outbound tunnel  │
        ┌───────────────────────────────────┴──────────────────────────────┴─────────────────┐
        │                                THE SUPREME OS HUB                                    │
        │  Supreme plane (gateway/identity/permissions/home/scenes/automations/SIL/AI)         │
        │  Hub Agent (cloud connector): identity, enrollment, tunnel client, push relay, OTA   │
        │  Hidden, headless Home Assistant Core (loopback only) · Protocol stacks              │
        └──────────────────────────────────────────────────────────────────────────────────────┘
```

Two distinct cloud↔hub channels, both **hub-initiated** and **mutually authenticated**:

1. **Control channel** (always on): a persistent QUIC/HTTP-3 stream the hub holds open to
   the Tunnel Broker. Carries: liveness/heartbeat, command pushes (voice/remote), config
   deltas, OTA availability, revocations. Tiny, low-bandwidth, low-latency.
2. **Brokered data channel** (on demand): when an off-LAN client needs the hub, the broker
   multiplexes a logical stream over the same QUIC connection to the hub's local gateway.
   The hub validates identity/RBAC locally exactly as on the LAN; the broker only transports
   ciphertext it cannot read (end-to-end between client session and hub).

---

## 3. Hub Identity & Zero-Touch Provisioning

Every hub is a **cryptographic principal** with a hardware-rootable identity. No manual
registration, no copy-pasting tokens.

### 3.1 Identity material (generated once, on first boot)

| Artifact | Type | Storage | Purpose |
|---|---|---|---|
| `hub_uuid` | UUIDv7 (time-ordered) | secrets store + cloud registry | globally-unique stable hub id |
| Device keypair | Ed25519 (+ X25519 for key agreement) | private key sealed at rest; never leaves hub | signing, mTLS client identity |
| Device CSR → **Device Certificate** | X.509, issued by Supreme Hub CA | secrets store | mTLS to cloud, attestation |
| Provisioning secret | one-time enrollment token (factory or installer-bound) | consumed on first enroll | bootstraps trust before a cert exists |
| HRoT handle (future) | TPM/SE-backed key reference | secure element | hardware root of trust |

Private keys are sealed by the hub's existing secrets manager (see `gateway` secrets dir),
and on hardware with a TPM/secure element the device key is generated *inside* the element
and never extractable (Phase 4 / §3.5).

### 3.2 Zero-touch enrollment handshake

```
Hub (first boot)                              Cloud (Hub Registry + AuthN + Hub CA)
────────────────                              ─────────────────────────────────────
1. generate hub_uuid + Ed25519 keypair
2. build CSR(hub_uuid, pubkey)
3. POST /v1/hubs/enroll  ───────────────────▶ verify provisioning secret / attestation
   { csr, hub_uuid, attestation,                (factory-signed, installer-bound, or
     model, fw_version, nonce_sig }              TPM EK cert in Phase 4)
                                              4. issue Device Certificate (short-lived,
                                                 auto-renewing) signed by Hub CA
                                              5. create hubs row (status=provisioned,
                                                 unclaimed), emit hub.enrolled event
6. store cert + CA chain  ◀─────────────────── { device_cert, ca_chain, broker_endpoint,
7. open mTLS QUIC control channel               rotation_policy }
   to broker_endpoint (cert-authenticated)
8. heartbeat + await claim
```

The hub is now **provisioned but unclaimed** — reachable by the cloud, owned by nobody.

### 3.3 Claiming a hub (binding to an owner)

Ownership is established by a human with physical/network proximity, never by the cloud
alone:

- **On-LAN claim:** the installer or owner app, on the same LAN, reads a short-lived claim
  code shown on the hub (or signed mDNS TXT record), and calls
  `POST /v1/hubs/{hub_uuid}/claim { claim_code }` while authenticated as a Supreme user. The
  first claimant becomes **Owner**; the hub records the binding and the cloud creates the
  `home` + `membership(owner)`.
- **Installer pre-provisioning:** a dealer claims the hub into their org, configures it, then
  transfers ownership to the end customer (`POST /v1/hubs/{id}/transfer`). Audit-logged.

Claim codes are single-use, time-boxed, rate-limited, and only valid while the requester
proves LAN proximity (mDNS challenge) or holds a dealer-scoped token.

### 3.4 Certificate lifecycle

Device certs are **short-lived (e.g. 30 days) and auto-renew** over the authenticated
control channel well before expiry; a renewal proves possession of the device key. Compromise
or decommission triggers **revocation** (CRL + short-cert TTL ⇒ fast effective revocation).
A hub that fails renewal for the grace window must re-enroll (re-claim required if unbound).

### 3.5 Hardware Root of Trust (future-ready)

The enrollment payload carries an `attestation` envelope. Phase-1 accepts a factory- or
installer-signed attestation; the schema and verifier are designed so Phase-4 can require a
**TPM 2.0 / secure-element EK certificate + quote** and a Secure Boot measurement without any
API break. Keys move into the secure element; the rest of the flow is unchanged.

---

## 4. Cloud Microservices Catalog

Independently deployable, independently scalable, mesh-internal mTLS, stateless where
possible (state in the data tier). Each owns its schema (schema-per-service in a shared
Citus/Postgres cluster initially; physically splittable later). Synchronous calls via gRPC
inside the mesh; asynchronous domain events via NATS JetStream (`supreme.cloud.<svc>.<event>`).

| Service | Responsibility | State | Scale driver | Public API |
|---|---|---|---|---|
| **Identity** | accounts, profiles, identities (email/phone/username), social-link records, passkeys (WebAuthn) | Postgres `identity` | users | REST + gRPC |
| **AuthN** | login flows, password (Argon2id), TOTP/MFA, passkey assertions, OAuth/OIDC for Google/Apple/Microsoft, token mint/rotate (JWT + refresh), session registry | Postgres `auth` + Redis | login QPS | REST (OIDC) |
| **AuthZ** | RBAC/ABAC policy decision point; per-(home,resource,action) decisions; grant evaluation incl. time windows | Postgres `authz` + Redis cache | request QPS | gRPC (PDP) |
| **Hub Registry** | enrollment, device certs (via Hub CA), claim/transfer, hub inventory, liveness, fw/version | Postgres `hubs` | hubs | REST + gRPC |
| **Device Registry** | per-account client devices (phones/tablets/panels), device certs, push tokens, trust/approval, remote logout | Postgres `devices` | client devices | REST |
| **Tunnel Broker** | terminates hub control channels; routes off-LAN client sessions ⇄ hub; presence; backpressure | Redis (routing) + in-mem conn state | concurrent connections | QUIC/WS + gRPC |
| **Notification** | push fan-out to APNs/FCM/WebPush/Wear/Watch; templating; delivery receipts; quiet hours | Postgres `notify` + Redis | notifications/s | gRPC (internal) |
| **Voice** | Alexa/Google/Siri/Shortcuts account-linking, skill OAuth, directive routing, async state reporting | Postgres `voice` + Redis | linked accounts | OAuth + webhooks |
| **Matter Cloud** | Matter fabric/credential brokering, Matter-cloud APIs, multi-admin coordination | Postgres `matter` | fabrics | gRPC + webhooks |
| **Firmware/OTA** | release channels, signed manifests, staged rollout, hub-targeted availability | Postgres `ota` + S3 | hubs polling | REST |
| **Subscription/Licensing** | plans, entitlements, billing-provider integration, signed offline license tokens | Postgres `billing` | accounts | REST + webhooks |
| **Installer/Dealer** | org management, project/site assignment, commissioning hand-off, remote service grants | Postgres `dealer` | dealers | REST + GraphQL |
| **Admin Console** | internal ops, support, impersonation (audited), feature flags | reads others | ops | GraphQL |
| **Telemetry** | opt-in metrics/events ingestion, anonymization, retention | ClickHouse + S3 | event volume | gRPC ingest |
| **Analytics** | energy/usage/fleet reporting on telemetry | ClickHouse | queries | GraphQL |
| **Audit** | append-only, tamper-evident security/event log across services | ScyllaDB/Postgres | event volume | gRPC ingest |

**Edge tier** (in front of all of the above): global Anycast + API Gateway (routing,
versioning, schema validation), WAF, DDoS/rate-limiting, TLS/QUIC termination, request
authentication (JWT verification at the edge, fail-closed).

---

## 5. Identity & Authentication

Supreme Cloud is the **sole identity provider**. The hub trusts Supreme identities; it never
holds user passwords for cloud users and never authenticates anyone against Home Assistant.

### 5.1 Supported authenticators

- **Knowledge:** email + password, phone + password, username + password (Argon2id, per-user
  salt, pepper in KMS).
- **Possession/inherence:** **Passkeys (WebAuthn/FIDO2)** — primary, phishing-resistant;
  platform biometrics (Face/Touch ID, Android Biometric) gate the local keystore + passkey.
- **Federated:** **Sign in with Apple, Google, Microsoft** via OIDC; linked to a single
  Supreme account (account-linking by verified email, with explicit merge consent).
- **MFA:** TOTP, WebAuthn second factor, and push-approval (via the Device Registry). Step-up
  auth required for sensitive actions (add hub, transfer ownership, change roles, unlock).

### 5.2 Token model

- **Access token:** short-lived JWT (e.g. 10 min), asymmetrically signed (EdDSA), `aud`-scoped
  per audience (cloud API vs. hub), carries `sub`, `home`/`hub` scope hints, `amr` (auth
  methods), device-bound `cnf` (proof-of-possession / DPoP or mTLS thumbprint).
- **Refresh token:** opaque, **rotating** (one-time-use; reuse ⇒ family revocation), bound to
  a registered device (Device Registry) and an auth session. Sliding lifetime with absolute
  cap.
- **Automatic rotation:** refresh rotates the pair on every use; access tokens are re-minted;
  signing keys rotate on a schedule with JWKS publication + overlap.
- **Hub-scoped tokens:** off-LAN, the client presents a cloud access token to the edge; the
  Tunnel Broker hands the hub a short-lived, hub-audience assertion so the hub can authorize
  the request **locally** against its own RBAC (cloud identity → local principal mapping).
- **Revocation:** session registry (Redis) + token-family invalidation; remote logout from
  Device Management revokes a device's refresh family within seconds.

### 5.3 On-LAN vs off-LAN identity

On-LAN the client may authenticate directly to the hub's local identity service (already
exists) for zero-cloud-dependency control, OR present a cached cloud token. Off-LAN, identity
is always cloud-anchored. Either way the hub is the **enforcement point** for device/scene/
room permissions — the cloud authenticates *who you are*; the hub authorizes *what you may do
here* (defense in depth, and it keeps automation working offline).

---

## 6. Multi-Tenant Data Model

The model is **account-centric** with a many-to-many mesh of users ↔ homes ↔ hubs. One
account → unlimited homes/hubs; one hub → unlimited users.

```
accounts(id, status, created_at, primary_identity_id)            -- the person/principal
identities(id, account_id, kind[email|phone|username], value,    -- login handles
           verified_at, UNIQUE(kind, value))
federated_identities(id, account_id, provider[apple|google|ms],
           subject, email, linked_at)
credentials(account_id, password_hash(argon2id), updated_at)
passkeys(id, account_id, credential_id, public_key, sign_count,
           aaguid, transports, name, created_at, last_used_at)
mfa_methods(id, account_id, type[totp|webauthn|push], secret_ref,
           confirmed_at)
auth_sessions(id, account_id, device_id, amr, created_at,
           expires_at, absolute_expiry, revoked_at)
refresh_tokens(id, session_id, family_id, hash, rotated_to,
           used_at, revoked_at, expires_at)

hubs(id[uuid7], status[provisioned|claimed|suspended|decommissioned],
           model, fw_version, hub_ca_serial, last_seen_at,
           claimed_by_account_id NULL, dealer_org_id NULL, created_at)
hub_certs(id, hub_id, serial, not_before, not_after, revoked_at,
           pubkey_fingerprint)
hub_attestations(id, hub_id, kind[factory|installer|tpm], evidence_ref,
           verified_at)

homes(id, name, address, timezone, owner_account_id, hub_id,        -- a home ≈ one hub
           tier, created_at)                                        -- (hub may also be hub-less virtual)
memberships(id, home_id, account_id, role[owner|admin|installer|
           homeowner|family|guest|service], invited_by, status,
           valid_from, valid_until NULL, schedule_json NULL)
member_grants(id, membership_id, resource_type, resource_id NULL,
           action, effect[allow|deny], valid_until NULL)             -- ABAC overlay

client_devices(id[uuid], account_id, name, platform[ios|android|
           web|wearos|watchos|panel|macos], os_version, model,
           push_token, push_provider, cert_serial, trust[approved|
           pending|revoked], last_seen_at, last_ip, last_geo,
           created_at)

voice_links(id, account_id, home_id, assistant[alexa|google|siri|
           matter], external_user_ref, scopes, linked_at, status)
matter_fabrics(id, home_id, fabric_id, root_ref, admin_refs_json,
           created_at)

subscriptions(id, account_id, plan, status, entitlements_json,
           current_period_end, provider_ref)
licenses(id, home_id, hub_id, sku, features_json, issued_at,
           expires_at, signature)                                    -- offline-validatable

audit_log(id, scope[cloud|home], home_id NULL, actor_account_id,
           actor_kind[user|hub|dealer|system], action, resource_type,
           resource_id, metadata_json, ip, created_at)               -- append-only
```

**Tenancy & sharding:** the shard key is `home_id` for home-scoped data and `account_id` for
identity data (Citus distributed tables). A home maps to exactly one hub (the common case);
"hub-less" virtual homes are supported for future cloud-only scenarios. Cross-home queries
(an account's home list) are served from a co-located `memberships` reference table.

**Local mirror:** the hub keeps its own authoritative copy of home-scoped data (rooms,
devices, scenes, RBAC). The cloud stores the *membership graph and identity*, not device
state. The two reconcile via the offline-sync log (§12), with the hub authoritative for
device/automation state and the cloud authoritative for identity/membership.

---

## 7. Remote Connectivity — Zero-Trust Tunnel Broker

Replaces the Phase-1 shared-token relay entirely.

### 7.1 Transport

- **Hub→Broker:** persistent **QUIC (HTTP/3)** connection, **mutual TLS** with the hub's
  device certificate. QUIC gives us multiplexed streams, 0-RTT resumption, connection
  migration (hub IP changes don't drop the tunnel), and head-of-line-blocking-free
  multiplexing. Falls back to WebSocket-over-TLS where QUIC/UDP is blocked.
- **Client→Edge:** HTTP/3 to the nearest Anycast PoP; the Supreme API. The edge authenticates
  the client (JWT/mTLS) and routes to the Tunnel Broker holding that home's hub.
- **Broker→Hub:** a new logical QUIC stream per client request/stream, framed and forwarded to
  the hub agent, which proxies to the **local** gateway (`127.0.0.1:8080`). gRPC is used for
  the broker↔hub control framing; raw byte streams for media (camera) where needed.

### 7.2 Security properties

- **End-to-end auth:** the client session and the hub establish an authenticated channel; the
  broker routes ciphertext and cannot read request bodies (it is a transport, not a
  man-in-the-middle). The hub re-validates identity & RBAC locally for every request.
- **No inbound ports** (I4): the hub holds the only connection it ever opens — outbound.
- **Per-home isolation:** a hub stream is keyed by `hub_id` from its client cert; a client may
  only reach homes its account is a member of (edge + broker enforce, hub re-checks).
- **Replay protection:** request nonces + monotonic stream sequencing; short-TTL hub
  assertions.
- **Backpressure & fairness:** per-hub and per-account concurrency limits, stream flow
  control, abuse rate-limiting at the edge.

### 7.3 Latency budget (target: first remote byte < 1 s, steady-state < 250 ms)

```
client → nearest PoP (Anycast, warm QUIC)         ~20–60 ms
edge authn + route to broker (same region)        ~5–15 ms
broker → hub (existing warm QUIC stream)           RTT to hub region
hub local gateway + SIL execute                    ~5–30 ms
return path                                         symmetric
```

Warm connections (control channel already open) make the steady state a single RTT + local
execution. Cold start (hub just reconnected) is bounded by QUIC 0-RTT resumption.

### 7.4 Presence & failover

The broker tracks hub presence (Redis) and rebalances hubs across broker instances; client
edge nodes discover the owning broker via the routing table. Broker instances are stateless
beyond live connections; a broker loss drops tunnels, hubs auto-reconnect (exponential
backoff, jitter) to a healthy broker within seconds. Multi-region: hubs connect to their
nearest region; clients are routed to the hub's home region.

---

## 8. Local Discovery & Transparent Transport Switching

The homeowner never types a URL or toggles "local/remote." The app maintains a **connection
manager** that prefers the fastest correct path:

1. **Discover on-LAN:** mDNS/DNS-SD (`_supreme._tcp`) + signed TXT record advertising
   `hub_uuid` + cert fingerprint. The app verifies the advertised hub is one of the account's
   claimed hubs (prevents rogue-hub spoofing) by checking the fingerprint against the cloud
   registry / cached membership.
2. **Prefer local:** if a verified hub is reachable on the LAN, connect directly to the hub
   gateway over TLS (hub presents its device cert; app pins the registry fingerprint). Sub-LAN
   latency, zero cloud dependency.
3. **Fallback to cloud:** otherwise route via the Supreme API → Tunnel Broker.
4. **Continuous health + seamless handoff:** the connection manager runs both probes; moving
   from Wi-Fi to cellular (or back) switches transports **without re-auth and without
   interrupting subscriptions** — the session identity is transport-independent; in-flight
   WebSocket/stream subscriptions are re-established transparently and optimistic UI state is
   preserved.

The same Supreme API contract is served on both paths, so client code is path-agnostic.

---

## 9. Voice Assistants & Matter

The cloud owns *linking and cloud-to-cloud*; the hub owns *execution*. HA is never exposed.

- **Account/skill linking:** the Voice service is an OAuth2 provider for Alexa, Google, and an
  app-intents/Shortcuts provider for Apple. Linking maps an external assistant user to a
  Supreme account + home, with explicit scopes.
- **Discovery & state reporting:** Supreme exposes the home's devices/capabilities to each
  ecosystem (Alexa Smart Home discovery, Google HomeGraph `SYNC`/`QUERY`, HomeKit
  accessories). State changes on the hub publish to the cloud Voice service, which performs
  **async state reporting** (Alexa `ChangeReport`, HomeGraph `ReportState`) so assistants stay
  in sync.
- **Directive routing:** a voice command hits the ecosystem cloud → Supreme Voice service →
  Tunnel Broker → hub → SIL executes locally → response. Capability mapping reuses the SIL
  capability model (`onoff/brightness/color/temperature/position/media/lock/fan/vacuum/…`), so
  one mapping serves all assistants.
- **Matter:** the hub runs the local Matter controller/bridge (already in the driver store);
  the **Matter Cloud** service brokers fabric credentials, multi-admin, and future Matter-cloud
  APIs. Supreme can expose hub devices to a third-party Matter fabric and consume Matter
  devices — all credential/fabric state coordinated in the cloud, all on-network operation on
  the hub.
- **Offline:** if the internet is down, voice assistants are unavailable (they are cloud
  services), but local control, automation, and on-LAN Siri Shortcuts that target the local
  hub continue.

---

## 10. Push Notifications

Events **originate on the hub** (doorbell, motion, alarm, scene, automation alert). The hub
sends a signed notification request over the control channel to the cloud Notification
service, which fans out to **APNs / FCM / WebPush / Wear OS / watchOS**. The cloud only
*delivers*; it does not generate notifications and (for end-to-end-encrypted payloads) cannot
read sensitive contents — the title/body can be encrypted to the device with a notification
key, with a routable, non-sensitive envelope. Targets resolve through the Device Registry
(push tokens per client device). Delivery receipts + quiet-hours/priority handled cloud-side.
Target latency < 2 s end-to-end.

---

## 11. RBAC & Permissions

Roles are per-**home** (membership), with an ABAC grant overlay for fine-grained, temporary,
or scheduled access. The cloud AuthZ service is the policy decision point for cloud APIs; the
**hub re-enforces** the same model locally (so it works offline and is defense-in-depth).

**Roles:** `Owner`, `Administrator`, `Installer`, `Homeowner`, `Family`, `Guest`,
`Service Engineer`.

**Resource domains:** Rooms, Devices, Scenes, Automation, Cameras, Security, Schedules,
Notifications, Remote Access, Installer Portal, Firmware, Diagnostics.

Baseline role→domain matrix (●=full, ◐=scoped/limited, ○=none; overridable per-grant):

| Domain \ Role | Owner | Admin | Installer | Homeowner | Family | Guest | Service |
|---|---|---|---|---|---|---|---|
| Rooms/Devices | ● | ● | ● | ● | ◐ | ◐ | ◐ |
| Scenes/Automation | ● | ● | ● | ● | ◐ | ○ | ◐ |
| Cameras | ● | ● | ◐ | ◐ | ◐ | ○ | ◐ |
| Security (arm/unlock) | ● | ● | ○ | ◐ | ◐ | ○ | ○ |
| Schedules | ● | ● | ● | ● | ◐ | ○ | ◐ |
| Notifications | ● | ● | ◐ | ● | ◐ | ◐ | ◐ |
| Remote Access | ● | ● | ◐ | ● | ◐ | ◐ | ◐ (granted) |
| Installer Portal | ◐ | ◐ | ● | ○ | ○ | ○ | ◐ |
| Firmware | ● | ◐ | ● | ○ | ○ | ○ | ◐ |
| Diagnostics | ● | ● | ● | ◐ | ○ | ○ | ● |

Guests and Service Engineers are typically **time-boxed** (`valid_until` / `schedule_json`);
Service access is explicitly granted by the Owner/Admin and auto-expires.

---

## 12. Offline Behavior & State Synchronization

**When the internet is down (I1):** automation, wall panels, on-LAN mobile control, scenes,
and schedules all continue — none touch the cloud. Only cloud-mediated features (off-LAN
access, voice, push delivery, cloud backup) pause.

**Reconnect is automatic and silent:** the hub agent reconnects the QUIC control channel
(backoff + jitter), re-attests if needed, and runs a **bidirectional reconciliation**:

- Identity/membership: cloud → hub (cloud authoritative).
- Device/scene/automation state + audit/events generated offline: hub → cloud (hub
  authoritative), via an **append-only, monotonic change log** with last-writer-wins per
  field and vector-clock/`updated_at` conflict detection. Notifications queued offline are
  flushed (de-duplicated, with staleness suppression) on reconnect.

No user interaction is required at any point. The sync log is the same mechanism that powers
cloud backup and multi-device consistency.

---

## 13. Device Registration, Management & Phone Replacement

**Registration:** on first login from a client, the Device Registry issues a `device_uuid`, a
device certificate (for DPoP/mTLS proof-of-possession), a rotating refresh token, and records
the push token + a human name (e.g. "Mujeeb's iPhone", "Office Wall Panel").

**Management surface (per account):** list devices with **Last Seen, OS, device type, IP,
approximate location**; rename; delete; **remote logout** (revokes the refresh family within
seconds); **approve new devices** (optional step-up for first login on a new device).

**Phone replacement (no installer):**

```
1. Install Supreme OS app on new phone
2. Login (password/passkey/social) + MFA/step-up
3. Cloud authenticates → Device Registry registers the new device
4. Sync down: homes, memberships, favorites, scenes, settings, notification prefs
5. Old device: left active or revoked at the user's choice (remote logout)
```

Everything the user sees is restored from the cloud membership/identity graph + per-hub sync;
no re-commissioning, no dealer involvement.

---

## 14. Installer Portal & Dealer Backend

A **separate** experience and backend from the homeowner app (shared design system, different
IA and permissions). The Installer/Dealer service provides:

- **Org & fleet:** dealer organizations, technicians, customer sites, hub assignment,
  ownership transfer, multi-site rollups.
- **Commissioning hand-off:** the heavy commissioning (KNX/Matter/Zigbee/DALI/MQTT/Modbus,
  `.knxproj` import incl. encrypted) runs **on the hub** (already implemented); the portal
  drives it remotely over the tunnel and tracks project state cloud-side.
- **Remote service:** Owner-granted, time-boxed `Service Engineer` access for diagnostics,
  logs, backup/restore, networking, and firmware — fully audited, revocable, and visible to
  the owner.
- **Firmware & diagnostics:** target fleet rollouts by model/site/channel; pull diagnostics
  bundles and logs over the tunnel.

---

## 15. API Strategy

- **REST/JSON** (`/v1/…`) for CRUD and OIDC auth flows — the broad, cacheable surface.
- **gRPC** for internal mesh service-to-service and broker↔hub control framing.
- **GraphQL** for read-heavy, relationship-rich aggregations: the homeowner multi-home
  dashboard, dealer/fleet console, analytics — one round-trip, client-shaped.
- **WebSocket / Server-Sent + QUIC streams** for realtime device state, presence, and
  notifications.
- **Streaming** (byte/media streams over QUIC) for camera and large transfers.
- **Versioning:** URI-versioned public REST (`/v1`), schema-evolution rules for gRPC/GraphQL
  (additive, deprecation windows), capability-negotiation header, and a published OpenAPI +
  AsyncAPI + GraphQL SDL generated from `packages/supreme-contracts`. SDKs (`supreme-sdk-ts`,
  `supreme-sdk-dart`) are generated, so clients never hand-roll protocol details.

---

## 16. Mobile App Architecture (multi-home native)

```
App
├── Cloud Session (identity, tokens, device registry)      ← survives home switches
├── Connection Manager (per hub)                            ← mDNS-local ↔ cloud-tunnel, transparent
│     └── Supreme API client (path-agnostic, generated SDK)
├── Home Switcher (instant, no logout)                      ← lists all accessible hubs/homes
└── Per-Home State (Riverpod scopes, one per hub)
      ├── Rooms · Devices · Scenes · Favorites
      ├── Permissions (from membership)
      ├── Cameras · Security · Automation
      └── Notifications
```

After login the app lists every home the account is a member of (Mumbai Villa, Dubai
Apartment, Farmhouse, Office…) and **switches instantly** by swapping the active per-home
Riverpod scope and connection — no logout, no re-auth. Each home keeps fully independent
rooms/devices/scenes/notifications/favorites/permissions/automation/cameras. The Connection
Manager picks local vs. cloud transparently per home (you can be on the LAN of one home and
remote to another simultaneously).

---

## 17. Security — Zero Trust

- **mTLS everywhere** between planes (client↔edge optional mTLS/DPoP; hub↔cloud mandatory
  device-cert mTLS; service mesh mTLS via SPIFFE-style identities).
- **Certificate rotation** (short-lived device + service certs, automated renewal, JWKS key
  rotation with overlap).
- **Refresh-token rotation** with reuse-detection family revocation; **replay protection**
  (nonces, monotonic sequencing, short TTLs).
- **Secrets** sealed at rest (KMS/HSM-backed envelope encryption; hub secrets manager seals
  the device key; Phase-4 HRoT/secure-element + Secure Boot measurement).
- **No plaintext credentials** anywhere; passwords Argon2id + KMS pepper; push payloads
  E2E-encryptable.
- **Edge defenses:** WAF, per-account/per-IP/per-hub rate limiting, anomaly detection,
  geo/velocity checks on auth.
- **Audit:** append-only, tamper-evident (hash-chained) audit log spanning cloud + hub
  security events, queryable by Owner/Admin/Dealer with export.
- **Least privilege & blast-radius:** schema-per-service, scoped service identities, per-home
  data isolation, impersonation only via audited Admin Console with consent.

---

## 18. Scalability & Multi-Region

- **Stateless services** behind the edge; horizontal autoscaling on QPS/connection count.
- **Data tier:** Citus/Postgres (sharded by `home_id`/`account_id`) for relational;
  Redis (sessions, presence, routing, caches); NATS JetStream (events/commands);
  ScyllaDB/ClickHouse (telemetry/analytics/audit at volume); S3 (backups, firmware, media).
- **Tunnel Broker** scales by concurrent connections; hubs shard across brokers by region and
  consistent hashing on `hub_id`; brokers are replaceable (hubs auto-reconnect).
- **Multi-region:** hubs and clients pinned to nearest region; identity is globally
  replicated (read-anywhere, write-home-region); home data is region-resident with disaster
  failover. Designed for **millions of users and millions of hubs**, unlimited homes/users/
  devices.
- **Targets:** remote first-byte < 1 s, home switch instant (pre-warmed sessions), push < 2 s,
  offline fallback immediate, reconnect automatic.

---

## 19. Observability & Telemetry (opt-in)

OpenTelemetry traces/metrics/logs across the mesh (the hub already emits OTel). Telemetry from
hubs is **opt-in**, anonymized, retention-bounded, and never required for operation. SLOs +
error budgets per service; runbooks; the existing `infra/observability` stack extends to
cloud.

---

## 20. Subscription, Licensing & Entitlements

The Subscription service manages plans/entitlements and integrates a billing provider;
entitlements gate premium features (heavy AI, cloud backup, advanced fleet). Licensing issues
**signed, offline-validatable** license tokens stored on the hub so an air-gapped install
stays licensed and local features never blackout on a billing hiccup (I1/I2). Re-validation is
periodic and optional.

---

## 21. Migration From the Current Architecture

What is **kept, refactored, or replaced**:

| Current | Verdict | Action |
|---|---|---|
| `cloud/relay` (shared-token push + homeId tunnel) | **Replace** | Split into **Tunnel Broker** (mTLS/QUIC, cert-identified hubs) + **Notification** service. Shared `hubAuthToken` removed in favor of device certs. |
| `services/gateway` `relay-tunnel.ts` (hub side) | **Refactor** | Becomes the **Hub Agent** cloud connector: enrollment, device-cert mTLS, QUIC control channel, push relay, OTA. |
| Hub-local `services/identity` | **Keep + re-scope** | Remains for **on-LAN** local auth and as the local enforcement point; cloud Identity/AuthN becomes the off-LAN IdP; map cloud identity → local principal. |
| `services/permissions` (RBAC) | **Keep + mirror** | Stays as the hub enforcement point; cloud AuthZ mirrors the same model for cloud APIs. |
| `cloud/fleet`, `cloud/licensing` | **Evolve** | Fold into **Installer/Dealer** and **Subscription/Licensing** services; keep contracts. |
| No hub identity | **New** | Hub UUID + Ed25519 + device cert + zero-touch enrollment (§3). |
| Single-home assumption in clients | **Replace** | Multi-home account model (§6, §16). |
| `persistence` migrations (hub) | **Keep** | Hub stays authoritative for device state; add a cloud schema (new migrations in the cloud services). |

**Backwards compatibility:** the Supreme API contract clients depend on is preserved; the
transport beneath it (relay → broker) changes without changing client code. Hubs already
deployed enroll on upgrade (generate identity, auto-register, owner re-claims once).

---

## 22. Phased Roadmap

- **C0 — Foundation (spine):** hub cryptographic identity + zero-touch enrollment; cloud Hub
  Registry + Hub CA; device-cert mTLS; cloud data-model schema. *(implementation started this
  phase — see code under `cloud/` + `services/gateway` hub agent.)*
- **C1 — Identity plane:** cloud Identity + AuthN (password/passkey/social/MFA) + token
  rotation; Device Registry + device management; multi-home membership.
- **C2 — Connectivity plane:** Tunnel Broker (QUIC/mTLS) replacing the relay; transparent
  local/cloud switching in the app; presence/failover.
- **C3 — Ecosystem plane:** Notification service; Voice (Alexa/Google/Siri/Shortcuts) +
  Matter Cloud; firmware/OTA fleet rollout.
- **C4 — Commercial plane:** Subscription/Licensing; Installer/Dealer + Admin; Telemetry/
  Analytics; multi-region + HRoT/Secure Boot; AI assistant, energy/EV/solar hooks.

---

## 23. Cloud Database Schemas (detailed)

Schema-per-service; see §6 for the canonical tables. Each service ships its own migrations
(mirroring the hub's `services/persistence` pattern). Distribution: home-scoped tables sharded
by `home_id`, identity tables by `account_id`, reference tables (`memberships`) co-located.
Audit is append-only + hash-chained. All timestamps UTC; all ids UUIDv7 except natural keys.

---

## 24. Verification

Architecture verification = stakeholder approval of this blueprint + the ADRs in
`docs/architecture/adr/`. Implementation verification, per phase, is the existing CI gate
(`pnpm build && pnpm test`) plus: enroll a simulated hub end-to-end (UUID→CSR→cert→control
channel), claim it to an account, switch a multi-home app between two hubs, and drive a remote
command through the broker to the hub and back — with **no Home Assistant branding anywhere**
and **local control unaffected with the cloud disabled**.

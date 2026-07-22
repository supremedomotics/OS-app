# Architecture — Supreme OS

This document explains system design and, wherever the code/ADRs/git history make
it inferable, **why** each decision exists. It complements (does not replace) the
founding design doc, [`docs/architecture/supreme-os-blueprint.md`](docs/architecture/supreme-os-blueprint.md),
and the ADRs in [`docs/architecture/adr/`](docs/architecture/adr/).

## High-level architecture

```
                        CLIENTS
        Flutter Mobile/Tablet  │  Web (Homeowner + Installer Portal)
        Aureon Design System   │
                    │  HTTPS / WSS (Supreme API only)
      ┌─────────────┴──────────────────────────────┐
      │        SUPREME CLOUD (OPTIONAL / OPT-IN)     │
      │  Remote-access relay · off-site backup ·      │
      │  driver-store mirror · fleet mgmt · voice ·   │
      │  Matter metadata · licensing · optional heavy AI │
      └─────────────┬──────────────────────────────┘
                    │ mutual-TLS, outbound tunnel — only if remote
                    │ access is enabled by the owner (hub dials cloud)
   ── LAN clients always talk directly to the hub; cloud never required ──
┌───────────────────┴────────────────────────────────────────────────┐
│                     THE HOME HUB (Docker Compose)                    │
│  ┌────────────────────── SUPREME PLANE ─────────────────────────┐   │
│  │ API Gateway/BFF (Node) · Identity/Permissions (Node)          │   │
│  │ Room/Device/Scene/Automation services (Node)                 │   │
│  │ AI Assistant Worker (Python, optional local LLM)              │   │
│  │ Event Bus (in-process, or NATS/Redis at scale)                │   │
│  │ ┌────────── SUPREME INTEGRATION LAYER (SIL) ──────────────┐  │   │
│  │ │ Capability Mapper · Entity Registry Mirror               │  │   │
│  │ │ HaAdapter (Node) · SupremeNativeAdapter · MockAdapter     │  │   │
│  │ └───────────────┬────────────────────────────────────────┘  │   │
│  └──────────────────┼──────────────────────────────────────────┘   │
│           HA WS+REST (loopback only)                                 │
│  ┌──────────────────┴──────────────────┐                             │
│  │ HOME ASSISTANT CORE (headless, hidden) │                             │
│  └──────────────────┬──────────────────┘                             │
│  Protocol stacks: KNX · DALI · Matter · Zigbee · MQTT · Modbus ·      │
│                    AVR · CoolMaster · Lutron LIP · Tuya · media       │
└────────────────────────────────────────────────────────────────────┘
```

**Why this shape:** the founding constraint (blueprint §Context) is that Home
Assistant must be usable *today* without becoming a permanent dependency. Putting
everything Supreme-facing above a single seam (the SIL) is the only way to make
"replace HA later" a real, tested capability rather than an aspiration.

## Backend architecture

- **Polyglot split by responsibility, not by preference.** Node/TypeScript owns
  the real-time/API-gateway/identity/SIL surface — it shares types with the web
  clients and has a strong WebSocket story for the HA bridge. Python/FastAPI owns
  AI inference and protocol-commissioning logic that benefits from Python's
  ecosystem (HA itself is Python; KNX/DALI/Modbus tooling has mature Python
  libraries). See ADR 0002.
- **Services are single-responsibility Node packages** under `services/*`
  (gateway, identity, permissions, home, scenes, notifications, persistence,
  messaging, drivers, protocols, commissioning, automations, analytics, audit,
  ai, security, cameras, integration-layer, intelligence, license), each with its
  own `package.json`/tests, composed by the gateway process. This mirrors the
  monorepo's Turborepo dependency graph (`turbo.json`: `build`/`typecheck`/`test`
  depend on `^build`, i.e. each service builds its own deps first).
- **`services/integration-layer` (the SIL) is the crown jewel** (ADR 0001): it
  owns `IBackendAdapter { command(), subscribe(), discover(), capabilities() }`
  and is the *only* code that may reference Home Assistant concepts (entity IDs,
  domains, services). Three adapters exist: `HaAdapter` (real HA), `MockAdapter`
  (in-memory, used by most e2e tests and `SUPREME_BACKEND=mock`), and
  `SupremeNativeAdapter` (fronts real native protocol drivers, used by the Phase
  4 migration).
- **Cloud services** (`cloud/*`) are separate deployables from the hub services
  — this is deliberate: the cloud plane must be independently removable without
  touching the hub's `services/*` code, matching the "no cloud on the critical
  path" constraint.
- **Persistence seam** (ADR 0003): `services/persistence` wraps Postgres
  repositories behind interfaces so services don't hand-roll SQL; PGlite
  (embedded Postgres) runs the same repositories in tests without a real DB
  server — this is why e2e tests can assert "survives a restart" cheaply.

## Frontend architecture

- **Two personas, one design system.** `packages/aureon-flutter` (Dart) and
  `packages/aureon-web` (TS/CSS) are both generated/derived from the single
  source of truth `packages/aureon-web/tokens/aureon.tokens.json` (color,
  typography, spacing, radius, elevation, motion) — see UI_GUIDELINES.md. This
  exists so mobile and web never visually drift.
- **`apps/mobile` (Flutter)** — homeowner experience: Riverpod for state,
  optimistic UI updates reconciled against WSS state deltas from the gateway.
- **`apps/web-homeowner` (React)** — mirrors the mobile homeowner IA using the
  generated `supreme-sdk-ts` client and the same WSS reconciliation pattern.
- **`apps/web-installer` (React)** — the denser, technical Installer Portal:
  Driver Store, discovery, commissioning wizards, diagnostics, backup/restore,
  project export, licensing, native-migration controls, fleet.
- **Clients never hand-roll HA calls or hit HA endpoints.** They only ever speak
  the contract in `packages/supreme-contracts`, consumed via the generated SDKs
  (`supreme-sdk-ts` / `supreme-sdk-dart`). This is the client-side half of the
  SIL guarantee — even if a client bug tried to reach HA directly, there's no HA
  URL or entity ID anywhere in client code to reach it with.

## Driver / integration architecture

- **Driver = manifest + adapter code + compat matrix + signature** (ADR 0004,
  0014). `drivers/sdk` is the authoring SDK; first-party drivers live behind
  `services/protocols` / `services/drivers` implementing `INativeProtocolDriver`.
- **Trust channels**: official / certified / community / beta, with a
  certification pipeline (lint manifest → sandbox test → security scan → sign).
  Hub verifies signature + license before install. **Why:** a luxury platform
  cannot risk a community driver bricking a $50k lighting install — signing and
  channel gating make risk visible and controllable per install.
- **Bind, don't hardwire**: `POST /v1/commissioning/bind` places a commissioned
  device onto a real bus; `ProtocolBinding`s persist and re-bind on hub boot.
  Discovery (MQTT bridge/devices, SSDP/UPnP M-SEARCH, mDNS/DNS-SD) auto-surfaces
  devices so installers get "discover → commission → auto-bind," not manual
  address entry, wherever the protocol supports it.
- **Phase-1 reality vs. Phase-4 target**: today most drivers wrap an HA
  integration underneath while exposing a Supreme capability manifest; the
  `SupremeNativeAdapter` fronts a growing set of **real** bus stacks directly
  (KNXnet/IP, MQTT, Modbus TCP, Matter, native Zigbee via zigbee-herdsman, DALI,
  AVR Telnet, CoolMasterNet, WiiM, Devialet, Sonos, Ajax, SIP, Shelly, AirPlay,
  Apple TV via pyatv bridge, Lutron LIP, Tuya) — each driver declares the same
  SIL contract so a native rewrite is a drop-in replacement, never a rewrite of
  callers.

## Data / event flow

### Device command
```
App → WSS: {capability=brightness, target=room/livingroom/lights, value=60}
  → API Gateway (authz: room+device permission, time window)
  → Device Service (Supreme deviceId → SIL capability call)
  → SIL adapter (HaAdapter maps to HA service call, or SupremeNativeAdapter → driver)
  → physical device
  ← state_changed event → SIL normalizes → Event Bus
  ← Gateway pushes Supreme state delta over WSS → App updates optimistic UI
```

### State/telemetry stream
```
Backend state change → SIL normalizer (entity→capability, units, presence)
  → Event Bus (in-process, or NATS subject home.<id>.room.<id>.device.<id>.state
    when SUPREME_NATS_URL is set)
  → Gateway fan-out → subscribed clients (room-scoped, permission-filtered)
  → Analytics sink (energy, usage)
```

### Remote access (optional)
```
Default (cloud off): LAN clients discover the hub (mDNS) → direct hub WSS.
If owner enables remote access:
  Hub dials OUT → persistent mTLS tunnel to the Cloud Relay (no inbound firewall rule)
  Off-LAN app → Cloud Relay → routed to this home's tunnel → hub API Gateway
  (identity is still validated locally on the hub; the relay only transports)
```

**Why outbound-only:** a luxury residential product cannot ask homeowners to
manage port-forwarding or expose their home network to inbound internet traffic.
Dialing out avoids any inbound attack surface entirely (ADR 0009 — zero-trust
tunnel broker).

## Service communication

- **REST** for CRUD (`/v1/*`), **WSS** for realtime command/state, **mTLS
  tunnel** for cloud↔hub remote access transport.
- **Contract-first**: `packages/supreme-contracts` is the single source of truth
  (OpenAPI 3.1 + AsyncAPI + zod/protobuf-style shared types); `supreme-sdk-ts`
  and `supreme-sdk-dart` are generated, never hand-written, from it. **Why:**
  this is what makes the client/backend boundary a real regression gate for the
  HA→native migration — a contract test failure means a client would have broken.
- **Event bus**: in-process by default (single gateway process, fine for a
  single-hub deployment); `SUPREME_NATS_URL` / `SUPREME_REDIS_URL` upgrade to
  real NATS JetStream + Redis so device-state and notification fan-out spans
  multiple gateway processes. This is an explicit "start simple, scale when
  needed" seam (`@supreme/messaging`), not built speculatively — it's wired but
  optional.

## Auth / authorization

- **AuthN**: Supreme-branded login (never HA's), Argon2id password hashing,
  TOTP MFA (RFC 6238, no external dependency, `node:crypto` + `timingSafeEqual`),
  short-lived access JWT + rotating refresh tokens (session-bound; reuse of a
  revoked refresh token revokes the whole session), device-bound sessions,
  passkeys/WebAuthn.
- **AuthZ**: central policy engine — RBAC baseline (7 seeded user types: master/
  family/child/guest/staff/installer/admin) with an ABAC overlay (`resource +
  action + time window + schedule`) for fine-grained, temporary, or expiring
  grants (e.g. a guest's door-unlock access that expires). Enforced at the
  gateway and (partially, see TODO.md) re-checked at services for defense in
  depth.
- **Identity ownership**: HA users are **not** the user model — one hidden HA
  service account backs everything; all Supreme users map through the
  permission layer (ADR 0001, ADR 0007 — cloud as sole identity provider for
  multi-home/hub-registry scenarios, ADR 0008 — hub identity + zero-touch
  provisioning).
- **Audit**: append-only, tamper-evident (hash-chained) `audit_log` for
  security-relevant actions, separate `activity_log` for general usage.

## State management

- **Backend**: Postgres is the system of record for identity/home/scenes/
  grants/drivers/automations/audit/sessions/security/bindings/push tokens/
  migration policy — durability survives hub restarts by design (this is a
  named success criterion in `docs/production-readiness.md` §4, verified by a
  gateway-restart e2e test).
- **Frontend**: Riverpod (Flutter) / equivalent React state over the generated
  SDKs, with **optimistic updates reconciled by WSS state deltas** — the UI
  assumes a command succeeded and corrects only if the server disagrees, which
  is what makes tile-drag interactions feel instant despite a network round trip.

## API structure

- **`/v1` namespace**, capability-negotiation header, additive-only evolution —
  the contract clients depend on must never break (this is literally what
  "protects the migration" means in the blueprint).
- Representative surface: `POST /v1/devices/{id}/command`, `/v1/scenes`,
  `/v1/automations`, `/v1/users`, `/v1/users/{id}/grants`, `/v1/drivers`,
  `/v1/ai/assistant`, `WSS /v1/stream`. See blueprint §6 for the full
  representative list.

## Driver lifecycle

1. Installer browses the (signed, license-gated) catalog in the Driver Store.
2. Hub Driver Manager verifies the bundle signature and license before install.
3. Driver provisions its adapter (container/module) + underlying HA integration
   config, or wires directly to `SupremeNativeAdapter` if native.
4. Capabilities register in the SIL Entity Registry Mirror.
5. Device becomes discoverable/commissionable in the Supreme Device Manager;
   `POST /v1/commissioning/bind` places it on the real bus; the binding
   persists and re-binds on every hub boot.
6. Lifecycle states: published → deprecated → yanked, with version/rollback
   support (`driver_versions.status`).

## Entity / device model

Supreme owns its own topology, decoupled from HA entity IDs (ADR 0001, ADR
0003):
```
rooms(id, home_id, name, floor, area_type, sort_order, icon, parent_room_id)
devices(id, home_id, room_id, supreme_type, manufacturer, model, driver_id, status)
device_capabilities(id, device_id, capability, config_json)
ha_entity_map(supreme_device_id, capability, ha_entity_id, ha_domain, ha_attr)
  -- lives ONLY inside the SIL; the single bridge to HA IDs; swappable
```
A **Building › Floor › Area** location hierarchy sits above rooms (see git log:
"Add Building › Floor › Area location hierarchy to rooms"). Capabilities are a
closed, stable vocabulary (`onoff`, `brightness`, `color`, `temperature`,
`position`, `media`, `lock`, `sensor`, …) — adding a new backend or native
engine means mapping onto this set, not extending client-facing types ad hoc.

## Automation engine

- **Visual builder** (Flutter Automation Builder, per git log "Phase 4
  follow-up (3/4)") edits a **Supreme automation DSL** (JSON), never HA YAML.
- **Compiler/executor split** (ADR 0005, 0006): `engine=ha` compiles the DSL to
  an HA automation via the SIL and stores `external_ref`; `engine=supreme`
  executes natively in the Supreme automation engine. Same DSL, swappable
  executor — this is the automation-domain instance of the general
  strangler-fig pattern.
- **AI-assisted generation**: a deterministic NL→DSL planner is the always-on
  correctness floor; an optional real on-box LLM (llama.cpp, `SUPREME_AI_WITH_LLM`)
  upgrades quality when a GGUF model is provisioned, so the assistant works
  offline either way (ADR 0006, ADR 0013 — Supreme Intelligence Engine).
- Domain-specific automation runners exist as discrete, testable units:
  circadian lighting, solar schedule (NOAA sunrise/sunset), scene scheduling,
  vacation/occupancy simulation, climate programs, load-shift, consumption
  estimation — each has its own runner + unit test (`services/automations`,
  `services/gateway/src` runner files).

## Protocol abstraction / plugin architecture

- **`IBackendAdapter`** is the top-level plugin seam (HA vs. native vs. mock).
- **`INativeProtocolDriver`** is the per-protocol plugin seam beneath
  `SupremeNativeAdapter` — every real bus (KNX, Modbus, MQTT, Matter, Zigbee,
  DALI, AVR, …) implements this interface, so adding protocol #18 means writing
  one driver, not touching the gateway, SIL, or clients.
- **`drivers/sdk`** externalizes this further for third-party/community driver
  authors: manifest schema + signing tooling, so drivers can be built and
  distributed without forking this repo.

## Architectural decisions

Full text in `docs/architecture/adr/000N-*.md`. Index and one-line rationale:

| ADR | Decision | Why (as stated in the ADR) |
|---|---|---|
| 0001 | SIL is the only seam to the backend | HA knowledge leaking above one layer would make the native migration impossible |
| 0002 | Polyglot monorepo tooling | Node for realtime/gateway/SIL; Python for AI + HA-adjacent commissioning tooling |
| 0003 | Persistence SQL/DB seam | Repositories behind interfaces; PGlite lets e2e tests prove restart-durability without a real DB server |
| 0004 | Driver Store trust and licensing | Signing + channel gating make community-driver risk controllable |
| 0005 | Native automation and AI | Same DSL, swappable HA vs. native executor |
| 0006 | Native migration and local LLM | Strangler-fig per domain; on-box LLM keeps AI assistant offline-capable |
| 0007 | Cloud as sole identity provider | Needed for multi-home/hub-registry/zero-touch provisioning scenarios |
| 0008 | Hub identity + zero-touch provisioning | Installers shouldn't hand-configure hub identity per site |
| 0009 | Zero-trust tunnel broker | Outbound-only hub-to-cloud dialing removes inbound attack surface entirely |
| 0010 | Voice cloud-to-cloud certification | Alexa/Google require cloud-hosted fulfillment endpoints by their own certification rules |
| 0011 | Matter commissioning and fabric seams | Matter is optional/opt-in per blueprint; needs its own commissioning + fabric-sync seam |
| 0012 | HomeKit local HAP bridge | Siri/HomeKit is local-only by Apple's design; needs its own bridge, not cloud |
| 0013 | Supreme Intelligence Engine | Formalizes the AI planner + optional LLM architecture |
| 0014 | Licensing and driver framework | Ties licensing validation into the driver install/lifecycle path |

## Cross-references

- Founding blueprint: `docs/architecture/supreme-os-blueprint.md`
- Production readiness / what's real vs. simulated: `docs/production-readiness.md`
- Security posture: `docs/security-review.md`
- History: `DEVELOPMENT_LOG.md` · Current snapshot: `SESSION_HANDOFF.md`
- Conventions: `CODING_STANDARDS.md` · Design system: `UI_GUIDELINES.md`
- Forward plan: `ROADMAP.md` · Backlog: `TODO.md`

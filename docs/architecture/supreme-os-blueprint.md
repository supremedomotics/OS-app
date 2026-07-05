# Supreme OS — Founding Technical Blueprint

> Prepared by the founding CTO / Principal Architect, Supreme Domotics.
> Status: **Blueprint for approval. No application code to be generated until approved.**

---

## Context

Supreme Domotics is building **Supreme OS**, a luxury smart-home platform meant to
compete head-to-head with Control4, Savant, Crestron and RTI. The repository
(`supremedomotics/os-app`) is currently empty (only `README.md` + `LICENSE`).

The strategic constraint that shapes every decision below: **Home Assistant (HA)
is the hidden automation backend for Phase 1, but must be fully abstracted** so it
can be progressively replaced by Supreme-native services without the homeowner,
installer, or frontend ever noticing. End users must never see HA branding or
login pages; installers see only Supreme OS branding.

This document is the deliverable requested: a complete technical blueprint
(architecture, repo structure, schemas, APIs, UI architecture, roadmap, risks).
It is **not** an implementation. Implementation begins only after approval.

### Confirmed decisions (from stakeholder)
| Area | Decision |
|------|----------|
| Mobile app | **Flutter** (single codebase, luxury 120fps custom UI) |
| Backend runtime | **Polyglot: Node.js/TypeScript + Python** (split by responsibility, below) |
| Hub topology | **Sidecar Docker containers** beside a headless, hidden HA Core |
| Runtime locality | **100% local server.** The hub runs everything (control, automation, data, identity, AI). **No mandatory cloud.** Supreme Cloud is **fully optional** (opt-in remote access / management only). |
| Matter | **Optional, user-activatable.** Off by default; homeowner/installer can enable the local Matter controller from the integration/driver store. |
| UX references | Stakeholder will share screenshots directly in chat; UI sections refined on receipt |

---

## 1. Executive Summary

Supreme OS is a **local-first, abstraction-first platform**. The **home hub is the
complete system**: control, automation, data, identity, permissions, scenes,
drivers, and on-box AI all run locally and **work with zero internet**. Supreme
Cloud is an **optional, opt-in companion** for remote access and fleet management —
never a runtime dependency.

1. **Edge (the home hub) — the whole product.** A Supreme appliance running Docker
   Compose. Supreme services run as sidecar containers next to a headless Home
   Assistant Core. The **Supreme Integration Layer (SIL)** is the *only* thing that
   ever talks to HA. Everything above SIL speaks "Supreme", never "HA". Identity,
   licensing validation, automations, and AI assistant all function offline.
2. **Cloud (Supreme Cloud) — OPTIONAL.** Opt-in remote access (encrypted relay),
   plus optional multi-home/installer fleet management, off-site backup, and
   heavier AI. Disabling it leaves full in-home functionality intact.
3. **Clients** — Flutter mobile + tablet, a web platform (homeowner + installer
   portal), built against a single, stable **Supreme API** served by the hub
   (and reachable via the optional relay when away).

**Matter is optional and user-activatable** — the local Matter controller ships
disabled and is enabled on demand from the integration/driver store; it never
requires cloud and runs entirely on the hub.

The **core architectural bet** is the SIL: a stable, versioned internal contract
(Supreme domain model: Homes, Rooms, Devices, Capabilities, Scenes, Automations,
Users) that maps onto HA today and onto Supreme-native engines tomorrow. Clients
bind to Supreme contracts, never to HA entity IDs, so the backend can be swapped
adapter-by-adapter (the "strangler fig" migration).

The **design language, "Aureon"**, is dark, architectural, gold-accented, mobile-
first, room-first — implemented as a Flutter design-system package plus a web
token mirror so both clients share one source of visual truth.

**Polyglot split:** Node.js/TypeScript owns the real-time, API-gateway, identity,
and integration-layer surface (shares types with web; superb WebSocket story for
the HA bridge). Python/FastAPI owns AI services, driver commissioning logic that
benefits from HA's Python ecosystem, and protocol tooling (KNX/DALI/Modbus).

---

## 2. System Architecture (ASCII)

### 2.1 Macro view

```
                        ┌───────────────────────────────────────────┐
                        │                CLIENTS                      │
                        │  Flutter Mobile/Tablet  │  Web (Homeowner)  │
                        │  Aureon Design System   │  Installer Portal │
                        └───────────────┬─────────────────────────────┘
                                        │  HTTPS / WSS (Supreme API only)
                                        │
              ┌─────────────────────────┴──────────────────────────┐
              │            SUPREME CLOUD  (OPTIONAL / OPT-IN)        │
              │  Remote-access Relay · Off-site Backup · Driver      │
              │  Store mirror · Installer Fleet / Multi-Home Mgmt    │
              │  Optional heavy AI · (NOT required for any in-home   │
              │  control — hub is fully self-sufficient offline)     │
              └─────────────────────────┬──────────────────────────┘
                                        │  mutual-TLS, outbound tunnel — ONLY if
                                        │  remote access is enabled by the owner
                                        │  (hub dials cloud; no inbound ports)
            ── LAN clients always talk directly to the hub; cloud never needed ──
        ┌───────────────────────────────┴───────────────────────────────┐
        │                  THE HOME HUB  (Docker Compose)                 │
        │                                                                 │
        │   ┌──────────────────────── SUPREME PLANE ─────────────────┐    │
        │   │  API Gateway / BFF (Node)                              │    │
        │   │  User & Permission Service (Node)                     │    │
        │   │  Room/Device/Scene/Automation Services (Node)         │    │
        │   │  AI Assistant Worker (Python)                         │    │
        │   │  Local Notification + Event Bus (NATS/Redis)          │    │
        │   │  ┌────────────── SUPREME INTEGRATION LAYER ─────────┐ │    │
        │   │  │  Capability Mapper · Entity Registry Mirror     │ │    │
        │   │  │  HA Adapter (Node)  +  Driver Adapters (Py/Node)│ │    │
        │   │  └───────────────┬─────────────────────────────────┘ │    │
        │   └──────────────────┼──────────────────────────────────┘     │
        │                      │  HA WebSocket + REST (loopback only)     │
        │   ┌──────────────────┴──────────────────────────────────┐      │
        │   │   HOME ASSISTANT CORE (headless, hidden, no UI)      │      │
        │   │   Long-lived token · supervisor disabled/locked     │      │
        │   └──────────────────┬──────────────────────────────────┘      │
        │                      │                                          │
        │   Protocol stacks: KNX · DALI · Casambi · Matter · Zigbee ·     │
        │                     MQTT broker · Modbus                        │
        └─────────────────────────────────────────────────────────────────┘
                                        │
                          Field buses / RF / IP devices
```

### 2.2 The abstraction principle (why HA never leaks up)

```
Client ──"Supreme contract"──► API Gateway ──► Domain Services ──► SIL
                                                                    │
                              ┌─────── adapters (swappable) ────────┤
                              │                                     │
                       HA Adapter (today)              Supreme-native engine (future)
                              │                                     │
                       Home Assistant                    Supreme Automation/Device engine
```
Clients and domain services know only Supreme IDs and capabilities. The SIL holds
the *only* HA knowledge. Replacing HA = writing a new adapter behind the same SIL
contract; nothing above changes. This is the migration guarantee.

---

## 3. Data Flow Diagrams

### 3.1 Device command (homeowner taps "Living Room → Lights 60%")
```
App → (WSS, Supreme cmd: capability=brightness, target=room/livingroom/lights, value=60)
   → API Gateway (authz: room+device permission, time window)
   → Device Service (resolves Supreme deviceId → SIL capability call)
   → SIL HA Adapter (maps to HA service light.turn_on {entity_id, brightness_pct})
   → HA Core → physical device
   ← HA state_changed event → SIL normalizes → Event Bus
   ← Gateway pushes Supreme state delta over WSS → App updates optimistic UI
```

### 3.2 State/telemetry stream
```
HA state_changed (WS) → SIL normalizer (entity→capability, units, presence)
   → Event Bus (NATS subject: home.<id>.room.<id>.device.<id>.state)
   → Gateway fan-out → subscribed clients (room-scoped, permission-filtered)
   → Analytics sink (energy, usage) → local TSDB → batched to Cloud
```

### 3.3 Remote access (off-LAN control) — OPTIONAL, opt-in
```
DEFAULT (cloud off): LAN clients discover hub via mDNS → direct hub WSS. No cloud.
IF owner enables remote access:
  Hub dials out → persistent mTLS tunnel to Cloud Relay (no inbound firewall)
  App (off-LAN) → verify Supreme session → Cloud Relay
     → routes to correct home's tunnel → Hub API Gateway → same path as local
  (Identity still validated locally on the hub; relay only transports.)
```

### 3.4 Driver install (installer adds "Supreme KNX")
```
Installer Portal → Cloud Driver Store (browse, check license/compat)
   → download signed driver bundle → Hub Driver Manager verifies signature
   → provisions adapter container/module + HA integration config underneath
   → registers capabilities in SIL Entity Registry Mirror
   → device discovery available in Supreme Device Manager
```

---

## 4. Repository Structure (monorepo)

A single monorepo (`os-app`) with workspace tooling: **pnpm + Turborepo** for
JS/TS, **uv/Poetry** for Python packages, **Melos** for the Flutter workspace.

```
os-app/
├── apps/
│   ├── mobile/                # Flutter homeowner app (iOS/Android/tablet)
│   ├── installer/             # Flutter or web installer app (decide P1)
│   ├── web-homeowner/         # Web platform (React/Next + TS, Aureon web tokens)
│   └── web-installer/         # Installer Portal (React/Next)
├── services/
│   ├── gateway/               # Node: API Gateway / BFF, WSS hub
│   ├── identity/              # Node: Supreme User & session/token service
│   ├── permissions/           # Node: RBAC/ABAC policy engine
│   ├── rooms/                 # Node: Room & home topology service
│   ├── devices/               # Node: Device manager (Supreme device model)
│   ├── scenes/                # Node: Scene service
│   ├── automations/           # Node: Automation orchestration service
│   ├── integration-layer/     # Node: SIL core + HA adapter (the crown jewel)
│   ├── ai-assistant/          # Python/FastAPI: NLU, AI scene/automation gen
│   └── commissioning/         # Python: KNX/DALI/Casambi/Matter/Modbus tooling
├── cloud/
│   ├── edge-gateway/          # Node: tunnel relay, remote-access router
│   ├── licensing/             # Node: license issuance/validation
│   ├── driver-store/          # Node: marketplace API + signing pipeline
│   ├── fleet/                 # Node: multi-home + installer fleet mgmt
│   ├── backups/               # Node/Py: backup orchestration + storage
│   └── analytics/             # Py: ingestion + reporting
├── packages/
│   ├── aureon-flutter/        # Flutter design system (tokens, widgets, motion)
│   ├── aureon-web/            # CSS/TS design tokens mirror for web
│   ├── supreme-contracts/     # Shared API contracts (OpenAPI + protobuf/zod)
│   ├── supreme-sdk-dart/      # Generated Dart client from contracts
│   ├── supreme-sdk-ts/        # Generated TS client from contracts
│   └── domain-model/          # Canonical Supreme domain types (codegen source)
├── drivers/                   # Driver SDK + first-party driver source
│   ├── sdk/                   # Driver authoring SDK + manifest schema
│   ├── supreme-knx/
│   ├── supreme-casambi/
│   ├── supreme-dali/
│   ├── supreme-matter/
│   ├── supreme-zigbee/
│   ├── supreme-mqtt/
│   └── supreme-modbus/
├── infra/
│   ├── hub-compose/           # Docker Compose for the home hub (incl. hidden HA)
│   ├── cloud-iac/             # Terraform/Pulumi for Supreme Cloud
│   └── ci/                    # pipelines, signing, release
├── docs/
│   ├── architecture/          # this blueprint, ADRs, diagrams
│   ├── reference/             # UX benchmark screenshots (stakeholder-provided)
│   └── design/                # Aureon spec, IA, user journeys
└── tools/                     # codegen, scripts, contract linting
```

---

## 5. Database Architecture & Schema Recommendations

**Polyglot persistence, all data is *Supreme-owned* (HA's recorder DB is treated
as ephemeral/internal):**

| Store | Tech | Owns |
|-------|------|------|
| Relational (hub + cloud) | **PostgreSQL** | users, permissions, rooms, devices, scenes, automations metadata, drivers, licensing, audit |
| Time-series | **TimescaleDB / InfluxDB** | energy, telemetry, sensor history |
| Cache / ephemeral | **Redis** | sessions, presence, optimistic state, rate limits |
| Event bus | **NATS JetStream** | normalized device events, command stream |
| Object storage | **S3-compatible** | backups, driver bundles, media thumbnails |
| Search (cloud) | optional OpenSearch | audit/log search, driver store search |

### Schema highlights (Supreme is the system of record, not HA)

**Identity / Users**
```
homes(id, name, address, tier, created_at, master_user_id)
users(id, home_id, email, phone, display_name, status[active|suspended],
      user_type[master|family|child|guest|staff|installer|admin],
      created_at, expires_at NULL)
auth_credentials(user_id, password_hash(argon2id), mfa_secret, recovery_codes)
sessions(id, user_id, device_id, issued_at, expires_at, refresh_token_hash, revoked)
devices_clients(id, user_id, platform, push_token, last_seen)
```

**Permissions (RBAC + ABAC overlay)**
```
roles(id, key, description)                         -- baseline per user_type
permissions(id, resource_type[room|device|scene|camera|integration|...],
            resource_id NULL, action, effect[allow|deny])
user_grants(id, user_id, permission_id, valid_from, valid_until NULL,
            schedule_json NULL)                     -- time-based / temporary
audit_log(id, home_id, actor_user_id, action, resource_type, resource_id,
          metadata_json, ip, created_at)            -- append-only
activity_log(id, user_id, event, context_json, created_at)
```

**Home topology & devices (the Supreme model, decoupled from HA entity IDs)**
```
rooms(id, home_id, name, floor, area_type, sort_order, icon, parent_room_id NULL)
devices(id, home_id, room_id, supreme_type, manufacturer, model,
        driver_id, status, metadata_json)
device_capabilities(id, device_id, capability[onoff|brightness|color|
        temperature|position|media|lock|...], config_json)
ha_entity_map(supreme_device_id, capability, ha_entity_id, ha_domain, ha_attr)
        -- lives ONLY inside SIL; the single bridge to HA; swappable
```

**Scenes & automations (metadata in Supreme; execution delegated for now)**
```
scenes(id, home_id, scope[room|home], owner_user_id NULL, schedule_json NULL,
       ai_generated bool, definition_json)
automations(id, home_id, enabled, trigger_json, condition_json, action_json,
       engine[ha|supreme], external_ref)            -- external_ref = HA automation id
```

**Drivers & licensing**
```
drivers(id, key, name, category, channel[official|certified|community|beta],
        publisher_id, latest_version, signing_key_id)
driver_versions(id, driver_id, version, bundle_url, signature, compat_json,
        changelog, status[published|deprecated|yanked])
installed_drivers(home_id, driver_id, version, installed_at, config_json)
licenses(id, home_id, sku, seats, features_json, issued_at, expires_at,
        signature)
```

---

## 6. API Architecture & Specifications

- **Contract-first.** `packages/supreme-contracts` is the source of truth
  (OpenAPI 3.1 for REST, AsyncAPI for events, zod/protobuf for shared types).
  Dart + TS SDKs are **generated** — clients never hand-roll HA calls.
- **Transport:** REST/JSON for CRUD; **WSS** for realtime state + commands;
  **mTLS tunnel** for cloud→hub remote access.
- **Versioning:** `/v1` namespace; capability negotiation header; never break the
  contract that clients depend on (this is what protects the HA→native migration).

### Representative surface (all "Supreme", zero HA leakage)
```
POST   /v1/auth/login            {email,password} → {access, refresh}
POST   /v1/auth/refresh          /v1/auth/mfa/verify   /v1/auth/recover
GET    /v1/homes/{id}/rooms
GET    /v1/rooms/{id}/devices
POST   /v1/devices/{id}/command  {capability, value}        ← core control verb
GET    /v1/scenes   POST /v1/scenes   POST /v1/scenes/{id}/activate
GET    /v1/automations  POST /v1/automations  PATCH .../enable
GET    /v1/users   POST /v1/users   POST /v1/users/{id}/suspend
POST   /v1/users/{id}/grants      {resource, action, valid_until, schedule}
GET    /v1/drivers  (store)   POST /v1/homes/{id}/drivers/install
POST   /v1/ai/assistant         {utterance|intent} → {actions|scene}
WSS    /v1/stream                ← subscribe: state deltas, notifications
```

---

## 7. Supreme Integration Layer (SIL) — the crown jewel

Responsibilities:
- **Capability model:** normalizes heterogeneous HA domains (`light`, `climate`,
  `cover`, `media_player`, `lock`…) into a stable Supreme capability set.
- **Entity Registry Mirror:** maintains `ha_entity_map`; the only component that
  knows HA entity IDs exist.
- **Adapter interface:** `IBackendAdapter { command(), subscribe(), discover(),
  capabilities() }`. Phase 1 = `HaAdapter`. Future = `SupremeNativeAdapter`.
- **Resilience:** survives HA restarts/upgrades — reconnects WS, re-syncs registry,
  buffers commands, version-detects HA API. Pinned HA version with tested upgrade
  gate so HA updates can't break the product.
- **Hidden:** HA runs headless, no Lovelace/onboarding exposed, admin port bound to
  loopback, long-lived token managed by SIL, supervisor UI disabled.

Migration path: introduce `SupremeNativeAdapter` per-domain (e.g., native Zigbee
first), route a capability to it behind a feature flag, validate, then retire that
HA dependency — repeat until HA is gone. No frontend change at any step.

---

## 8. User Management & Permission Architecture

```
Supreme User Service  →  Permission Layer (policy engine)  →  SIL  →  HA
```
- HA users are **not** the user model. The hub provisions **one** internal HA
  service account; all Supreme users map to it through the permission layer.
- First commissioning user = **Master User** (full grants listed in brief).
- **7 user types** seed baseline roles; fine-grained grants overlay via ABAC
  (`resource + action + time window + schedule`).
- **Time-based / temporary / expiring access:** `user_grants.valid_until` +
  `schedule_json`; a scheduler revokes/enables at boundaries; guest links expire.
- **Audit + activity logs:** append-only `audit_log` for security events,
  `activity_log` for usage; both queryable by Master/Admin, exportable.

---

## 9. Driver Store Architecture

- **Channels:** official / certified / community / beta, with a certification
  pipeline (lint manifest → sandbox test → security scan → sign).
- **Bundle = manifest + adapter code + compat matrix + signature.** Hub verifies
  signature and license before install; supports versioning, update, rollback,
  deprecation/yank, lifecycle states.
- **Phase-1 reality:** a driver wraps an HA integration underneath, but exposes a
  Supreme capability manifest. Its `supreme-knx` etc. adapter declares the SIL
  contract so a future native rewrite is a drop-in replacement.
- **First-party drivers:** KNX, Casambi, DALI, Zigbee, MQTT, Modbus, and **Matter**.
  **Matter ships disabled**; the local Matter controller is enabled on demand by the
  owner/installer (opt-in toggle in the integration/driver store) and runs entirely
  on the hub — no cloud required.

---

## 10. Automation & Scene Architecture

- **Visual builder** (triggers / conditions / actions / schedules / presence /
  geofencing) editing a **Supreme automation definition** (JSON DSL), not HA YAML.
- **Compiler:** `engine=ha` compiles the Supreme DSL → HA automation via SIL and
  stores `external_ref`; `engine=supreme` (future) executes in the Supreme engine.
  Same DSL, swappable executor.
- **AI-assisted generation:** Python AI service turns NL prompts + home context
  into Supreme DSL drafts the user confirms. **Runs on the hub** (local/on-box
  model) so the assistant works offline; cloud is an optional offload for heavier
  models only.
- **Scenes:** room / whole-home / scheduled / user-specific / AI-generated; stored
  as Supreme definitions, applied through capability commands (not HA scene coupling).

---

## 11. UI / Component Architecture — "Aureon"

### 11.1 UX benchmark analysis (from stakeholder reference screenshots)
The references are a light-themed HA companion app ("Ovio"). We adopt its **usability
patterns** and deliberately **invert its visual language** (it is cream/monochrome/
minimal; Aureon is dark/architectural/gold) so Supreme OS is clearly distinct.

Patterns worth adopting (usability only, original visuals):
- **Room-first horizontal pager** — swipe between rooms; current room name centered
  at bottom with the next room "peeking"; a list/search affordance opens a room
  switcher. (Refs: Welcome-home + Living/Bedroom/Kitchen/Garden/Office pager.)
- **Room switcher as full-bleed photo hero cards** in a vertical stack / pull-up
  sheet (dimmed backdrop). (Ref: room list overlay.)
- **Tile-as-control** — a category tile's background *fills proportionally* to its
  value (slider embedded in the tile): tap = toggle, drag = set. (Refs: "Lights
  7 on", "Fan 30%", "Awing 50%".) This is the core interaction grammar.
- **Aggregate → detail drill-down** — room shows category aggregates ("Lights 7 on",
  "Covers 1 open", "Players", "Switches") that open device lists.
- **Environment summary on the room hero** — air-quality / temperature / humidity
  overlaid on the room photo; a colored status card for at-a-glance health. (Refs:
  "Good · Air quality · 22.5° Inside · 45% Humidity".)
- **Slide-to-confirm for sensitive actions** — chevron "»»" slide to unlock doors /
  arm-disarm. (Refs: Front/Back Door, Alarm Away, dark security card.)
- **Quick-scene row** at top of dashboard ("Arrive", "Movie") + **edit mode** with
  an explicit "Save". (Refs: dashboard scenes + Save chip.)
- **Rich domain controls**: color wheel + warm→cool brightness gradient disc with
  draggable node and multi-light nodes on the color field; media card with art,
  source badge, scrubber, transport, volume slider, queue count; climate with
  dual setpoints + fan + humidifier states. (Refs: Office/Garden lights, Spotify
  media, Airco/Humidifier.)
- **Grouped settings list** with leading icons + chevron rows. (Ref: Configuration/
  General settings.)
- **Local vs Remote connection** concept at entry — we *absorb* this into automatic
  LAN-direct vs cloud-relay routing; the homeowner never configures a URL (the ref
  exposes HA endpoints; Supreme must hide that entirely — login is a Supreme account).

### 11.2 Aureon identity (our differentiation)
- **Design tokens** (single source → `aureon-flutter` + `aureon-web`): near-black
  architectural base layers, warm gold accent ramp, premium type scale, soft depth
  via blur/elevation, motion curves (slow-in/quiet-out) for a calm luxury feel,
  generous spacing grid. Photographic room heroes with dark-gradient scrims so gold
  text/controls read cleanly.

### 11.3 Navigation & screens
- **Room-first IA:** Welcome/Home overview → room pager → category → device/scene.
  Persistent quick-scene row, Favorites, global scene access; mobile-first, gesture-
  driven (swipe rooms, drag tiles, pull-up switcher).
- **Component layers:** primitives (Button, Tile, FillTile/slider-tile, Sheet,
  SlideToConfirm) → domain components (DeviceTile, LightWheel+BrightnessDisc,
  ClimateCard, MediaCard, CameraView, EnergyChart, SceneButton, SecurityCard) →
  screen compositions (Dashboard, RoomView, DeviceDetail, Scenes, Security, Energy,
  Settings) → Installer surfaces (Driver Store, Commissioning wizards, Diagnostics,
  Backup/Restore, Project Export).
- **State:** Riverpod (Flutter) over generated `supreme-sdk-dart`; optimistic updates
  reconciled by WSS state deltas. Web mirrors with the TS SDK.
- **Two personas:** Homeowner (calm, room-first) vs Installer (dense, technical,
  Supreme-branded) — shared design system, different IA.

> Reference screenshots will be committed to `docs/reference/` during implementation
> for traceability; only usability is reused — no assets, layouts, or branding copied.

---

## 12. Security Architecture

- **AuthN:** Supreme-branded login; Argon2id passwords; TOTP MFA; OAuth2/OIDC-style
  token model (short-lived access JWT + rotating refresh); device-bound sessions;
  no HA login pages ever exposed.
- **AuthZ:** central policy engine (RBAC baseline + ABAC overlay), enforced at the
  gateway and re-checked at services; permission checks on every command.
- **Encryption:** TLS everywhere; mTLS hub↔cloud; secrets in a vault/sealed store;
  at-rest encryption for DB + backups; signed driver bundles + license tokens.
- **Remote access:** outbound-only tunnel — **no inbound ports** on the home.
- **Audit:** append-only, tamper-evident logging; security event stream to cloud.
- **Hardening:** HA admin bound to loopback, least-privilege containers, network
  segmentation between Supreme plane / HA / device buses.

---

## 13. Cloud Architecture — OPTIONAL companion

**The hub is 100% local and self-sufficient.** Identity, permissions, automations,
scenes, drivers, licensing validation, and the AI assistant all run on the hub and
work with no internet. Supreme Cloud is **opt-in** and additive only:

- **Remote-access relay** (encrypted, outbound-only tunnel) — enabled by the owner;
  off = no remote, full local control unaffected.
- **Off-site backup**, **driver-store mirror/CDN**, **push notifications**,
  **installer fleet / multi-home management**, and **optional heavy AI** offload.
- Multi-tenant by `home_id`; per-installer org scoping. **No cloud service is on the
  critical path for in-home use.** Push/notifications degrade gracefully to local
  (on-LAN) delivery when cloud is disabled.

Licensing is designed to **validate offline** (signed license tokens stored on the
hub, periodic optional re-validation), so a fully air-gapped install stays licensed.

---

## 14. Deployment Architecture

- **Hub:** `infra/hub-compose` Docker Compose — Supreme services + headless HA Core
  + Postgres + Redis + NATS + MQTT broker; signed images; OTA update channel with
  staged rollout and rollback; pinned/tested HA version.
- **Cloud:** IaC (Terraform/Pulumi), managed Postgres + object storage, blue/green
  deploys, environment tiers (dev/staging/prod).
- **Clients:** Flutter via app stores + internal track for installers; web via CDN.
- **Release:** monorepo CI (Turborepo affected-graph) → build/test/sign →
  channel-based driver + hub releases.

---

## 15. Testing Strategy

- **Contract tests** against `supreme-contracts` (consumer-driven) — guarantees the
  client/backend boundary that protects the HA→native migration.
- **SIL adapter tests** against a mocked HA + a real HA in CI (integration), incl.
  HA-upgrade regression suite.
- Unit (services, design system), widget/golden tests (Aureon Flutter), E2E
  (mobile via Patrol/integration_test; web via Playwright), load tests on gateway/
  event bus, security tests (authz matrix, pen-test checklist), commissioning
  simulators for KNX/DALI/Modbus.

---

## 16. Development Roadmap (phases)

- **Phase 0 — Foundations (build first):** monorepo + tooling, `domain-model` +
  `supreme-contracts`, Aureon token packages, hub Compose with hidden HA, SIL skeleton
  with `HaAdapter`, Identity + Permissions, gateway + WSS. *Exit: tap a light in
  Flutter through the full Supreme stack.*
- **Phase 1 — Homeowner MVP:** Dashboard, Rooms, Device Control (lighting/climate/
  media/covers), Scenes, Favorites, Notifications, user management + master flow,
  local + remote access.
- **Phase 2 — Installer & Drivers:** Installer Portal, Driver Store, device
  discovery, KNX/DALI/Casambi/Matter/MQTT/Modbus commissioning, diagnostics,
  backup/restore, project export, licensing.
- **Phase 3 — Intelligence & Scale:** visual Automation Builder, AI assistant +
  AI scenes/automations, energy/analytics, cameras/security depth, multi-home +
  installer fleet, advanced audit.
- **Phase 4 — Native migration:** introduce `SupremeNativeAdapter` per domain
  behind flags; retire HA dependencies incrementally; zero frontend change.

---

## 17. Risk Assessment & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| HA upgrades break SIL | High | Pin HA, adapter version-detection, HA-upgrade regression CI, command buffering |
| HA branding/UI leaks to users | High (brand) | Headless HA, loopback admin, no Lovelace, SIL-only token, audit for leaks |
| Tight coupling creeps in | High (kills migration) | Contract-first SDKs, lint forbidding HA refs above SIL, ADR governance |
| Remote-access security | Critical | Outbound-only mTLS tunnel, no inbound ports, short-lived tokens, audit |
| Scope (14 components) overwhelms | High | Strict phasing; Phase 0/1 ruthlessly minimal; defer cloud-heavy features |
| Polyglot complexity (Node+Py) | Med | Clear ownership split, shared contracts, unified CI, container boundaries |
| Driver security (community) | High | Signing, sandboxing, certification pipeline, license gating |
| Real-time scale / event storms | Med | NATS JetStream, room-scoped fan-out, backpressure, load tests |
| Legal/IP from UX references | Med | References as usability benchmarks only; original Aureon assets |

---

## 18. Technology Recommendations (summary)

Flutter + Riverpod (mobile) · Next.js/React + TS (web) · Node.js/TypeScript
(gateway, identity, permissions, domain services, SIL, cloud control plane) ·
Python/FastAPI (AI, commissioning, protocol tooling) · PostgreSQL · TimescaleDB ·
Redis · NATS JetStream · MQTT (Mosquitto/EMQX) · S3-compatible object store ·
Docker Compose (hub) + Terraform/Pulumi + k8s (cloud) · OpenAPI/AsyncAPI contract-
first codegen · Turborepo + pnpm + Melos + uv.

---

## 19. Verification (how we'll prove the blueprint when implementation starts)

This blueprint produces **no runnable code**. Verification of the *blueprint* =
stakeholder approval of these sections. When Phase 0 implementation is later
approved, the first end-to-end proof will be: launch `infra/hub-compose`, register
the Master User via Supreme auth, and toggle a real/simulated light from the
Flutter app — confirming the full path Client → Gateway → Device Service → SIL →
HA → device and back over WSS, with **no HA branding anywhere** in the client.

---

## Open items pending stakeholder input
1. ~~UX reference screenshots~~ — **received & analyzed** (§11.1). Will be committed
   to `docs/reference/` during implementation for traceability.
2. **Installer app form factor** — Flutter app vs. web-only Installer Portal (§4).
3. **Optional-cloud scope** — since the server is 100% local, which cloud features
   (if any) to build first when/if cloud is enabled: remote-access relay,
   off-site backup, or fleet management. (All optional; can defer entirely.)
4. **Local AI model** — preferred on-box assistant model/size given hub hardware
   target (affects §10 AI and hub resource sizing).

# SupremeOS — Project Context

> Long-term understanding of the project. This document changes only when SupremeOS's overall
> direction or architecture evolves — not on every feature. If you're about to edit this file
> for a routine feature addition, you probably want `SESSION_HANDOFF.md` or `TODO.md` instead.

## 1. Project overview

**SupremeOS** is a luxury smart-home platform built by Supreme Domotics, designed to compete
head-to-head with **Control4, Savant, Crestron, and RTI** — not with Home Assistant, not with
mass-market DIY smart-home apps. Everything about the product — architecture, visual design,
commercial model — is built for premium residential integrators and the homes they serve.

Two governing ideas show up everywhere in the codebase and docs:

- **Local-first:** the home hub is a complete, self-sufficient system that works with zero
  internet. Supreme Cloud is optional/opt-in — it adds identity, remote reachability, and
  ecosystem integrations (voice, Matter multi-admin, fleet management) on top of a system that
  is fully functional with the internet cut.
- **Abstraction-first:** no client (web, mobile, or otherwise) ever talks to a protocol or to
  Home Assistant directly. Everything goes through the **Supreme Integration Layer (SIL)** —
  see §5.

## 2. Commercial model

- **Target market:** premium/luxury residential AV & home-automation integrators (dealers) and
  their homeowner clients — not a consumer DIY product.
- **Two personas, one design system:** Homeowner apps are calm and room-first; the Installer
  Portal is dense and technical. Both are Aureon-branded, never exposing the underlying stack.
- **Licensing:** signed, Ed25519-based tokens that verify **offline** — an air-gapped
  installation stays licensed with no ongoing internet requirement. Tiers: `essential ⊂ pro ⊂
  estate`. A pluggable provider model (Developer / Offline / Cloud / OEM / Testing) merges into
  one `EffectiveLicense` — cloud subscription is just one more provider, not a hard dependency.
- **Dealer/fleet model:** `cloud/dealer` and `cloud/fleet` let an installer organization manage
  technicians, customer sites, and hub assignment, including transferring ownership of a
  pre-provisioned hub to the end customer. **Known gap:** cloud subscription sync and the
  dealer portal are scaffolded by the provider model but not fully built (ADR 0014).
- **Roles:** Owner, Administrator, Installer, Homeowner, Family, Guest, Service Engineer.

## 3. Technology stack

| Layer | Stack |
|---|---|
| Web apps (`apps/web-homeowner`, `apps/web-installer`) | React + TypeScript + Vite |
| Mobile app (`apps/mobile`) | Flutter (Dart SDK ≥3.5.0, Flutter ≥3.24.0), managed by **Melos**, not pnpm |
| Design system | `packages/aureon-web` (React + CSS, canonical token source) / `packages/aureon-flutter` (Flutter mirror, tokens generated via `tools/codegen`) |
| API gateway (`services/gateway`) | Fastify `^5.2.1` + `@fastify/websocket` (REST + WSS) — the only client-facing surface |
| Other TS services | Node ≥22, TypeScript `^5.7.3`, most on Fastify |
| Python services (`services/ai-py`, `services/commissioning-py`, `services/appletv-py`) | Python ≥3.11, **FastAPI** + `pydantic` v2, `hatchling` build |
| Testing | `vitest ^2.1.8` (TS), `pytest` (Python), `flutter test` (Dart) |
| Monorepo tooling | pnpm workspaces (`pnpm@10.33.0`) + **Turborepo** (`^2.3.3`) for TS/Python packages; **Melos** for the Flutter workspace |
| Persistence | Postgres via a `SqlDb` seam (`services/persistence`, `cloud/persistence`), verified with embedded Postgres in tests |
| Messaging | NATS (event bus) + Redis (ephemeral/presence) — in-process fakes by default, real backends behind config |

## 4. Monorepo map

```
apps/            web-homeowner, web-installer (React/Vite) · mobile (Flutter)
packages/        aureon-web, aureon-flutter    — design system
                 domain-model                  — canonical types/schemas (capabilities, entities)
                 supreme-contracts              — REST/WSS contract schemas (source of truth for SDKs)
                 supreme-sdk-ts, supreme-sdk-dart — generated typed clients
                 crypto                         — Ed25519 signing primitives
                 hub-identity, hub-pki          — hub cryptographic identity, X.509 device certs
services/        gateway            — the one client-facing API (REST + WSS)
                 integration-layer  — SIL: the only thing that knows HA exists
                 protocols          — native drivers (KNX, Matter, Zigbee, DALI, MQTT, Modbus,
                                       AVR/HEOS/Yamaha, CoolMaster, Lutron, Tuya, Shelly, Sonos,
                                       WiiM, Devialet, AirPlay, Apple TV, SIP, Ajax, Casambi)
                 home, identity, permissions, persistence, messaging, notifications,
                 automations, keypad-framework, intent-engine, scenes, security, cameras, audit,
                 backup, drivers, license, analytics, intelligence, commissioning(+py), ai(+py),
                 appletv-py, homekit
cloud/           identity, authn, authz, hub-registry, tunnel-broker, fleet, dealer,
                 device-registry, licensing, subscription, notification, voice, matter, ota,
                 backups, telemetry, admin, audit, persistence, schema (SQL migrations)
drivers/sdk      driver authoring SDK — manifest schema, bundle signing/verification
tools/           codegen (Aureon Flutter tokens), loadtest (chaos/soak harness), ota (release signer)
infra/           cloud-compose, cloud-iac, hub-compose (Docker Compose stack), observability
docs/            architecture/ (blueprints + ADRs), drivers.md,
                 provisioning-and-identity.md, production-readiness.md, coolmaster/, reference/
```

## 5. Core architectural principles

- **Supreme Integration Layer (SIL)** (`services/integration-layer`, ADR 0001) — "the crown
  jewel." The *only* seam to any backend. Everything above SIL speaks in Supreme's own
  capability vocabulary; nothing above it ever knows Home Assistant exists.
- **Capability abstraction, never protocol** — devices expose a small, stable set of
  capabilities: `onoff, brightness, color, temperature, position, media, lock, fan, vacuum,
  sensor`. No brand's input list or DSP vocabulary is ever hardcoded into a client — see
  `packages/domain-model/src/capabilities.ts`. This exact rule governs all UI work too: **render
  from capabilities, never from protocol or brand.**
- **"UI is the contract" (Premium Device Experience Library — added this development cycle)** —
  premium device pages are allowed to show the FULL intended control set for a device category
  even where no driver backs a specific control yet. Real controls stay interactive; anything
  not backed by a genuine capability/config field renders as an honestly-labeled, visually
  distinct disabled state (never fabricated data, never silently hidden). See
  `apps/web-homeowner/src/features/_shared/capability-availability.ts` and aureon-web's
  `CapabilityGate`/`CapabilityGrid` components.
- **Strangler-fig migration** (ADR 0006) — Home Assistant runs hidden as the Phase-1 backend and
  is replaced adapter-by-adapter with native `SupremeNativeAdapter` drivers, domain by domain,
  with **zero frontend change** at any step. HA is an implementation detail on a path to
  eventual removal, never a "supported integration" from the product's perspective.
- **Local-first invariants** (cloud blueprint §1) — local automation never depends on the cloud;
  the cloud is a control plane, never a data plane for device state; HA is invisible and
  unauthenticated by users; the hub always dials out (no inbound ports, ever); zero trust
  throughout.
- **Contract-first clients** — `packages/supreme-contracts` is the source of truth for every
  REST/WSS shape; `supreme-sdk-ts`/`supreme-sdk-dart` are typed clients built on it. Clients
  never hand-roll backend calls.
- **Aureon design language** — dark, architectural, gold-accented, room-first, one token source
  shared by web and Flutter. See `CLAUDE.md` §UI & UX Standards for the full visual system.

## 6. Current capabilities (what's actually implemented)

**Real, tested native protocol drivers** (`services/protocols`, `docs/drivers.md` — 20 total):
KNX (real DPT codec), MQTT (incl. Zigbee2MQTT discovery), Modbus TCP, Matter (`@matter/main`
seam, opt-in), Zigbee (`zigbee-herdsman` seam), DALI/IEC 62386, AVR (Denon/Marantz Telnet),
HEOS, Yamaha MusicCast, CoolMasterNet HVAC, SIP door stations, WiiM/LinkPlay, Devialet, Sonos,
Ajax security sensors, AirPlay (sender), Apple TV (MRP via `appletv-py`/pyatv), Shelly Gen2,
Lutron LIP (wired RadioRA2/HomeWorks QS + wireless Caséta Pro), Tuya, Casambi.

**Ecosystem/voice integrations** — built behind real seams and unit-tested, but with a stated
hardware/credential boundary before they're field-deployable: Alexa Smart Home (cloud-to-cloud),
Google Smart Home, HomeKit/Siri (local HAP bridge), Matter commissioning (fabric manager +
cloud multi-admin sync implemented; the real CHIP/Thread controller bring-up is not runnable
yet).

**Explicitly planned, not implemented:** Onkyo/Pioneer, Sony, Arcam, Anthem, NAD, JBL Synthesis,
StormAudio, Trinnov AVR brands; HRoT/TPM-backed hub identity; local (non-cloud) Alexa/Google
fulfillment; Bluetooth pairing management for HEOS/Yamaha; any real keypad driver (see next
paragraph — the framework is real, no protocol implementation is).

**Universal Keypad Framework (ADR 0016, Phase 1 — architecture only):** a protocol-independent
input/feedback pipeline (`@supreme/keypad-framework`) so any future keypad (KNX push-button,
Casambi keypad, Lutron Pico, Matter switch, MQTT button, RTI keypad, Zigbee remote, BLE fob, DALI
push-button unit) can control any Supreme device, never via a protocol-to-protocol mapping. Ships
a Universal Input Engine (press-timing derivation: short/long/double/triple-press,
hold-start/holding/hold-end), a Universal Feedback Engine (capability-gated LED/display/haptic
routing), a Subscription Manager, and a Mapping Engine (reuses the existing Automation DSL's
`AutomationCondition`/`AutomationAction` verbatim, plus `{{variable}}` expansion at authoring
time), all wired into the gateway with a full REST CRUD surface — but **no real keypad driver
ships yet** and **no visual editor exists**; see `docs/architecture/Universal-Keypad-Framework.md`
and `Keypad-Driver-Author-Guide.md`.

**Universal Intent & Capability Engine (ADR 0017, Phase 2 — architecture only):** a protocol- AND
device-independent semantic layer (`@supreme/intent-engine`) sitting between "something happened"
(a keypad, an automation, a future AI/voice assistant) and "write this capability command to this
device." A `KeypadMapping`/`Automation` action can now be `{ type: "intent", intentId, target,
params }` (additive to the existing `AutomationAction` union) instead of naming a concrete device
+ command — the Capability Engine (`IntentEngine` + `CapabilityIndex`) resolves which device(s)
and which concrete `CapabilityCommand` satisfy it, dynamically, every time it runs, so replacing a
device's underlying driver (KNX → Casambi → Matter → …) never touches the mapping. Ships a 42-intent
built-in catalog across lighting/climate/av/blinds/security/system (`IntentRegistry`, publicly
extensible at runtime — no core change needed to add an intent), an O(matches)-not-O(all-devices)
capability lookup index, real parameter validation, and a full REST surface
(`GET /v1/intents`, `POST /v1/intents/:id/run`). Two categories of built-in intent are registered
but honestly fail at execution (`swingMode`/`tiltUp`/`tiltDown` — no swing/tilt field exists in the
capability model yet; `executeScript`/`webhook` — no script engine or webhook dispatcher exists
yet) — visibly incomplete, never faked. See `docs/architecture/
Universal-Intent-Capability-Engine.md`.

**Major recent UI work (this development cycle — Premium Device Experience Library):**
A feature-module architecture (`apps/web-homeowner/src/features/<domain>/`) delivering premium,
capability-gated device pages for the Media module (Television, Projector, AVR, Speaker) and
the Security module (Door Lock, Furniture Lock, SIP Video Door Phone, Camera, NVR, Alarm
System), plus a full visual-polish pass: a shared SVG icon system replacing emoji, premium
card/button micro-interactions, a consolidated "unavailable capability" presentation, and an
adaptive two-column detail layout. See `SESSION_HANDOFF.md` for exact file-level detail and
`TODO.md` for what's left (Infrastructure module: Energy, EV Charger, Pool, Irrigation, Water
Tank, Generator, Building Management, Vehicle; further device-category visual identity).

## 7. Roadmap summary

**Product phases** (`docs/architecture/supreme-os-blueprint.md` §16) — status per README: **"Phases
0–4 implemented."**
- **Phase 0 — Foundations:** monorepo, domain-model/contracts, Aureon tokens, hub Compose with
  hidden HA, SIL skeleton, Identity + Permissions, gateway + WSS.
- **Phase 1 — Homeowner MVP:** Dashboard, Rooms, Device Control, Scenes, Favorites,
  Notifications, user management, local + remote access.
- **Phase 2 — Installer & Drivers:** Installer Portal, Driver Store, discovery/commissioning
  (KNX/DALI/Casambi/Matter/MQTT/Modbus), diagnostics, backup/restore, licensing.
- **Phase 3 — Intelligence & Scale:** visual Automation Builder, AI assistant, energy/analytics,
  cameras/security depth, multi-home + installer fleet, advanced audit.
- **Phase 4 — Native migration:** `SupremeNativeAdapter` per domain behind flags; retire HA
  dependencies incrementally, zero frontend change — "the strangler-fig payoff."

**Cloud plane phases** (`docs/architecture/supreme-cloud-blueprint.md` §22, a separate
C-numbered track): C0 Foundation (hub identity, zero-touch enrollment) → C1 Identity plane → C2
Connectivity plane (Tunnel Broker) → C3 Ecosystem plane (notifications, voice, Matter cloud,
OTA) → C4 Commercial plane (subscription/licensing, dealer/admin, telemetry, multi-region).

**Important caveat** (`docs/production-readiness.md`): there are two different axes of "done."
Feature-complete development is estimated ~80%, but **real-world deployment readiness is
materially lower (~25–30%)** — nothing has run against real field-bus hardware, an unattended
multi-week soak, real cloud providers, or a security audit yet. Recommended critical path:
(1) security hardening → (2) real HA integration → (3) wire real Redis/NATS + persist remaining
state → (4) cloud IaC + CD + observability → (5) real drivers/protocols + remote-access relay.

## 8. Glossary

| Term | Meaning |
|---|---|
| **SIL** | Supreme Integration Layer — the one seam between Supreme services and any backend. |
| **Capability** | A normalized, backend-agnostic device function (`onoff`, `brightness`, `color`, `temperature`, `position`, `media`, `lock`, `fan`, `vacuum`, `sensor`) — the vocabulary every client speaks instead of raw protocol identifiers. |
| **Adapter** (`IBackendAdapter`) | Interface implemented by `HaAdapter`, `MockAdapter`, `SupremeNativeAdapter`, `RoutingBackendAdapter` (migration-era router between HA and native). |
| **Driver** (`INativeProtocolDriver`) | A native, non-HA protocol implementation (KNX, MQTT, Matter, AVR, …) plugged into the SIL via `SupremeNativeAdapter`. |
| **Protocol binding** | The config record wiring one commissioned device/capability to a specific driver connection/address. |
| **Commissioning** | Discovering and binding a physical device onto a bus/protocol, registering it as a controllable Supreme device. |
| **Hub** | The home appliance (Docker Compose stack) — the complete local product, running headless HA + all Supreme services. |
| **Fleet** | Cloud-side multi-home/multi-hub management for installers/dealers. |
| **Dealer** | An installer organization in the cloud Installer/Dealer service — manages technicians, sites, hub assignment, ownership transfer. |
| **Strangler fig** | The incremental, per-domain replacement of HA with native drivers, with zero frontend change at any step. |
| **Aureon** | The shared design language/token system — dark, architectural, gold-accented, room-first. |
| **Tunnel Broker** | Cloud service terminating hub control channels (mTLS/QUIC) and routing off-LAN client sessions to the right hub. |
| **Zero-touch provisioning** | The hub self-generates a cryptographic identity and enrolls with the cloud Hub Registry with no manual token copying. |
| **SIE** (Supreme Intelligence Engine) | Pluggable, deterministic, local-only intelligence modules (presence, energy, comfort) emitting Observations and confidence-scored Suggestions. |
| **Auto Pilot** | SIE mode that auto-executes suggestions only above a confidence threshold. |
| **Effective License** | The merged licensing result combining every pluggable provider (Developer/Offline/Cloud/OEM/Testing) into one answer. |
| **Developer Mode** | Licensing provider + UI mode unlocking every SKU/feature for engineering; disabled via `SUPREME_DEV_MODE_LOCKED` on customer/OEM builds. |
| **Capability Gate / Capability Grid** | The UI pattern (this dev cycle) for showing a premium control that isn't backed by a real driver yet — dimmed, honestly labeled, never faked, never spammed per-tile. |

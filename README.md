# Supreme OS

A luxury smart-home platform by **Supreme Domotics** — designed to compete with
Control4, Savant, Crestron and RTI.

- **Local-first:** the home hub is a complete, self-sufficient system that works
  with zero internet. Supreme Cloud is optional/opt-in (remote access & management).
- **Abstraction-first:** Home Assistant is a hidden backend behind the Supreme
  Integration Layer and is never exposed to end users or installers.
- **Aureon** design language: dark, architectural, gold-accented, room-first.
- **Matter** support is optional and user-activatable (runs locally on the hub).

For the full narrative (vision, philosophy, use cases, terminology, dev status) see
[`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md). For system design and the "why" behind
each decision see [`ARCHITECTURE.md`](ARCHITECTURE.md). For history and open work
see [`DEVELOPMENT_LOG.md`](DEVELOPMENT_LOG.md), [`SESSION_HANDOFF.md`](SESSION_HANDOFF.md),
[`ROADMAP.md`](ROADMAP.md) and [`TODO.md`](TODO.md). For conventions see
[`CODING_STANDARDS.md`](CODING_STANDARDS.md) and [`UI_GUIDELINES.md`](UI_GUIDELINES.md).

## Documentation
- **Technical blueprint:** [`docs/architecture/supreme-os-blueprint.md`](docs/architecture/supreme-os-blueprint.md)
  (founding design doc — repo structure, schemas, APIs, roadmap, risks) and
  [`docs/architecture/supreme-cloud-blueprint.md`](docs/architecture/supreme-cloud-blueprint.md)
- **Architecture decisions:** [`docs/architecture/adr/`](docs/architecture/adr/) (14 ADRs, 0001–0014)
- **Production readiness checklist:** [`docs/production-readiness.md`](docs/production-readiness.md)
  — living scorecard of what's built vs. what's left for real-world deployment
- **Security review:** [`docs/security-review.md`](docs/security-review.md)
- **Driver authoring:** [`docs/drivers.md`](docs/drivers.md)
- **HA integration internals:** [`docs/ha-integration.md`](docs/ha-integration.md)
- **Provisioning & identity:** [`docs/provisioning-and-identity.md`](docs/provisioning-and-identity.md)
- **UX benchmark references:** [`docs/reference/`](docs/reference/) · **UI screenshots:** [`docs/screenshots/`](docs/screenshots/)

> Status: **Phases 0–4 implemented.** On the homeowner + installer + intelligence
> stack, **Phase 4 (native migration)** lands the strangler-fig payoff: the SIL
> routes each backend domain to Home Assistant *or* the Supreme-native engine, and
> an operator migrates a domain to native at runtime with **zero change above the
> SIL** (proven by e2e). The AI assistant runs a **real on-box LLM** (llama.cpp)
> when a model is provisioned, with the deterministic planner as a correctness
> floor. Everything is verified by automated tests (PGlite e2e, Ed25519/hash-chain,
> a runtime native-migration e2e, and a real-inference test gated on a local model).
>
> Overall **development completion ~80%** (software surface built + tested in CI/
> simulation); **real-world readiness ~25–30%** (no real field-bus hardware run yet,
> no unattended multi-week soak, no third-party pen test). See
> [`docs/production-readiness.md`](docs/production-readiness.md) for the itemized
> scorecard and [`ROADMAP.md`](ROADMAP.md) / [`TODO.md`](TODO.md) for what's next.

## Features

- **Room-first homeowner experience** (Flutter mobile/tablet + React web): dashboard,
  room pager, device tiles with live state, scenes, favorites, notifications, security
  panel, energy, media (camera HLS/WebRTC playback), AI assistant.
- **Installer Portal** (React web): device discovery, Driver Store, commissioning
  wizards (KNX/DALI/Casambi/Matter/MQTT/Modbus/Zigbee/etc.), diagnostics, backup/
  restore, project export, licensing, native-migration controls, fleet management.
- **Automation & AI**: visual Automation Builder over a Supreme DSL, deterministic
  NL→automation planner with an optional real on-box LLM (llama.cpp), circadian
  lighting, solar schedule, scene scheduling, vacation/occupancy simulation, energy
  cost/tariff engine.
- **17 first-party drivers**: KNX, MQTT (Zigbee2MQTT/Tasmota), Modbus TCP, Matter,
  native Zigbee, DALI, AVR (Denon/Marantz), CoolMasterNet HVAC, WiiM, Devialet,
  Sonos, Ajax, SIP door stations, Shelly, AirPlay, Apple TV, Lutron LIP
  (RadioRA2/HomeWorks QS + Caséta Pro), Tuya.
- **Ecosystem/voice**: Alexa Smart Home, Google Smart Home, HomeKit (local HAP
  bridge), Matter commissioning + fabric sync — behind the same seam discipline as
  the HA integration.
- **Optional Supreme Cloud**: outbound-only remote-access relay (no inbound ports),
  push notification fan-out, off-site backup vault, installer fleet/multi-home
  management, dealer licensing.
- **Native migration engine**: per-domain strangler-fig routing from the HA adapter
  to a `SupremeNativeAdapter` behind a runtime flag, with zero frontend change.

## Tech stack

| Layer | Technology |
|---|---|
| Mobile | Flutter (Dart), Riverpod, `aureon-flutter` design system |
| Web | React + TypeScript (Vite), `aureon-web` design tokens |
| Backend services (Node/TS) | gateway, identity, permissions, home, scenes, automations, integration-layer (SIL), drivers, protocols, notifications, persistence, messaging, analytics, audit, security, cameras, intelligence, license, commissioning |
| Python sidecars (FastAPI) | `ai-py`, `commissioning-py`, `appletv-py` |
| Automation backend (hidden) | Home Assistant Core (headless), abstracted behind the SIL |
| Databases | PostgreSQL (system of record; PGlite for embedded tests), Redis (presence/cache, optional), NATS JetStream (event bus, optional) |
| Contracts/codegen | `supreme-contracts` (OpenAPI/AsyncAPI/zod), generated `supreme-sdk-ts` / `supreme-sdk-dart` |
| Infra | Docker Compose (`infra/hub-compose`, `infra/cloud-compose`), Terraform (`infra/cloud-iac`), Caddy edge proxy, GitHub Actions CI/CD |
| Observability | Prometheus, Grafana, OpenTelemetry (OTLP/HTTP) |
| Build tooling | pnpm + Turborepo (TS/JS), Melos (Flutter/Dart), ruff+pytest (Python) |

## Repository layout (monorepo)

```
apps/       mobile (Flutter homeowner: rooms, scenes, security, energy, AI
            assistant, Automation Builder) · web-homeowner (React) ·
            web-installer (React Installer Portal: drivers, commissioning,
            diagnostics, backup, licensing, native migration, fleet)
services/   gateway · identity · permissions · home · scenes · notifications
            persistence · messaging · drivers · protocols (real MQTT/Modbus)
            commissioning · commissioning-py (FastAPI) · automations
            analytics · audit · ai · ai-py (FastAPI) · security
            cameras (RTSP→HLS/WebRTC) · integration-layer (SIL) ·
            intelligence · license · backup · appletv-py (FastAPI)
cloud/      admin · audit · authn · authz · backups · dealer · device-registry
            fleet (HTTP API) · hub-registry · identity · licensing · matter ·
            notification · ota · persistence · relay · schema · subscription ·
            telemetry · tunnel-broker · voice
packages/   domain-model · supreme-contracts · supreme-sdk-ts ·
            supreme-sdk-dart · aureon-web · aureon-flutter · crypto ·
            hub-identity · hub-pki
drivers/    sdk (driver authoring + signing)
infra/      hub-compose (Docker Compose for the home hub, incl. hidden HA) ·
            cloud-compose · cloud-iac (Terraform) · observability
tools/      codegen (Aureon token generation) · loadtest · ota
docs/       architecture (blueprint + ADRs) · reference · screenshots
scripts/    dev (environment provisioning helpers)
```

The JS/TS sides use **pnpm + Turborepo**; the Flutter side uses **Melos**; the
protocol-commissioning, AI, and Apple TV sidecars are **Python/FastAPI**.

## Getting started

```bash
# TS workspace — build, typecheck, and run all tests (incl. e2e + persistence)
pnpm install
pnpm build && pnpm test

# Run the gateway standalone with the in-memory backend (no HA, no DB needed)
SUPREME_BACKEND=mock pnpm --filter @supreme/gateway dev
# → Supreme API on http://127.0.0.1:8080  (GET /healthz)

# Bring up the full home hub (headless hidden HA + Postgres data plane)
cd infra/hub-compose && cp .env.example .env && docker compose up -d --build
# → Supreme API + installer portal behind TLS at https://localhost (dev: Caddy
#   internal CA / self-signed). Only the edge proxy (:80/:443) is host-published;
#   the gateway, portal, HA, and data plane stay internal.
```

### Native toolchains (Flutter & Docker)

The TS/Python work needs no extra setup. For the Flutter app and the Docker/Compose
stack, run the idempotent provisioner (also wired as a Claude Code **SessionStart
hook** in `.claude/settings.json`, so web sessions auto-provision in the background):

```bash
bash scripts/dev/enable-native-tools.sh   # installs Flutter, starts dockerd (+ mirror + proxy CA)
export PATH="/opt/flutter/bin:$PATH"
cd apps/mobile && flutter pub get && flutter test && flutter build web

# Docker: build images + run the gateway against real Postgres and hit the API
bash scripts/dev/compose-smoke.sh
```

> **Docker behind a restricted network.** The managed web environment routes egress
> through a TLS-intercepting, host-allowlisting proxy: Docker Hub anonymous pulls
> are rate-limited and its blob CDN is blocked, and in-container package fetches
> fail CA validation. `enable-native-tools.sh` resolves both **without any
> network-policy change**: it points the daemon at Google's Docker Hub mirror
> (`mirror.gcr.io`, an allowlisted host) and stages the proxy CA into
> `infra/hub-compose/ca-certs/` so the Dockerfiles trust it at build time. On normal
> networks (CI, real hubs) that CA dir is empty and the steps are a no-op. Verified
> here: all hub images pull, all three images build, and the gateway serves the API
> against a Postgres container. The full `docker compose up` additionally needs the
> required `.env` secrets.

### Build / typecheck / lint

```bash
pnpm build          # turbo run build across all TS/JS packages+services
pnpm typecheck      # turbo run typecheck
pnpm lint           # turbo run lint
```

### Test

```bash
pnpm test                                   # all TS/JS unit + e2e (incl. persistence, PGlite)
cd apps/mobile && flutter test              # Flutter widget tests
cd services/ai-py && pytest -q              # Python sidecar tests (ruff + pytest per service)
```

### What's verified by tests

- **Tap a light through the full stack** (`services/gateway/src/e2e.test.ts`):
  login → REST command → SIL → backend → normalized state delta over WSS, with an
  assertion that **no Home Assistant identifiers leak** into the Supreme contract.
- **Homeowner MVP** (`services/gateway/src/phase1.e2e.test.ts`): scene activation
  driving device state over WSS, favorites, family-user RBAC, live notifications.
- **Real HA backend** (`services/integration-layer/src/ha/ha-ws-transport.test.ts`):
  a fake HA WebSocket server proves auth + command mapping + state normalization.
- **Persistence** (`services/persistence/src/persistence.test.ts` and the gateway
  restart test): the services run on the Postgres-backed repositories via embedded
  Postgres (PGlite), and a commissioned hub survives a reboot.
- **Installer & drivers** (`services/gateway/src/phase2.e2e.test.ts`): browse the
  signed catalog, license-gated driver install, Matter opt-in, commission a device
  into a controllable Supreme device, diagnostics, project export, and signed
  backup/restore over the API. Signing/licensing primitives and the Driver Manager
  have their own unit suites; the Python tooling is covered by `pytest`.
- **Intelligence & scale** (`services/gateway/src/phase3.e2e.test.ts`): an
  automation drives a device end-to-end over WSS, energy telemetry aggregates, the
  hash-chained audit log verifies, the AI assistant returns a draft, and the
  security panel arms/disarms. The automation engine, AI planner, audit chain,
  security panel, and cloud fleet each have their own unit/PGlite suites.

### Deploy

- **Hub:** `infra/hub-compose` — signed images, OTA update channel (Ed25519-signed
  manifest via `tools/ota`, verified in `services/gateway/src/ota.ts`); staged
  rollout/rollback are deploy-target wiring.
- **Cloud (optional):** `infra/cloud-compose` for a single-box deploy, or
  `infra/cloud-iac` (Terraform) for managed infrastructure.
- **CI/CD:** `.github/workflows/ci.yml` (TS build/typecheck/test, Flutter analyze/
  test/build, Python ruff+pytest per sidecar, Docker image build smoke), `cd.yml`
  (build/push images + signed OTA manifest), `clients.yml` (client builds),
  `loadtest.yml` (load/soak/chaos gate).

Configuration: set `SUPREME_BACKEND=native` (the only real backend) and
`DATABASE_URL` to enable Postgres persistence (both wired in `hub-compose`).

## Environment variables

Two canonical, heavily-commented `.env.example` files are the source of truth:

- [`infra/hub-compose/.env.example`](infra/hub-compose/.env.example) — hub/home:
  backend selection (`SUPREME_BACKEND=native|mock`), token
  secrets, Postgres, per-driver enable flags/hosts (KNX/Modbus/MQTT/Matter/Zigbee/
  DALI/AVR/CoolMaster/SIP/Lutron/Tuya/media drivers), camera streaming, push
  relay, voice cloud reporting, remote-access relay, OTA, sealed secrets (`*_FILE`
  convention), edge TLS domain/ACME email.
- [`infra/cloud-compose/.env.example`](infra/cloud-compose/.env.example) — cloud
  plane: relay tokens, cloud Postgres, fleet API keys, dealer-licensing keys,
  voice OAuth clients/HMAC secret, Matter API keys, backup-vault API keys.

Key variables:

| Variable | Purpose |
|---|---|
| `SUPREME_BACKEND` | `ha` (real Home Assistant) or `mock` (in-memory, no HA) |
| `SUPREME_TOKEN_SECRET` | JWT signing secret, ≥32 chars, fail-closed in production |
| `DATABASE_URL` / `POSTGRES_PASSWORD` | enables Postgres persistence |
| `SUPREME_NATS_URL` / `SUPREME_REDIS_URL` | cross-process event bus + presence (optional; in-process otherwise) |
| `SUPREME_RELAY_URL` / `SUPREME_RELAY_TOKEN` | optional remote-access relay |
| `SUPREME_AI_WITH_LLM` / `SUPREME_AI_MODEL_PATH` | real on-box LLM vs. the deterministic planner |
| `NODE_ENV=production` | refuses to boot with the insecure dev token secret; requires an explicit CORS allow-list |

## Contribution guidelines

- Follow [`CODING_STANDARDS.md`](CODING_STANDARDS.md) (naming, file organization,
  error handling, testing patterns) — derived from what the codebase already does.
- Every capability that reaches Home Assistant or a protocol/driver must go
  through the SIL (`IBackendAdapter`) — never call HA or a protocol directly from
  a domain service or client (ADR 0001).
- New architectural decisions get a new ADR in `docs/architecture/adr/000N-*.md`
  following the existing Context/Decision/Consequences format.
- CI must pass: TS build/typecheck/test, Flutter analyze/test/build, Python
  ruff+pytest per sidecar, Docker image build smoke (`.github/workflows/ci.yml`).
- Commit messages follow `<Area/feature>: <what changed> (§<blueprint/roadmap section>)`
  — keep using it so `git log` stays scannable (see history for examples).

## Versioning strategy

- Root `package.json` is pinned at `0.0.0` (pre-release monorepo; no public
  package versioning yet).
- API contracts are versioned via a `/v1` namespace with a capability-negotiation
  header (blueprint §6) — the client-facing contract must not break, since that's
  what protects the HA→native migration.
- Hub/cloud releases ship via a **signed OTA manifest** (Ed25519, `tools/ota`)
  rather than semver package bumps; `docs/production-readiness.md` tracks
  readiness by dimension, not by version number.

# Supreme OS

A luxury smart-home platform by **Supreme Domotics** — designed to compete with
Control4, Savant, Crestron and RTI.

- **Local-first:** the home hub is a complete, self-sufficient system that works
  with zero internet. Supreme Cloud is optional/opt-in (remote access & management).
- **Abstraction-first:** Home Assistant is a hidden backend behind the Supreme
  Integration Layer and is never exposed to end users or installers.
- **Aureon** design language: dark, architectural, gold-accented, room-first.
- **Matter** support is optional and user-activatable (runs locally on the hub).

## Documentation
- **Technical blueprint:** [`docs/architecture/supreme-os-blueprint.md`](docs/architecture/supreme-os-blueprint.md)
- **Architecture decisions:** [`docs/architecture/adr/`](docs/architecture/adr/)
- **UX benchmark references:** [`docs/reference/`](docs/reference/)

> Status: **Phase 3 (Intelligence & Scale) in progress.** On the Phase 0–2
> foundations, Phase 3 adds: a native **automation engine** over an engine-agnostic
> DSL (the visual Builder's source), an **AI assistant** (offline NL→DSL planner,
> local-LLM-ready), **energy/analytics** time-series, a tamper-evident **audit
> log**, **security** (arm/disarm) + cameras, and optional **multi-home/installer
> fleet** management — wired through the gateway and the Flutter app, all verified
> by automated tests (incl. PGlite-backed e2e and Ed25519/hash-chain checks).

## Repository layout (monorepo)

```
packages/   domain-model · supreme-contracts · supreme-sdk-ts · supreme-sdk-dart
            aureon-web · aureon-flutter · crypto
services/   gateway · identity · permissions · integration-layer (SIL)
            home · scenes · notifications · persistence
            drivers · commissioning · backup · commissioning-py (FastAPI)
            automations · analytics · audit · ai · security · ai-py (FastAPI)
cloud/      licensing · fleet
drivers/    sdk (driver authoring + signing)
apps/       mobile (Flutter homeowner) · web-installer (React Installer Portal)
infra/      hub-compose (Docker Compose for the home hub, incl. hidden HA)
tools/      codegen (Aureon token generation)
docs/       architecture (blueprint + ADRs) · reference · design
```

The JS/TS sides use **pnpm + Turborepo**; the Flutter side uses **Melos**; the
protocol-commissioning sidecar is **Python/FastAPI**.

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

Configuration: set `SUPREME_BACKEND=ha` + `SUPREME_HA_TOKEN` for the real backend,
and `DATABASE_URL` to enable Postgres persistence (both wired in `hub-compose`).

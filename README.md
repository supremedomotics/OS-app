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

> Status: **Phase 2 (Installer & Drivers) in progress.** On the Phase 0/1
> foundations (monorepo, SIL, identity & permissions, gateway REST + WSS, device
> control, scenes/favorites/notifications, real HA backend, Postgres persistence,
> Flutter homeowner app), Phase 2 adds: a signed **Driver Store** with offline
> license gating + Matter opt-in, the first-party KNX/Casambi/DALI/Zigbee/MQTT/
> Modbus/Matter drivers, **device discovery + commissioning** (with a Python
> KNX/DALI/Modbus tooling sidecar), **diagnostics**, signed **backup/restore**,
> **project export**, **licensing**, and a **web Installer Portal**. All verified
> by automated tests (incl. embedded-Postgres persistence and Ed25519 signing).

## Repository layout (monorepo)

```
packages/   domain-model · supreme-contracts · supreme-sdk-ts · supreme-sdk-dart
            aureon-web · aureon-flutter · crypto
services/   gateway · identity · permissions · integration-layer (SIL)
            home · scenes · notifications · persistence
            drivers · commissioning · backup · commissioning-py (FastAPI)
cloud/      licensing
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
bash scripts/dev/enable-native-tools.sh   # installs Flutter, starts dockerd
export PATH="/opt/flutter/bin:$PATH"
cd apps/mobile && flutter pub get && flutter test && flutter build web
```

> **Docker image pulls** depend on the environment's network policy. In the default
> managed web environment, container-registry blob CDNs (Docker Hub, GHCR, ECR,
> Quay) are blocked, so the daemon starts but `docker compose up` can't fetch base
> images — allowlist those registry hosts (or configure a registry mirror / Docker
> Hub credentials) in your environment to run the full hub stack locally. CI uses
> GitHub-hosted runners, which can pull images and install Flutter normally.

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

Configuration: set `SUPREME_BACKEND=ha` + `SUPREME_HA_TOKEN` for the real backend,
and `DATABASE_URL` to enable Postgres persistence (both wired in `hub-compose`).

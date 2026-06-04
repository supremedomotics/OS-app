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

> Status: **Phase 1 (Homeowner MVP) in progress.** On the Phase 0 foundations
> (monorepo, domain model + contracts, SIL, identity & permissions, gateway with
> REST + WSS, Aureon design system, SDKs, hub Compose), Phase 1 adds: device
> control across lighting/climate/media/covers, scenes (CRUD + activation),
> favorites, notifications, user management + grants, a real Home Assistant
> WebSocket backend, Postgres persistence (system of record), and the Flutter
> homeowner app (dashboard, rooms, scenes, alerts). The full stack is verified by
> automated e2e/integration tests (incl. embedded-Postgres persistence).

## Repository layout (monorepo)

```
packages/   domain-model · supreme-contracts · supreme-sdk-ts · aureon-web
            aureon-flutter · supreme-sdk-dart
services/   gateway · identity · permissions · integration-layer (SIL)
            home · scenes · notifications · persistence
apps/       mobile (Flutter homeowner app)
infra/      hub-compose (Docker Compose for the home hub, incl. hidden HA)
tools/      codegen (Aureon token generation)
docs/       architecture (blueprint + ADRs) · reference · design
```

The JS/TS + Python sides use **pnpm + Turborepo**; the Flutter side uses **Melos**.

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

Configuration: set `SUPREME_BACKEND=ha` + `SUPREME_HA_TOKEN` for the real backend,
and `DATABASE_URL` to enable Postgres persistence (both wired in `hub-compose`).

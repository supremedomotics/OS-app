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

> Status: **Phase 0 (foundations) in progress.** The monorepo, canonical domain
> model + contracts, the Supreme Integration Layer, identity & permissions, the
> API gateway (REST + WSS), the Aureon design system, the SDKs, the Flutter
> homeowner app, and the hub Docker Compose are scaffolded and the end-to-end
> "tap a light" vertical slice is proven green.

## Repository layout (monorepo)

```
packages/   domain-model · supreme-contracts · supreme-sdk-ts · aureon-web
            aureon-flutter · supreme-sdk-dart
services/   gateway · identity · permissions · integration-layer (SIL)
apps/       mobile (Flutter homeowner app)
infra/      hub-compose (Docker Compose for the home hub, incl. hidden HA)
tools/      codegen (Aureon token generation)
docs/       architecture (blueprint + ADRs) · reference · design
```

The JS/TS + Python sides use **pnpm + Turborepo**; the Flutter side uses **Melos**.

## Getting started (Phase 0)

```bash
# TS workspace — build, typecheck, and run all tests (incl. the e2e slice)
pnpm install
pnpm build && pnpm test

# Run the gateway standalone with the in-memory backend (no HA needed)
SUPREME_BACKEND=mock pnpm --filter @supreme/gateway dev
# → Supreme API on http://127.0.0.1:8080  (GET /healthz)

# Bring up the full home hub (headless hidden HA + data plane)
cd infra/hub-compose && cp .env.example .env && docker compose up -d --build
```

The Phase-0 exit criterion — *tap a light in Flutter through the full Supreme
stack* — is exercised end-to-end by `services/gateway/src/e2e.test.ts`: login →
REST command → SIL → backend adapter → normalized state delta back over WSS, with
an assertion that **no Home Assistant identifiers leak** into the Supreme contract.

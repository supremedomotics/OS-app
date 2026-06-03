# ADR 0002 — Polyglot monorepo with pnpm/Turborepo + Melos

- Status: **Accepted**
- Date: 2026-06-03
- Context: Phase 0 foundations (§4, §18).

## Decision

A single monorepo (`os-app`) hosts three toolchains side by side:

- **pnpm + Turborepo** for all JS/TS (`packages/*`, `services/*`, `cloud/*`,
  `drivers/*`, `tools/*`). Workspace deps use `workspace:*`; Turborepo caches and
  orders `build`/`typecheck`/`test` via the package graph.
- **Melos** for the Dart/Flutter workspace (`apps/mobile`, `apps/installer`,
  `packages/aureon-flutter`, `packages/supreme-sdk-dart`).
- **uv/Poetry** for Python services (`services/ai-assistant`,
  `services/commissioning`) — added when those services land (Phase 1+).

## Rationale

- The contract-first packages (`domain-model`, `contracts`) are the source of
  truth; TS builds derive from them and Dart mirrors are **generated** from the
  same canonical assets (e.g. Aureon tokens via `@supreme/codegen`), guaranteeing
  one source of visual + domain truth across clients.
- Turborepo's affected-graph keeps CI fast and lets the gateway Docker build pull
  only its dependency subtree (`pnpm --filter @supreme/gateway...`).

## Consequences

- Two package managers coexist; each owns its language's packages cleanly. CI runs
  both pipelines. Cross-language contracts flow only through generated artifacts,
  never shared source.

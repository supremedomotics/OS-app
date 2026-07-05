# ADR 0003 — Persistence behind a SqlDb seam, verified with embedded Postgres

- Status: **Accepted**
- Date: 2026-06-04
- Context: Phase 1 (Homeowner MVP) needs a durable system of record (§5, §16).

## Decision

Every stateful domain service (identity, home, scenes, permissions/grants,
notifications) already depends on a small store **interface**, not a concrete
database. Phase 1 adds `@supreme/persistence`, which implements those interfaces
with plain Postgres SQL through a thin `SqlDb` seam:

- `PgDb` — node-postgres pool — the hub's production Postgres (in `hub-compose`).
- `PgliteDb` — embedded Postgres (PGlite, WASM) — used by tests, and available as
  a zero-dependency local-first option.

Because both speak real Postgres, the **migrations and repository SQL are shared**;
there is no second dialect to keep in sync. The gateway connects + migrates at the
boot edge when `DATABASE_URL` is set and injects the repositories; otherwise it
falls back to the in-memory stores used by dev and tests.

## Rationale

- The store-interface boundary means swapping in Postgres changed **no service
  logic** — only the bootstrap wiring.
- PGlite lets CI verify the **actual production SQL** (schema, upserts, JSONB,
  `ANY($n)`, `LOWER(email)` uniqueness) with no database server, so the persistence
  path is genuinely tested everywhere the unit tests run.
- Timestamps are stored as ISO-8601 text so the domain (ISO strings) round-trips
  identically across Postgres and PGlite.

## Consequences

- First boot commissions the home + Master User and seeds demo devices; subsequent
  boots detect the existing home and instead rebind stored devices into the SIL
  registry — commissioning happens exactly once (covered by a restart test).
- New schema changes ship as additional, append-only migration files; shipped
  migrations are never edited.

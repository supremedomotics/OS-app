# Coding Standards — Supreme OS

Derived from what this codebase actually does (`services/*`, `packages/*`,
`apps/*`, `.editorconfig`, `.github/workflows/ci.yml`), not aspirational rules.
Where a convention isn't consistently followed, that's noted rather than
invented.

## Formatting

- `.editorconfig` is the enforced baseline: UTF-8, LF line endings, final
  newline, trim trailing whitespace, **2-space indent** for TS/JS/Dart/JSON/
  YAML, **4-space indent** for Python. Markdown files keep trailing whitespace
  (`trim_trailing_whitespace = false`) since it can be meaningful (line breaks).
- No repo-root `.eslintrc`/`.prettierrc` was found — formatting discipline
  relies on `.editorconfig` + `tsc` typechecking + `ruff` (Python) rather than a
  configured linter/formatter pipeline. If you add one, wire it into
  `turbo.json`'s `lint` task (currently a no-op placeholder: `"lint": {}`).

## Naming conventions

- **TypeScript packages**: scoped `@supreme/<name>` (e.g. `@supreme/gateway`,
  `@supreme/domain-model`, `@supreme/integration-layer`). Package folder name
  matches the unscoped part.
- **Files**: kebab-case (`home-service.ts`, `ha-ws-transport.ts`,
  `relay-tunnel.ts`, `config-store.ts`). Test files are colocated as
  `<name>.test.ts` or `<name>.e2e.test.ts` (e.g. `phase1.e2e.test.ts`,
  `phase2.e2e.test.ts`) next to the code they cover.
- **Types/interfaces**: PascalCase for types (`Device`, `Room`, `Home`,
  `CapabilityState`), `I`-prefixed for seam/port interfaces (`IHomeStore`,
  `IBackendAdapter`, `INativeProtocolDriver`, `IPushTokenStore`) — this prefix
  is used specifically for swappable/pluggable interfaces (adapters, stores),
  not for every interface in the codebase.
- **Branded ID types**: `DeviceId`, `RoomId`, `UserId`, etc. from
  `@supreme/domain-model`, constructed via `newId()` — never pass a raw
  `string` where an ID type is expected.
- **Classes**: PascalCase, suffixed by role (`HomeService`, `InMemoryHomeStore`,
  `SupremeIntegrationLayer`, `HaAdapter`, `MockAdapter`, `SupremeNativeAdapter`).
- **Env vars**: `SUPREME_<AREA>` prefix for hub/product config
  (`SUPREME_BACKEND`, `SUPREME_TOKEN_SECRET`, `SUPREME_KNX_HOST`), bare names
  for widely-shared infra vars (`DATABASE_URL`, `POSTGRES_PASSWORD`,
  `NODE_ENV`). `*_FILE` suffix convention for secrets sourced from a mounted
  file (Docker/K8s secrets) instead of a plaintext value — always checked
  before the plain var (see `secret()` helper referenced in
  `docs/security-review.md`).

## File / folder organization

- **Monorepo workspaces** are grouped by role, not by feature:
  `apps/` (clients) · `services/` (hub-side Node/Python) · `cloud/` (cloud-only
  services) · `packages/` (shared libraries/design system/SDKs) · `drivers/`
  (driver SDK) · `infra/` (deploy) · `tools/` (codegen/loadtest/ota) · `docs/`.
- Each TS package/service is self-contained: its own `package.json`,
  `src/`, `dist/` (build output, gitignored), and colocated tests — no shared
  `test/` directory at the repo root.
- Standard package scripts (see any `services/*/package.json`): `build` (tsc),
  `typecheck` (tsc --noEmit), `test` (vitest run --passWithNoTests), `dev`
  (tsx watch), `start` (node dist), `clean`. Keep this script set consistent
  when adding a new service so Turborepo's task graph works uniformly.
- Flutter code under `apps/mobile/lib/` is organized by `screens/` and
  `widgets/`; the shared design system lives in `packages/aureon-flutter/lib/src/`
  (`theme.dart`, `tokens.g.dart`, `widgets/`).

## Component / module patterns

- **Service classes wrap a store interface, constructor-injected with a
  default in-memory fallback**: `constructor(private readonly sil: X, store?: IHomeStore) { this.store = store ?? new InMemoryHomeStore(); }`.
  This is the dominant pattern across `services/*` — it makes every service
  testable without a database and swappable to Postgres by injecting a
  different store implementation, matching ADR 0003's persistence seam.
- **JSDoc block comments above classes/methods explain the *why*, referencing
  blueprint section numbers** (e.g. `/** Home service (§4 rooms + devices
  services...) */`). Keep this convention — it's how the codebase
  self-documents its relationship to the founding blueprint and ADRs.
- **Thin pass-through methods return store promises directly** where no extra
  logic is needed (`getHome(): Promise<Home | null> { return this.store.getHome(); }`);
  logic is only added where genuinely needed (e.g. `applyState` merges state).
  Don't add unnecessary async/await ceremony around a passthrough.
- Domain types are imported as `type`-only imports where possible
  (`import { type Device, type Room, ... } from "@supreme/domain-model"`),
  keeping the runtime/type boundary explicit for tree-shaking and clarity.

## API / driver conventions

- **Every backend-reaching capability goes through `IBackendAdapter`
  (`command()`, `subscribe()`, `discover()`, `capabilities()`)** — this is the
  hard rule from ADR 0001. Do not import Home Assistant concepts (entity IDs,
  domains, services) anywhere outside `services/integration-layer`.
- **Protocol drivers implement `INativeProtocolDriver`** under
  `services/protocols` / `services/drivers`, so `SupremeNativeAdapter` can
  front any of them uniformly. New drivers should declare a SIL capability
  manifest even if they currently wrap an HA integration underneath (Phase-1
  reality per the blueprint) — this is what keeps a future native rewrite a
  drop-in replacement rather than a rewrite of callers.
- **Contract-first**: shared request/response/event types live in
  `packages/supreme-contracts`; `supreme-sdk-ts` / `supreme-sdk-dart` are
  generated from it. Never hand-roll a client type that duplicates a contract
  type.
- REST routes live under `/v1/*`; commands are always
  `{capability, value}`-shaped against a resolved Supreme device/room target —
  never a raw backend command.

## TypeScript conventions

- `type: "module"` (ESM) across services; imports use explicit `.js` extension
  for local relative imports (`from "./store.js"`) per Node ESM resolution
  rules — keep this even though the source file is `.ts`.
- `tsconfig.base.json` is the shared compiler config; each package's
  `tsconfig.json` extends it. Match its strictness settings rather than
  loosening per-package.
- Prefer `readonly` constructor-injected dependencies (`private readonly sil: SupremeIntegrationLayer`).
- Errors use `SupremeError` from `@supreme/contracts` for domain-level errors
  surfaced to clients (see `services/gateway/src/http-errors.ts` for the
  HTTP-layer mapping) rather than throwing raw `Error`.

## Error handling

- **Fail-closed configuration**: the gateway refuses to boot in production
  with an insecure/default token secret or missing required config
  (`assertSecureConfig`) — this pattern (validate config eagerly, throw before
  serving traffic) should be followed for any new service that owns secrets.
- **Homeowner-facing errors never expose technical detail** (git log:
  "Homeowner-friendly errors — never expose technical detail (§ Errors)") —
  client-facing error messages are deliberately different from
  developer/installer-facing ones; keep raw stack traces/internal identifiers
  out of homeowner UI copy.
- SQL is always parameterized (`$1, $2, …`); no string interpolation of user
  input into queries anywhere in `services/persistence` (verified in
  `docs/security-review.md`).
- Ownership/authorization checks happen before mutation, scoped by the
  authenticated caller's id (see the push-token IDOR fix in
  `docs/security-review.md` — `remove(userId, token)`, not `remove(token)`
  alone) — apply the same "scope every delete/update by the acting principal"
  discipline to new mutating endpoints.

## Logging

- Structured logging with correlation IDs: pino per-request child logger
  stamps `reqId` on every line; the gateway honors an inbound
  `x-request-id`/`x-correlation-id` header or mints one, echoes it on the
  response, and attaches it to the request's trace span so logs and traces
  share one key (`services/gateway`). Use the same child-logger-per-request
  pattern in any new HTTP-facing service.
- `SUPREME_LOG_LEVEL` env var controls verbosity; default `info`.
- Secrets must never be logged (explicitly tracked as a not-yet-verified item
  in `docs/production-readiness.md` §1 — treat it as a real constraint, not
  just a checklist item, when adding new logging).

## Performance

- Event bus defaults to **in-process** (single-gateway deployments) and
  upgrades to real NATS JetStream/Redis only when `SUPREME_NATS_URL`/
  `SUPREME_REDIS_URL` are set — don't force an external dependency where the
  in-process seam already works; follow the existing "cheap by default, real
  infra behind an env var" pattern for new cross-cutting concerns.
- Load/soak/chaos testing lives in `tools/loadtest` (`@supreme/tools-loadtest`)
  and drives either an in-process gateway or a real deployed hub via `--url` —
  reuse this harness for new performance-sensitive changes rather than writing
  a bespoke script.

## Security

- Argon2id for password hashing, TOTP (RFC 6238) via `node:crypto` +
  `timingSafeEqual` for MFA — no external auth dependency.
- HS256 JWTs require a signing key ≥32 chars; access vs. refresh tokens carry a
  distinguishing `kind` claim that's checked, not just the signature.
- Rate limiting: global + a stricter limit specifically on `/v1/auth/*`.
- CORS: explicit allow-list required in production (no wildcard).
- Never commit secrets, model weights, or CA bundles — `.gitignore` and
  `.dockerignore` both exclude these; use the `*_FILE` convention or the
  compose `.env` (never committed) instead.
- See `docs/security-review.md` for the fixed findings and "surface reviewed
  and found solid" list — read it before touching auth/relay/persistence code.

## Testing

- **Vitest** for TS/JS unit + e2e (`*.test.ts`, `*.e2e.test.ts`, run via
  `pnpm test` / `turbo run test`, depends on `^build` in `turbo.json`).
- **PGlite** (embedded Postgres) backs persistence tests so they run without a
  real DB server, while still exercising real SQL — prefer this over mocking
  the repository layer for anything persistence-related.
- **Phase-numbered e2e suites** (`e2e.test.ts`, `phase1.e2e.test.ts`,
  `phase2.e2e.test.ts`, `phase3.e2e.test.ts`) each prove one blueprint phase
  end-to-end over the real gateway + WSS — when adding a feature that belongs
  to an existing phase's user journey, extend its e2e suite rather than
  starting a new one, unless it's a genuinely new phase-level capability.
- **Flutter**: `flutter analyze` (or `dart analyze` as fallback) + `flutter
  test` (widget tests) + a `flutter build web` compile-proof, run per package
  (`aureon-flutter`, `supreme-sdk-dart`, `mobile`) in CI.
- **Python**: `ruff check .` + `pytest -q` per FastAPI sidecar
  (`commissioning-py`, `ai-py`, `appletv-py`), each with its own CI matrix job.
- **Fake transports over real ones for hardware-dependent tests**: e.g. a fake
  HA WebSocket server (`ha-ws-transport.test.ts`), in-process HTTP/TCP servers
  for AVR/CoolMaster drivers, embedded MQTT brokers — this lets protocol logic
  be tested deterministically without real hardware; keep using this pattern
  for new drivers rather than skipping tests until hardware is available.
- **Gated real-integration tests** exist for things that need real external
  resources (a real HA instance, a real local LLM model) — these are opt-in
  via env var so CI stays deterministic and fast by default (e.g.
  `SUPREME_AI_WITH_LLM` gates the real-inference test).
- CI runs four parallel jobs: `ts` (build/typecheck/test), `flutter`
  (analyze/test/build), `python` (matrix per sidecar), `docker` (image build +
  smoke). A change should keep all four green.

## Review & documentation standards

- New architectural decisions get a new ADR (`docs/architecture/adr/000N-*.md`)
  in the existing Context/Decision/Consequences format — this repo treats ADRs
  as a durable record, not a one-off doc; don't fold a real architectural
  decision into a PR description instead.
- `docs/production-readiness.md` is a **living checklist** — update its status
  boxes/scorecard percentages as work lands, rather than letting it drift
  stale (it explicitly says so at the top of the file).
- Screenshot docs (`docs/screenshots/`) are refreshed alongside UI changes
  (see the many `docs: refresh ... screenshots` commits) — if you change a
  screen's visual design, refresh its screenshot in the same PR.
- Commit message convention (observed across ~299 commits, not written down
  elsewhere until now): `<What changed, in plain language> (§<blueprint or
  roadmap section / project codename>)`, e.g. `"Room summaries as glyphs +
  personalized greeting (§ review)"`, `"Phase 3: energy/analytics + tamper-
  evident audit log"`. Keep using it — `git log --oneline` is a genuinely
  useful project history because of this discipline.

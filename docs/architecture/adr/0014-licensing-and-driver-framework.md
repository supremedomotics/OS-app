# ADR 0014 — Licensing Service + Driver Framework + Developer Edition

- Status: **Accepted**
- Date: 2026-07-01
- Context: blueprint §9 (drivers + licensing), §13 (cloud optional); ADR 0001 (SIL),
  ADR 0004 (driver-store trust). Invariant **I1**: the hub works fully offline.

## Context

Two coupled needs emerged from field use:

1. **Licensing was hardcoded and leaky.** Driver SKUs were checked ad-hoc, the "pro"
   gate blocked owners from their own KNX bus, and there was no single place that
   answered "is this licensed?". Dev/production, offline, cloud, OEM and subscription
   models all needed one home.
2. **The Driver Manager was a hardcoded list with no config.** Manifests carried no
   config schema, drivers exposed no configure/diagnostics/health/logs, and the UI
   couldn't populate itself or generate a config page. Adding a driver meant editing
   the UI.

## Decision

### Licensing Service — the single source of truth

`@supreme/license-service` merges pluggable **providers** (Developer, Offline, Cloud,
OEM, Testing) into one `EffectiveLicense`. Everyone — drivers, Driver Manager, apps,
REST — asks only `hasSku` / `hasFeature` / `canInstallDriver`. **No licensing logic
lives anywhere else.** Local-first: providers resolve offline; cloud is just one more
provider. `mergeGrants` takes the union of SKUs/features, the highest tier, the
earliest expiry, and the dominant source.

- **Developer Mode** (`DeveloperProvider`) unlocks every SKU + feature and flags the
  UI watermark. Enabled by `SUPREME_DEV_MODE=true`, a runtime admin toggle, or the
  built-in dev account — **never** by touching code. Gated OFF only when a customer/OEM
  build sets `SUPREME_DEV_MODE_LOCKED=true` (crucially **not** keyed off `NODE_ENV`,
  which the hub image always sets to `production` for perf).
- **Offline licensing** reuses the existing signed-token path (Ed25519, `@supreme/
  crypto`): issue → activate → offline-validate against the embedded public key. The
  activated token maps to a provider grant (tier-expanded SKUs + features). A `.slic`
  file is that token; the app imports/pastes it. No internet needed afterward.
- The `DriverManager` licensing gate now delegates to the service, so Dev Mode or a
  real license both unlock KNX — through one path.

### Driver Framework — one registry, generated config

The manifest gains a declarative **`configSchema`**, **`dependencies`**, and declared
**`operations`**. `DriverManager.registry()` merges every catalog driver with its
installed state + schema + operations — the **one source the UI populates from**, so
*any current or future driver appears automatically with no UI change*. Config is
schema-validated (`validateDriverConfig`: coercion, defaults, required/range/select,
secret-preservation), persisted in `installed_drivers.config` (survives restart/
update). Per-driver **health** (config completeness + native connectivity → healthy/
not_configured/error/disabled), **logs** (in-memory ring buffer of lifecycle events),
and **connect/disconnect** bridge the manifest driver to its runtime protocol stack
via new SIL passthroughs (`nativeProtocolStatus`, `connect/disconnectNativeProtocol`).

### Developer Edition

Two modes. **Developer Mode** exposes a tool shell (`DeveloperTools`, hidden unless
`devMode`) showing only the **functional** engineering tools — API Explorer, live
WebSocket Inspector, hub Diagnostics — with protocol analyzers / DB browser / OTA
etc. deliberately **hidden until real** ("no placeholder pages"). Dev builds seed a
default `supreme` / `supreme@72` master account with Dev Mode on; production never
seeds it.

## Consequences

- **No hardcoded licensing, checked in one place.** New SKUs/features/providers are
  additive; drivers stay logic-free.
- **The Driver Manager scales.** New drivers need a manifest, not UI edits; every
  driver gets a generated config page + health/logs/lifecycle for free.
- **Local-first + secure.** Offline activation and Dev Mode both work without cloud;
  the developer path can be locked for OEM/customer builds.
- **Trade-off / follow-ups:** native drivers are still hand-wired from env in
  `bootstrap.ts` — full auto-instantiation from installed manifests (closing the
  manifest↔runtime gap) is a larger follow-up; cloud subscription sync and the dealer
  portal are scaffolded by the provider model but not yet built; the Flutter app has
  the licensing surface but not yet the full Driver Manager (web-homeowner does).

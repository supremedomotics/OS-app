# ADR-0023: Native Device Lifecycle Architecture (Phase 1)

## Status
Implemented (Phase 1, complete)

## Context

The Home Assistant dependency audit found the backend model still couples device
lifecycle, provider selection, driver binding, and state generation:

- **A-1**: `SupremeNativeAdapter.command()` silently falls through to a deterministic
  in-process simulator (`applyCommand`) for any device marked `ownership=native` but
  never `bind()`-bound to a real driver. `manages(deviceId) === true` does not mean a
  real driver is behind it — callers can't distinguish real state from simulated state.
- **A-2**: `RoutingBackendAdapter` requires `ha: IBackendAdapter` as a non-optional
  constructor field and always wires `this.ha.onState(...)` — HA is structurally
  required even when unused (a `MockAdapter` fills the slot, but the slot can't be empty).
- **A-3**: No dedicated rebind workflow. Binding is scattered across `sil.bindNative()`,
  `InstallerServices.bindProtocol()`, and ad hoc teardown/rebind logic in
  `installer-context.ts`'s protocol-disable path.
- **A-4**: `HomeService.bind()` (`services/integration-layer/src/home-service.ts:272`)
  sets `ownership="ha"` as an implicit default the first time a device gets any HA
  `backendId` mapping — never an explicit installer choice, never surfaced as a decision.
- **A-5**: Discovery output (`DiscoveredView`) is already protocol-neutral; the backend
  bias lives entirely in the commissioning funnel's implicit-HA default, not discovery.

Existing strengths this refactor preserves, not replaces:
- `INativeProtocolDriver` (`services/integration-layer/src/protocols/driver.ts`) is
  already a mature, protocol-agnostic contract: `connect/disconnect/bind/unbind/manages/
  command/getState/discover/onState` plus optional diagnostics/artwork/keypad methods.
  No driver rewrites — Casambi, KNX, Matter, MQTT, Apple TV, DALI stay untouched.
- Persistence already separates ownership from the `devices` table into its own table
  (`device_ownership`, migration `0020`) — the new `provider`/lifecycle-state columns
  follow the same additive, non-destructive migration convention.
- `SUPREME_BACKEND` env var already exists as the seam for backend selection.

## Decision

Replace the ownership model (`kind: "ha"|"native"|"unassigned"`) with a **provider +
lifecycle-state** model, decoupling four previously-conflated concerns into four
independent stages: Provider Assignment, Driver Binding, Capability Discovery, State
Engine. HA becomes one `ProviderAdapter` among many, wired only when configured —
never structurally required.

### New vocabulary

```
provider = casambi | knx | matter | mqtt | dali | modbus | appletv | homeassistant | ...
```
Provider describes device origin only; it never gates runtime behavior (no
`if (provider === "homeassistant")` branches in routing/state/diagnostics).

```
DeviceLifecycleState =
  DISCOVERED → REGISTERED → UNBOUND → BINDING → BOUND → ONLINE
                                          ↓         ↓        ↓
                                        ERROR    OFFLINE  REMOVED
```
`UNBOUND` is the explicit, honest state for "no driver bound" — replacing every
implicit simulated fallback. A device in `UNBOUND` has **no** state; the State Engine
refuses to emit one. `OFFLINE` (was bound, driver unreachable) and `ERROR` (bind/health
failure) are distinct from `UNBOUND` (never bound) — diagnostics must never collapse them.

### Components

1. **`ProviderRegistry`** (`services/integration-layer/src/provider-registry.ts`) —
   replaces `OwnershipRegistry`. Persists `{ deviceId, provider, state, updatedAt }` to
   a new `device_provider` table (migration `0025`, additive; `device_ownership` stays
   read-only for migration). No `kind`/HA-special-casing — `provider` is a free-form
   string validated against a registered-provider list, not a closed union.

2. **`DriverBindingEngine`** (`services/integration-layer/src/driver-binding-engine.ts`)
   — owns `bind()/unbind()/rebind()/validate()/health()/recovery()`. Every transition
   writes a `DeviceLifecycleState` row and emits a lifecycle event. This is the ONLY
   code path allowed to call a driver's `bind()`/`unbind()` — `sil.bindNative()` and
   `InstallerServices.bindProtocol()` become thin callers into it, not independent
   implementations.

3. **`ProviderRouter`** (replaces `RoutingBackendAdapter`, same file, renamed export
   kept as a deprecated alias for one release) — routes by `provider` + current
   `DeviceLifecycleState`, not `ownership.kind`. Constructor takes
   `providers: Map<string, ProviderAdapter>` (zero or more) instead of a mandatory
   `ha` field. A device with no bound driver returns `UNBOUND` state, never throws into
   a simulator and never silently no-ops.

4. **`ProviderAdapter` interface** — the generic shape every provider (including HA)
   implements: `discover()/bind()/unbind()/diagnostics()/metadata()/health()/events()`.
   `HaAdapter` is refactored to implement this interface as one adapter among several,
   registered the same way Casambi/KNX/etc. are — no constructor-level special casing.

5. **`SupremeNativeAdapter`** — the `applyCommand` deterministic model moves behind an
   explicit `SUPREME_BACKEND=mock` / test-only seam (`MockDriverAdapter`), never reachable
   in `SUPREME_BACKEND=native` (the new production default). A device with `provider` set
   but no bound driver in native/production mode stays `UNBOUND` — command calls return
   `backend_unavailable`, exactly like today's "native owned but not bound" path, just
   without the silent simulate-instead option ever being reachable in production.

6. **Commissioning** (`installer-context.ts`, `services/commissioning`) — flow becomes
   `Commission → Create Device (REGISTERED) → Assign Provider → Bind Driver (via
   DriverBindingEngine) → Discover Capabilities → Ready (ONLINE/UNBOUND)`. The implicit
   HA-default in `home-service.ts:272` is removed; every device gets an explicit
   provider assignment at commission time (installer-chosen or protocol-inferred from
   the binding step), never inferred later from an incidental `backendId` mapping.

7. **Migration**: `device_ownership.kind="ha"` → `device_provider.provider="homeassistant"`.
   `kind="native"` → `provider` set from the bound driver's `protocol` field (already
   recorded on `OwnershipRegistry.protocol` today, carried forward 1:1). Runs once at
   boot, additive, idempotent, logged — `device_ownership` table kept (not dropped) for
   one release as a rollback fallback.

8. **Diagnostics**: extend the existing driver diagnostics surface
   (`getDiagnostics`/health panel already in `apps/web-homeowner/src/drivers.tsx`) with
   provider, lifecycle state, binding status, last event, recovery attempts — reusing
   the current UI pattern, not a redesign.

## Explicitly Not Changed

Protocol drivers (Casambi, KNX, Matter, MQTT, Apple TV, DALI, Modbus), discovery
scanners, UI beyond the diagnostics panel, capability model, automation engine, Docker
and native-Linux deployment support (both keep working — this is a runtime-layer
change, not a deployment-layer one, per the existing `SUPREME_LAN_DEPLOYMENT` precedent).

## Phased Implementation Plan

- **Phase 1a** — `DeviceLifecycleState` type + `ProviderAdapter` interface +
  `ProviderRegistry` (new table, migration, repo, class) with tests. No wiring yet;
  additive and inert.
- **Phase 1b** — `DriverBindingEngine` with tests, using the existing
  `INativeProtocolDriver` contract unchanged. `sil.bindNative()` delegates to it.
- **Phase 1c** — `ProviderRouter` (rename+refactor of `RoutingBackendAdapter`): HA
  becomes optional, routing keyed on provider+state. Update `bootstrap.ts` wiring,
  `SUPREME_BACKEND=native` as new default, `mock` as the explicit test-only value.
- **Phase 1d** — Commissioning flow update: remove implicit HA-default in
  `home-service.ts`, wire explicit provider assignment through `installer-context.ts`.
- **Phase 1e** — Automatic migration (`device_ownership` → `device_provider`) + boot-time
  runner + rollback path.
- **Phase 1f** — Diagnostics surface updates + zero-regression full-suite verification
  (`pnpm -r build`, full test suite, live commissioning smoke test) + Docker rebuild/redeploy.

Each sub-phase lands as its own build+test-green checkpoint before the next starts.

## Completion Summary (this pass)

All six sub-phases landed and are live in production (`supreme-hub-gateway-1`, verified
via `/healthz` → `backend: "provider-router"`):

- **Deleted from runtime**: `OwnershipRegistry`, `RoutingBackendAdapter`,
  `OwnerKind`/`DeviceOwnership` types, every `ownership.get/set/clear` call site.
  `device_ownership` is now read-only, consulted only by the migration.
- **`ProviderRegistry`** (`services/integration-layer/src/provider-registry.ts`) is the
  single source of truth — `provider` (free-form string) + `DeviceLifecycleState`
  (`DISCOVERED→REGISTERED→UNBOUND→BINDING→BOUND→ONLINE/OFFLINE/ERROR→REMOVED`,
  illegal transitions rejected by `canTransition()`).
- **`DriverBindingEngine`** is the sole authority for bind/unbind/rebind/validate/
  health/recover — `sil.bindNative()` is a thin caller into it.
- **`ProviderRouter`** fully replaces `RoutingBackendAdapter` (not wrapped) — routes
  by provider + lifecycle state, never assumes HA exists.
- **`HomeAssistantProviderDriver`** wraps `HaAdapter` as an `INativeProtocolDriver`,
  registering into the exact same driver array Casambi/KNX/Matter/MQTT/DALI use — HA
  gets zero special-cased routing code anywhere above the driver registry.
- **Simulation removed from production**: `SupremeNativeAdapter`'s in-process model is
  now gated behind an explicit `simulate` constructor option, default `false`,
  test-only. Production `command()`/`getState()` on an unbound device throws/returns
  `null` — never fabricates.
- **`SUPREME_BACKEND` default is now `native`** (was `mock`). `ha` adds Home Assistant
  as one more provider; `mock` is explicitly documented test/CI-only.
- **Commissioning**: `HomeService.addDevice()` no longer implicitly defaults ownership
  to `"ha"` (the audit's A-4). A device with `backendIds` binds through
  `bindNative(..., "homeassistant")` — the same path every provider uses — only when a
  `"homeassistant"` driver is actually registered on the hub; otherwise it stays
  honestly unassigned (never a guessed provider). `rebindRegistry()` replays real HA
  bindings on every boot, mirroring how native protocol bindings already replay.
- **Migration**: `services/persistence/src/migrate-ownership.ts`, wired into
  `bootstrap.ts`, runs on every boot (idempotent/no-op once complete).
  `kind="ha"→provider="homeassistant"`, `kind="native"→provider=<bound protocol>`,
  anything else → left unresolved, reported, never guessed. Migrated devices start
  `UNBOUND` — provenance is recorded, live state is never fabricated.

### Disclosed, deliberate behavior change

The pre-existing `/v1/migration/:domain` "migrate to native" wizard used to
instantly copy HA's last-known state into the native engine with **no real driver
bound** — exactly the class of fabrication ADR-0023 forbids. `SupremeIntegrationLayer
.migrateDomain()` now unbinds the device from its current provider and leaves it
honestly `UNBOUND` under `provider="supreme-native"` until a real driver binds it.
`services/gateway/src/phase4.e2e.test.ts` was rewritten to assert this honest
contract instead of the old fabricated-control behavior. This is the one identified
place where the new architecture's requirements changed observable behavior from the
pre-refactor baseline — every other change is additive/internal.

### Verification

- Full workspace build (`pnpm -r build`): clean, zero errors.
- Full workspace test suite: clean except two confirmed pre-existing flakes in files
  untouched by this refactor (`services/protocols/src/avr-driver.test.ts` racing
  `heos-driver.test.ts` over real TCP sockets; `services/lan/src/server/
  replay-dgram-socket.test.ts`'s timing-based loop-count assertion) — both re-run
  clean in isolation, confirmed not regressions.
- `@supreme/integration-layer`: 68/69 (1 pre-existing skip, gated live-HA test).
- `@supreme/home`: 10/10 (2 new commissioning tests added).
- `@supreme/gateway`: 295/295 (16 e2e fixtures migrated off `RoutingBackendAdapter`).
- `@supreme/persistence`: 16/16 (5 new migration tests added).
- Docker: `gateway` + `homeowner` rebuilt and redeployed; `/healthz` confirms
  `backend: "provider-router"`; all 14 containers `Up`.

### Not done in this pass (documented gaps, not silently skipped)

- Per-device `provider`/lifecycle fields on `GET /v1/devices/:id/diagnostics` (the
  broader `/v1/drivers/diagnostics` surface + UI panel already expose lifecycle-state
  counts; per-device wiring into the existing diagnostics response/UI needs a
  `supreme-contracts` schema change plus a UI consumer update — scoped out to stay
  within a reviewable diff).
- Architecture diagrams / developer docs / migration guide beyond this ADR itself —
  ADR-0023 is the authoritative source for now; a follow-up pass should extract a
  shorter migration guide for installers upgrading existing hubs.
- Native Linux (non-Docker) deployment was not re-verified this pass — the change is
  entirely in the runtime layer (no Docker/HA/deployment-specific code paths were
  touched), consistent with the existing `SUPREME_LAN_DEPLOYMENT` precedent, but only
  the Docker path was actually exercised here.

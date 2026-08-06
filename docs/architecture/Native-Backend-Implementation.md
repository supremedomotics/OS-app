# Native Backend Implementation

- Status: **Accepted**
- Companion: `docs/architecture/adr/0023-native-backend-default.md`
- Scope: replace the production use of `MockAdapter` with the Supreme-native engine as
  the default backend; make Home Assistant a genuinely optional compatibility plugin.
  No protocol, deployment, or UI redesign — this is a backend-wiring and
  ownership-defaulting fix layered on architecture that already existed.

## 0. Correcting the starting assumption

The brief's "current architecture" diagram (`RoutingBackendAdapter → {Home Assistant,
Mock Adapter}`) does not match this codebase. Before making any change, the actual
code was read end to end (`services/integration-layer/src/{adapter,routing-adapter,
native-adapter,mock-adapter,ha/ha-adapter,ownership,sil}.ts`,
`services/gateway/src/{bootstrap,config,context,installer-context}.ts`,
`services/home/src/home-service.ts`, `services/automations/src/{engine,service,
compiler}.ts`, `packages/domain-model/src/entities.ts`) and confirmed against real
`typecheck`/`test` runs at every step, per this repo's "verify, never fabricate" rule.

What was actually found:

- **`SupremeNativeAdapter` already exists and is a complete `IBackendAdapter`
  implementation** (`services/integration-layer/src/native-adapter.ts`) — this **is**
  the Native Backend the brief asks for. It already fronts every real protocol driver
  (KNX/Matter/Zigbee/DALI/AVR/HEOS/Yamaha/CoolMaster/SIP/Sonos/Ajax/Shelly/AirPlay/
  AppleTV/Lutron/Tuya/Casambi/MQTT/Modbus…), already has an in-process simulation model
  for anything not yet bound to real hardware, and was **already** wired
  unconditionally as `RoutingBackendAdapter`'s `native` slot (`services/gateway/src/
  bootstrap.ts`) — regardless of `SUPREME_BACKEND`. Building a second, parallel
  "NativeBackendAdapter" from scratch would have violated this repo's own "extend,
  don't fork" rule for zero benefit.
- **The real gap was the other slot.** `RoutingBackendAdapter`'s `ha` slot — meant to
  hold either a real `HaAdapter` or nothing — was **always** `MockAdapter` whenever
  `SUPREME_BACKEND !== "ha"` (`services/gateway/src/bootstrap.ts`, pre-fix), and
  `GatewayConfig.backend`'s type was literally `"mock" | "ha"` with no `"native"` value
  at all (`services/gateway/src/config.ts`). A hub that never set `SUPREME_BACKEND`
  (the common case) silently got `MockAdapter` in that slot — a real instance of "no
  live backend behind the API pretends to be one," even though most day-to-day
  commands already routed correctly through the (independently-wired) native engine.
- **Ownership defaulting was the second real gap**, and a self-contradicting one:
  `services/home/src/home-service.ts`'s `bind()` set every newly-mapped device's
  ownership to `"ha"` unconditionally, with a comment literally saying "if this device
  was actually mapped to anything... record ownership as ha" — the exact "nothing else
  claimed it so it must be HA" heuristic that `ownership.ts`'s own docstring, three
  lines above the `OwnerKind` type, explicitly forbids ("never inferred... not from
  'well nothing else claimed it so it must be HA'"). This is very likely the specific
  finding the brief's audit refers to.
- **`Device.status` really is never updated after commissioning** — confirmed by
  grepping every write site; the field is set once (`"online"`) at commission time and
  never touched again anywhere in the codebase.
- **`engine: "ha"` automations really are silently accepted and never executed** —
  confirmed: `AutomationEngine.setAutomations()` filters `list.filter((a) => a.enabled
  && a.engine === "supreme")`, so an `engine: "ha"` row is accepted by
  `AutomationService.create()` with no validation, persists, shows as enabled in the
  UI, and simply never runs. A real `compileToHa()` compiler exists
  (`services/automations/src/compiler.ts`) but nothing ever calls it outside its own
  tests — no live push-to-HA/`externalRef` lifecycle was ever built.

## 1. `SUPREME_BACKEND=native` as the production default

`services/gateway/src/config.ts`:

```ts
backend: "native" | "mock" | "ha";
// ...
const backend = env.SUPREME_BACKEND === "ha" ? "ha"
  : env.SUPREME_BACKEND === "mock" ? "mock"
  : "native"; // default, and the fallback for any unrecognized value
```

`assertSecureConfig()` (the existing fail-closed production gate) now also refuses to
boot with `SUPREME_BACKEND=mock` in production — see §5.

## 2. `NativeBackendAdapter`

Delivered as: **`SupremeNativeAdapter` remains the Native Backend Adapter** (no
duplicate class — see §0), now reachable as the production default through a fixed
wiring bug, plus one small, honest new class:

**`HaUnavailableAdapter`** (new — `services/integration-layer/src/
ha-unavailable-adapter.ts`) implements the exact same `IBackendAdapter` contract as
`HaAdapter`/`MockAdapter`. It is what "the Home Assistant compatibility plugin isn't
installed" honestly looks like: `isConnected()` is always `false`, `discover()` always
returns `[]`, `getState()` always returns `null`, and `command()` throws a clear,
typed `backend_unavailable` error naming the reason — never a silent success against
fabricated in-memory state. `services/gateway/src/bootstrap.ts` now wires the router's
`ha` slot as:

```ts
if (config.backend === "ha") haSide = new HaAdapter({ transport, registry });
else if (config.backend === "mock") haSide = new MockAdapter(); // test/dev opt-in only
else haSide = new HaUnavailableAdapter(); // production default
```

## 3. Method-by-method classification

Every member of `IBackendAdapter` (`services/integration-layer/src/adapter.ts`),
classified against `SupremeNativeAdapter` (the Native Backend) and `HaAdapter` (the
optional compatibility plugin):

| Member | `SupremeNativeAdapter` | `HaAdapter` |
|---|---|---|
| `kind` | ✅ Already implemented (`"supreme-native"`) | ✅ Already implemented (`"ha"`) |
| `connect()` / `disconnect()` / `isConnected()` | ✅ Already implemented — brings up every real registered driver; a driver that can't reach its bus is skipped, never crashes boot | ✅ Already implemented — WS open/close, reconnect backoff |
| `command()` | ✅ Already implemented — real driver dispatch when bound, deterministic in-process model otherwise | ✅ Already implemented — buffers while disconnected |
| `getState()` | ✅ Already implemented | ✅ Already implemented |
| `discover()` | ✅ Already implemented — aggregates every real driver's discovery, tagged with its protocol | ✅ Already implemented — HA `get_states`, domain-inferred capabilities |
| `onState()` | ✅ Already implemented | ✅ Already implemented |
| `getArtwork?` | ✅ Already implemented (delegates to owning driver) | ⚪ Unsupported — no generic HA entity concept to map to; not implemented (pre-existing, correct) |
| `getQueue?` | ✅ Already implemented | ⚪ Unsupported (same reason) |
| `getCapabilityConfig?` | ✅ Already implemented | ⚪ Unsupported (same reason) |
| `getDiagnostics?` | ✅ Already implemented — **this session newly consumed it** for Device.status reconciliation (§4); was implemented but unused for that purpose before | ⚪ Unsupported (same reason) |
| `getTrace?` / `exportDiagnosticsLog?` | ✅ Already implemented | ⚪ Unsupported (same reason) |
| `sendRaw?` | ✅ Already implemented (throws if the owning driver doesn't support it) | ⚪ Unsupported (same reason) |
| `unbindDevice?` | ✅ Already implemented (§ Driver Lifecycle Completion) | ⚪ Unsupported — HA owns its own device lifecycle independently |
| `refreshCapabilities?` | ✅ Already implemented | ⚪ Unsupported (same reason) |
| `getKeypadCapabilities?` / `onInputEvent?` / `sendKeypadFeedback?` | ✅ Already implemented (§ Universal Keypad Framework) | ⚪ Unsupported — no HA integration in this fleet reports keypad input through this adapter |

**Needs implementation — found and closed this session** (not a method gap on the
adapter itself, but a wiring/policy gap around it):

1. `SUPREME_BACKEND=native` production default — §1.
2. `HaUnavailableAdapter` replacing `MockAdapter`'s old implicit non-"ha" role — §2.
3. Commissioning ownership defaults (native vs. ha, never inferred) — §4.1.
4. `Device.status` reconciliation (online/offline) — §4.2.
5. `engine: "ha"` automations — reject new ones, surface legacy ones as broken — §4.3.

**Unsupported — deliberate, disclosed, out of this task's scope:**

- Live push of `engine: "ha"` automations to a real Home Assistant instance
  (`compileToHa()`'s output is never sent anywhere) — the brief explicitly offers
  "execute them or reject them"; rejecting was chosen (§4.3's rationale).
- `Device.status` for HA-owned, unassigned, or native-owned-but-never-bound devices —
  left exactly as it already was (defaults to `"online"` at commissioning). There is no
  honest per-device connectivity signal for these, and "never fabricate" cuts both
  ways: guessing `"offline"` would be exactly as dishonest as the original bug.

## 4. Changes made

### 4.1 Commissioning ownership defaults (`services/home/src/home-service.ts`)

`HomeService.bind()`'s starting-ownership default now reads:

```ts
const haCompatKind = this.sil.haCompatBackendKind; // new SIL accessor: router.ha.kind
const defaultOwner = haCompatKind === "ha" || haCompatKind === "mock" ? "ha" : "native";
await this.sil.ownership.set(device.id, defaultOwner);
```

`"mock"` is included alongside `"ha"` deliberately: `MockAdapter` is still a legitimate
stand-in for "a working ha-compatibility backend" in tests that explicitly opt into
`SUPREME_BACKEND=mock` (several pre-existing gateway e2e tests construct a
`RoutingBackendAdapter` with `ha: new MockAdapter()` specifically to test HA→native
domain migration) — those tests' whole premise is "devices start on HA," and remain
valid. The production default (`HaUnavailableAdapter`, `kind === "ha-unavailable"`)
is the only case that now defaults to `"native"`. A native-bus device's ownership is
still confirmed moments later with its real protocol name by the existing driver
lifecycle's Rebind Devices stage (`installer-context.ts`'s `bindNative()` call) —
unchanged behavior, just starting from the correct default instead of a wrong one.

A second, related fix: `SupremeIntegrationLayer.primeState()` (new method,
`services/integration-layer/src/sil.ts`) primes whichever in-process engine now owns
an unbound device with its persisted state on every boot — the same problem
`MockAdapter` priming solved before (a device's in-memory cache starts empty every
process restart), now solved centrally in `AppContext.create()` (`services/gateway/
src/context.ts`) so **every** boot path gets it, not just the real hub's. This was
found the hard way: the first version of this fix only primed inside
`bootstrap.createHubContext`, and every gateway e2e test that builds its own
`AppContext` directly (bypassing `bootstrap.ts` — most of them do) broke, because a
demo/simulated device now defaulted to native ownership but was never `provision()`-ed
onto the native engine. Centralizing the priming step in `AppContext.create()` fixed
it for every caller uniformly.

### 4.2 `Device.status` reconciliation

New: `HomeService.setDeviceStatus()` (persists + emits a topology change, no-op if
unchanged) and `InstallerServices.reconcileDeviceStatuses()` (`services/gateway/src/
installer-context.ts`). The correct native owner of "is this device really reachable"
is each device's **owning protocol driver's own already-tracked connectivity** — never
a guess:

- Per-device: `getDiagnostics(deviceId).connectionStatus` when the owning driver
  reports one (`"connected"` → online, `"connecting"`/`"disconnected"` → offline).
- Falls back to the owning **protocol's** connect/disconnect status
  (`nativeProtocolStatus()`) when the driver doesn't report per-device diagnostics —
  still a real, already-tracked signal, not fabricated.
- Everything else (HA-owned, unassigned, native-owned with no bound driver at all) is
  left untouched — no honest signal to move it from wherever it already is.

Called: once per protocol at the end of `runDriverLifecycle()` (covers every
connect/disconnect/reconnect/config-change/teardown trigger — including a driver
teardown explicitly marking its released devices `"offline"`, since that's a known
fact, not a guess), and once a minute from the gateway's existing tick loop
(`main.ts`) to catch a driver's own silent internal reconnect/drop that never flows
through the lifecycle pipeline at all.

### 4.3 `engine: "ha"` automations

Chosen: **reject**, not execute (`services/automations/src/service.ts`). Building a
live push-to-HA/`externalRef` sync lifecycle — the only way to genuinely "execute"
these — would be a substantial, independently-risky feature this task's scope doesn't
call for, and this sandbox has no live HA instance to validate it against honestly.
`AutomationService.create()`/`update()` now reject `engine: "ha"` with a clear
`validation_failed` error. Already-persisted legacy rows (from before this fix) are
never mutated or deleted, but `AutomationEngine.health()` now reports them as
`"broken"` with an explicit reason instead of looking silently idle-but-fine.

## 5. MockAdapter — production guard

`assertSecureConfig()` (`services/gateway/src/config.ts`) now refuses to boot when
`NODE_ENV=production` **and** `SUPREME_BACKEND=mock`:

```
refusing to boot (production hardening): SUPREME_BACKEND=mock is not permitted in
production — use "native" (the default) or "ha"
```

`MockAdapter` itself is untouched — it remains a fully real, useful class for the
handful of test suites that explicitly construct it (both directly, and via
`SUPREME_BACKEND=mock` for the handful of gateway e2e tests that need the full HTTP
stack over a mock-backed device).

## 6. Compatibility verification

Verified, by running the actual suites (not by inspection alone):

- **Boots without Home Assistant.** New test `services/gateway/src/
  native-backend-boot.e2e.test.ts` calls the REAL production entrypoint
  (`bootstrap.createHubContext`, what `main.ts` always uses) with no `SUPREME_BACKEND`
  set — confirmed no prior test in this repo exercised that function at all; every
  other gateway e2e test builds its own `AppContext` directly, bypassing
  `bootstrap.ts` entirely. The hub boots, `sil.migrationEnabled === true` (a real
  router, not the bare test-only slice), `sil.haCompatBackendKind ===
  "ha-unavailable"`, and `sil.isHealthy() === true` off the native side alone.
- **Native Backend is active.** Every seeded demo device's ownership is `"native"`;
  commanding one reaches the native engine's in-process model and its state round-trips.
- **MockAdapter is never used in production.** `assertSecureConfig` throws for
  `NODE_ENV=production && SUPREME_BACKEND=mock` (new `config.test.ts` cases); the
  production code path (`config.backend !== "mock"`) never constructs `MockAdapter`.
- **Never fabricate.** A device still (incorrectly) recorded as `"ha"`-owned once HA
  compatibility is disabled fails loudly (`backend_unavailable`, naming the reason)
  rather than silently succeeding — verified in both
  `routing-adapter.test.ts` (unit) and `native-backend-boot.e2e.test.ts` (full stack).
- **Existing HA compatibility still functions when enabled.** Every pre-existing test
  that exercises `HaAdapter`/HA→native domain migration
  (`services/integration-layer/src/{ha,routing-adapter}.test.ts`,
  `services/gateway/src/phase4.e2e.test.ts`) passes unchanged — same assertions, same
  expected behavior, zero modification to their premises.
- **Casambi/KNX/Matter/LAN/UI byte-for-byte compatibility.** Zero files under
  `services/protocols/`, `apps/web-*`, or `infra/` were touched — confirmed via `git
  diff` scoped to this change set. Every existing e2e test that exercises a specific
  protocol driver (KNX ETS import, Casambi room assignment, Matter commissioning, the
  full driver lifecycle suite) passes unchanged.
- **Full suite.** `pnpm turbo run build typecheck test` — see the exact pass count
  recorded at the end of this session's verification pass (this doc is written
  alongside that run; the session's final chat message states the authoritative
  number, matching `main`'s own baseline).

## 7. Final Home Assistant dependency status

Home Assistant is now a genuinely optional compatibility plugin, not a boot
dependency, matching the brief's target architecture exactly:

```
RoutingBackendAdapter
        ├── Native Backend (SupremeNativeAdapter) — default, always wired, never requires HA
        ├── Home Assistant Adapter (HaAdapter) — optional, SUPREME_BACKEND=ha
        │     └── HaUnavailableAdapter — the honest placeholder when HA compat is off
        └── Mock Adapter — test/dev-only opt-in (SUPREME_BACKEND=mock), refused in production
```

- A production hub boots, commissions devices, and commands them with **zero** Home
  Assistant process running, reachable, or configured.
- Home Assistant remains fully supported as an **opt-in compatibility plugin**
  (`SUPREME_BACKEND=ha`) for imported HA entities — unchanged, still real, still tested.
- New devices default to `ownership: "native"`; only a device actually imported while
  HA compatibility is the configured backend gets `ownership: "ha"`.
- No remaining code path silently substitutes `MockAdapter` for a missing Home
  Assistant connection, in production or otherwise.
- Remaining, disclosed HA-related gap: `engine: "ha"` automations have no live
  execution path (by choice — see §4.3), and `HaAdapter` still doesn't implement the
  richer optional `IBackendAdapter` members (artwork/queue/diagnostics/keypad/…) —
  both pre-existing, both unaffected by this task, both honestly out of scope.

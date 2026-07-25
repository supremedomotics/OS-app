# ADR 0017 — Universal Intent & Capability Engine (Phase 2)

- Status: **Accepted**
- Date: 2026-07-21
- Context: ADR 0001 (Supreme Integration Layer), ADR 0005 (native automation engine),
  ADR 0016 (Universal Keypad Framework, Phase 1). Invariant **I1**: fully offline —
  nothing in this engine has an internet dependency.

## Context

Phase 1 (ADR 0016) gave every keypad a protocol-independent input pipeline, but a
`KeypadMapping`'s action still named a concrete `deviceId` + a concrete
`CapabilityCommand` (`device_command`) — correct and protocol-independent, but not
yet **device-independent**. Replacing a KNX dimmer with a Casambi one still means
the mapping keeps working (same `deviceId`, same capability), but there was no way
to say "this button means ToggleLight, whatever device that resolves to" — no
semantic layer above the raw command, no way for a future AI/marketplace template
to say "Movie Mode" instead of enumerating device ids.

Phase 2's brief: "completely decouple user interactions from drivers." The flow
must become:

```
Physical Keypad → Universal Input Event → Universal Intent → Capability Engine →
Best Device Capability → Driver Adapter → Physical Device
```

not `KNX Button → KNX Driver → KNX Light`.

## Decision

### Intent is additive to the existing Automation DSL, not a parallel engine

The single highest-leverage decision in this phase: `AutomationAction`
(`packages/domain-model/src/automations-dsl.ts`) gained ONE new discriminated-union
variant, `{ type: "intent", intentId, target, params }`, alongside the existing
`device_command`/`scene_activate`/`notify`/`delay`. Because `KeypadMapping.actions`
already reuses `AutomationAction` verbatim (ADR 0016's design), **every existing
consumer gained Intent support with zero additional schema or engine changes**:
`KeypadMappingService`'s zod validation, `KeypadMappingEngine`'s execution,
`AutomationEngine`'s execution, and `describeAutomationAction`'s run-trace summaries
all handle `"intent"` correctly the moment `runAutomationAction`'s switch grew one
case. This is the payoff of ADR 0016's reuse decision, not a coincidence — it is the
concrete proof that "never duplicate architecture" was the right call there.

`AutomationExecutors` (the interface both the Automation Engine and the Keypad
Mapping Engine already share) gained one new **optional** method:
`runIntent?(intentId, target, params): Promise<void>`. Optional so any existing
executor fixture/test that never constructs an `"intent"` action is unaffected;
`runAutomationAction`'s `"intent"` case throws a clear, honest error if invoked
without one wired, never a silent no-op. `compileToHa` (the `engine: "ha"` static
compilation path) honestly refuses to compile an `"intent"` action — intent
resolution is inherently dynamic (a runtime capability lookup), and there is no
static HA automation config that could express "resolve the best device for this
capability right now."

### The Intent Registry: a registry, not a closed enum

Because the brief demands the catalog be "extensible forever," `IntentDefinition`
(`packages/domain-model/src/intents.ts`) is pure, serializable metadata — no fixed
`z.enum` of every intent id that will ever exist. The actual catalog lives in a new
service, `@supreme/intent-engine`, as runtime `IntentRegistry.register()` calls —
public API, exactly like `DriverManifest`/the Driver Store let a new protocol appear
with no core-architecture change. `registerBuiltinIntents()` (`catalog.ts`) seeds 42
intents across all six brief-specified categories (lighting, climate, av, blinds,
security, system); a future driver, marketplace template importer, or AI module
calls the exact same `register()` to add more.

Each registration pairs the serializable `IntentDefinition` with EXECUTABLE
behavior that can't be serialized and so never leaves the server:
- **`translate`** (capability-driven intents): `(params, currentState,
  capabilityConfig) → CapabilityCommand`. Called once per resolved device.
- **`runSystem`** (system-level intents: `RunScene`, `RunAutomation`, `Arm`,
  `Notification`, …): the intent's entire behavior, dispatched directly.

`IntentRegistry.register()` validates the pairing matches `requiredCapabilities`
(capability-driven needs `translate`, system-level needs `runSystem`, never both)
**at registration time** — a catalog bug is a boot-time failure, never discovered
silently at the first real invocation.

### Capability Resolution: an index, not a scan

"Given Intent ToggleLight, discover every compatible device... no linear scans."
`CapabilityIndex` (`services/intent-engine/src/capability-index.ts`) indexes every
device by each capability it exposes (`Map<CapabilityKind, Set<DeviceId>>`), so
`devicesWithCapability`/`devicesWithCapabilityInRoom` are O(matching devices), never
O(every device on the hub) — two thousand devices costs the same as two. Kept in
sync incrementally via a new, additive `HomeService.onDeviceChanged()` event
(mirrors `SupremeIntegrationLayer.subscribe`/`NotificationService.onNotification`'s
exact shape) rather than the CapabilityIndex re-scanning `listDevices()` on every
lookup or the gateway hooking dozens of device-mutation call sites individually
(error-prone — easy to miss one and silently go stale).

### Target resolution: device, room, scene, automation, home

`IntentTarget` is a discriminated union. `device`/`room` targets resolve through the
`CapabilityIndex` (a room target hits EVERY matching device in that room — the
brief's "Movie Mode button dims every light in the room" case); `scene`/`automation`
targets dispatch directly to the existing `SceneService`/`AutomationService`; `home`
is for panel/system-scoped intents (Arm/Disarm/Panic/Notification/ExecuteScript/
Webhook) with no natural device/room/scene/automation to name — single-home-per-hub,
so no id is carried (mirrors `ctx.homeId` being implicit everywhere else).

### Honest gaps: registered, not fabricated

Two categories of built-in intent are registered (so the catalog is complete, per
the brief's example list) but honestly fail at execution:
- **`swingMode`/`tiltUp`/`tiltDown`**: `TemperatureState`/`PositionState` have no
  swing/tilt field — no schema change was made to invent one speculatively. Their
  `translate` handler always throws a clear, specific error.
- **`executeScript`/`webhook`**: SupremeOS has no script sandbox or outbound
  webhook dispatcher. Their `runSystem` handler always throws.

This is the same "visibly incomplete, never silently faked" discipline ADR 0015
already established for undocumented protocol gaps (no Denon feature-query
command, etc.) — applied here to intents with no backing implementation yet.

### Parameter validation, real and typed

`validateIntentParams` (`param-validation.ts`) checks every declared
`IntentParameterSpec` — required/type/min/max/enum-options — against the caller's
params (a keypad mapping, an automation, a direct REST call, a future AI
assistant), filling in declared defaults for anything omitted. Never trusts a
caller blindly regardless of source.

## Consequences

- **Zero breaking changes.** `AutomationAction` gained a variant (additive, matches
  ADR 0015's "MediaState gained fields" precedent); `ResourceType` gained
  `"intent"` (additive, `RolePolicy` is already `Partial`); `HomeService` gained one
  new optional-subscription method with no signature change to any existing method.
  Full monorepo `pnpm build` (56/56), `pnpm typecheck` (97/97), `pnpm test` (97/97
  tasks) — every pre-existing suite passing **unmodified**, including
  `@supreme/automations`' 39 tests (36 pre-existing + 3 new for the `"intent"`
  action), `@supreme/protocols`' 378, `@supreme/gateway`'s 240 (229 pre-existing +
  11 new).
- **The Automation Engine and Keypad Mapping Engine are untouched at the
  architecture level** — both gained Intent support purely by an additive schema
  variant + one new optional executor method, never a fork or parallel dispatch
  path.
- **Migration readiness is structural, not aspirational.** `IntentEngine.run()`
  never imports or references a protocol, driver, or `ProtocolKind` — it only ever
  sees `Device`/`CapabilityKind`/`CapabilityState`. Replacing a device's underlying
  driver changes nothing the Intent Engine does; `engine.test.ts`'s "migration
  readiness" test proves this directly (the same intent + target invocation against
  two different `executors.command` implementations, standing in for two different
  drivers, with identical results).
- **AI/template/marketplace-ready by construction.** `IntentDefinition` is plain
  JSON — safe to serve via `GET /v1/intents`, safe to embed in a future Luxury
  Villa/Apartment/Hotel/Office/Developer template file, safe to hand to a future AI
  assistant deciding what "Movie Mode" should do without any protocol knowledge.
- **No visual Intent/Mapping editor** — Phase 2 is backend architecture only, same
  scope discipline as Phase 1.
- **No Postgres persistence** for the Intent Registry (it's code-defined, not a
  user-editable record, so this doesn't apply the way it does to
  `KeypadMapping`/`KeypadSubscription`) — but `IntentEngine`'s run-history is
  in-memory only, same as `AutomationEngine`/`KeypadMappingEngine`.

New/changed files this ADR: `packages/domain-model/src/intents.ts` (+ test),
`packages/domain-model/src/automations-dsl.ts` (additive `"intent"` action
variant), `packages/domain-model/src/users.ts` (additive `"intent"` ResourceType),
`services/automations/src/{engine,compiler}.ts` (+ 3 new tests in `engine.test.ts`;
`compiler.ts`'s honest HA-compile rejection), `services/home/src/home-service.ts`
(additive `onDeviceChanged`), `services/permissions/src/roles.ts` (additive
baseline), new `services/intent-engine/` package (`capability-index.ts`,
`registry.ts`, `param-validation.ts`, `catalog.ts`, `engine.ts` + 5 test files, 48
tests), `packages/supreme-contracts/src/intents.ts`, `services/gateway/src/
{context,server}.ts` (additive wiring) + new `routes/intents.ts` + new
`intents.e2e.test.ts`.

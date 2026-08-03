# SESSION_HANDOFF.md

> Current development state. **Rewrite this at the end of every session** — it should describe
> what changed *since the previous handoff*, not the whole project history (that's
> `PROJECT_CONTEXT.md`). Keep it concise.

---

## Latest pass — Home Assistant Dependency Audit (analysis only, ZERO code changes)

A repository-wide audit of every remaining runtime dependency on Home Assistant, producing
`docs/architecture/Home-Assistant-Dependency-Audit.md` (10 phases: dependency discovery, runtime
graph, registry/automation/state/UI/driver audits, compatibility-layer design, migration roadmap,
readiness assessment). **No application code was modified, no HA code removed, no driver touched** —
the only file added is the audit document; `pnpm build`/`typecheck`/`test` remained fully cached
(56/56, 97/97, 97/97), proving nothing was disturbed.

**Headline findings (all evidence-cited in the doc):**
- HA-specific code is confined to **4 files** in `services/integration-layer/src/ha/`, with exactly
  **2 consumers** elsewhere — `bootstrap.ts` (conditional on `SUPREME_BACKEND=ha`) and
  `compiler.ts`'s `compileToHa`, which has **no runtime caller at all**.
- **Every protocol driver is 100% native** (zero HA references in `services/protocols/src/`), the
  **entire UI has zero HA calls**, and **every registry** (device/entity identity/room/floor/area/
  state/capabilities/history/statistics) is Supreme-owned.
- Only **6 of the brief's 20 HA subsystems** are genuinely used, all via one WebSocket connection
  plus a one-time onboarding HTTP flow.
- **SupremeOS already boots and fully functions with no HA process** — the entire 240-test gateway
  suite runs at `SUPREME_BACKEND=mock`.
- **The one real blocker:** there is no native-only backend mode. The router always has an `ha`
  side, which is either real HA or `MockAdapter` — **an in-memory simulator**. Turning HA off today
  doesn't remove the dependency, it silently replaces it with a fake. Now tracked as the top
  **Critical** item in `TODO.md`.
- Assessment: **architecturally ~90% HA-independent, operationally ~40%** — 1 Critical, 2 High,
  3 Medium, 2 Low blockers, all small and well-scoped (a third adapter mode, a compose profile, a
  dead-code decision), not a platform rewrite.

**Newly tracked in `TODO.md`:** the Critical native-mode blocker; 2 High (compose opt-in; the
`engine:"ha"` dead path); 2 Medium (unowned `Device.status` availability; commissioning defaulting
to `ownership="ha"`).

---

## Prior pass — Universal Intent & Capability Engine (Phase 2)

**Branch:** `claude/universal-keypad-framework-7khr2o`, based on `main` at session start (the
same branch Phase 1 shipped on — this session's branch instruction named
`feature/universal-keypad`, but the harness's assigned branch for this session takes precedence,
per this environment's git-safety convention). This session built the **Universal Intent &
Capability Engine, Phase 2** (ADR 0017), directly on top of the Universal Keypad Framework (ADR
0016) shipped last session — the brief's mission: completely decouple user interactions from
drivers, so `ToggleLight` keeps meaning the same thing forever even if the physical device behind
it changes from KNX to Casambi to Matter to anything else.

## What actually shipped

**The single highest-leverage decision**: `AutomationAction`
(`packages/domain-model/src/automations-dsl.ts`) gained ONE new additive variant — `{ type:
"intent", intentId, target, params }` — alongside the existing `device_command`/`scene_activate`/
`notify`/`delay`. Because `KeypadMapping.actions` already reuses `AutomationAction` verbatim (Phase
1's design), keypad mappings gained full Intent support with **zero** additional schema/engine
changes — direct payoff of Phase 1's reuse decision. `AutomationExecutors` gained one new optional
method, `runIntent?`, wired identically for both the Automation Engine and the Keypad Mapping
Engine (they already share one executor set). `runAutomationAction`/`describeAutomationAction`
(both previously extracted+shared, see Phase 1) grew an `"intent"` case; `compileToHa` (the
`engine: "ha"` static-compile path) honestly refuses to compile an intent action — intent
resolution is inherently dynamic, no static HA config can express it.

**New domain-model** (`packages/domain-model/src/intents.ts`, new + `intents.test.ts`):
`IntentDefinition` (pure, serializable metadata: id/name/category/description/
requiredCapabilities/parameters/targetKinds/version/i18nKey — future-proofed for AI/marketplace
consumption), `IntentTarget` (device/room/scene/automation/home, discriminated union).
Deliberately NOT a closed `z.enum` of every intent id — the catalog lives as runtime
`IntentRegistry.register()` calls, extensible forever with zero schema changes, mirroring how
`DriverManifest`/the Driver Store let a new protocol appear with no core-architecture change.

**New bounded service `@supreme/intent-engine`** (mirrors `@supreme/automations`/
`@supreme/keypad-framework`'s conventions — depends only on domain-model/contracts):
- `CapabilityIndex` — `Map<CapabilityKind, Set<DeviceId>>`, O(matching devices) lookup for
  `devicesWithCapability`/`devicesWithCapabilityInRoom`, never O(every device on the hub). Kept in
  sync via a new, additive `HomeService.onDeviceChanged` event (mirrors `SIL.subscribe`/
  `NotificationService.onNotification`'s exact shape) rather than re-scanning on every lookup or
  hooking dozens of device-mutation call sites individually.
- `IntentRegistry` — pairs each `IntentDefinition` with a `translate` (capability-driven: params +
  current state + capability config → `CapabilityCommand`) or `runSystem` (system-level: direct
  dispatch, no device resolution) handler, validated to match `requiredCapabilities` **at
  registration time**, not at first invocation.
- `validateIntentParams` — real required/type/min/max/enum-options validation + defaults, never
  trusting a caller (keypad, automation, direct REST, future AI) blindly.
- `registerBuiltinIntents` (`catalog.ts`) — 42 intents across all 6 brief-specified categories
  (lighting/climate/av/blinds/security/system). Two categories are honest, registered-but-throwing
  gaps: `swingMode`/`tiltUp`/`tiltDown` (no swing/tilt field in `TemperatureState`/`PositionState`
  yet) and `executeScript`/`webhook` (no script engine/webhook dispatcher exists) — same "visibly
  incomplete, never faked" discipline as ADR 0015's undocumented protocol gaps.
- `IntentEngine` — the Capability Engine itself: validate target kind → validate params → resolve
  device(s) via `CapabilityIndex` (or dispatch system-level directly) → translate → command →
  record an `IntentRun` trace (mirrors `AutomationRun`/`KeypadMappingRun`).
- 48 tests across 5 files, all passing, including a dedicated "migration readiness" test proving
  the identical intent+target invocation against two different `executors.command`
  implementations (standing in for two different drivers) behaves identically.

**Gateway wiring** (`services/gateway/src/{context,server}.ts`, new `routes/intents.ts`): the
`CapabilityIndex`/`IntentRegistry`/`IntentEngine` are constructed in `initWithHome()`, wired to the
SAME executors closures already built for automations/scenes/security/notifications; `runIntent`
added to the shared `AutomationExecutors` object. New REST surface (`GET /v1/intents`,
`GET /v1/intents/:id`, `POST /v1/intents/:id/run`, `GET /v1/intents/runs`,
`GET /v1/intents/:id/runs`), gated by a new additive `"intent"` `ResourceType` (baseline
permissions mirroring `"keypad_mapping"`'s per-role defaults). New `intents.e2e.test.ts` (11 tests)
proves the full pipeline over a real mock-backend hub: catalog listing, direct device-target
invocation, room-target multi-device resolution ("Movie Mode" pattern), param validation
(422 on missing required param), the honest `executeScript` failure (503), real security
arm/disarm dispatch, run-history retrieval, AND a keypad mapping whose action is `{type:"intent",
...}` driving a real device through the exact same Intent Engine a direct REST call uses.

**Documentation**: `docs/architecture/adr/0017-universal-intent-capability-engine.md`,
`docs/architecture/Universal-Intent-Capability-Engine.md` (architecture diagram, 4 sequence
diagrams — lifecycle/resolution/room-resolution/migration-readiness — Intent Registry spec,
capability resolution flow, driver integration spec, migration strategy, performance/scalability
analysis, public APIs, extension points, future roadmap). `PROJECT_CONTEXT.md` §4/§6 updated.

**Verification**: full monorepo `pnpm build` (56/56), `pnpm typecheck` (97/97), `pnpm test` (97/97
tasks) — all green, including every pre-existing suite passing **unmodified**
(`@supreme/automations`' original 36 tests + 3 new for the `"intent"` action = 39,
`@supreme/protocols`' 378, `@supreme/gateway`'s 229 pre-existing + 11 new = 240,
`@supreme/permissions`' 10, `@supreme/home`'s 8).

## What was deliberately NOT built (Phase 2 scope, per the brief)

- **No visual Intent/mapping editor** — backend architecture only, matching Phase 1's scope
  discipline.
- **No Postgres persistence** for anything new (the Intent Registry is code-defined, not a
  user-editable record, so this doesn't apply the way it does to `KeypadMapping`; `IntentEngine`'s
  run-history is in-memory only, same as the Automation/Mapping engines).
- **No swing/tilt capability-model addition** — `swingMode`/`tiltUp`/`tiltDown` are registered,
  honestly throwing intents, not a speculative schema change to invent the field.
- **No script engine or webhook dispatcher** — `executeScript`/`webhook` are registered, honestly
  throwing intents, not fabricated infrastructure.

## Known issues / open gaps

- `IntentEngine`'s `resolveDevices()` for a `room` target unions across every capability in
  `requiredCapabilities` — correct today (every built-in intent requires exactly one capability),
  but untested against a hypothetical future intent requiring more than one simultaneously (no such
  intent exists in the catalog yet, so this is a latent-but-unexercised path, not a known bug).
- `CapabilityIndex` has no idle-eviction — same documented, negligible-at-realistic-scale
  characteristic already accepted for `UniversalInputEngine`'s per-control timer map in Phase 1.
- The "Optional Variables" mechanism from Phase 1 (`expandVariables`) hasn't been exercised
  end-to-end with an `"intent"` action's `params` field yet (only with `device_command`'s nested
  `command` fields) — the underlying recursive JSON walk is generic and should just work, but no
  dedicated test proves `{{step}}` inside an intent action's `params`.

## Immediate priorities for the next session

1. Pick a real protocol from `Keypad-Driver-Author-Guide.md`'s list (Lutron remains the most
   natural first target — its LIP transport already exists) and do the actual spec-verification
   research pass before writing keypad-specific code, exactly as ADR 0015 did for AVR.
2. If a homeowner-facing "Movie Mode"-style scene/intent authoring surface is prioritized next,
   this is exactly the point where the visual Universal Keypad Editor (or an Intent-aware
   extension to the existing Automation Editor) becomes worth its own scoped session — the backend
   (Phase 1 + Phase 2) is now complete enough to build a real UI against.
3. Consider extending `KeypadMapping`'s `variables` test coverage to include an `"intent"` action's
   `params` field (see "Known issues" above) — small, low-risk, closes a coverage gap.
4. Everything from the prior (Phase 1) handoff not touched this session remains open — see
   `TODO.md` for the full backlog with priority tiers.

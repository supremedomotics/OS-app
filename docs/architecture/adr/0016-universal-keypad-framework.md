# ADR 0016 — Universal Keypad Framework (Phase 1: core framework)

- Status: **Accepted**
- Date: 2026-07-21
- Context: ADR 0001 (Supreme Integration Layer / native protocol driver seam), ADR
  0005 (native automation engine), ADR 0015 (Universal AVR Framework — the prior
  precedent for "extract the real shared seam, don't build a parallel stack").
  Invariant **I1**: the hub works fully offline — nothing in this framework has an
  internet dependency.

## Context

SupremeOS needed a way for ANY supported keypad (KNX push-button, Casambi keypad,
Lutron Pico, Matter switch, MQTT button, RTI keypad, Zigbee remote, BLE fob, DALI
push-button input unit, …) to control ANY supported device, without ever creating a
protocol-to-protocol mapping (KNX→KNX, Casambi→Casambi, …). The existing
`INativeProtocolDriver`/`IBackendAdapter`/`SupremeIntegrationLayer`/capability model
already solve exactly this problem for *device control* (a KNX dimmer and a Casambi
dimmer both expose `brightness` — nothing above the SIL knows or cares which
protocol drives them); this framework applies the identical discipline to *input*.

This is explicitly a **Phase 1: architecture only** brief — build the core seam
every future keypad driver plugs into, without implementing any real keypad driver
yet (no KNX/Casambi/Lutron/Matter/Zigbee/MQTT/RTI/BLE/DALI keypad driver ships in
this pass; see `docs/drivers.md` for what's real vs. planned).

## Decision

### Never protocol-to-protocol — the pipeline

```
Physical Input → Universal Input Event → Mapping Engine → Capability Engine → Target Driver → Target Device
Device State Change → State Engine → Universal Feedback Engine → All Compatible Keypads
```

Concretely, in this codebase's existing vocabulary: **State Engine = the SIL**
(`SupremeIntegrationLayer`, already the single seam for state), **Capability
Engine = the existing `CapabilityCommand`/`CapabilityState` model**
(`packages/domain-model/src/capabilities.ts`, untouched) — this framework does not
invent a second one. What's new is everything to the LEFT of "Capability Engine" on
the input side and everything to the RIGHT on the feedback side.

### New domain-model vocabulary (`packages/domain-model/src/keypad-*.ts`)

- **Keypad Capability Model** (`keypad-capabilities.ts`): `KeypadInputCapability`
  (buttons/long_press/double_press/triple_press/hold/rotary_encoder/swipe/gesture),
  `KeypadFeedbackCapability` (led/rgb_led/display/haptic/buzzer/
  brightness_feedback/icon_feedback/text_feedback), `KeypadControlDescriptor` (one
  physical button/encoder/touch-zone + which of the above it supports), and
  `KeypadCapabilityDeclaration` (a keypad device's full control list) — the exact
  same "advertise capabilities, never protocol" discipline as `CapabilityKind`,
  applied to input hardware.
- **Universal Input Event Definitions** (`keypad-events.ts`): `KeypadInputEvent`, a
  discriminated union covering `button_pressed`/`button_released`/`short_press`/
  `long_press`/`double_press`/`triple_press`/`hold_start`/`holding`/`hold_end`/
  `rotate_clockwise`/`rotate_counterclockwise`/`swipe`/`gesture`. `gesture` carries a
  free-string name specifically so a future vendor-specific gesture is a driver-side
  addition, never a schema change (future-proofing, per the brief).
- **Universal Feedback Definitions** (`keypad-feedback.ts`): `KeypadFeedbackCommand`
  — `led_on`/`led_off`/`led_color`/`led_brightness`/`display_text`/`display_icon`/
  `display_page`/`ring_brightness`/`ring_color`/`haptic_pulse`/`buzzer`.
- **Subscription Manager model** (`keypad-subscription.ts`): `KeypadSubscription`
  (deviceId+capability ↔ keypadId+control) — the brief's worked example ("Living
  Room Light subscribed by KNX/Casambi/Lutron/Matter") as data.
- **Mapping Engine Interface** (`keypad-mapping.ts`): `KeypadMapping` — Input
  (keypadId+control+event) → Conditions → Actions → Variables. **Deliberately reuses
  `AutomationCondition`/`AutomationAction` verbatim** from the existing, shipped
  Automation DSL (`automations-dsl.ts`, untouched) rather than re-declaring an
  equivalent shape: a keypad mapping's actions ARE automation actions (device
  command / scene activate / notify / delay), so "Optional Delays" is just a
  `"delay"` action already in that union — no new delay concept was invented.

### Extract-only, zero-behavior-change reuse (`condition-eval.ts`)

`evaluateComparator`/`readCapabilityField`/`isWithinScheduleWindow` were extracted
from `@supreme/automations`' `AutomationEngine` (previously private) into
`packages/domain-model/src/condition-eval.ts`, and `AutomationEngine` now imports
them instead of its own copies. This is a pure refactor — `AutomationEngine`'s own
7-test suite passes **unmodified** — done so the new Mapping Engine evaluates
`device_state`/`time_window` conditions identically instead of maintaining a second
copy of the same comparator. Likewise, `runAutomationAction`/
`describeAutomationAction` were extracted from `AutomationEngine`'s private
`runAction`/`describeAction` and exported from `@supreme/automations`, so the Mapping
Engine executes the exact same reused `AutomationAction` union through the exact
same dispatch code, not a re-implementation.

### Driver SDK Extension — three new OPTIONAL members, zero breaking change

Exactly like `getArtwork?`/`getCapabilityConfig?`/`getDiagnostics?` before it,
`INativeProtocolDriver` (`services/integration-layer/src/protocols/driver.ts`)
gained three more **optional** members:

```ts
getKeypadCapabilities?(deviceId): KeypadCapabilityDeclaration | null;
onInputEvent?(listener: (event: KeypadInputEvent) => void): () => void;
sendKeypadFeedback?(command: KeypadFeedbackCommand): Promise<void>;
```

`IBackendAdapter` gained the mirrored optional members. Every existing driver (all
22, including the 3 flagship AVR/HEOS/Yamaha drivers) implements none of them and is
**completely unaffected** — confirmed by the full pre-existing test suite passing
unmodified (`@supreme/protocols`' 378 tests, `@supreme/integration-layer`'s 51,
`@supreme/gateway`'s 229). `SupremeNativeAdapter`/`RoutingBackendAdapter`/
`SupremeIntegrationLayer` each got the same three-method pass-through, mirroring the
existing `getDiagnostics` plumbing exactly (native-first routing in the router,
honest `null`/thrown-`backend_unavailable` for an unbound keypad, never a silent
no-op that could mask a real bug).

### New bounded service: `@supreme/keypad-framework`

A new `services/keypad-framework/` package (mirrors `services/automations`'
layout/conventions exactly — package.json/tsconfig, engine + service + store +
index.ts barrel), depending only on `@supreme/domain-model`, `@supreme/contracts`,
`@supreme/automations` (for the shared executor/action-dispatch types), and
`@supreme/messaging` (for the canonical bus subject). It does **not** depend on
`@supreme/integration-layer` — exactly like `@supreme/automations` doesn't — so the
engines stay protocol/backend-agnostic by construction; the gateway composition root
(`context.ts`) is the only place that bridges them to the SIL.

- **`UniversalInputEngine`** (`input-engine.ts`) — the Universal Input Engine.
  `ingest(event)` passes semantic events (rotation/swipe/gesture, or a driver with
  its own onboard press-timing) straight through, and derives
  `short_press`/`double_press`/`triple_press`/`hold_start`/`holding`/`hold_end`/
  `long_press` from raw `button_pressed`/`button_released` pairs via one shared,
  per-(keypad,control) timing state machine — so no individual driver reimplements
  press-timing logic. A press crossing `longPressMs` fires BOTH the continuous
  `hold_start`→`holding`→`hold_end` stream (for press-and-hold behaviors like
  dim-while-held) AND a discrete `long_press` summary on release (for "long-press
  does one thing" mappings) — a deliberate design decision documented in the file
  itself, not an accident of two half-built features.
- **`UniversalFeedbackEngine`** (`feedback-engine.ts`) — the Universal Feedback
  Engine. `onDeviceState(event)` looks up every subscribed keypad control via the
  Subscription Manager, fetches (and caches, per fan-out) each keypad's real
  capability declaration, and renders feedback via the pure, exported
  `renderFeedback()` — **capability-gated**: a command is only ever emitted for a
  feedback type the control actually declared (never a fabricated LED update to
  hardware with no LED). One subscriber's send failure never aborts fan-out to the
  rest (`onError` callback, isolated per subscriber).
- **`SubscriptionManager`** (`subscription-manager.ts`) — indexed by
  `deviceId:capability` for O(subscribers) fan-out, not a scan of every subscription
  on the hub.
- **`KeypadMappingEngine`** (`mapping-engine.ts`) — the Mapping Engine's execution
  half. Mirrors `AutomationEngine`'s shape (same run-trace type, same
  condition-evaluation semantics) but fires on `onInputEvent(event)` instead of a
  device-state delta or clock tick.
- **`KeypadMappingService`** (`service.ts`) — CRUD + `expandVariables` (see below).
- **`expandVariables`** (`variables.ts`) — Optional Variables. Because
  `AutomationAction`'s zod schema enforces real numeric/boolean types, a
  `"{{name}}"` placeholder can never be stored in — or executed from — a concrete
  `KeypadMapping.actions` entry without breaking validation. So variable
  substitution happens exactly ONCE, at mapping create/update time: the caller
  submits raw JSON that may reference `variables` anywhere a literal would go
  (including nested fields, e.g. a `device_command`'s `command.level`);
  `expandVariables` walks that tree, and the RESULT is what gets zod-validated into
  the stored, concrete mapping. The engine itself never re-resolves a variable — see
  `variables.ts`'s doc comment for the full reasoning.

### Gateway wiring (`services/gateway/src/context.ts`, `routes/keypad.ts`)

Wired into `AppContext.initWithHome()` immediately after `AutomationService` is
built, **reusing the exact same `AutomationExecutors` object** already constructed
for the Automation Engine (a keypad mapping's actions run through the identical
command/activateScene/notify/getState closures — one "run a Supreme action"
implementation, not two). `onBackendState()` gained one line feeding
`UniversalFeedbackEngine.onDeviceState()`, mirroring the existing
`automations.onDeviceState()` call immediately above it. A new `subjects.keypadInput`
bus subject (`services/messaging`) mirrors `subjects.deviceState` for cross-process
fan-out. New routes (`GET/POST/PATCH/DELETE /v1/keypad/mappings*`,
`GET/POST/DELETE /v1/keypad/subscriptions`, `GET /v1/devices/:id/keypad-capabilities`)
mirror `registerPhase3Routes`' automation-CRUD shape exactly, gated by a new
`"keypad_mapping"` `ResourceType` (additive to the existing zod enum) with baseline
role permissions mirroring `"automation"`'s per-role defaults.

## Consequences

- **No protocol-to-protocol mapping is possible by construction.** A `KeypadMapping`
  can only ever reference an `AutomationAction` (which addresses a device purely by
  `CapabilityCommand`); nothing in the schema or the engine can express "when KNX
  group address X fires, write Casambi register Y."
- **Zero breaking changes.** Every existing driver, adapter, route, and test kept
  working unmodified — confirmed by the full monorepo `pnpm build` (55/55),
  `pnpm typecheck` (95/95), and `pnpm test` (95/95 task, including the pre-existing
  `@supreme/protocols` 378, `@supreme/integration-layer` 51, and `@supreme/gateway`
  229 suites all passing **unmodified**). The Driver SDK, Capability Model, Runtime
  Events/Objects (Automation DSL/Engine), ADRs 0001–0015, Device Cards, and UI
  architecture are untouched.
- **The Automation Engine is untouched, not forked.** `KeypadMapping` is a
  deliberately distinct resource (`"keypad_mapping"`, not `"automation"`) because a
  keypad mapping is installer commissioning work tied to physical bus wiring, not a
  homeowner-authored automation — but its actions/conditions execution is the SAME
  code (`runAutomationAction`/`describeAutomationAction`/`evaluateComparator`),
  extracted and shared rather than duplicated.
- **No real keypad driver ships in this pass** — by design (Phase 1 scope). See
  `docs/architecture/Keypad-Driver-Author-Guide.md` for exactly what a future
  KNX/Casambi/Lutron/Matter/Zigbee/MQTT/RTI/BLE/DALI keypad driver implements to
  plug into this seam, and `docs/architecture/Universal-Keypad-Framework.md` for the
  full architecture reference (diagrams, sequence diagrams, thread safety,
  scalability, migration/testing strategy).
- **Persistence gap, documented not silently skipped:** `IKeypadMappingStore`/
  `IKeypadSubscriptionStore` default to in-memory (mirroring
  `InMemoryAutomationStore`'s pattern exactly); no Postgres-backed repository was
  added in this pass (would require new `services/persistence`/`cloud/persistence`
  schema work, out of "architecture only" scope). See `TODO.md`.
- **No visual editor** — explicitly out of scope per the brief; the backend APIs
  above are what a future Universal Keypad Editor will call.

New/changed files this ADR: `packages/domain-model/src/{condition-eval,
keypad-capabilities,keypad-events,keypad-feedback,keypad-mapping,
keypad-subscription}.ts` (+ tests), `packages/domain-model/src/{ids,users,index}.ts`
(additive), `services/automations/src/engine.ts` (extract-only refactor, zero
behavior change), `services/automations/src/index.ts` (new exports),
`services/permissions/src/roles.ts` (additive baseline), `services/integration-layer/
src/{adapter,native-adapter,routing-adapter,sil,protocols/driver}.ts` (additive
optional members, mirroring the `getDiagnostics` pattern) + new
`protocols/keypad-extensibility.test.ts`, new `services/keypad-framework/` package
(engines/service/store + 6 test files), `packages/supreme-contracts/src/keypad.ts`,
`services/gateway/src/{context,server}.ts` (additive wiring) + new
`routes/keypad.ts` + new `keypad.e2e.test.ts`, `services/messaging/src/event-bus.ts`
(additive subject).

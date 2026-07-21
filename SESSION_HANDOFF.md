# SESSION_HANDOFF.md

> Current development state. **Rewrite this at the end of every session** — it should describe
> what changed *since the previous handoff*, not the whole project history (that's
> `PROJECT_CONTEXT.md`). Keep it concise.

**Branch:** `claude/universal-keypad-framework-7khr2o`, based on `main` at session start. This
session built the **Universal Keypad Framework, Phase 1** (ADR 0016) — the brief was explicit
"architecture only, no real driver, no visual editor" — a protocol-independent input/feedback
pipeline so any future keypad (KNX push-button, Casambi keypad, Lutron Pico, Matter switch, MQTT
button, RTI keypad, Zigbee remote, BLE fob, DALI push-button unit) can control any Supreme device,
never via a protocol-to-protocol mapping.

## What actually shipped

**Domain model** (`packages/domain-model/src/keypad-{capabilities,events,feedback,mapping,
subscription}.ts`, new): the Keypad Capability Model (input/feedback capability enums + a
per-control declaration, mirroring `CapabilityKind`'s "advertise, never hardcode protocol"
discipline), the 13 Universal Input Events (`button_pressed` … `gesture`), the 11 Universal
Feedback Commands (`led_on` … `buzzer`), `KeypadSubscription` (the Subscription Manager's record),
and `KeypadMapping` (the Mapping Engine's DSL — deliberately reuses `AutomationCondition`/
`AutomationAction` **verbatim** from the existing, untouched Automation DSL rather than
re-declaring an equivalent shape). Also extracted `evaluateComparator`/`readCapabilityField`/
`isWithinScheduleWindow` out of `@supreme/automations`' `AutomationEngine` into a new shared
`condition-eval.ts` (pure extract, zero behavior change — `AutomationEngine`'s own 7-test suite
passed unmodified before and after), and exported `runAutomationAction`/`describeAutomationAction`
from the same engine so the new Mapping Engine runs actions through the identical dispatch code
instead of a re-implementation.

**Driver SDK Extension** (`services/integration-layer/src/{adapter,native-adapter,routing-adapter,
sil,protocols/driver}.ts`): three new **optional** `INativeProtocolDriver`/`IBackendAdapter`
members — `getKeypadCapabilities?`/`onInputEvent?`/`sendKeypadFeedback?` — mirroring the existing
`getArtwork?`/`getCapabilityConfig?`/`getDiagnostics?` pattern exactly. Every one of the 22 shipped
drivers implements none of them and is unaffected (confirmed: `@supreme/protocols`' full 378-test
suite passes unmodified). A new `services/integration-layer/src/protocols/keypad-extensibility.
test.ts` proves a synthetic, from-scratch fake driver can implement the seam end-to-end through
`SupremeNativeAdapter`/`SupremeIntegrationLayer` with zero framework changes — the same
extensibility-proof pattern ADR 0015 established for the AV SDK.

**New bounded service `@supreme/keypad-framework`** (`services/keypad-framework/`, mirrors
`services/automations`' layout/conventions exactly, depends only on domain-model/contracts/
automations/messaging — NOT integration-layer, staying protocol-agnostic by construction):
- `UniversalInputEngine` — derives short/long/double/triple-press and hold-start/holding/hold-end
  from raw button press/release pairs via one shared per-control timing state machine (a design
  decision documented in the file: a long press fires BOTH the continuous hold-start/holding/
  hold-end stream AND a discrete `long_press` summary on release, so both "dim while held" and
  "long-press does one thing" mappings are served from the same physical gesture).
- `UniversalFeedbackEngine` + `renderFeedback` — capability-gated state→feedback rendering (never
  fabricates a command for an undeclared feedback type), per-subscriber failure isolation.
- `SubscriptionManager` — device+capability-indexed fan-out (the brief's "Living Room Light
  subscribed by KNX/Casambi/Lutron/Matter" example, as data).
- `KeypadMappingEngine` + `KeypadMappingService` — mirrors `AutomationEngine`'s shape (same
  run-trace type, same condition semantics) but fires on keypad input instead of device state/tick.
- `expandVariables` — Optional Variables: `{{name}}` substitution happens ONCE at mapping
  create/update time (before zod validation), never at execution time, because `AutomationAction`'s
  strict schema can't hold a template string in a numeric field — documented in `variables.ts`.
- 41 tests across 6 files, all passing.

**Gateway wiring** (`services/gateway/src/{context,server}.ts`, new `routes/keypad.ts`): wired into
`AppContext.initWithHome()` reusing the SAME `AutomationExecutors` object already built for the
Automation Engine (one "run a Supreme action" implementation, not two); `onBackendState()` gained
one line feeding the feedback engine. New REST surface (`/v1/keypad/mappings*`,
`/v1/keypad/subscriptions*`, `/v1/devices/:id/keypad-capabilities`) mirrors `registerPhase3Routes`'
automation-CRUD shape, gated by a new `"keypad_mapping"` `ResourceType` (additive enum value,
baseline permissions added per role in `services/permissions/src/roles.ts`). New
`subjects.keypadInput` bus subject mirrors `subjects.deviceState`. New `keypad.e2e.test.ts` (7
tests) proves the full REST surface over a real mock-backend hub, including a manual "run" that
drives an actual seeded device through the SIL and `{{variable}}` expansion end-to-end.

**Documentation**: `docs/architecture/adr/0016-universal-keypad-framework.md`,
`docs/architecture/Universal-Keypad-Framework.md` (architecture diagram, 3 sequence diagrams,
service responsibilities, public interfaces, registration flow, lifecycle, thread safety,
scalability, performance, migration/testing strategy, no-breaking-changes guarantee),
`docs/architecture/Keypad-Driver-Author-Guide.md` (step-by-step + per-protocol notes for KNX/
Casambi/Lutron/Matter/MQTT/Zigbee/RTI/BLE/DALI — explicitly flagged as unverified hypotheses, not
researched specs, since no real driver work happened this session). `docs/drivers.md` and
`PROJECT_CONTEXT.md` §6 cross-link the new framework.

**Verification**: full monorepo `pnpm build` (55/55), `pnpm typecheck` (95/95), `pnpm test` (95/95
tasks) — all green, including every pre-existing suite (`@supreme/protocols` 378,
`@supreme/integration-layer` 51, `@supreme/automations` 36, `@supreme/gateway` 229,
`@supreme/permissions` 10) passing **unmodified**, which is the direct evidence backing the
"zero breaking changes" claim.

## What was deliberately NOT built (Phase 1 scope, per the brief)

- **No real keypad driver** — no KNX push-button, Casambi keypad, Lutron Pico, Matter switch, MQTT
  button, RTI keypad, Zigbee remote, BLE, or DALI push-button protocol implementation. The
  Driver-Author-Guide's per-protocol notes are documented as unverified starting hypotheses.
- **No visual Universal Keypad Editor** — only the backend APIs the brief asked for.
- **No Postgres-backed persistence** for `KeypadMapping`/`KeypadSubscription` — both default to
  in-memory (mirroring `InMemoryAutomationStore`'s exact pattern); no new
  `services/persistence`/`cloud/persistence` schema work was in scope. See `TODO.md`.
- **No idle-eviction** for `UniversalInputEngine`'s per-control timer state map — documented in
  the architecture doc as negligible at realistic home scale (tens–hundreds of controls), not a
  silently-accepted leak.

## Known issues / open gaps

- Persistence gap above — real installations restarting the hub lose keypad mappings/subscriptions
  today (same limitation automations had before its own store was wired to Postgres in
  `services/persistence`).
- No live hardware exists to verify ANY of the per-protocol notes in the Driver Author Guide —
  every claim there is flagged as unverified, matching this project's own "verify before building"
  standard applied honestly rather than silently skipped.
- `KeypadMapping.conditions` reuses `AutomationCondition`'s `time_window` variant, but `variables`
  expansion currently only exercises `device_command`/`delay`-shaped actions in tests — a
  `scene_activate`/`notify` action with a templated field is supported by `expandVariables`'s
  generic JSON walk (proven by its own deep-substitution test) but has no DEDICATED end-to-end test
  for those two action types specifically. Low risk (same code path), but worth a follow-up test if
  the Mapping Editor later exposes those action types to installers.

## Immediate priorities for the next session

1. Pick ONE real protocol from the Driver Author Guide's list (Lutron is the most natural first
   target — its LIP transport already exists in `lutron-driver.ts`) and do the actual spec-verification
   research pass (mirroring ADR 0015's AVR spec-verification rigor) before writing any keypad-specific
   code against it.
2. If persistence is prioritized before a real driver: add `KeypadMappingRepo`/
   `KeypadSubscriptionRepo` to `services/persistence` + `cloud/persistence` schema, wire into
   `bootstrap.ts`'s `deps.keypadMappingStore`/`deps.keypadSubscriptionStore` — small, mirrors the
   existing `automations` repo exactly.
3. The visual Universal Keypad Editor is explicitly future work — needs its own scoped session once
   at least one real driver exists to build against (an editor with nothing to bind to is premature).
4. Everything from the prior (AV SDK refactor) handoff not touched this session remains open — see
   `TODO.md` for the full backlog with priority tiers.

# TODO.md — SupremeOS Engineering Backlog

> Prioritized backlog. When work completes, **move it to Completed — never delete it.** This is
> project history, not a scratchpad. For "what changed most recently," see `SESSION_HANDOFF.md`.

---

## Critical

### No native-only backend mode — HA-owned devices silently fall through to a simulator
- **Description:** found by the Home Assistant Dependency Audit
  (`docs/architecture/Home-Assistant-Dependency-Audit.md`). `RoutingBackendAdapter` is always
  constructed with an `ha` side (`services/gateway/src/bootstrap.ts:288-294`), which is either the
  real `HaAdapter` or **`MockAdapter` — an in-memory simulator**. A device whose ownership is
  `"ha"` on a hub running `SUPREME_BACKEND=mock` is therefore served by fabricated state rather
  than real hardware or an honest error.
- **Reason:** directly violates this codebase's own "never fabricate data" rule (`CLAUDE.md`) and
  `routing-adapter.ts:29-33`'s own stated no-silent-fallback principle (which is already enforced
  in the native→HA direction but not the reverse). This is the single blocker gating "Home
  Assistant becomes optional."
- **Dependencies:** none — additive third mode (`SUPREME_BACKEND=native`), no breaking change.
- **Complexity:** Small.
- **Status:** Diagnosed, not fixed (audit was analysis-only per its brief). See the audit's Phase 9
  item **C-1** for the exact design.

### Real-world deployment readiness gap
- **Description:** `docs/production-readiness.md`'s own assessment: feature-complete
  development is ~80%, but real-world deployment readiness is ~25–30%. Nothing has run against
  real field-bus hardware, an unattended multi-week soak, real cloud providers, or a security
  audit.
- **Reason:** shipping without closing this gap risks the product failing in the field in ways
  unit/integration tests can't catch.
- **Dependencies:** none — this is the top-level gate.
- **Complexity:** Large (multi-session).
- **Status:** Not started. Recommended order from the doc itself: (1) security hardening →
  (2) real HA integration → (3) wire real Redis/NATS + persist remaining state → (4) cloud IaC +
  CD + observability → (5) real drivers/protocols + remote-access relay against live hardware.

### App-wide density-breakpoint remount bug
- **Description:** Resizing the browser across the `expanded`↔`comfortable` boundary (~1200px)
  mid-session remounts `App.tsx`'s entire page tree (two structurally different root trees for
  `wide` true/false), silently discarding in-page navigation state.
- **Reason:** real, reproducible; affects every page in the app, not just newly-built ones.
- **Dependencies:** none.
- **Complexity:** Medium — likely fixable by hoisting the page content into one stable render
  path shared by both the sidebar and bottom-tab shells, rather than branching the whole return.
- **Status:** Diagnosed, not fixed. Found during Security/Media module Playwright verification.

---

## High

### Make Home Assistant opt-in in the production compose topology
- **Description:** `infra/hub-compose/docker-compose.yml:25` defaults `SUPREME_BACKEND=ha` and
  `:125-127` hard-declares `depends_on: homeassistant`. The shipped production topology therefore
  cannot start without the HA container even though the *code* boots fine without it (proven by the
  full 240-test gateway suite running at `SUPREME_BACKEND=mock`).
- **Reason:** HA cannot be "optional" while compose requires it to start.
- **Dependencies:** the Critical native-mode item above (ship together).
- **Complexity:** Small — move HA behind a compose profile, flip the default.
- **Status:** Not started. Audit Phase 9 item **H-1**; breaking for existing HA deployments, needs
  a documented upgrade note.

### `engine: "ha"` automations are accepted, persisted, and never executed by anyone
- **Description:** `compileToHa()` (`services/automations/src/compiler.ts:17`) has **no runtime
  caller anywhere** — only tests. Meanwhile the API accepts and stores `engine: "ha"` automations
  (`routes/phase3.ts:41-52`) and the native engine filters them out
  (`services/automations/src/engine.ts:116`). Net effect: such an automation runs nowhere.
- **Reason:** a live correctness bug today, independent of the HA migration — the API promises a
  capability the platform does not deliver.
- **Dependencies:** none.
- **Complexity:** Small — either wire `compileToHa` to a real push path, or reject `engine:"ha"` at
  the API with a clear error.
- **Status:** Diagnosed, not fixed. Audit Phase 9 item **H-2**.

### Universal Keypad Editor / Intent-aware mapping UI
- **Description:** Phase 1 (ADR 0016) and Phase 2 (ADR 0017) both shipped complete backend
  architecture — Universal Input/Feedback Engines, Subscription Manager, Mapping Engine, and the
  Intent & Capability Engine (42-intent registry, capability resolution, REST API) — with
  explicitly no visual editor. A homeowner/installer cannot author a `ToggleLight`/`Movie Mode`
  style mapping through any UI today, even though the backend already fully executes it.
- **Reason:** the backend is now complete enough (both phases) that a real editor has something
  substantive to build against — this is the natural next UI investment, not a premature one.
- **Dependencies:** at least one real keypad driver (see below) makes the editor demonstrable
  end-to-end, but is not strictly required to start (intents can already target existing
  KNX/Casambi/etc. device capabilities via room/device targets today).
- **Complexity:** Large — needs its own scoped session/ADR (visual node/pipeline editor, likely
  extending the existing Automation Editor's canvas rather than a wholly separate surface, given
  `KeypadMapping`/`Automation` now share one `AutomationAction` vocabulary including `"intent"`).
- **Status:** Not started; fully documented as future work in both ADR 0016 and ADR 0017.

### Universal Intent & Capability Engine: fill the honest capability gaps
- **Description:** `swingMode`/`tiltUp`/`tiltDown`/`executeScript`/`webhook` are registered in the
  Intent Registry but their execution honestly throws — no swing/tilt field exists in
  `TemperatureState`/`PositionState` yet, and no script engine or webhook dispatcher exists.
- **Reason:** these are real, named gaps in the capability model / platform infrastructure, not
  hypothetical — a genuine venetian-blind installation or a "run this automation via webhook"
  marketplace template would hit them today.
- **Dependencies:** the tilt/swing gap needs a deliberate `TemperatureState`/`PositionState` schema
  addition (additive, low risk, but a real capability-model decision, not a one-line fix);
  executeScript/webhook need actual new infrastructure (a script sandbox, an outbound HTTP
  dispatcher) — each a meaningfully-sized feature in its own right.
- **Complexity:** Medium (tilt/swing, per capability) to Large (script engine / webhook dispatcher).
- **Status:** Not started; honestly documented as incomplete rather than faked, per ADR 0017.

### Universal Keypad Framework: first real keypad driver
- **Description:** ADR 0016 shipped the full protocol-independent input/feedback/mapping
  framework (Phase 1: architecture only) — no real keypad driver exists yet. `docs/architecture/
  Keypad-Driver-Author-Guide.md` lists per-protocol hypotheses (KNX push-button, Casambi keypad,
  Lutron Pico, Matter switch, MQTT button, RTI keypad, Zigbee remote, BLE, DALI push-button unit),
  explicitly flagged as unverified — no spec-verification research has been done for any of them.
- **Reason:** the framework has zero real-world value until at least one real driver plugs into it.
- **Dependencies:** none architecturally — the seam (`getKeypadCapabilities?`/`onInputEvent?`/
  `sendKeypadFeedback?` on `INativeProtocolDriver`) is ready and proven via a synthetic
  extensibility test. Lutron is the most natural first target (its LIP transport already exists in
  `lutron-driver.ts`).
- **Complexity:** Medium per protocol (spec verification + codec + tests, same shape as adding a
  new AVR brand).
- **Status:** Not started, framework ready.

### Universal Keypad Framework: Postgres-backed persistence
- **Description:** `IKeypadMappingStore`/`IKeypadSubscriptionStore` (`@supreme/keypad-framework`)
  default to in-memory only (mirrors `InMemoryAutomationStore`'s exact pre-persistence-era shape).
  A hub restart today loses every keypad mapping/subscription.
- **Reason:** real deployment readiness — same gap automations had before its own store was wired
  to `services/persistence`/`cloud/persistence`.
- **Dependencies:** none — small, additive, follows the automations repo's exact existing pattern.
- **Complexity:** Small–Medium.
- **Status:** Not started.

### Universal Keypad Editor (visual UI)
- **Description:** the Mapping Engine Interface's backend APIs
  (`/v1/keypad/mappings*`/`/v1/keypad/subscriptions*`) are built and tested; no visual editor
  exists — explicitly out of Phase 1 scope per the brief.
- **Reason:** installers/homeowners need a UI to actually author mappings; a homeowner cannot build
  "KNX button 2 → Casambi light" through any UI today even though the backend already executes it.
- **Dependencies:** at least one real keypad driver (see above) should exist first — an editor with
  nothing real to bind to is premature, same reasoning already applied to the Automation Editor's
  onoff-only gap.
- **Complexity:** Large — needs its own scoped session/ADR.
- **Status:** Not started; fully documented as future work in ADR 0016.

### Finish the UI/UX Design Polish phase
- **Description:** The user-directed polish brief (Phase 2) is partially done — icon system and
  card/button/capability-chip polish shipped. Remaining: device-category ambient color identity
  (camera=blue-tech, media=cinematic, lighting=warm-gold, etc. — without conflicting with
  existing state-driven tinting), and layout-rhythm variation so each device category feels
  structurally distinct rather than reusing one hero→controls→more-controls shape everywhere.
- **Reason:** explicit, repeated user request — "not a CRUD app," compete visually with
  Control4/Savant/Crestron/Tesla/Sonos.
- **Dependencies:** none — builds on the now-complete icon/card/button work.
- **Complexity:** Large — touches every premium device page's composition, not just its colors.
- **Status:** Not started (blocked on user confirming direction before continuing, per the
  last session's handoff message).

### Infrastructure module (Premium Device Experience Library, remaining device types)
- **Description:** Build the remaining device types from the original 18-item priority list:
  Tesla/Vehicle (#11), Energy (#12), EV Charger (#13), Pool (#14), Irrigation (#15), Water Tank
  (#16), Generator (#17), Building Management (#18) — each needing Standard Card, Expanded
  Sheet, Premium Detail Page, capability mapper, and honest capability-gating per the "UI is the
  contract" principle already established for Media/Security.
- **Reason:** explicit original roadmap item; user paused it to prioritize the polish phase, not
  cancelled it.
- **Dependencies:** should wait for the polish phase (above) to land first, so new modules are
  built to the *new* premium standard instead of needing a second pass.
- **Complexity:** Large — 8 device types × full page set. Energy has real backend support
  (`services/analytics`, `/v1/energy/*`); the rest currently have little-to-no backend
  representation (KNX generic `onoff` for Pool/Irrigation; nothing for the rest) — expect most
  controls to be honestly capability-gated at first, same as Camera/NVR were.
- **Status:** Energy (device #1 of 8) built — see Completed. Solar, Battery Storage, EV Charger,
  Pool, Irrigation, Water Tank, Generator, Building Management, Vehicle not started; the new
  `features/infrastructure/<domain>/` pattern + `PowerRing` component are ready to extend.

### Finish emoji migration in generic device quick-sheets
- **Description:** `device-sheets.tsx`'s Climate/Fan/Vacuum/generic-Media quick-sheets still use
  emoji (heat/cool/fan-mode glyphs, shuffle/repeat icons) — out of scope for the Security/Media
  redesign pass but a loose end for "replace every emoji" (icon.tsx already has the pattern
  established, just needs ~6 more `PATHS` entries).
- **Reason:** consistency — the rest of the app no longer uses emoji.
- **Dependencies:** none.
- **Complexity:** Small.
- **Status:** Not started.

---

## Medium

### Device availability (`Device.status`) is owned by nobody
- **Description:** found by the HA Dependency Audit. `Device.status` is set to `"online"` at
  creation (`services/home/src/home-service.ts:523`, `camera-service.ts:45`) and **never updated by
  any code path afterwards** — verified by exhaustive search. Neither HA nor any native driver ever
  writes it, so `"offline"`/`"unavailable"` are unreachable states in practice.
- **Reason:** pre-existing gap, unrelated to HA, but must be assigned an owner before HA (a
  plausible future source of availability) is removed.
- **Dependencies:** none.
- **Complexity:** Medium — needs a driver-side liveness signal threaded through the SIL.
- **Status:** Diagnosed, not fixed. Audit Phase 9 item **M-3**.

### Generic commissioning defaults new devices to `ownership="ha"`
- **Description:** `CommissioningService.commission()` always writes `backendIds`
  (`services/commissioning/src/index.ts:162-163`), which makes `HomeService.bind()` record
  ownership as `"ha"` (`home-service.ts:272`) unless a protocol bind immediately overwrites it.
  A device commissioned without a protocol therefore lands in the exact bucket the HA migration is
  trying to empty.
- **Reason:** keeps growing the `"ha"`-owned population while the migration tries to shrink it.
- **Dependencies:** the Critical native-mode item (land that first).
- **Complexity:** Small — default to `unassigned` rather than `ha`.
- **Status:** Diagnosed, not fixed. Audit Phase 9 item **M-2**.

### Wire real Redis/NATS backends behind the messaging seam
- **Description:** `services/messaging` uses in-process fakes for the event bus (NATS) and
  ephemeral/presence store (Redis) by default; real backends exist behind config but aren't
  verified end-to-end in a real multi-instance deployment.
- **Reason:** required for the hub to survive a process restart without losing live state /
  presence, and for horizontal scale-out.
- **Dependencies:** part of the production-readiness critical path.
- **Complexity:** Medium.
- **Status:** Scaffolded, not verified live.

### Cloud subscription sync + dealer portal
- **Description:** ADR 0014 explicitly notes cloud subscription sync and the dealer portal are
  scaffolded by the licensing provider model but not fully built.
- **Reason:** commercial model dependency — `cloud/dealer`/`cloud/subscription` need this to be
  usable by real installer organizations.
- **Dependencies:** `cloud/licensing`, `cloud/identity` (both further along).
- **Complexity:** Large.
- **Status:** Provider seam exists; sync/portal not implemented.

### Real CHIP/Thread Matter controller bring-up
- **Description:** Matter commissioning (setup-code parsing, commissioning seam, fabric manager,
  cloud multi-admin sync) is implemented in code, but the real `@matter/main` hardware
  controller bring-up is explicitly not runnable yet (ADR 0011).
- **Reason:** Matter support is a stated product feature ("optional and user-activatable").
- **Dependencies:** real Thread border-router hardware for testing.
- **Complexity:** Large.
- **Status:** Seam built, hardware integration outstanding.

### Real hap-nodejs HomeKit transport
- **Description:** the local HAP accessory bridge (`services/homekit`) has its mapping/bridge/
  routing logic done; the real `hap-nodejs` transport layer is the stated outstanding boundary
  (ADR 0012).
- **Reason:** Apple Home/Siri support is a stated product feature.
- **Dependencies:** none blocking, just unimplemented.
- **Complexity:** Medium.
- **Status:** Logic done, transport not wired.

### HEOS `queryPlayers()` unbounded discovery buffer
- **Description:** found during the AV SDK refactor's duplication audit: `heos-driver.ts`'s
  `queryPlayers()` (used only during `discover()`) reimplements manual `buffer.split("\r\n")` line
  accumulation instead of reusing the already-imported `LineAccumulator`, and — unlike
  `LineAccumulator` — has no `maxBytes` cap. A non-HEOS device answering on port 1255 with a flood
  of undelimited data during discovery could grow this buffer unbounded.
- **Reason:** real, low-risk, small-scope bug; adjacent to (but not part of) the AV SDK refactor's
  scope, so deliberately not silently bundled into any other change.
- **Dependencies:** none.
- **Complexity:** Small — reuse `LineAccumulator`, matching the pattern already used for AVR/HEOS's
  main TCP link buffers.
- **Status:** Not started.

---

## Low

### Additional AVR brand drivers
- **Description:** `docs/architecture/adding-avr-brands.md` explicitly lists brands with zero
  implementation: Onkyo/Pioneer (ISCP/eISCP), Sony, Arcam, Anthem (ARC), NAD, JBL Synthesis,
  StormAudio, Trinnov.
- **Reason:** broaden AVR hardware compatibility beyond the current Denon/Marantz/HEOS/Yamaha
  set.
- **Dependencies:** the Universal AVR Framework (ADR 0015) already provides the seam; each brand
  is an isolated driver addition.
- **Complexity:** Medium per brand (protocol research + codec + tests).
- **Status:** Not started, framework ready.

### Live hardware verification of the Universal AV Driver SDK additions
- **Description:** Diagnostics Console, Room Assignment Engine, Automatic Zone Generation, and
  the Media Topology Engine (ADR 0015 addendum) were built and tested against in-process fake
  TCP/HTTP servers only — never against a real Denon/HEOS/Yamaha unit or a running `hub-compose`
  stack. The Topology UI has not been Playwright-verified at any responsive tier. A full,
  per-brand checklist now exists: `docs/architecture/avr-framework-production-audit.md` Phase 5
  — nothing on it is checked yet.
- **Reason:** this project's own testing standard ("new UI behavior should be Playwright-verified
  live... not just typechecked") wasn't met for this work — no backend/hardware was available in
  either session that built/hardened it. The production-readiness audit explicitly declines to
  call the framework production-ready until this is done (currently ~70%, see the audit's Phase
  10 report).
- **Dependencies:** `hub-compose` running, ideally real AVR hardware.
- **Complexity:** Small (verification only, no new code expected unless something's found).
- **Status:** Not started. One specific open question to resolve while doing this: does a bare
  Denon `Z2?` query echo Zone 2's current SOURCE as well as power on real hardware (the codec
  only sends `Z2?`/`Z2MU?` on reconnect, no explicit zone2-source query token)?

### Small, named gaps found by the Universal AV Driver SDK production audit
- **Description:** Three small, real, unaddressed gaps confirmed during the production-hardening
  audit (`docs/architecture/avr-framework-production-audit.md`, Phase 1/2/4/10): (1) Yamaha's
  `setEqualizer` (multi-band EQ) exists in the YXC spec but isn't wired into
  `yamaha-codec.ts`'s `commandToYamaha`; (2) HEOS's QuickSelect has a working command path
  (`heos-codec.ts:124`, `play_quickselect`) but `heosCapabilityConfig()` never populates
  `presets`/`advancedControls`, so there's no UI surface to trigger it; (3) HEOS's Bluetooth
  surface (if any) isn't modeled at all — `bluetooth` field always absent from
  `heosCapabilityConfig()`.
- **Reason:** found by direct code audit against the vendor specs, not guessed — each is a
  genuine, scoped, low-risk fix, not a design question.
- **Dependencies:** none.
- **Complexity:** Small, per item.
- **Status:** Not started; deliberately not fixed in the same session as the audit that found
  them, per that session's "no new features, harden only" scope.

### Fleet-wide missing `unbind()` on `INativeProtocolDriver`
- **Description:** confirmed during the AVR framework's Phase 6 stress-testing audit: no driver
  in the fleet implemented a way to remove ONE device's bindings without tearing down the whole
  driver via `disconnect()`.
- **Status:** ✅ **Done** — SupremeOS Driver Lifecycle Completion effort. `unbind?(deviceId):
  Promise<void>` added to `INativeProtocolDriver` and implemented on all 22 drivers in
  `@supreme/protocols` (including the 3 flagship AVR/HEOS/Yamaha drivers, which turned out to
  have no `unbind()` either despite the earlier audit's summary — corrected here, not assumed).
  Wired through `SupremeNativeAdapter.unbindDevice()` → `IBackendAdapter.unbindDevice?()` →
  `RoutingBackendAdapter` → `SupremeIntegrationLayer.unmapDevice()`, which previously only cleared
  SIL bookkeeping and never told the owning driver to release its own resources — that was the
  root cause. New `DriverLifecycleController` SDK primitive (20-state lifecycle + LIFO
  fault-tolerant cleanup registry) at `services/integration-layer/src/protocols/lifecycle.ts`.
  Five real leaks found and fixed along the way (AirPlay/AppleTV/Sonos `disconnect()` never
  cleaning up at all; Matter/KNX subscriptions with no unsubscribe mechanism; KNX's GA-scoped
  `unsubscribe()` risking killing a sibling device's subscription; an unbounded offline-command
  queue per unbound device; `SupremeNativeAdapter.connect()` not being idempotent, causing
  duplicate state events under a reconnect storm). Full detail: `docs/architecture/
  Driver-Lifecycle.md`, `Driver-SDK.md`, `Resource-Cleanup.md`, `Driver-Author-Guide.md`.

### Wire more protocols into the generic Room Assignment Engine
- **Description:** `services/commissioning/src/room-assignment-engine.ts` is protocol-agnostic
  (takes a generic `LocationHint`) but only AVR/HEOS/Yamaha discovery currently emits one. Matter
  (Room/Location cluster), KNX live discovery, Zigbee/Z-Wave/BLE could all feed it the same way.
- **Reason:** explicit product ask — "every SupremeOS driver should provide location hints."
- **Dependencies:** none — the engine itself needs no changes, only each driver's `discover()`.
- **Complexity:** Small per protocol.
- **Status:** Not started; deliberately deferred to avoid touching the working KNX ETS import
  pipeline and other stable discovery paths in the same session that built the engine.

### Whole-home Media Dashboard topology graph view
- **Description:** the Media Topology Engine currently renders only a per-device connections list
  (in the AVR console's sidebar); a whole-home graph view (the brief's worked example — "Living
  Room AVR ├── HDMI1 → Apple TV …") for the Media dashboard was not built.
- **Reason:** explicit brief ask ("support Diagnostics, Media Dashboard, Activity Generation,
  Automation Relationships") — only the diagnostics-adjacent per-device view shipped.
- **Dependencies:** `MediaTopology` schema (`packages/domain-model/src/media-topology.ts`) already
  exists and is populated by the per-device editor; a dashboard view just needs to read it.
- **Complexity:** Medium.
- **Status:** Not started.

### Bluetooth pairing management for HEOS/Yamaha
- **Description:** explicitly called out as out of scope for the current AVR framework.
- **Reason:** completeness of the AVR control surface.
- **Dependencies:** AVR framework.
- **Complexity:** Small–Medium.
- **Status:** Not started.

### Local (non-cloud-to-cloud) Alexa/Google fulfillment
- **Description:** current voice integrations are cloud-to-cloud only; a local fulfillment path
  was explicitly deferred to a follow-up.
- **Reason:** reduce cloud dependency for voice control, consistent with local-first principles.
- **Dependencies:** `cloud/voice`, local intent-routing design.
- **Complexity:** Large.
- **Status:** Deferred, not designed.

### Automation Editor: onoff-only field-resolution gap
- **Description:** confirmed during Automation Editor production hardening
  (`docs/architecture/Automation-Editor.md` §2): the automation DSL and engine
  (`packages/domain-model/src/automations-dsl.ts`, `services/automations/`) already support
  triggers/conditions/actions across every `CapabilityKind` (brightness/color/temperature/
  position/media/lock/fan/vacuum/sensor) and the full `CapabilityCommand` union — but both the web
  (`apps/web-homeowner/src/automations.tsx`) and mobile (`apps/mobile/lib/screens/
  automation_editor.dart`) drag-and-drop editors only ever author onoff-style device triggers/
  conditions/commands. A homeowner cannot build "when brightness drops below 20%, run a scene"
  through either builder today, even though the backend already executes it.
- **Reason:** a real, user-facing functionality gap, not a hardening concern — deliberately not
  fixed in the hardening pass that found it, per that pass's explicit "no new user-facing
  features" scope.
- **Dependencies:** the real, already-shared `getCapabilityConfig()` mechanism
  (`services/integration-layer/src/protocols/driver.ts`) is the natural foundation for a
  capability-aware field editor; see `docs/architecture/Automation-Editor-Future-Driver-SDK-
  Roadmap.md` for a fully-worked (but unimplemented) design proposal — Driver Command Metadata
  contract, maturity model, extension points — to build from rather than redesigning from scratch.
- **Complexity:** Large — needs its own scoped session/ADR (a generic, data-driven field-editor
  renderer for both platforms), not a bolt-on to another task.
- **Status:** Not started; fully documented as a future proposal, not implemented.

### `AutomationService` unit test coverage
- **Description:** `services/automations/src/service.ts` (the CRUD layer: create/update/remove/
  setEnabled/testRun) has no direct unit tests — its only coverage is one happy-path e2e test
  (`services/gateway/src/phase3.e2e.test.ts`, create + WSS-observed execution). Update/delete/
  enable-toggle/list/runs and validation-error paths are untested at the service level.
- **Reason:** found during the Automation Editor hardening pass's test-coverage audit; the engine
  itself (`engine.ts`) has solid coverage (8 tests), the CRUD wrapper around it does not.
- **Dependencies:** none.
- **Complexity:** Small — `InMemoryAutomationStore` already exists as an injectable fake, so this
  is straightforward unit testing, no new infrastructure needed.
- **Status:** Not started.

### `@supreme/web-homeowner` has no component-test infrastructure
- **Description:** confirmed during the Automation Editor hardening pass: the entire
  `apps/web-homeowner` app has zero `.test.tsx` files and no `@testing-library/react`/jsdom/
  happy-dom dependency — only plain-function `vitest` tests are possible today. This blocked
  adding real component/interaction tests (drag-and-drop, click handlers, save-payload
  correctness) for the Automation Editor; only its pure helper functions got new test coverage.
- **Reason:** a real, app-wide testing-infrastructure gap, not specific to automations — worth
  fixing once, deliberately, rather than every future UI hardening pass re-discovering it and
  settling for pure-function-only coverage.
- **Dependencies:** none — add `@testing-library/react` + `jsdom` (or `happy-dom`) as dev
  dependencies and a vitest environment config.
- **Complexity:** Small to set up; the follow-on value (actually writing component tests for
  `automations.tsx` and other pages) is separate, larger work.
- **Status:** Not started.

---

## Future ideas

- HRoT/TPM-backed hub identity ("future-ready," not yet built per the blueprint's Phase 4 notes).
- Multi-region cloud deployment (cloud roadmap plane C4).
- AI assistant expansion — energy/EV/solar hooks (cloud roadmap plane C4).
- A `CHANGELOG.md`/`ROADMAP.md` at the repo root — currently neither exists; roadmap detail
  lives only inside the two architecture blueprints. Worth extracting into a lighter-weight,
  more discoverable root file if the roadmap keeps changing.

---

## Completed

> High-level milestones only — see `git log` for full commit-level history, and
> `PROJECT_CONTEXT.md` §6 for what each milestone actually delivers.

- **Universal Intent & Capability Engine, Phase 2** (ADR 0017) — a protocol- AND
  device-independent semantic layer decoupling user interactions from drivers entirely:
  `AutomationAction` gained one additive `"intent"` variant (reused automatically by both the
  Automation Engine and the Phase 1 Keypad Mapping Engine — zero extra schema/engine work, the
  direct payoff of Phase 1's "reuse `AutomationAction` verbatim" decision); new
  `packages/domain-model/src/intents.ts` (`IntentDefinition`/`IntentTarget`); new
  `@supreme/intent-engine` service (`CapabilityIndex` — O(matching devices), never O(all devices),
  kept in sync via a new additive `HomeService.onDeviceChanged` event; `IntentRegistry` —
  extensible-forever catalog pairing serializable definitions with server-only `translate`/
  `runSystem` handlers, validated at registration; `registerBuiltinIntents` — 42 intents across
  lighting/climate/av/blinds/security/system, with `swingMode`/`tiltUp`/`tiltDown`/`executeScript`/
  `webhook` honestly registered-but-throwing where no real capability/infrastructure backs them
  yet; `IntentEngine` — the Capability Engine itself, 48 tests including a dedicated "migration
  readiness" proof). Full gateway REST wiring (`GET /v1/intents`, `POST /v1/intents/:id/run`, run
  history) + 11 e2e tests including a keypad mapping's intent action driving a real device through
  the same engine a direct REST call uses. Zero visual editor, zero new capability-model fields —
  explicitly Phase 2/architecture-only per the brief. Full monorepo `pnpm build`/`typecheck`/`test`
  green (56/56, 97/97, 97/97 tasks), every pre-existing suite passing unmodified. Full detail:
  `SESSION_HANDOFF.md`, ADR 0017, `docs/architecture/Universal-Intent-Capability-Engine.md`.
- **Universal Keypad Framework, Phase 1** (ADR 0016) — a protocol-independent input/feedback/
  mapping pipeline so any future keypad controls any Supreme device without a protocol-to-protocol
  mapping: Keypad Capability Model + 13 Universal Input Events + 11 Universal Feedback Commands +
  `KeypadSubscription`/`KeypadMapping` DSL (`packages/domain-model`); three new optional
  `INativeProtocolDriver`/`IBackendAdapter` members threaded through
  `SupremeNativeAdapter`/`RoutingBackendAdapter`/`SupremeIntegrationLayer`, proven via a synthetic
  extensibility test; new `@supreme/keypad-framework` service (`UniversalInputEngine` with
  short/long/double/triple-press + hold-start/holding/hold-end derivation,
  `UniversalFeedbackEngine` with capability-gated rendering, `SubscriptionManager`,
  `KeypadMappingEngine`/`Service` reusing the existing Automation DSL's conditions/actions verbatim,
  `expandVariables` for Optional Variables); full gateway REST CRUD wiring + e2e test. Zero real
  keypad driver, zero visual editor — explicitly Phase 1/architecture-only per the brief. Full
  monorepo `pnpm build`/`typecheck`/`test` green (55/55, 95/95, 95/95 tasks), every pre-existing
  suite passing unmodified. Full detail: `SESSION_HANDOFF.md`, ADR 0016, `docs/architecture/
  Universal-Keypad-Framework.md`, `Keypad-Driver-Author-Guide.md`.
- **Universal AV SDK refactor** (AVR/HEOS/Yamaha → thin protocol adapters) — a new internal-only
  `services/protocols/src/av-sdk/` module (`TcpLineTransport` + `state-cache.ts`'s
  `recordCapabilityState()`) extracting the real, evidence-backed duplication found by a prior
  architecture audit (a ~55-line TCP-link-pool + reconnect + line-buffering pattern between
  AVR/HEOS, plus a verbatim-identical `record()` in all three drivers). `AvrProtocolDriver`
  387→305 lines (~21%) and `HeosProtocolDriver` 522→437 lines (~16%) migrated onto
  `TcpLineTransport`; `YamahaProtocolDriver` 486→481 lines gets only the `record()` extraction
  ("thinner, not thin" — HTTP+UDP transport, no second caller in the fleet to justify a
  speculative HTTP-transport primitive). Zero placeholder adapters created for any of the 17
  unbuilt future brands — instead, a synthetic `extensibility.test.ts` proves the SDK's public API
  is sufficient for a from-scratch adapter, backed by a new `AV-Adapter-Development-Guide.md`. All
  pre-existing driver test suites (AVR 19, HEOS 21, Yamaha 24 tests) pass **unmodified** — the
  regression evidence that runtime/protocol/discovery/diagnostics/reconnect behavior is unchanged.
  Full monorepo `pnpm build`/`typecheck`/`test` green (54/54, 93/93, all tasks). New
  `docs/architecture/Universal-AV-SDK.md` + `AV-Adapter-Development-Guide.md`; updated
  `avr-sdk-developer-guide.md` to correct its stale "no separate AVR engine" claim. Full detail:
  `SESSION_HANDOFF.md` Part 4.
- **Universal AV Driver SDK production hardening audit** — full 10-phase audit
  (`docs/architecture/avr-framework-production-audit.md`): architecture/digital-twin/
  lifecycle audit, protocol coverage matrix, hardware validation checklist (unchecked,
  honest), stress-testing, performance audit, production readiness report (~70%,
  explicitly not marked production-ready — see the report for why). Found and fixed
  two real concurrency bugs (a TOCTOU race + orphaned-timer leak in
  `YamahaProtocolDriver.ensureHostFeatures()`, and unbounded overlapping HTTP requests
  in `syncZone()`, both fixed via in-flight-promise coalescing), one real resource-
  safety gap (no upper bound on `link.buffer` in AVR/HEOS — a misbehaving device could
  grow memory without limit; fixed with a new shared, bounded `LineAccumulator`
  (`line-buffer.ts`), which also deduplicated identical buffer-handling code that was
  previously copy-pasted between the two drivers), and one lifecycle gap (`command()`
  never checked whether the driver had been `disconnect()`-ed, silently resurrecting a
  real connection instead of failing — now guarded in all 3 drivers). 15 new tests, all
  348 protocol-package tests and all 93 monorepo build/typecheck/test tasks pass. New
  developer docs: `docs/architecture/avr-sdk-developer-guide.md` (SDK/Lifecycle/Digital
  Twin/Discovery/Capability/Diagnostics/Room-Assignment/Topology reference) and a new
  §8 in `adding-avr-brands.md` confirming all 9 future brands (Anthem/Arcam/NAD/Sony/
  Pioneer/Onkyo/JBL Synthesis/StormAudio/Trinnov) are supported without architectural
  change. Three small named gaps and one fleet-wide architectural gap were found and
  deliberately NOT fixed (out of "harden, don't add features" scope) — see the new TODO
  items above.
- **Universal AV Driver SDK completion** (ADR 0015 addendum) — Diagnostics Console
  (`services/protocols/src/driver-diagnostics.ts`, wired into AVR/HEOS/Yamaha drivers, exposed
  via a new `INativeProtocolDriver.getDiagnostics?()` seam and `GET /v1/devices/:id/diagnostics`);
  a generic, protocol-agnostic confidence-based Room Assignment Engine
  (`services/commissioning/src/room-assignment-engine.ts`, explicitly superseding ADR 0015 §2.3's
  narrower "installer always assigns the room" position); Automatic Zone Generation for Yamaha's
  real multi-zone units (`InstallerServices.autoCommissionMedia`, `POST /v1/commissioning/
  auto-media`); a Media Topology Engine (`packages/domain-model/src/media-topology.ts`,
  installer-declared HDMI/zone graph, editable in the AVR console). Also fixed a pre-existing gap
  where `RoutingBackendAdapter` never implemented `getCapabilityConfig`. See `SESSION_HANDOFF.md`
  and the ADR addendum for full detail; not yet live-verified against real hardware.
- Infrastructure module, Energy (device #1 of 8) — `features/infrastructure/energy/`
  (capability-mapper/card/detail) plus `infrastructure-energy.tsx` (whole-home dashboard),
  replacing the old plain-`.card.row` Energy tab. New shared `PowerRing` radial-gauge component
  in `@supreme/aureon-web`, 7 new icons (`plug`/`sun`/`ev`/`generator-unit`/`leaf`/`trend-up`/
  `flow`). Whole-home hero and per-device consumption sparkline both read real
  `client.energySummary()`/`/v1/energy/history` data — no fabricated live numbers; per-device
  page gates Schedule/Load Priority/Usage Alerts/Efficiency Insights honestly (no backing
  capability exists yet). `devices.tsx`'s `friendlyType()` updated to classify energy devices.
- Monorepo foundation: pnpm + Turborepo (TS/Python) + Melos (Flutter), domain-model, contracts,
  Aureon design tokens, hub Compose stack with hidden HA, SIL skeleton, Identity + Permissions,
  gateway (REST + WSS).
- Homeowner MVP: Dashboard, Rooms, Device Control, Scenes, Favorites, Notifications, user
  management/roles, local + remote access.
- Installer Portal, Driver Store, device discovery/commissioning (KNX/DALI/Casambi/Matter/MQTT/
  Modbus), diagnostics, backup/restore, licensing.
- KNX ETS import engine (full `.knxproj`/`.esf` parsing, device recognition, room assignment,
  learning engine, review-before-commit UI on web + mobile).
- Universal AVR/media framework — AVR (Denon/Marantz Telnet), HEOS, Yamaha MusicCast drivers;
  rich AVR console UI (album art, halo/particle ambient glow, volume knob, waveform) on web +
  Flutter; real SSDP/mDNS discovery.
- Design System phases 0–8: `@supreme/aureon-web` component library (Button, Card, Chip/Badge,
  Sheet, unified Icon registry, responsive breakpoints), migrated every existing device console
  onto it, Universal DeviceSheet 7-section architecture (Information/Diagnostics/Automations/
  History/Advanced Settings + capability-specific Overview/Controls).
- Responsive framework (frozen): density engine (compact/comfortable/expanded), fluid tokens,
  Grid/Container/Stack primitives.
- **Premium Device Experience Library — Media module:** feature-module architecture
  established; Television/Projector/AVR/Speaker with capability-driven classification and the
  "UI is the contract" gating principle.
- **Premium Device Experience Library — Security module:** Door Lock, Furniture Lock, SIP Video
  Door Phone, Camera, NVR, Alarm System — full premium pages, all wired into the Security tab.
- **UI/UX Design Polish phase (first pass):** shared Card/Button/QuickActions/CapabilityGrid
  primitives upgraded with real depth, motion, and a decluttered capability-gating presentation;
  complete SVG icon system (63 icons) replacing emoji across Security + Media; fixed an app-wide
  ultrawide-display layout bug.
- Project memory system established: `CLAUDE.md`, `PROJECT_CONTEXT.md`, `SESSION_HANDOFF.md`,
  `TODO.md` (this file).

# TODO.md — SupremeOS Engineering Backlog

> Prioritized backlog. When work completes, **move it to Completed — never delete it.** This is
> project history, not a scratchpad. For "what changed most recently," see `SESSION_HANDOFF.md`.

---

## Critical

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
  only sends `Z2?`/`Z2MU?` on reconnect, no explicit zone2-source query token)? **A concrete,
  written guided-capture procedure now exists** for the three RTI Capability Audit Category B
  items specifically (Zone 3/4, 8 extra channel-trim targets, Tone Defeat) —
  `RTI-Capability-Audit.md`'s closing section: with `devMode` on, send each probe token via the
  new Raw Command box and read the reply in the Protocol Trace panel. No code changes needed to
  run it, only physical access to a unit.

### Live Playwright verification of the Raw Command UI section
- **Description:** `RawCommandSection` (`device-detail-sections.tsx`, wired into
  `media/detail.tsx` as a devMode-gated sibling of Diagnostics/Protocol Trace) was built this
  session — typecheck/build clean, backed by a tested gateway route
  (`raw-command.e2e.test.ts`) — but never opened in a real browser.
- **Reason:** no running dev server/backend was available in this sandbox this session; per
  this project's UI verification standard, that's a real gap, not a completed item.
- **Dependencies:** `hub-compose` running (or the local dev server), an AVR device (real or the
  fake in-process test server) bound as native.
- **Complexity:** Small — verification only.
- **Status:** Not started.

### Wire `heartbeat()` into an automatic keepalive scheduler
- **Description:** `AvrProtocolDriver.heartbeat()` and `HeosProtocolDriver.heartbeat()` both
  exist, are tested, and return `{ ok, latencyMs }` — but nothing calls either one
  automatically. No scheduler, no interval, no gateway route, no UI affordance.
- **Reason:** flagged as "Partial" (not "✓") for the Keepalive Framework engine in
  `docs/architecture/Universal-AVR-SDK-Roadmap.md` — the primitive exists, the framework
  around it doesn't.
- **Dependencies:** none — both `heartbeat()` methods are ready to be called.
- **Complexity:** Small-Medium (interval scheduler + a health-degradation signal + surfacing it
  somewhere a user/installer can see it).
- **Status:** Not started.

### Raise Yamaha's real SDK-primitive reuse
- **Description:** `YamahaProtocolDriver` only adopted `state-cache.ts` from the AV SDK — it
  never migrated onto `HttpPollClient`/`AdaptivePoller` (built for and currently only used by
  AVR's HTTP AppCommand layer), and has no `heartbeat()`.
- **Reason:** documented honestly in `Universal-AVR-SDK-Roadmap.md`'s Yamaha mapping section as
  a concrete, scoped 3-step follow-up, deliberately not attempted this session (Yamaha's
  existing polling is working and tested; force-migrating "for consistency alone" was
  explicitly rejected as unjustified churn in the original SDK extraction pass).
- **Dependencies:** none.
- **Complexity:** Medium (migrate `getJson()`/`diagnosticsFor()`/`hostFeaturesInFlight` onto
  `HttpPollClient`; adopt `AdaptivePoller` for the existing zone-sync loop; add `heartbeat()`
  once a real Yamaha no-op-equivalent command is evidenced from official docs).
- **Status:** Not started.

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

- **RTI Capability Audit, Phases 1–4** — executed the user's 4-phase instruction against the
  prior `RTI-Capability-Audit.md` A/B/C/D classification. Phase 1: all 5 Category A commands
  shipped (Subwoofer, Cinema/Music/Game/Pro Logic mode, Cinema EQ, Loudness Management, Tone
  Control On/Off — all official-PDF-cited). Phase 2: all 4 Category C application-layer patterns
  shipped — a new `InitHandshake` primitive (`av-sdk/init-handshake.ts`) for paced, response-
  driven init-sync plus a new `fullySynced` diagnostics field (C.1/C.2); `AvrProtocolDriver
  .heartbeat()` (C.3); a devMode-gated raw-command escape hatch threaded through 6 backend touch
  points to a new `POST /v1/devices/:id/raw-command` route plus a new `RawCommandSection` UI
  (C.4). Two real race-condition bugs were found and fixed via test-driven debugging while
  wiring this (a test-harness ECONNRESET gap, and a genuine `fullySynced` default-value race in
  `bind()`). Phase 3: an honest, non-fabricated response that this sandbox has no real Denon
  hardware to verify Category B against, plus a concrete guided-capture procedure using the new
  Raw Command + Protocol Trace tooling for someone with physical access to run themselves. Phase
  4: `docs/architecture/Universal-AVR-SDK-Roadmap.md` — an engine-level (not brand-level)
  roadmap across 17 engines, each cited against real code, plus a Denon/Yamaha/Anthem reuse
  mapping that deliberately corrects the user's own "reuses 95%" framing with real, measured
  numbers (Yamaha's actual SDK-primitive reuse is low) rather than repeating an unverified
  estimate. Full monorepo `pnpm build`/`typecheck`/`test` green.
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

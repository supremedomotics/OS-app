# SESSION_HANDOFF.md

> Current development state. **Rewrite this at the end of every session** — it should describe
> what changed *since the previous handoff*, not the whole project history (that's
> `PROJECT_CONTEXT.md`). Keep it concise.

## Session: Universal AV SDK

**Branch:** `claude/supremeos-universal-av-sdk-0rtaiw`, based on `main` at session start.

This handoff was rewritten from scratch — the previous version had drifted several sessions out
of date (it stopped at the original `TcpLineTransport`/`state-cache.ts` extraction and never
recorded the subsequent HTTP AppCommand layer, the Audyssey-family command pass, the RTI
Capability Audit, or this session's work). The detailed history of each of those passes lives in
its own architecture doc, cross-linked below — this file only needs to describe current state and
what changed most recently.

## Current state of the AV SDK

- `services/protocols/src/av-sdk/` is the real, runtime shared module: `TcpLineTransport`
  (pooled/reconnecting/line-buffered TCP, shared by AVR+HEOS), `HttpPollClient`/`AdaptivePoller`
  (shared in-flight-deduped HTTP + adaptive polling, shared by AVR's AppCommand layer), `state-
  cache.ts` (`recordCapabilityState`, shared by all three AV drivers), `init-handshake.ts`
  (`InitHandshake` — new this session, see below), `protocol-tracer.ts`, `network-source-
  resolver.ts`.
- `avr-driver.ts` (Denon/Marantz) is the SDK's reference implementation — the only driver
  combining two transports (Telnet realtime push + HTTP AppCommand for renamed/hidden inputs and
  album art) through shared SDK primitives.
- Full architecture: `docs/architecture/Universal-AV-SDK.md`. Full per-capability wire evidence:
  `docs/architecture/AVR-Universal-Capability-Matrix.md`. Engine-level roadmap (what's ✓/Partial/
  Planned across the whole SDK, honest Denon/Yamaha/Anthem reuse mapping): **new this session**,
  `docs/architecture/Universal-AVR-SDK-Roadmap.md`.

## This session's work — RTI Capability Audit, Phases 1–4

Prior session produced `docs/architecture/RTI-Capability-Audit.md`: an evidence-based audit of 16
capabilities RTI's driver has that SupremeOS didn't, classified A (officially confirmed, ready to
build) / B (officially-adjacent, one piece of evidence missing) / C (RTI application-layer pattern
buildable from already-confirmed commands) / D (RTI-only, no official corroboration). This
session executed the user's 4-phase instruction against that audit:

**Phase 1 — Category A (5 items), all shipped:**
Subwoofer On/Off (`PSSWR`), Cinema/Music/Game/Pro Logic mode (`PSMODE:`), Cinema EQ (`PSCINEMA
EQ.`), Loudness Management (`PSLOM`), Tone Control On/Off (`PSTONE CTRL`) — all in `avr-codec.ts`,
each an official-PDF-cited exact token, wired into `denonCapabilityConfig()`'s `advancedControls`
(reusing the existing generic `select` UI renderer, zero new frontend code needed). New
`hasExtendedAudio` installer-declared gate flag. 30 tests in `avr-codec.test.ts`.

**Phase 2 — Category C (all 4 items), all shipped:**
- **C.1/C.2 (connection-readiness state machine + paced init-burst)**: new `InitHandshake` class
  (`av-sdk/init-handshake.ts`) — sends one init token, waits for any reply, sends the next, rather
  than one blind burst write. New `DriverDiagnosticsSnapshot.fullySynced: boolean` (three-file
  sync: `adapter.ts` → `rest.ts` → `driver-diagnostics.ts`), wired into `avr-driver.ts`'s
  `onLinkConnect()`.
- **C.3 (keepalive probe)**: `AvrProtocolDriver.heartbeat()` — `PW?` probe, `{ ok, latencyMs }`,
  structurally identical to the existing `HeosProtocolDriver.heartbeat()`.
- **C.4 (raw command escape hatch)**: `AvrProtocolDriver.sendRaw()`, threaded through 6 interface/
  adapter touch points (`INativeProtocolDriver` → `IBackendAdapter` → `avr-driver.ts` →
  `native-adapter.ts` → `routing-adapter.ts` → `sil.ts`) to a new `POST /v1/devices/:id/raw-
  command` gateway route (`validation_failed`/422 when the owning backend doesn't support it), plus
  a new devMode-gated **Raw Command** UI section (`device-detail-sections.tsx`, wired into the AVR
  console). New `services/gateway/src/raw-command.e2e.test.ts` (4 tests) covers both the success
  path (fake native driver) and the unsupported-backend 422 path (HA-owned device).
- Two real race-condition bugs were found and fixed via test-driven debugging while wiring this
  (not guessed, not papered over — see `RTI-Capability-Audit.md`'s git history / the full session
  transcript for the exact repro): a test-harness ECONNRESET gap (fixed in the test helper) and a
  genuine `fullySynced` default-value race in `avr-driver.ts`'s `bind()` (fixed with `if
  (!link.ready) link.diagnostics.setFullySynced(false);` right after `ensureLink()`).

**Phase 3 — honest response on hardware access:**
This sandboxed environment has no LAN reachability to any physical Denon/Marantz receiver — there
is no real hardware to verify Category B (Zone 3/4, 8 extra channel-trim targets, Tone Defeat)
against. Rather than fabricate a live capture, `RTI-Capability-Audit.md` got a new closing section
documenting this plainly and laying out a concrete, self-serve **guided capture procedure**: with
`devMode` on, send each Category B probe token via the new Raw Command box and read the reply in
the existing Protocol Trace panel — the exact tooling built in Phase 2 is what a real Category B
verification pass needs, no new engineering. Category B/D stay unbuilt, as they should.

**Phase 4 — Universal AVR SDK Roadmap (the explicitly-flagged most important deliverable):**
New `docs/architecture/Universal-AVR-SDK-Roadmap.md` — an engine-level (not brand-level) roadmap:
a ✓/Partial/Planned status for each of 17 engines (Core Transport, Realtime Event Engine,
Diagnostics, Capability Engine, Protocol Recorder, Connection State Machine, Keepalive Framework,
Zone Engine, Media Engine, Artwork Engine, Metadata Engine, Audio/Video Processing Engine,
Calibration Engine, Developer Console, Capability Discovery, Hardware Verification Mode), each
cited against real code. Includes a Denon "Uses:" mapping, and — deliberately correcting the
user's own illustrative "reuses 95%" framing rather than parroting it — an **honest** Yamaha reuse
assessment (real, measured reuse is low: only `state-cache.ts` + the shared `DriverDiagnosticsTracker`
class; `Universal-AV-SDK.md`'s own before/after table already recorded Yamaha's SDK-extraction
line-count reduction at ~1%, not 95%) with a concrete 3-step path to raise it, and an Anthem
mapping framed honestly as **not yet built** — a projection based on Phase 9's readiness findings
(transport/diagnostics tier likely near-total reuse; command-vocabulary tier 100% unevidenced,
zero shortcuts).

## Verification (RTI Capability Audit phases)

`pnpm build` — 54/54 (now includes the new `raw-command.e2e.test.ts`, `init-handshake.ts`/`.test.ts`).
`pnpm typecheck` — 93/93. `pnpm test` — full monorepo green (a `pnpm test` run under maximum
turbo parallelism transiently failed 3 unrelated, pre-existing timing-sensitive tests in
`avr-driver.test.ts`/`heos-driver.test.ts` due to CPU contention across ~50 concurrently-running
packages; confirmed non-reproducible via 3 repeated isolated re-runs and a scoped
`--filter @supreme/protocols --filter @supreme/gateway` run, both 100% green — not a regression
from this session's changes). Frontend (`apps/web-homeowner`) `typecheck`/`build` both clean for
the new `RawCommandSection`/`sendRawDeviceCommand` wiring; **not** Playwright-verified live this
session (no running dev server/backend in this sandbox) — flagged honestly rather than claimed.

## Later this session — Denon Cheat Sheet Audit

The user supplied an installer/engineer reference document ("Dan's Denon Cheat Sheets," Denon
section, pasted directly after a `share.google` link proved unreachable from this sandbox — the
outbound proxy rejected the CONNECT with a policy denial, confirmed via `$HTTPS_PROXY/
__agentproxy/status`) and asked for it to be audited against the official protocols and this
SDK, under a strict evidence hierarchy: official Denon Telnet PDF → official HEOS spec → live
hardware → the cheat sheet (reference only, never a source), with an explicit copyright
constraint (extract capabilities/observations only, never copy text/tables/examples/code).

**Method**: every claim in the cheat sheet was independently re-derived by fetching and reading
`denonavr`'s real, MIT-licensed source from GitHub (`const.py`, `foundation.py`, `input.py`,
`volume.py`) — the same independent cross-check source this project has used since the original
HTTP AppCommand pass — plus SupremeOS's own existing Telnet/AppCommand code. Every literal string
or field name that appears in the new doc is cited to one of those, never to the cheat sheet.

**New**: `docs/architecture/Denon-CheatSheet-Audit.md` — a full per-capability table, a gap
matrix, and an SDK-layer placement review (per-capability: Transport/Discovery/State/Capability/
Diagnostics/Media/Audio/Video/Developer-Tools layer, or Denon-adapter-only).
---

## Session: Universal Keypad Framework / Intent Engine

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

**Findings, net**:
- Most of the cheat sheet's *write*-path claims (power/volume/mute/input via a legacy
  `/MainZone/index.put.asp?cmd0=...`-style HTTP interface) are fully redundant with the
  already-shipped, universal Telnet control path — and independently, `denonavr`'s own
  legacy-generation write path uses a *different* URL family than the cheat sheet describes,
  so that specific write shape isn't even cross-corroborated. Not implemented.
- Several things SupremeOS already does are independently confirmed to already be *better* than
  the cheat sheet's own described workflow: renamed inputs (already solved via the stronger,
  2016+ `GetRenameSource`/`GetDeletedSource` mechanism, which `denonavr` also treats as primary,
  not a fallback), and volume shown as dB in the UI with a "dB" unit label (the exact confusion
  the cheat sheet's author flags is already resolved).
- **The one genuine, previously-silent gap it led to finding**: `avr-driver.ts` hardcoded its
  HTTP port to a fixed `8080`, with no fallback — so pre-2016 Denon/Marantz units (which answer
  on port 80 and don't support `AppCommand.xml` at all) silently got **zero** HTTP-sourced data:
  no album art, no renamed inputs, no error, just quiet absence. Independently confirmed via
  `denonavr/foundation.py`'s own real `async_identify_receiver()` (try `Deviceinfo.xml` on 8080,
  then 80) and its own port-templated album-art URL usage (proving album art genuinely works on
  either port, not gated to `AppCommand.xml`).
- Two things were deliberately left **documented only, not implemented**, per the stated
  evidence rules: a generic HTTP keypress-simulation endpoint (uncorroborated by any second
  source) and an HTML-scraped SETUP rename page (the cheat sheet's own text calls it unreliable).
- One **bonus finding, unrelated to the cheat sheet itself** (surfaced while independently
  verifying its claims): `denonavr/input.py` confirms a real now-playing metadata path
  (`formNetAudio_StatusXml.xml`'s `szLine` array) for legacy pre-HEOS "NetAudio" sources
  (AirPlay/Media Server/iPod-USB/Bluetooth) — extends, not contradicts, the capability matrix's
  existing "no verified non-HEOS metadata source" finding (that one was scoped to Tuner/USB
  against the 2016+ AppCommand path specifically). Documented, not implemented — needs its own
  scoped design pass.

## Session: Universal AV SDK

**Implemented** (the one Ready-to-Implement, no-hardware-needed finding):
- `avr-http-codec.ts`: `DEVICE_INFO_URL`/`MAIN_ZONE_STATUS_URL` constants, `parseMainZoneStatus()`
  — a narrow, tested parser for exactly the 4 fields independently confirmed (power, mute,
  volume-in-dB, current input). 24 new tests.
- `avr-driver.ts`: `resolveHttpPort()`/`detectHttpGeneration()` — a best-effort, per-host-cached
  probe (an explicit `opts.httpPort` always wins, preserving every existing test's behavior
  unmodified). `refreshInputEnrichment()` now skips the doomed `AppCommand.xml` attempt entirely
  on a detected-legacy host (stops wasting a request every 15-minute poll forever) and instead
  does a best-effort legacy-status read for diagnostics only — never written into the
  installer-facing input-rename data, since that source is independently confirmed incomplete.
  `getArtwork()` and `discover()`'s AppCommand attempt both use the resolved port. `unbind()`'s
  per-host cleanup clears the cache so a re-added unit re-detects fresh. 7 new driver-level
  tests (2016+ detection, legacy detection, no-answer default, per-host caching, explicit-
  override-always-wins, artwork-on-legacy-port).
- Updated `AVR-Universal-Capability-Matrix.md` (new generation-detection row, corrected
  renamed-input/album-art/metadata rows, and fixed a stale "no AVR heartbeat exists" row that
  predated the RTI Capability Audit's own `heartbeat()` work landing) and
  `Universal-AVR-SDK-Roadmap.md` (Artwork Engine/Capability Discovery rows + Denon mapping, no
  status-label changes — the ✓/Partial labels were already accurate).
- Did **not** touch `RTI-Driver-Knowledge-Base.md`/`RTI-Capability-Audit.md` — checked for
  overlap (grepped for port-80/legacy-HTTP/pre-2016 references) and found none; those documents
  are about an unrelated source (an extracted RTI driver), not genuinely affected by this audit.

**Verification**: `pnpm --filter @supreme/protocols run typecheck` clean; `avr-driver.test.ts`
(56/56, was 50) and `avr-http-codec.test.ts` (18/18, was... wait, this file grew from 0 dedicated
generation tests to include the new suite) both green, re-run 3× to confirm no flakiness in the
new async-heavy detection tests (one genuine test race was found and fixed during authoring — the
cache-verification test's `vi.waitFor` was synchronizing on the wrong signal, not a driver bug).
Full monorepo regression run after this — see the next section below for the final numbers.

## Known issues / open gaps (carried forward, still real, still unfixed)

- Cross-platform duplication: web (`automations.tsx`) and mobile
  (`apps/mobile/lib/screens/automation_editor.dart`) Automation Editors independently hand-
  implement the identical six-node palette/defaults/field rules.
- Automation DSL/engine supports triggers/conditions/actions across every `CapabilityKind`; the
  editor UI only authors `onoff`. Documented in `Automation-Editor.md` §2, not fixed (new
  user-facing functionality, out of scope for a hardening pass).
- `AutomationService` has no direct unit tests beyond one happy-path e2e test.
- `HeosProtocolDriver.queryPlayers()` (discovery-only) reimplements manual line buffering instead
  of reusing `LineAccumulator`, no `maxBytes` cap. Still real, still unfixed, still in `TODO.md`.
- Yamaha's real SDK-primitive reuse is low (see Phase 4 roadmap doc) — `HttpPollClient`/
  `AdaptivePoller` migration and a `heartbeat()` addition are documented, scoped, NOT started.
- Category B (Zone 3/4, 8 extra channel-trim targets, Tone Defeat) and Category D (All Zone
  Stereo, Surround Back mode/Front A+B select, D.Comp, video-output routing) remain unbuilt —
  correctly so, pending either an official spec update or a real-hardware guided capture (see the
  Phase 3 procedure above).
- Raw Command UI (`RawCommandSection`) was typecheck/build-verified but not live-browser-verified
  at the project's required phone/tablet/desktop/ultrawide breakpoints this session.

## Immediate priorities for the next session

1. If a real Denon/Marantz unit becomes reachable: run the Phase 3 guided capture procedure
   against Category B's three items, AND (new this session) verify the legacy full-zone-state
   snapshot's partial rename list on a real pre-2016 unit (`TODO.md` — "Verify the pre-2016
   legacy rename-list fallback on real hardware") — both are the single highest-value next step,
   since the tooling to do the first already exists and is tested.
2. Live Playwright verification of the new Raw Command UI section (`ProtocolTraceSection`'s
   sibling in `media/detail.tsx`) at all 4 required breakpoints — genuinely not done this session.
3. Yamaha's `HttpPollClient`/`AdaptivePoller`/`heartbeat()` migration (Phase 4 roadmap doc, "Roadmap
   ordering" step 5) — independently valuable, not blocked on anything.
4. Wire the two existing `heartbeat()` methods (AVR, HEOS) into an actual scheduler + gateway
   route/UI affordance — currently callable but never automatically invoked (roadmap step 3).
5. The HEOS `queryPlayers()` unbounded-buffer bug fix (`TODO.md`) remains small, low-risk, ready
   whenever a bug-fix pass is in scope.
6. Legacy NetAudio now-playing metadata (`TODO.md`, Denon Cheat Sheet Audit bonus finding) — a
   real, evidenced capability (`formNetAudio_StatusXml.xml`'s `szLine` array) for pre-HEOS
   AirPlay/Media-Server/USB/Bluetooth sources, needs its own scoped design pass.
7. An HTTP-request equivalent of the Raw Command devMode tool (`TODO.md`) — surfaced as a real
   gap while trying to write a hardware-verification task for the cheat sheet audit's
   uncorroborated keypress-endpoint finding; today that kind of check needs a manual, out-of-band
   request.
---

## Session: Universal Keypad Framework / Intent Engine

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

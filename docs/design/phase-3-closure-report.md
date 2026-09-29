# Phase 3 closure report

Branch `ccr-9def36f2-4lfmxo`. Companions: `docs/architecture/homeowner-contract-gate.md` (status table at
its top), `docs/architecture/adr/0102-residence-and-space-assets.md`, `docs/design/phase-2-closure-report.md`.

Decisions applied: D8 Experience orchestration is **Hub-owned**; ADR 0102 asset architecture accepted; D5
(Shape / Make Your Own) deferred. Every contract change went contract → Dart parity → simulator → client.

## Lifecycle verification (the closing gate)

**Real gateway, real transport** — `apps/new/shared/test/live_hub_lifecycle_test.dart`. It starts the
production gateway (`services/gateway/tools/test-hub.ts`: Fastify REST, `/v1/stream` WebSocket, SIL, state
feed, scene runner) and drives the production client stack against it (`HttpHubTransport`,
`WebSocketHubEventStream`, `ResidenceStreamLink`, `ResidenceState`, `CommandTracker`,
`ExperienceActivations`, `HeroImageStore`). It proves:

* a device command: requested → pending → **confirmed by the device's report arriving over the real
  stream**; the snapshot and the Hub's own REST record agree;
* a Hub-orchestrated Experience authored by the owner (description + two phases): one client request; the
  Hub sequences and sends the steps; the run completes with every step confirmed; the client's
  `experienceStatus` is Active; every step's device, read back over REST, satisfies `expectationOf`;
* a room photograph: owner upload → versioned URL in the snapshot → authenticated fetch with the Mobile
  authorization → bytes equal; a bad token gets 401.

**Simulated integration** — the same lifecycles on `SimulatedResidence` in `experience_activation_test`,
`residence_state_test`, `command_deadlines_test`, and the Mobile/Touch Panel widget tests (manual clock).

**Honest limit — read this before calling Phase 3 done.** The gateway's device layer in that test is its
built-in *mock backend*: devices that accept commands and report state through the same SIL / state-feed
path a driver uses. **No physical hardware and no specific protocol driver (Casambi, KNX, Sonos, Matter…)
was exercised.** The requirement "one real integration" is met at the gateway/transport level only; a
per-driver device-report proof remains open (see Risks).

## Completed

* **Hub (committed `95f73f8`)**: `SceneRun` state machine (`scene-runs.ts`): phases, per-capability
  deadlines with a movement-extended deadline, supersession, partial failure; `POST /v1/scenes/:id/activate`
  → 202 with the run; `GET /v1/scenes/runs/:id`; `run` frames on the stream; `Scene.description/phases`,
  derived `roomIds`; `Home.heroImageUrl`, `GET|PUT /v1/home/hero-image`, Mobile authorization + ETag/304 +
  hash-versioned URLs on hero routes. One "done" predicate (`expectationOf`) implemented in TS and Dart and
  pinned by `packages/domain-model/fixtures/state-expectation.json`. Gateway suite 103 files / 581 tests at
  that commit.
* **Client contract layer**: `SceneRun` projection, `ResidenceState` run/hero/description handling,
  `HubTransport.getBytes`, `SimulatedSceneRunner` (Dart port), simulator conformance.
* **Hub-orchestrated activation on the client**: `ExperienceActivations` (requested → pending → confirmed
  derived from device state | failed unreachable/rejected/incomplete). The client sends no device commands
  for an Experience; `CommandTracker.submitGroup` and the per-space command loop are deleted.
* **Drift gate**: `services/gateway/src/wire-shapes.e2e.test.ts` records the gateway's real wire shapes to
  `packages/domain-model/fixtures/wire-shapes.json`; `wire_conformance_test.dart` holds the simulator to it
  (required keys, no invented keys, JSON types). First run found real drift (rooms lacked
  `area/areaType/building/sortOrder`; media lacked `durationSec/positionSec/advanced`) — fixed.
* **Touch Panel** no longer draws hardcoded state. Correction to the brief: it never used
  `HomeStateRepository` — it used fixed values, no-op controls and a timer-based fake "confirmation". It now
  derives every control from a `PanelResidence` (`ResidenceState` + `CommandTracker` +
  `ExperienceActivations`), draws a control only where the room's devices declare the capability, confirms
  only from device reports, and says so when it has no residence. Provisioning areas come from the Hub's
  rooms. `shared_ui` domain controls accept unknown values instead of inventing them.
* **Devices** (`inventoryOf`, shared) and the **Device Sheet** (Mobile): In use now → Needs attention →
  function → floor → room → device; a sheet built from declared capabilities with Control's own blocks;
  reached from Control ("Physical objects"), Home's note, and a space's attention line. Floor headings only
  when floors differ. Stacked layers are opaque (a lower drawer ghosted through).
* **Authenticated photography on the client**: `HeroImageStore` (cache by versioned URL, deduped, failure
  remembered 60 s, never a stand-in) → Space page and Spaces plates.
* **Per-capability command deadlines**: onoff/brightness/media 10 s, temperature 15 s, position 90 s,
  fallback 10 s — the Hub runner's own table, parity-tested against the TS source; movement restarts a
  device's own deadline. Replaces the fixed 8 s.
* **Stream fixes found by the live test** (would have broken every real Hub): nothing ever sent the
  stream's `subscribe`, so on a real Hub `ResidenceState` received a snapshot and then no frame — every
  command would time out and no activation confirm; and a snapshot taken before the subscription went live
  could miss a change. Now: `WebSocketHubEventStream(autoSubscribeRooms:)` subscribes and waits for the
  Hub's `pong` (existing contract) before reporting `subscribed`; `ResidenceStreamLink` re-reads after every
  live subscription; Mobile uses it.
* **Verified at the closing commit** (all run in this session): `dart analyze` shared (3 pre-existing
  infos in `hub_discovery_test.dart`); shared `dart test`; `flutter analyze` + `flutter test` for
  shared_ui, mobile, touchpanel; gateway `wire-shapes` twice (deterministic). Full counts in the final
  reply.

## Intentionally deferred

* Shape / Make Your Own / Experience authoring (D5); Watch; TV focus; full panel commissioning;
  occupancy / security / sun (re-verified: `occupancy.e2e` is a lighting simulation and `security.e2e` is
  gateway hardening — neither is a sensing/alarm contract).
* Residence photograph on Home / Experiences (the Hub serves it and the store can fetch it; no surface
  draws it yet — Home's cover needs its own scrim and design pass).
* A disk cache for photographs (memory only: after a restart they refetch from the Hub, and show tonal
  plates while it is unreachable).
* Touch Panel talking to a real Hub (needs panel credentials — commissioning). It takes an injected
  `PanelResidence`; the dev flag `SUPREME_SIMULATED_RESIDENCE` supplies the simulator explicitly.
* Devices on the Touch Panel / tablet-specific layouts beyond the shared layers; battery, firmware, fault
  history in the sheet (no contract carries them).

## Backend contract gaps (still open — see the gate's status table)

`asOfRev` snapshot watermark · durable per-home `rev` and resume · `hello` · device reachability frame ·
per-capability freshness (`stateAt`) · `commandId`/`causedBy` and Hub-side command outcome · stable error
codes / idempotency · normalised climate config · floor names, room order, locative · readable
`Home.location` · a subscription acknowledgement frame (worked around with ping/pong) · per-space
permission check on scoped activation.

## Visual gaps

* Home / Experiences have no residence photograph (see Deferred); rooms without an uploaded photograph are
  tonal plates.
* No Golden Master reference exists for Devices or the Device Sheet (the prototype source is not in the
  repo); they are matched to `golden-master-implementation-map.md` §Devices and the shared control blocks.
  Checked by capture at phone, tablet, desktop and ultrawide. The phone-landscape capture does not reach
  the Devices layer (its flow found no Control entry) — **not visually verified in landscape**.
* Touch Panel screens were re-plumbed, not re-composed; their tiers were verified by widget tests, **not by
  fresh screenshots**.
* Unchanged from Phase 2: no sun line, no "Occupied/Secure", no blurred glass, synthesized wordmark weight.

## Architectural risks

1. **No per-driver device proof.** The live test's devices are a mock backend. A driver that reports state
   late, in a different shape, or not at all is only covered by the deadlines and the timeout path.
2. **Runs are in memory, single process.** They do not survive a Hub restart, and API activation no longer
   records Automation Debugger run history.
3. **No per-space permission check** on scoped activation (scene-level `scene:control` only).
4. **Two runners can drift**: the Dart `SimulatedSceneRunner` is a port of `scene-runs.ts`. Wire shapes are
   pinned (fixture) and the deadline table is parity-tested, but sequencing semantics are only pinned by
   the live test's one scenario.
5. **Subscription barrier relies on frame ordering** (the Hub handles a socket's frames in order). It is the
   existing contract but it is an inference, not a documented guarantee; a real ack frame would remove it.
6. **Remote (broker) binary transport is unverified** — `RemoteHubTransport.getBytes` is implemented, never
   run against the broker; photographs over Remote Access are untested.
7. **The simulator's required-key rule is derived from one mock-backend sample** (`?` marks keys absent from
   some device). A key the mock always sends but the contract makes optional is treated as required.
8. **Live test needs Node deps** (`pnpm install && pnpm -r build`); without them it prints a skip notice and
   passes vacuously — CI must install them.
9. `apps/new/mobile/lib/main.dart` remains the composition root and keeps growing.

## Phase 4 entry criteria

1. Owner accepts this report and decides whether to (a) require a per-driver device-report proof before
   Phase 4, or (b) accept the mock-backend level.
2. Panel commissioning is designed (identity, Hub session for a panel) so `PanelResidence.fromHub` gets a
   real transport.
3. Decision on the subscription ack frame and `rev`/resume (the gate's §3), since Watch and TV are
   long-lived subscribers.
4. Full matrix green at the starting commit; CI installs the gateway's node deps so the live test runs.
5. Design pass for the residence photograph on Home / Experiences.

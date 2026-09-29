# SupremeOS — full-chat handoff (import this into a new chat)

Written at the end of a long working session. It records what the project is, every instruction and decision
that governs the work, what was built, what was found, what is verified and what is NOT, and what to do next.
Where this file and the repository disagree, the repository wins — verify before acting.

## 0. Read this first (the five things most likely to matter)

1. **Physical-driver validation has NOT been done.** No KNX bus, shade actuator or media device was ever
   exercised. Every "passes" below means a software test against real driver code with a stand-in for the bus
   socket. Never claim physical validation passed.
2. **Nothing has been installed on the user's Android phone.** The session runs in a Linux cloud container as
   `root` with no ADB and no Android SDK; the phone and the user's PC (`G:\Documents\Claude Projects\OS-app`)
   are unreachable from it. The user must run the build/install on their own machine (commands in §9).
3. **Phase 4 has NOT started** and the user explicitly said not to start it until told.
4. **Do not run Flutter as root** (user instruction). Earlier tests in this session did (Flutter printed a
   warning); do not repeat it in a session that can avoid it.
5. **`main` now contains all the work** (merge commit `0da8cdc`, pushed). The feature branch
   `ccr-9def36f2-4lfmxo` still exists, unchanged at `7f47a5e`.

## 1. The project

SupremeOS — luxury smart-home platform by Supreme Domotics (repo `supremedomotics/OS-app`), competing with
Control4 / Savant / Crestron / RTI. Local-first (the Hub is a complete product with no internet dependency),
abstraction-first (no client speaks a protocol; everything goes through the Supreme Integration Layer, SIL).

* **Production Flutter generation:** `apps/new/{shared, shared_ui, mobile, touchpanel}`.
  `apps/mobile` and `packages/aureon-flutter` are FROZEN — never use or extend them.
* **Golden Master** (HTML prototype; source not in the repo, only `docs/design/golden-master-implementation-map.md`
  and reference JPGs in `docs/design/golden-master/`) wins for homeowner visuals.
* Repo rulebook: `CLAUDE.md` (read at the start of every session, with `PROJECT_CONTEXT.md`,
  `SESSION_HANDOFF.md`, `TODO.md`). Key rules: never fabricate data or capabilities; capability-driven, never
  protocol-driven UI; reuse shared primitives; Aureon design language (dark, gold-accented, no emoji, tokens not
  hex); verify UI at phone/tablet/desktop/ultrawide; update SESSION_HANDOFF.md and TODO.md at session end; never
  commit secrets; commit/push only when the user asks.
* Stack: TypeScript services (Fastify gateway, zod contracts in `packages/domain-model` and
  `packages/supreme-contracts`, vitest), Python services, Flutter/Dart clients.

## 2. Standing user preferences (apply in every reply)

* Advisor tone. **No agreement openers**; first sentence challenges an assumption or exposes a gap. Lead with the
  uncomfortable truth. No warm-up paragraphs. Banned phrases: "Great question", "You're absolutely right",
  "That makes a lot of sense", "Absolutely", "Definitely".
* Tag claims **[Certain] / [Likely] / [Guessing]**; if mostly guessing, say so first.
* When the user is wrong: "I disagree because … Here's what I'd do instead … The risk in your approach is …".
  Do not fold to pushback without new information.
* Cross-check any code against the whole codebase for bugs.
* Never claim tests passed unless actually run; mark UNVERIFIED otherwise. Report failures honestly.
* Commit messages end with:
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_015K66EMrQ9R8iLxqGokudaV`.
  No model identifiers in pushed artifacts otherwise. Pronouns: use they/them unless stated.
* Do not create a PR unless asked. Push with `git push -u origin <branch>`; retry network failures with backoff.
  (A failed push earlier was misreported as "up-to-date" because of a `| tail` in a retry loop — verify pushes
  with `git rev-parse HEAD origin/<branch>`.)

## 3. Phase history (all done unless noted)

| Phase | What |
|---|---|
| 1A–1C | one authoritative `SurfaceProfile`; Golden Master design foundation (tokens, fonts, theme, motion); navigation shell, `SupremeGlyph`, Control as a layer |
| 2A–2E | canonical `ResidenceState` read model (REST snapshot + `/v1/stream` deltas), `CommandTracker` lifecycle, `SimulatedResidence` (transport-boundary simulator), Home/Spaces/Space/Control/Experiences/Settings surfaces, visual-QA capture harness, contract-gate doc, ADR 0102, closure report. Commit `daa26aa`, accepted |
| 3 | see §4 |
| 3.5 | physical-driver gate → found G1 → provenance fix, see §5 |
| 4 | **NOT started** (watch, TV focus, panel commissioning, foldables, …). Entry criteria in `docs/design/phase-3-closure-report.md` |

Owner decisions: D5 Shape / Make Your Own **deferred** until an Experience-authoring contract exists; D8
Experience orchestration is **Hub-owned**; ADR 0102 (assets are entity-owned, Hub-served) **accepted**.
Architecture rules: `ResidenceState` is the only homeowner read model; no Flutter-only domain truth; physical
device reports determine confirmation; the simulator must conform to the same contracts as the gateway;
contract changes always go contract → Dart parity → simulator → client; no UI merely to fill a visual gap.
Explicitly **not** to be implemented yet: Shape/Make Your Own, Watch, TV focus, full panel commissioning,
speculative occupancy/security/sun data, homeowner features without an underlying contract.

## 4. Phase 3 — what was built

**Hub (TS)**
* `services/gateway/src/scene-runs.ts` — `SceneRun` state machine: steps queued→sent→confirmed|failed|timeout|
  skipped; run running→completed|partial|failed; phases (index groups into `steps`); per-capability deadlines
  (onoff/brightness/media 10 s, temperature 15 s, position 90 s, fallback 10 s) with a movement-extended
  deadline; supersession. `POST /v1/scenes/:id/activate {spaceIds?}` → 202 `{activated, steps, run}`;
  `GET /v1/scenes/runs/:id`; `run` frames (full idempotent snapshots) on the stream. Scenes gained
  `description`, `phases`, derived `roomIds`.
* One shared "done" predicate `expectationOf` (TS `packages/domain-model/src/state-expectation.ts` and Dart),
  pinned by `packages/domain-model/fixtures/state-expectation.json`.
* Assets (ADR 0102): Mobile authorization on hero routes, strong ETag/304, hash-versioned `heroImageUrl`,
  `Home.heroImageUrl`, `GET|PUT /v1/home/hero-image`.

**Client (Dart, `apps/new/shared`)**
* `SceneRun` projection; `ResidenceState` handles runs/hero/description; `HubTransport.getBytes` + `HubBytes`;
  `SimulatedSceneRunner` (Dart port); `ExperienceActivations` (requested→pending→confirmed derived from device
  state | failed unreachable/rejected/incomplete — the client sends no device commands for an Experience);
  `CommandTracker.submitGroup` and the per-space command loop deleted.
* `ResidenceStreamLink`: the one stream↔state wiring (frames feed state; **re-read after every live
  subscription**). `WebSocketHubEventStream(autoSubscribeRooms: ['*'])` sends `subscribe` then `ping`; the Hub's
  `pong` proves the subscription is live (no new frame type). **Bug found by the live test:** no client ever sent
  `subscribe`, so on a real Hub `ResidenceState` would go silent after its snapshot.
* Per-capability command deadlines (`command_deadlines.dart`, parity-tested against the TS table).
* `HeroImageStore` (cache by versioned URL, deduped, failures paused 60 s, never a stand-in) → Space page and
  Spaces plates (Mobile providers `heroImageStoreProvider`, `heroBytesProvider`).
* Devices: `inventoryOf` (shared) + Mobile Devices layer and Device Sheet (In use now → Needs attention →
  function → floor → room → device; sheet reuses Control's blocks; reached from Control's "Physical objects",
  Home's note, a space's attention line). Stacked layers get an opaque surface (`showSupremeLayer(stacked:)`);
  layer header kicker no longer overflows. Floor headings only when floors differ.
* **Touch Panel:** it never used `HomeStateRepository` (brief was wrong on that) — it used hardcoded values,
  no-op controls and a timer "confirmation". It now reads a `PanelResidence` (`ResidenceState` + `CommandTracker`
  + `ExperienceActivations`), draws a control only where the room's devices declare the capability, says so when
  it has no residence, and takes provisioning areas from the Hub's rooms. `PanelResidence` is injected; dev flag
  `SUPREME_SIMULATED_RESIDENCE` supplies the simulator. No real-Hub transport (commissioning deferred).
  `shared_ui` domain controls accept unknown values (nullable mood/ambient/volume, `offered` shade presets).

**Drift gate (step 8)**: `services/gateway/src/wire-shapes.e2e.test.ts` records the gateway's real wire shapes to
`packages/domain-model/fixtures/wire-shapes.json` (regenerate with `UPDATE_WIRE_SHAPES=1`);
`apps/new/shared/test/wire_conformance_test.dart` holds the simulator to it (required keys, no invented keys,
types; `object` = open). First run found the simulator missing room/media fields.

**Live-gateway lifecycle**: `services/gateway/tools/test-hub.ts` starts the production gateway (mock backend
devices) on a random port with a Mobile token; `apps/new/shared/test/live_hub_lifecycle_test.dart` (tag
`live-hub`, skips loudly if node deps missing) drives the production client stack against it: command
requested→pending→confirmed via real stream; a Hub-run two-phase Experience; a room photograph with 401 on a bad
token. **Honest limit:** the devices are the gateway's mock backend — no physical hardware, no protocol driver.

## 5. Phase 3.5 — physical-driver gate and provenance fix

Gate result: cannot be passed here (no hardware). It nevertheless found **G1**: `KnxProtocolDriver.command()` and
`SupremeKnxDriver` published the value a command asked for as if the device reported it, so a silent actuator
showed as confirmed. Cause chain: drivers recorded optimistic state → state events had no provenance → the Hub
persisted and fanned out everything → the tracker confirms on any matching state; also KNX observed the *command*
address when no status address existed, and the contract defaulted `moving` to `false`.

**Fix (Option A, explicit provenance)** — `StateProvenance` = `observed | commanded | assumed | unknown`
(`packages/domain-model/src/capabilities.ts`):
* `BackendStateEvent.provenance?` and `StateDeltaFrame.provenance` (default `observed`). Missing on a driver =
  "legacy", treated as observed (an audit item).
* Hub (`gateway/src/context.ts`, `integration-layer/src/native-adapter.ts`): only `observed` is persisted
  (`home.applyState`), fed to automations/HomeKit/voice/analytics/keypad, used to confirm scene-run steps, held in
  the adapter's `getState` cache, or sent to the Matter bridge. Non-observed events are forwarded labelled.
* KNX drivers: writes announced as `commanded`, never stored; actuated capabilities (`onoff, brightness,
  position, color, lock, fan`) are observed **only** on a declared `statusAddress`; same address for command and
  status is ambiguous and NOT feedback unless `feedbackOnCommandAddress: true`; no declared feedback ⇒ observe
  nothing, no group-read on resync, `getCapabilityConfig` → `{feedback:"none"}`. `PositionState.moving` is
  `boolean|null` (`null` = unknown; absent parses to `null`); KNX emits `moving: null`.
* Client: `ResidenceState` ignores non-observed frames without advancing `seq` (`nonObservedFrames` counter);
  a control declaring `feedback:"none"` settles `confirmed` with `ConfirmedBy.sentOnly` (`physicallyConfirmed`
  false; never a timeout); `RoomShades.motionKnown`. Lifecycle phases unchanged. `ResidenceState` core,
  `SurfaceProfile` and UI not redesigned.
* Regression tests: `gateway/src/knx-state-provenance.e2e.test.ts` (7), `shared/test/state_provenance_test.dart`
  (8); existing KNX tests that encoded optimistic behaviour were rewritten, not deleted.

Doc: `docs/design/phase-3.5-physical-validation-gate.md` (original failure, cause, model, lifecycle, evidence,
remaining hardware gaps, per-integration table with blanks).

## 6. Verification record (what was actually run)

At the Phase 3.5 fix commit: gateway 105 files / 590 tests; Dart `shared` 415 (incl. live-gateway test);
mobile 135 (+7 skipped); touchpanel 27; shared_ui 87; domain-model 87; integration-layer 60; protocols 2071 pass
with **15 pre-existing failures** in `src/matter-controller/*` (`MdnsService unavailable` — same 15 fail on the
unmodified tree here). Analyzers clean except 3 pre-existing `prefer_const_constructors` infos in
`shared/test/hub_discovery_test.dart`. `cloud/authn` typecheck fails on a missing `jose` install (unrelated).
After the merge to `main` only: typecheck of domain-model/contracts/integration-layer/protocols/gateway and 16
gateway tests (provenance, wire shapes, experience runs). **The Dart suites and the full gateway suite were NOT
re-run on merged `main`.**

Visual verification: capture harness (`apps/new/mobile/test/tools/capture_test.dart`, `CAPTURE_DIR=… flutter
test …`) checked Devices/Device Sheet at phone, tablet, desktop, ultrawide. **Not verified:** phone-landscape
Devices; Touch Panel screens by screenshot.

## 7. Git state

* `main` = `origin/main` = `0da8cdc` (merge of all 19 of my commits + 18 other commits already on `main`;
  conflicts only in `SESSION_HANDOFF.md`/`TODO.md`, resolved by keeping both).
* `ccr-9def36f2-4lfmxo` = `7f47a5e`, pushed, unchanged.
* Key commits: `daa26aa` Phase 2 closure · `95f73f8` Hub runs/assets · `6b9c71d` Dart integration ·
  `aebd36f` Touch Panel · `ac415c1` drift gate/live/deadlines/stream fix · `6a07521` Devices ·
  `d7d13f5` Phase 3 closure · `b1b6c07` gate interim · `7f47a5e` provenance.
* User's local project path (unreachable from the cloud session): `G:\Documents\Claude Projects\OS-app`.
  To sync: `git fetch origin && git checkout main && git pull` (commit/stash local changes first).

## 8. Open items, risks, gaps

**Hardware (unverified — needs real devices or the user running a harness):** KNX switching with real bus
feedback; a shade with intermediate state and completion/failure; an IP/media device (Sonos/HEOS/AVR). The
per-integration table in the gate document is blank on purpose. The user was offered an env-var-driven harness
(`KNX_HOST`, group addresses, player IP) and asked whether an emulator result is acceptable as evidence (assistant
recommended no); **unanswered**.

**Driver audit (not done):** every other driver is "legacy" (treated as observed). Shelly, Lutron, Casambi,
`integration-layer/apply.ts` and the `home-service.ts` seed still hardcode `moving: false`; CoolMaster mentions
optimistic behaviour. Single-GA KNX `temperature` (reading + setpoint on one address) deliberately left alone
(needs an installer-level decision). Sonos (G3): state read right after a command may be pre-transition, polled
every 4 s, `transitioning` mapped to `playing`.

**Other:** runs are in memory and single-process (lost on Hub restart; API activation no longer records
Automation Debugger history); no per-space permission check on scoped activation; remote (broker) binary
transport unverified; no photograph disk cache; residence photograph not drawn on Home/Experiences; Touch Panel
cannot reach a real Hub until commissioning (provisioning still has `panel-demo-1`/test-signature fakes);
subscription barrier relies on in-order frame handling (a real ack frame would be cleaner); simulator's
required-key rule is derived from one mock-backend sample; `apps/new/mobile/lib/main.dart` keeps growing;
`commanded` frames reach clients but no UI uses them; `sentOnly` has no distinct wording in the UI; the live test
needs `pnpm install && pnpm -r build` or it skips vacuously (CI must install).

**Contract gaps still open** (`docs/architecture/homeowner-contract-gate.md` status table): `asOfRev`, durable
`rev`/resume, `hello`, device reachability frame, `stateAt`, `commandId`/`causedBy`/Hub command outcome, stable
error codes, normalised climate config, floor names/room order/locative, readable `Home.location`.

## 9. Pending user tasks

1. **Install on the Android phone** (not done). On the user's PC as a **non-admin** user, from
   `apps/new/mobile` on `main` (or `7f47a5e`):
   `adb devices -l` · `flutter devices` ·
   `flutter run --release --dart-define=SUPREME_SIMULATED_RESIDENCE=true -d <device-id>`
   or `flutter build apk --release --dart-define=SUPREME_SIMULATED_RESIDENCE=true` then `adb install -r <apk>`
   (`-r` upgrades; do not uninstall an existing install without reporting first; never use legacy `apps/mobile`).
   Requested proof: git SHA, APK path, application ID, installed version, device ID; live checks of Home, Spaces,
   Control layer, Experiences, Settings, Devices, Device Sheet, one requested→pending→confirmed lifecycle, one
   failure path (the simulator supports `setSilent`/`setReachability` — check what the app exposes). No
   architecture changes during this task.
2. Answer: hardware/harness for the gate; is an emulator result acceptable; whether to bring the (already merged)
   work forward to Phase 4.

## 10. Practical notes for the next session

* Environment: Flutter at `/opt/flutter/bin` (was run as root — avoid); Node 22, pnpm 10, vitest 2.1.9.
  Gateway/tools consume **built** `dist` of workspace packages: after changing `domain-model`, `contracts`,
  `integration-layer` or `protocols`, run `pnpm --filter <pkg> build` before gateway tests.
* Bash tool in the cloud session was intermittently rejected by an auto-mode classifier; long piped commands
  failed more often than short ones.
* Pitfalls: never `dart format` whole trees; `flutter test` modifies `pubspec.lock` (revert with
  `git checkout apps/new/*/pubspec.lock`); `surface_authority_test` forbids raw `MediaQuery.of` outside
  `SurfaceScope`/`MotionScope`; `PageMetrics` clashes with Flutter (use `PageGeometry`); `pkill -f` can match
  its own shell; `whenComplete(() => map.remove(k))` on a future stored in that map deadlocks (use a block body);
  `Process.start` resolves a relative executable against `workingDirectory`; `fmtTemp` already appends `°`;
  a ws client that sends `subscribe` before the stream is up misses earlier changes (hence the post-subscribe
  re-read); widget tests: advance the manual clock inside `tester.runAsync` (see `mobile/test/support/sim_app.dart`,
  `touchpanel/test/support/panel_rig.dart`).
* Key docs: `docs/design/phase-3-closure-report.md`, `docs/design/phase-3.5-physical-validation-gate.md`,
  `docs/design/phase-2-closure-report.md`, `docs/architecture/homeowner-contract-gate.md`,
  `docs/architecture/adr/0102-residence-and-space-assets.md`, `docs/design/golden-master-implementation-map.md`.

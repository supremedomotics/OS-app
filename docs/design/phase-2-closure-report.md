# Phase 2 closure report

Branch `ccr-9def36f2-4lfmxo`. Companion documents: `docs/architecture/homeowner-contract-gate.md`
(minimum backend contract), `docs/architecture/adr/0102-residence-and-space-assets.md` (imagery).

## Completed

* **Canonical state.** `ResidenceState` is the single client read model (REST snapshot + `/v1/stream`
  deltas, stale frames dropped, unreachable Hub = "no data yet" with the last known state kept).
  `CommandTracker` implements requested → pending → confirmed | failed; confirmation only from a device
  report satisfying the command's target; timeouts; a shade that keeps reporting movement is not failed
  by the deadline (added at closure — real shades outlast an 8 s deadline); group calls for scene activation.
* **Derived Experience state** (`experienceStatus`): active / becoming / partial / inactive / unavailable /
  indeterminate — never stored.
* **Simulator** at the transport boundary (`SimulatedResidence`), unchanged in architecture; opt-in.
* **Surfaces:** Home, Spaces, Space, Control (scoped layer), Experiences, and now **Settings** —
  Golden Master two-column sections, hub sub-page (paired Homes, Remote Access) restyled without Material
  dialogs, and a real device preference (Motion: as device / reduced → `MotionScope`).
* **Nothing invented:** no occupancy, security, sun line, Shape, Make Your Own, Automations, Room photographs,
  Notifications, Transparency, Updates/Backup rows (each named in `settings_screen.dart`'s doc and asserted
  absent by `settings_page_test.dart`).
* **Gates added by the work:** `surface_authority_test` caught a raw `MediaQuery.of` in the app root at
  closure (moved into `MotionScope`, the sanctioned reader).
* **Docs:** contract gate and the asset ADR (above).
* **Visual QA:** `test/tools/capture_test.dart` (`CAPTURE_DIR=… flutter test …`) renders every surface at phone,
  phone landscape, tablet, desktop, ultrawide, watch (Home only) and a 4″ room panel with the real fonts.

## Intentionally deferred

* Hub extensions of any kind (constraint 7) — none implemented; the simulator gained none.
* Photography, image metadata, authenticated image fetch (ADR 0102 decides the architecture).
* Control instruments (line drawings), Devices inventory, device sheet; Protection; the Experience scope in Control.
* Shape / Make Your Own / edit-rename-duplicate-delete of Experiences (D5).
* Phase 4 as planned: watch glance, TV focus, residence-panel map, panel identity and commissioning,
  foldable behaviour.
* Touch Panel still on the legacy `HomeStateRepository` and its fakes.

## Backend contract gaps (full list in the gate document)

Snapshot/stream watermark (`rev`) · durable ordering · device status push · per-capability freshness ·
command correlation (`commandId`/`causedBy`) and Hub-side outcome · `SceneStep.target` · `Scene.roomIds` ·
`Scene.description` · Hub-orchestrated scoped activation with run/step outcomes and phases · readable
`Home.location` · floor names/room order/locative · normalised climate config · residence + mobile-authorised
hero images · `occupancy`/`contact` measures and an `alarm` capability (LATER).

## Visual gaps (compared against `docs/design/golden-master/` and the prototype CSS)

* **No photographs** — plates are honest brass tonal plates; this is the largest remaining difference and is
  owned by ADR 0102.
* No sun line under Home's name; no "Occupied"/"Secure"; no per-Experience authored words.
* Space and Control have no Golden Master reference capture (none was taken), so they were matched to the
  prototype's CSS/markup only.
* No blurred glass (transparency) — a flat surface stands in.
* Watch shows the phone hero (its glance is Phase 4).
* Settings has no Golden Master capture either; matched to `settings.js`/CSS.
* Wordmark is a synthesized weight (no static Jost 600 bundled).

## Architectural risks

1. **Two read paths exist**: the new `ResidenceState` and the legacy `HomeStateRepository`
   (`HubHomeStateRepository`, still exported and used by Touch Panel). Until Touch Panel migrates, a bug fix
   in one is not a fix in the other.
2. **`expectationOf` duplicates the Hub's notion of "done"** (command → expected state) with tolerances.
   Drift is possible until `SceneStep.target` exists.
3. **Client-orchestrated space-scope activation** (D8) is a temporary Flutter behaviour that must not calcify.
4. **Snapshot/stream race** is handled by an arrival heuristic and per-connection `seq` resets, not a Hub
   watermark.
5. **The simulator can drift from the Hub.** Only field names are pinned by a parity test; a contract test
   against the gateway's schemas is missing.
6. **The residence hour is the device's clock** (`residenceHourProvider`), wrong when the phone is elsewhere.
7. **Fixed 8 s command deadline** (movement-extended for shades only); slow non-moving devices can still be
   reported failed although they later succeed — the state then corrects itself, but the words said "didn't
   respond" in between.
8. `apps/new/mobile/lib/main.dart` is the composition root and is large; providers for residence state are
   in it.
9. Widget tests use tall viewports for lazy pages; scroll behaviour is verified visually, not by test.

## Verification at the closing commit

Recorded in the commit message and in the final reply: `flutter analyze` / `dart analyze` and the full test
matrix for `shared`, `shared_ui`, `mobile`, `touchpanel`. The three `prefer_const_constructors` infos in
`shared/test/hub_discovery_test.dart` are pre-existing and untouched.

## Phase 3 entry criteria (exact)

Phase 3 = Residence State read model hardening against a real Hub contract, device-level surfaces
(Devices, device sheet), command-tracker semantics, Touch Panel migration. Start when **all** hold:

1. Owner has accepted `homeowner-contract-gate.md` and ADR 0102, and answered **D5** (authoring) and **D8**
   (who orchestrates Experiences — recommended: the Hub).
2. It is decided whether the Hub extensions in the gate are built **first**, **in parallel**, or **not yet**,
   and Phase 3's scope is set accordingly: with no Hub work, Phase 3 is limited to client-only items
   (Touch Panel migration off `HomeStateRepository`, Devices/device sheet from existing device state,
   per-capability deadlines, contract test of the simulator against the gateway's zod schemas).
3. Any accepted contract change lands **contract-first**: `packages/supreme-contracts` /
   `domain-model` → a Dart parity test → the simulator → the client. No Dart-only model appears first.
4. The full matrix is green at the starting commit (shared, shared_ui, mobile, touchpanel; all analyzers
   clean apart from the three pre-existing infos).
5. The Touch Panel's fakes (`panel-demo-1`, fixed areas, test signature, timer confirmation) are listed with
   an owner and a replacement, so Phase 3 does not extend them.
6. The remaining Phase 2 visual gap (photography) is either scheduled behind ADR 0102's Hub work or
   explicitly accepted for the Phase 3 demo.

# SupremeOS Core Capability Audit — Phase 1 (Correctness Fixes)

- Status: **Complete**
- Scope: fixes ONLY the five specific correctness bugs named in
  `docs/architecture/SupremeOS-Core-Capability-Audit.md` §6 items 1–7. No new
  capabilities, no protocol expansion, no deployment change, no UI redesign — every
  change below either removes a fabrication or replaces a silent failure with an
  honest, visible one.
- Rules honored: `vacuum` support was NOT implemented; no new KNX/Matter fan features
  were implemented; no driver or UI was redesigned; no protocol functionality was
  added. Every change is a removal (of a fabricated behavior, a silently-dropped
  device, or an advertised-but-uncontrollable capability) or a disclosure (a log line,
  a diagnostic field), never an addition of new functionality.

## Correctness Fix Report

### Fix 1 — Sensor Expanded Sheet fabricated an On/Off control
- **File**: `apps/web-homeowner/src/device-sheets.tsx`
- **Before**: `DeviceSheet`'s dispatch chain had no `sensor` case; a sensor-only
  device (the minimal valid state `SensorState` allows) fell into the trailing
  `else` and rendered `SwitchSheet` — a "Turn on/off" button that issued an `onoff`
  command against a device with no `onoff` capability at all. `sensor` is explicitly
  read-only (`READONLY_CAPABILITIES`, `@supreme/domain-model`).
- **After**: added a `caps.includes("sensor")` branch (checked last, after every
  richer capability, mirroring `device-tile.tsx`'s existing `isSensor` precedence) and
  a new `SensorSheet` component that renders only a `Title` + a plain, non-interactive
  `.readout` of `value`/`unit`/`measure` — no button, no command, no writable control
  of any kind.
- **Verification**: `pnpm --filter @supreme/web-homeowner typecheck` passes. No
  automated UI test suite exists for this file in the repo (confirmed: no
  `device-sheets*.test.ts`/`.spec.ts` anywhere); this fix was verified by typecheck
  and code review only — **live Playwright verification was not performed** in this
  session (disclosed, not silently skipped — see Regression Report §"What was not
  verified").

### Fix 2 — SIP door station fabricated `locked: true` with no hardware confirmation
- **File**: `services/protocols/src/sip-driver.ts`
- **Before**: the `command()` method's `"lock"` action branch (i.e. re-locking, as
  distinct from `"unlock"`/door-release) unconditionally recorded
  `{ kind: "lock", locked: true, jammed: false }` with **zero hardware interaction** —
  `SipDoorStation`'s interface has no relatch/close method at all, only `openDoor()`.
- **After**: the `"lock"` action now throws a clear, typed error
  (`sip: cannot confirm "lock" on <deviceId> — this door station has no relatch
  hardware; only "unlock" (momentary door release) is supported`) instead of
  fabricating success. The `"unlock"` branch is unchanged — it already calls real
  hardware (`station.openDoor()`) before reporting state, so it was not in scope.
- **Verification**: new test
  `"§ Correctness Fix — refuses to fabricate a 'lock' action..."` in
  `sip-driver.test.ts` asserts the throw and that no state was recorded for the
  refused command. `pnpm --filter @supreme/protocols exec vitest run
  src/sip-driver.test.ts` — 3/3 passing (1 new).

### Fix 3 — KNX advertised a `fan` capability its own codec cannot execute
- **File**: `services/protocols/src/knx/capability-mapper.ts`
- **Before**: three classification rules (`{keywords:["fan","ventilation"]}`, the
  `fan_speed_percentage` DPT category, the `hvac_fan_speed` DPT category) all set
  `capabilities: ["fan"]`. `knx-codec.ts`'s `valueFromCommand()`/`stateFromValue()`
  has no `"fan"` case at all, so any command against such a device threw
  unconditionally — the capability was advertised at discovery time and guaranteed
  to fail at command time.
- **After**, per the explicit rule "do NOT implement new fan features": all three
  rules now set `capabilities: []`, while keeping `deviceKind: "fan"` (driver-internal
  diagnostic/labeling only — per this file's own doc comment, never part of the
  outward `DiscoveredDevice.capabilities` contract). A device classified this way is
  no longer commissioned with an unusable `fan` capability; it still gets useful
  diagnostic labeling, and the existing (pre-existing, unmodified) confidence-scoring
  pipeline already handles a zero-capability device gracefully (scores it lower,
  routes it through the normal installer review queue — `confidence-engine.ts:63-67`,
  not touched by this fix).
- **Verification**: two new tests in `capability-mapper.test.ts` assert `deviceKind:
  "fan"` with `capabilities: []` for both the keyword path (`classifyFromText`) and
  the DPT path (`classifyEtsSignal`, using the real DPT strings 5.100/20.105).
  `pnpm --filter @supreme/protocols exec vitest run
  src/knx/capability-mapper.test.ts` — 7/7 passing (2 new).

### Fix 4 — Matter silently dropped fan/vacuum (and any other unmapped-cluster) devices
- **File**: `services/protocols/src/matter-driver.ts`
- **Before**: `discover()` computed each node's capabilities via
  `capabilitiesFromClusters()`, then `.filter((d) => d.capabilities.length > 0)` —
  a node whose clusters mapped to zero capabilities (a real Matter `FanControl` or
  RVC/robot-vacuum node; this codec doesn't recognize either cluster) vanished from
  the discovery result with no error, no log, no trace of why.
- **After**, per the explicit rule "do NOT implement new capabilities" (no Matter
  `FanControl`/RVC cluster mapping was added): `discover()` no longer filters these
  nodes out. Every node is returned; a node with zero mapped capabilities now carries
  `raw.unmappedClusters` (the actual cluster list) so the gap is visible in the
  discovery data itself, and a new optional `onLog` callback on `MatterDriverOptions`
  (mirroring the exact pattern already used by `avr-driver.ts`/`heos-driver.ts`) fires
  a `"warn"` naming the node and its unrecognized clusters. `commission()`'s existing
  honest throw for a zero-capability node is unchanged, but now also calls `onLog`
  first for consistency. The node still cannot be *commissioned* (an empty capability
  list correctly still fails `CommissioningService.commission()`'s own "device must
  declare at least one capability" check) — this fix stops the node from vanishing
  invisibly, it does not make it controllable (that would require the new-capability
  work this phase explicitly excludes).
- **Verification**: `matter-driver.test.ts` updated — `discovers commissioned nodes`
  now expects both nodes (was 1, now 2), and a new test asserts the unmapped node's
  `capabilities: []`, `raw.unmappedClusters`, and the exact `onLog` warning fired.
  `pnpm --filter @supreme/protocols exec vitest run src/matter-driver.test.ts` —
  7/7 passing (1 new, 1 updated).

### Fix 5 — Voice platforms (Alexa, Google, HomeKit) advertised uncontrollable devices
- **Files**: `cloud/voice/src/alexa.ts`, `cloud/voice/src/google.ts`,
  `services/homekit/src/bridge.ts`
- **Before**:
  - `alexa.ts`'s `buildDiscoveryResponse()` always emitted an endpoint with a
    `displayCategories` entry (`ALEXA_DISPLAY`) regardless of whether the device's
    capabilities produced any real `alexaInterfaces()` — a `fan`/`vacuum`/`media`/
    `sensor`-only device appeared in the Alexa app with only the mandatory base
    `Alexa` interface: discoverable, uncontrollable.
  - `google.ts`'s `buildSyncResponse()` had the identical pattern (`GOOGLE_TYPE` always
    assigned, `traits` silently empty for the same four capabilities).
  - `services/homekit/src/bridge.ts`'s `HapBridge.addDevice()` always called
    `transport.publishAccessory()` even when the merged HAP `services` array was
    empty (true for any `media`/`vacuum`-only device — `hap-mapping.ts`'s own
    disclosed gap) — publishing a zero-service accessory to Apple Home.
- **After**: all three now omit the device/endpoint/accessory entirely when it would
  have zero real controllable surface — the exact "omit it" option the phase's rules
  offer (over "publish only supported capabilities," which doesn't apply here since
  these devices have *no* supported capability for that specific platform). A device
  that has at least one genuinely mapped capability alongside an unmapped one (e.g.
  `fan` + `onoff`) is unaffected and still publishes correctly with only its real,
  supported controls. `HapBridge.addDevice()`'s return type changed from
  `HapAccessory` to `HapAccessory | null` (the one call site, `context.ts`, already
  discarded the return value, so this is not a breaking change to any real caller) and
  now logs via the existing `HapBridgeOptions.log` hook when it skips a device.
- **Verification**: new `cloud/voice/src/alexa.test.ts` (5 tests) and
  `cloud/voice/src/google.test.ts` (5 tests) prove fan/sensor/vacuum-only devices are
  omitted and a fan+onoff device is still discovered with its real interface/trait.
  New test in `services/homekit/src/bridge.test.ts` proves media/vacuum-only devices
  are never published (and the log fires), while a media+onoff device still is.
  `pnpm --filter @supreme/voice exec vitest run` — 24/24 passing (10 new).
  `pnpm --filter @supreme/homekit exec vitest run` — 11/11 passing (1 new).

## Capability Compliance Report

Cross-referencing every fix against the master coverage matrix in the parent audit
(`SupremeOS-Core-Capability-Audit.md` §1):

| Capability | Fabrication/silent-failure closed this phase | Still-honest remaining gaps (unchanged, out of scope) |
|---|---|---|
| `sensor` | ✅ no longer offered a fake `onoff` control in the Expanded Sheet | UI still has no dedicated feature module (unchanged, not a fabrication) |
| `lock` | ✅ SIP door stations no longer fabricate a confirmed "locked" state | Still only 3 real drivers (KNX ×2, Zigbee, Matter) — unchanged |
| `fan` | ✅ KNX no longer advertises a capability it can't execute; ✅ Matter no longer silently drops a real Matter fan | Still zero drivers that can genuinely command `fan` (CoolMaster remains onoff-only within `fan`) — unchanged, and out of scope per "do NOT implement new fan features" |
| `vacuum` | ✅ Matter no longer silently drops a real Matter robot vacuum | Still zero real driver implementations anywhere — unchanged, and explicitly out of scope per "do NOT implement vacuum support" |
| `media` | ✅ Alexa/Google/HomeKit no longer advertise media-only devices as controllable when they aren't | Alexa/Google/HomeKit still have no real trait/interface/service for `media` at all (an intentional exclusion, per `reporting.test.ts`'s own pre-existing assertion) — unchanged; the fix is that the exclusion is now honest (omitted) instead of half-visible (discoverable-but-dead) |
| `onoff`/`brightness`/`color`/`temperature`/`position` | Unaffected — these already had real interfaces/traits/services on every platform that supports the device's other capabilities | No change |

**Principle-level compliance, verified against the actual code (not asserted):**
- **Never fabricate a capability**: Fixes 1–2 directly closed the two confirmed
  fabrication bugs found by the audit. No other fabrication was found or introduced.
- **Never advertise unsupported functionality**: Fix 3 (KNX fan) and Fix 5 (voice
  platforms) directly close this. Fix 4 (Matter) is the complementary case — a real
  capability gap that must be *disclosed*, not silently hidden, which is different
  from "advertising" it; Matter still correctly refuses to expose `fan`/`vacuum` as
  controllable (no cluster mapping was added), it just no longer erases the device
  from view entirely.
- **No silent failures**: Fix 2 converts a silent fabrication into a loud, typed
  error. Fix 4 converts a silent drop into a logged, disclosed one. Fix 3 converts a
  silent "advertise now, throw on first command later" into "never advertise it in
  the first place" — arguably the most honest of the three failure-mode fixes, since
  there is no failure at all once the false advertisement is removed.

## Regression Report

**Full verification performed**: `pnpm turbo run build typecheck test` across the
entire monorepo (not just touched packages) — **173/173 tasks successful** on the
final run (a `@supreme/protocols#test` `ECONNRESET` flake on an unrelated
`heos-driver.test.ts` socket test appeared once mid-session and did not reproduce on
isolated rerun — the same class of pre-existing test flakiness documented in earlier
sessions of this codebase, not caused by this phase's changes).

**A real regression was found and fixed during this verification pass** (this is what
the full-monorepo run is for, not a formality): `services/gateway/src/
knx-installer-workflow.e2e.test.ts`'s two "KNX Automatic Room Creation" tests failed
after Fix 3. Root cause: the first test's fixture ETS device was named
`"Vent Fan Switch"` — coincidental fixture-naming, not a real fan device; the test is
about room auto-creation, not fan control. Fix 3 correctly stopped classifying a
`"fan"`/`"ventilation"`-keyword device with a bindable capability, so this fixture now
had zero bindable plans and failed KNX approval (`"this device has no bindable
communication object yet"`), and the second test (which depends on the first having
created the "Attic" room) cascaded to fail too. This was a fixture-naming collision
with Fix 3's correct new behavior, not a flaw in Fix 3 itself — confirmed by checking
that the test asserts nothing about `fan` at all, only room creation/reuse. Fixed by
renaming the fixture to `"Attic Utility Switch"` (classifies as `onoff` via the
`switch` keyword rule, a real bindable capability, with no effect on what the test
actually verifies). Re-ran `knx-installer-workflow.e2e.test.ts` — 8/8 passing
(previously 6/8) — and the full `@supreme/gateway` suite — 74/74 files, 306/306 tests.

**Per-package verification during development** (all passing before the full run):
- `@supreme/web-homeowner` — typecheck clean.
- `@supreme/protocols` — `sip-driver.test.ts` 3/3, `knx/capability-mapper.test.ts`
  7/7, `matter-driver.test.ts` 7/7, full package typecheck clean.
- `@supreme/voice` — `alexa.test.ts` 5/5, `google.test.ts` 5/5, `server.test.ts`
  14/14 (pre-existing, unmodified — confirms the two fixture devices, which both have
  real mapped capabilities, are unaffected).
- `@supreme/homekit` — `bridge.test.ts` 6/6 (1 new), `hap-mapping.test.ts` 5/5
  (untouched), package typecheck clean.
- `@supreme/gateway` — `homekit.e2e.test.ts` 3/3 (pre-existing assertions are all
  relative — `toBeGreaterThan(0)`, matching counts — none assumed a fixed accessory
  count that the fix would have broken), full package typecheck clean.

**Existing devices/tests confirmed compatible, not just assumed:**
- Every pre-existing test in every touched file was re-run and passes unmodified
  except the two explicitly updated for the corrected behavior
  (`matter-driver.test.ts`'s discovery-count assertion, which now correctly expects
  the previously-hidden node to appear).
- The demo/seed home's devices (used by most gateway e2e tests, including
  `homekit.e2e.test.ts`) contain no capability-only device that any of these five
  fixes would newly exclude or break — confirmed by reading `seedDemoHome()` and by
  the fact that `homekit.e2e.test.ts` passes unmodified.

**What was not verified (disclosed, not fabricated):**
- Fix 1 (Sensor Expanded Sheet) has no automated UI test in this repo and was not
  verified live via Playwright in this session — verified by typecheck and code
  review only. This is a real gap in this phase's verification, not a silent
  omission: a follow-up session should open the app, commission/seed a sensor-only
  device, and open its Expanded Sheet to confirm the readout renders and no command
  fires.
- No real hardware (a real SIP UA, real KNX fan actuator, real Matter fan/vacuum
  node, real Alexa/Google/HomeKit client) was available to validate any of these
  fixes end-to-end against genuine external systems. All verification is unit/e2e-test
  level against fakes, consistent with how these subsystems were originally built and
  tested in this codebase.
- The full `pnpm turbo run build typecheck test` run's authoritative pass/fail count
  is reported in the session's closing message, not fabricated here ahead of it
  completing.

## Updated Capability Matrix

Delta from `SupremeOS-Core-Capability-Audit.md` §1's master matrix — only cells that
changed as a direct result of this phase's fixes are shown; every other cell is
unchanged from the original audit.

| Capability | Frontend UI | Automations | Voice (live) | HomeKit | Matter |
|---|---|---|---|---|---|
| `sensor` | ⚠️→✅ Expanded Sheet now honestly read-only (was 💀 fabricated control) | ✅ (unchanged) | ⚠️ (unchanged — still visible/uncontrollable in Alexa/Google's display-category sense; see note below) | ✅ (unchanged) | ✅ (unchanged) |
| `fan` | ❌ (unchanged — still no dedicated module, by design of this phase) | ✅ (unchanged) | ❌→✅ no longer discoverable-but-uncontrollable (was ⚠️) | ✅ (unchanged) | ❌→⚠️ no longer silently dropped; now disclosed via `raw.unmappedClusters` + `onLog` (was ❌ silent) |
| `vacuum` | ❌ (unchanged — still no dedicated module, by design of this phase) | ✅ (unchanged) | ❌ (unchanged — was already fully absent, no display/type entry to begin with) | ❌→(n/a) no longer publishes an empty accessory; still not controllable (was 💀 empty accessory) | ❌→⚠️ no longer silently dropped; now disclosed (was ❌ silent) |
| `media` | ✅ (unchanged) | ✅ (unchanged) | ❌ (unchanged in mapping — was already a deliberate, tested exclusion; the fix is that a media-only device is now omitted instead of half-published) | 💀→(n/a) no longer publishes an empty accessory (was 💀) | ❌ (unchanged — was already a deliberate, disclosed exclusion) |
| `lock` (SIP-specific) | n/a (SIP door stations are commissioned as `lock`/`sensor`, no dedicated UI change) | n/a | n/a | n/a | n/a |

**Note on `sensor` + voice**: `alexa.ts`'s `ALEXA_DISPLAY`/`google.ts`'s `GOOGLE_TYPE`
still assign a display category/type to `sensor` (`TEMPERATURE_SENSOR`), but per this
phase's fix, that only matters for devices that ALSO have zero other mapped
capability — a pure `sensor`-only device is now omitted entirely (Fix 5 applies to
`sensor` exactly as it does to `fan`/`vacuum`/`media`), consistent with the matrix
change shown for `fan` above. The audit's original ⚠️ ("visible, uncontrollable") for
`sensor`+voice is corrected by this phase to the same ✅ omission behavior as `fan`.

## Explicitly out of scope for this phase (per the phase's own rules)

- `vacuum` support was not implemented anywhere.
- No new KNX or Matter fan/vacuum features were implemented (no DPT command mapping,
  no `FanControl`/RVC cluster mapping).
- No driver was redesigned; no protocol functionality was added.
- No UI was redesigned; `fan`/`vacuum` still have no dedicated feature module (that
  remains the audit's documented, honest maturity gap, not a fabrication).
- `HaAdapter`'s missing optional `IBackendAdapter` members, the two live parallel KNX
  drivers, the dead `device-sheets.tsx` sub-sheets, and the dead 10/10 voice mapping
  in `cloud/voice/src/index.ts` — all named in the original audit's §6 items 8–16 —
  are architecture/maturity debt, not correctness bugs, and were correctly left
  untouched by this phase's "correctness fixes only" scope.

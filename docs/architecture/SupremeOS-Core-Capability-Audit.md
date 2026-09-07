# SupremeOS Core Capability Audit

- Status: **Complete** (research only — no code changes made as part of this audit)
- Scope: every layer that touches the `CapabilityKind` vocabulary — protocol drivers
  (`services/protocols`), the SIL/adapter layer (`services/integration-layer`), the
  homeowner frontend (`apps/web-homeowner`), and cross-cutting consumers (automations,
  voice, HomeKit, Matter, the Universal Keypad Framework).
- Method: the vocabulary itself was read directly; coverage across the four layers was
  researched in parallel by four independent agents, each required to cite `file:line`
  for every claim and to state "not found" / "not fully verified" rather than guess.
  This document cross-references and ranks their combined findings. No fabricated
  claims — every finding below traces to a specific file and line.

## 0. The vocabulary

`packages/domain-model/src/capabilities.ts:17-28` defines exactly **10** capabilities,
each with a Zod state shape and (except `sensor`, which is read-only per
`READONLY_CAPABILITIES`, `capabilities.ts:236`) a Zod command shape:

`onoff`, `brightness`, `color`, `temperature`, `position`, `media`, `lock`, `fan`,
`vacuum`, `sensor`.

`fan` and `vacuum` are the two newest additions (confirmed by code comments and by
every downstream layer independently showing them as the least-supported two
capabilities — see §5). Every state shape is **flat** — no nested objects — which
turns out to matter: it's why the automations engine's generic field reader works
perfectly for all 10 with zero special-casing (§4.1).

## 1. Master coverage matrix

Built by cross-referencing all four sub-audits. "✅" = genuinely working end to end;
"⚠️" = partial/degraded; "❌" = absent; "💀" = present but unreachable (dead code) or
actively fabricated (worse than absent).

| Capability | Real drivers | SIL (apply.ts / HA mapper) | Frontend UI | Automations | Voice (live) | HomeKit | Matter |
|---|---|---|---|---|---|---|---|
| **onoff** | ✅ ~15 drivers | ✅ | ⚠️ generic only, no Premium page | ✅ | ✅ | ✅ Switch | ✅ OnOff |
| **brightness** | ✅ several | ✅ | ⚠️ works, but outside `features/` convention | ✅ | ✅ | ✅ Lightbulb | ✅ LevelControl |
| **color** | ⚠️ 5 drivers, only 1 with real structural config | ⚠️ HA never *discovers* it (§3.2) | ⚠️ no card swatch; outside `features/` | ✅ | ✅ | ✅ (shared w/ brightness) | ✅ ColorControl |
| **temperature** | ⚠️ 1 full (CoolMaster), 2 basic-only (KNX) | ❌ apply.ts drops advanced/dual-setpoint fields (§2.1) | 💀 dedicated sheet exists but unreachable; Premium page works | ✅ | ✅ | ✅ Thermostat | ❌ unmapped |
| **position** | ✅ 7 drivers | ✅ | ⚠️ disclosed gap, no Premium page | ✅ | ✅ | ✅ WindowCovering | ✅ WindowCovering |
| **media** | ✅ 8 drivers, action coverage varies widely | ✅ | ✅ most complete UI module | ✅ | ❌ (tested no-op) | ❌ (disclosed, ungated) | ❌ (disclosed, incompletely) |
| **lock** | ⚠️ 3 real + 1 **fabricated** (SIP, §2.5) | ✅ | 💀 dedicated sheet dead, but Premium page live | ✅ | ✅ | ✅ LockMechanism | ✅ DoorLock |
| **fan** | ❌ only on/off (CoolMaster); KNX discovery promises it, codec can't deliver (§2.4) | ✅ (simulation only) | ❌ no dedicated module | ✅ | ⚠️ visible, uncontrollable | ✅ Fanv2 | ❌ not even the cluster referenced |
| **vacuum** | ❌ **zero real drivers** | ✅ (simulation only) | ❌ no dedicated module | ✅ | ❌ fully absent | ❌ (disclosed) | ❌ not even the cluster referenced |
| **sensor** | ✅ many, read-only | ✅ | 💀 **fabricates an onoff control** (§3.3) | ✅ | ⚠️ visible, uncontrollable | ✅ TemperatureSensor (fixed, regardless of `measure`) | ✅ 3 clusters |

**Headline finding:** the capability *vocabulary* — the type system, the automations
engine, and the generic UI sheets — is consistently 10/10. Every layer that sits
*between* the vocabulary and real hardware or a real external platform degrades, and
`fan`/`vacuum` (the newest capabilities) are the least finished at almost every layer
simultaneously. `vacuum` in particular has a complete state schema, a complete command
schema, a working (simulated) SIL path, a working generic UI sheet, and full
automation-field support — for a capability **no real driver in the fleet
implements**. It is fully "audited-and-approved" at the type-system level for
hardware that doesn't exist yet in this codebase.

## 2. Protocol driver layer (`services/protocols`)

22 driver classes were audited against `INativeProtocolDriver`
(`services/integration-layer/src/protocols/driver.ts:55-205`).

### 2.1 `vacuum` has zero real implementations
A repo-wide search for `"vacuum"` in `services/protocols/src` returns no matches
outside `capabilities.ts` itself. No driver declares, maps, or handles it. The only
place `vacuum` "works" is the in-process simulation model
(`services/integration-layer/src/apply.ts`), which every demo/unbound device uses.

### 2.2 `fan` is promised by discovery but guaranteed to fail on command
`SupremeKnxDriver`'s unified device mapper
(`services/protocols/src/knx/capability-mapper.ts:59,119,128`) can tag a discovered
device with the `fan` capability from functional-block/keyword matching — but the
shared `knx-codec.ts`'s `valueFromCommand()`/`stateFromValue()` has **no `"fan"` case
at all**. Any fan command on such a device throws "unsupported command for fan"
unconditionally. This is a concrete, reproducible bug, not a documented gap:
discovery advertises a capability execution cannot honor.

### 2.3 CCT-only fixtures likely render broken RGB controls
Five drivers declare `color` with real hue/saturation-vs-CCT distinctions in their
underlying protocol (DALI, both KNX drivers, Matter, Zigbee) — but **none of them**
produce a `ColorCapabilityConfig` (the ADR 0017 structural signal for "this fixture is
CCT-only, don't show RGB controls"). Per
`services/protocols/src/core/capability-engine.ts:72`, the absence of `colorConfig`
makes `supportsRGB` default to `true`. A CCT-only DALI/KNX/Matter/Zigbee fixture
therefore likely renders RGB hue/saturation controls in the UI that throw when used.
Casambi (`services/protocols/src/casambi/entity-mapper.ts:80-88`) is the **only**
driver in the fleet that produces a real `ColorCapabilityConfig`, and it delivers it
through discovery-time `DiscoveredDevice.capabilityConfig`
(`casambi/discovery-engine.ts:48-55`), not the runtime `getCapabilityConfig()` call
every other feature-complete driver uses — a second, narrower inconsistency.

### 2.4 `temperature` has no structural config outside CoolMaster
Only `coolmaster-driver.ts:191-200` implements `getCapabilityConfig()` for
temperature; the two KNX drivers report only a bare setpoint with no mode/advanced
support (`knx-codec.ts`). Matter doesn't map `temperature` to any cluster at all
(`matter-codec.ts:114-116` — falls to `default: null`, and `matter-driver.ts:158-160`
turns that into a thrown command-time error, which is at least honest).

### 2.5 A real "fabrication" bug: SIP door station's `lock` action
`services/protocols/src/sip-driver.ts:112-119` — the `"lock"` action sets local state
to `{ locked: true }` **without any real hardware call**. There is no relatch API on
`SipDoorStation`. This is the exact class of bug CLAUDE.md's "never fabricate" rule
exists to prevent: a command the UI shows as succeeded, with no corresponding
real-world effect.

### 2.6 Three media drivers silently no-op unsupported actions instead of throwing
`airplay-driver.ts:125-138`, `apple-tv-driver.ts:187-214`, and
`sonos-driver.ts:126-138` each use an inline `switch` with no `default` case for
~5 of `media`'s 13 actions, then unconditionally call `refresh()` regardless — the
caller gets no error and no effect. Every other media driver (avr, heos, yamaha, wiim,
devialet, mqtt) routes translation through a `commandToX()` function that returns
`null` for an unsupported action, which the driver turns into an explicit thrown
error. Airplay/AppleTV/Sonos should be brought onto that same pattern.

### 2.7 Two live, parallel KNX drivers
`knx-driver.ts` (`KnxProtocolDriver`, wired at
`services/gateway/src/native-driver-factory.ts:53`) and
`knx/supreme-knx-driver.ts` (`SupremeKnxDriver`, wired in
`services/gateway/src/installer-context.ts`) both fully implement
`INativeProtocolDriver` under the same `protocol: "knx"` and are **both live in
production simultaneously**. They share a command codec (so per-action capability
coverage is identical) but `SupremeKnxDriver` adds an offline command queue and a
`discoverUnified()` pipeline the legacy driver lacks. This is real architectural
duplication, not a capability gap per se, but it's the kind of thing that makes
"which KNX driver actually handles this device" a non-obvious question for a future
session.

### 2.8 Diagnostics/structural-config feature parity is narrow
Only 4 of 22 drivers (`avr`, `heos`, `yamaha`, `coolmaster`) implement
`getDiagnostics()`/`getTrace()`/`refreshCapabilities()`/`getCapabilityConfig()`.
Casambi has bespoke, differently-shaped equivalents
(`getCasambiDiagnostics()`/`getCasambiTransportMonitor()`) that are **not** reachable
through the generic `IBackendAdapter`/Diagnostics Console path at all. Everything else
(both KNX drivers, Matter, Modbus, MQTT, Shelly, SIP, Sonos, Tuya, WiiM, Zigbee, DALI,
Lutron, Devialet, AirPlay, AppleTV, Ajax) implements none of these — the Diagnostics
Console gets an honest `null` for them (never fabricated), but it's a real
feature-parity gap between the "full AV SDK" drivers and everything else.

### 2.9 Several drivers don't validate capability at bind time
`modbus`, `tuya`, `dali`, and `mqtt`'s `bind()` accept any capability without
validation and only fail when a command is actually issued — a misconfigured binding
succeeds silently until first use. `ajax`, `sip`, and `airplay` validate and throw
immediately in `bind()` instead, which is the safer pattern.

## 3. SIL / adapter layer (`services/integration-layer`)

### 3.1 `apply.ts` (the shared mock/native-simulation command applier)
Capability-level coverage is complete (9/9 commandable capabilities — `sensor` is
correctly excluded as read-only). At the field level, though:
`services/integration-layer/src/apply.ts:54-62`'s `temperature` case only reads
`targetC`/`mode` — it never reads `targetLowC`, `targetHighC`, or `advanced` (all
legal per the command schema), and worse, **drops** those fields (plus `humidity`)
from the previous state on every command instead of carrying them forward. Any
dual-setpoint or advanced-HVAC-parameter automation/UI action has zero effect in the
in-process simulation path — this affects every demo device and every native-bus
device not yet bound to a real driver.

### 3.2 HA discovery never surfaces `fan`, `vacuum`, or `color`
This is the audit's most important correction to a working hypothesis: the actual
bidirectional command/state mapper
(`services/integration-layer/src/ha/capability-mapper.ts`) is **fully correct** —
`commandToHaService`/`haStateToCapability` cover all 10 capabilities including `fan`
and `vacuum`. The gap is one layer up, in discovery:
`services/integration-layer/src/ha/ha-adapter.ts:171-179`'s domain map
(`light→[onoff,brightness]`, `switch→[onoff]`, `climate→[temperature]`,
`cover→[position]`, `media_player→[media]`, `lock→[lock]`, `sensor→[sensor]`) has
**no entry for HA's native `fan` or `vacuum` domains at all**. Since an entity from an
unmapped domain returns `null` and is filtered out
(`ha-adapter.ts:117-119,180-181`), **an HA `fan.*` or `vacuum.*` entity is never
surfaced by discovery** — the fully-correct mapper code beneath it is effectively dead
for anything onboarded through auto-discovery (a device manually mapped via
`mapEntity()` would still work). The same function also always maps HA's `light`
domain to `[onoff, brightness]` only — never `color`, regardless of the entity's real
`supported_color_modes` — and never populates `DiscoveredDevice.capabilityConfig`, so
ADR 0017's structural color signal never reaches an HA-discovered light either.

### 3.3 `READONLY_CAPABILITIES` enforcement is correct and complete
`services/integration-layer/src/sil.ts:209-220`'s single centralized check against
`READONLY_CAPABILITIES` (currently just `["sensor"]`) is correct for everything
currently marked read-only. No partial or capability-specific carve-out found.

### 3.4 Structural config pattern (ADR 0017) has only reached 3 of 10 capabilities
`color` (domain-model, but only genuinely populated by one driver — §2.3),
`temperature` (`ClimateCapabilityConfig`, CoolMaster only), and `media`
(`AudioCapabilityConfig`, avr/heos/yamaha) are the only capabilities with a real
structural-config schema anywhere in `services/protocols/src`. `fan`, `lock`,
`position`, and `vacuum` have none — confirmed by a zero-match search for
`Fan|Lock|Position|Vacuum` config interfaces. This matches ADR 0017's own disclosed
"remaining technical debt," though that ADR's list predates `vacuum` entirely and
understated `media`'s current state (it was closed by a later, separate effort).

## 4. Frontend UI (`apps/web-homeowner`)

### 4.1 Automations authoring UI: fully correct
Not a gap — `apps/web-homeowner/src/automation-capability-fields.ts`'s `STATE_FIELDS`
and `COMMAND_DEFINITIONS` tables enumerate every real field/action for all 10
capabilities, including `fan.direction`, `vacuum.status`, and `lock.jammed`. Backed by
the domain-model's generic, capability-agnostic `readCapabilityField()`
(`packages/domain-model/src/condition-eval.ts:16-18`), which works for all 10 because
every capability's state is flat.

### 4.2 A real "fabricated control" bug: sensor's Expanded Sheet
`apps/web-homeowner/src/device-sheets.tsx:33-47`'s `DeviceSheet` dispatch has cases
for `temperature`/`position`/`lock`/`fan`/`vacuum`/`media`, and an `else` that renders
`SwitchSheet` — **there is no `sensor` case**. A device whose only capability is
`sensor` (the minimal valid state the schema allows) falls into that `else` and gets a
"Turn on"/"Turn off" button wired to `client.command(device.id, {capability: "onoff",
...})` — a command the device has no `onoff` capability to honor, and `sensor` is
explicitly read-only (`capabilities.ts:236`). This is the single most direct
violation, anywhere in this audit, of CLAUDE.md's "never fabricate a capability"
rule — and it's user-facing. The Standard Card (`device-tile.tsx:95-104`) gets this
right (read-only tile, no toggle); only the Expanded Sheet has the bug.

### 4.3 `fan`/`vacuum` UI has not caught up to the domain model
Neither has a `capability-mapper.ts`, a dedicated card, a dedicated detail file, or a
Premium Detail Page anywhere in the tree.
`apps/web-homeowner/src/device-detail-router.tsx`'s own doc comment (lines 34-40)
names them directly as having "no dedicated rich console yet." Both do get a generic,
functional Standard Card and Expanded Sheet (`FanSheet`/`VacuumSheet` in
`device-sheets.tsx`, both genuinely reachable) — this is an honestly-plain fallback,
not a broken one, but it confirms the vocabulary moved faster than the UI layer for
exactly the two newest capabilities.

### 4.4 Architecture-convention drift for the two highest-traffic capabilities
`brightness`/`color` (lighting) and `temperature` (climate) are **not** under
`features/lighting/` or `features/climate/` the way CLAUDE.md's own Coding Standards
describe. Their logic sits at the top level of `src/`
(`lighting.tsx`/`lighting-page.tsx`, `climate-console.tsx`/`climate.tsx`) — `media`,
`security`, and `infrastructure/energy` are the only modules that actually match the
documented `features/<domain>/capability-mapper.ts` convention. Since CLAUDE.md itself
cites `climate-console.tsx`'s HVAC pattern as the model other modules should follow,
this reads as the convention having been written down after lighting/climate were
built, with neither retrofitted into `features/`.

### 4.5 Dead code from an incomplete router migration
`device-sheets.tsx` still defines full `ClimateSheet`, `LockSheet`, and `MediaSheet`
implementations, but `device-detail-router.tsx`'s `resolveCanonicalDetail()`
intercepts any device with `temperature`/`lock`/`media` **before** `DeviceSheet` is
ever reached. Three of `device-sheets.tsx`'s seven sub-sheets are currently
unreachable — not a functional bug (the live Premium pages cover the same ground),
but real maintenance debt: a future session could reasonably assume they're live and
spend time "fixing" dead code.

## 5. Cross-cutting consumers

### 5.1 Automations engine — fully correct (see §4.1)

### 5.2 Voice (Alexa/Google) — two inconsistent mappings, only the worse one is live
The webhook that actually runs (`cloud/voice/src/server.ts`) uses `alexa.ts`/
`google.ts`, which map only 6 of 10 capabilities (`onoff`, `brightness`, `color`,
`temperature`, `position`, `lock`) to real interfaces/traits and state properties.
`fan` and `sensor` get a **display category/type assigned with no controllable
interface at all** (`alexa.ts`'s `ALEXA_DISPLAY`/`google.ts`'s `GOOGLE_TYPE`) — a
device shows up in the Alexa/Google Home app but cannot be operated, which is worse
than an honest exclusion (it looks broken to the homeowner, not absent). `vacuum` gets
no mapping of any kind. `media`'s exclusion is the one with an explicit test proving
it's intentional (`reporting.test.ts:33-34`). Separately, `cloud/voice/src/index.ts`
defines a genuinely complete 10/10 mapping (`VOCAB`), but a repo-wide check confirms
**`VoiceService` (the class that consumes `VOCAB`) is never imported by the live
server** — it's dead code that, read in isolation, would give a false impression that
voice coverage is complete.

### 5.3 HomeKit/HAP — 8/10, disclosed in source but not gated at runtime
`services/homekit/src/hap-mapping.ts:41-43` has an explicit comment: `// media /
vacuum have no first-class HAP service we expose yet` — a genuine, rare-in-this-audit
example of the gap being named in the code itself. But nothing acts on that
disclosure at publish time: `services/gateway/src/context.ts:699-711` publishes
*every* device to HomeKit unconditionally. A device whose only capability is `media`
or `vacuum` would be published as an accessory with zero HAP services — silently
inert in the Apple Home app, with no signal anywhere in the runtime path telling an
installer why.

### 5.4 Matter — 6/10, with a silent-discovery-drop failure mode
`matter-codec.ts`'s cluster mapping covers `onoff`/`brightness`/`color`/`lock`/
`position`/`sensor`. Binding or commanding an unmapped capability throws an honest
error (`matter-driver.ts:121-124,158-160`). But **passive discovery does not**: real
Matter's standard `FanControl` cluster and the Matter 1.1+ RVC (robot vacuum) clusters
are never referenced anywhere in `matter-codec.ts`. A genuine Matter fan or robot
vacuum would report clusters this codec doesn't recognize,
`capabilitiesFromClusters()` returns `[]`, and `discover()`'s
`.filter((d) => d.capabilities.length > 0)` (`matter-driver.ts:177`) **silently drops
the device from discovery entirely** — no error, no log, the device simply never
appears on the hub. (Manual `commission()` does throw for the same case — only the
passive discovery path is silent.) The one disclosure comment that exists in the file
(`matter-codec.ts:114-115`) names only `temperature`/`media` as unmapped for
commands — it does not mention `fan`/`vacuum` at all, understating the actual gap.

### 5.5 Universal Keypad Framework — deliberately separate, well-documented
`KeypadCapabilityDeclaration`/`KeypadInputEvent`/`KeypadFeedbackCommand`
(`packages/domain-model/src/keypad-capabilities.ts`) are a genuinely separate
vocabulary from `CapabilityKind`, and the separation is explained in a doc comment
(`keypad-capabilities.ts:4-15`): it describes what input *hardware* can do, not what a
controlled *device's* state looks like. The two worlds reunite correctly at automation
action dispatch. This is the one place in the audit where an apparent inconsistency
turned out to be intentional and disclosed — included here for completeness, not as a
finding.

## 6. Consolidated findings, ranked by severity

**Fabrication / correctness bugs (highest priority — violate "never fabricate"):**
1. `apps/web-homeowner/src/device-sheets.tsx:33-47` — sensor-only devices render a
   fake, non-functional "Turn on/off" toggle in the Expanded Sheet (§4.2).
2. `services/protocols/src/sip-driver.ts:112-119` — the door-station `lock` action
   fabricates `{locked: true}` with no real hardware call (§2.5).
3. `services/protocols/src/knx/capability-mapper.ts` + `knx-codec.ts` — KNX discovery
   can promise a `fan` capability that its own command codec cannot execute; every
   such command throws (§2.2).

**Silent gaps that look like something else is wrong (deceptive, not fabricated):**
4. Matter `discover()` silently drops any real Matter fan or robot vacuum from
   discovery with no error at all (§5.4).
5. Alexa/Google Home discover `fan`/`sensor` devices with a category but no
   controllable interface — visible but inert to the homeowner (§5.2).
6. HomeKit publishes empty (zero-service) accessories for media/vacuum-only devices
   with no gate or warning (§5.3).
7. `airplay-driver.ts`/`apple-tv-driver.ts`/`sonos-driver.ts` silently no-op ~5
   unsupported `media` actions instead of erroring (§2.6).

**Vocabulary-ahead-of-reality gaps (real, but honestly a maturity gap, not a bug):**
8. `vacuum` has zero real driver implementations anywhere, despite full schema,
   automation, and generic-UI support (§2.1).
9. `fan`/`vacuum` have no dedicated frontend feature module (§4.3), no structural
   capability config anywhere (§3.4), and the weakest voice/HomeKit/Matter coverage.

**Structural/config gaps affecting real, shipped hardware:**
10. Five color-capable drivers (DALI, both KNX drivers, Matter, Zigbee) report no
    `ColorCapabilityConfig`, defaulting to `supportsRGB: true` — likely renders broken
    RGB controls on real CCT-only fixtures (§2.3).
11. `apply.ts`'s `temperature` handling drops dual-setpoint/advanced fields from every
    in-process device's state (§3.1).
12. HA auto-discovery never surfaces `fan`, `vacuum`, or `color` capabilities even
    though the underlying HA command/state mapper fully supports all three — the gap
    is entirely in the discovery domain map (§3.2).

**Architecture/maintenance debt (no functional bug today, but real risk):**
13. Two live, parallel KNX driver implementations under the same protocol id (§2.7).
14. Three dead sub-sheets in `device-sheets.tsx` made unreachable by router
    migration (§4.5).
15. A fully-correct, 10/10 voice capability mapping (`cloud/voice/src/index.ts`)
    exists but is never wired to the live server — dead code presenting a false
    picture of coverage if read in isolation (§5.2).
16. `brightness`/`color`/`temperature` — arguably the highest-traffic capabilities —
    don't follow this repo's own documented `features/<domain>/` convention (§4.4).

## 7. What this audit did not do

Per its scope as a research task, this audit made **no code changes**. It did not:
verify every codec file line-by-line (three large codec files — `heos-codec.ts`,
`yamaha-codec.ts`, `avr-codec.ts` — were sampled at the specific functions relevant to
command coverage, not read end-to-end; state-parsing logic elsewhere in those files
was not independently verified); test any of the above findings against real
hardware, a real HA instance, a real Alexa/Google/HomeKit/Matter client, or a real
KNX/DALI/Matter/Zigbee color fixture; or propose specific code fixes for any finding
(§6 is a severity-ranked list of *what's wrong*, not a remediation plan). A natural
next step, if wanted, is to pick items from §6 and scope them as individual follow-up
sessions — several (the sensor-fabrication bug, the SIP lock fabrication, the KNX
fan-discovery bug) look like small, well-isolated fixes; others (real `vacuum` driver
support, live voice-mapping consolidation) are larger efforts in their own right.

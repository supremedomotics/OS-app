# Homeowner Flutter generation — minimum backend contract gate

Scope: what `apps/new` (Mobile/Tablet/Panel) needs from the Hub so that the Residence State, the command
lifecycle and Experience state are **truthful without client heuristics**. Written at the close of
Phase 2, from reading the code, not from the prototype. Nothing here is implemented by this document.

## Status after Phase 3

| § | Contract | Status |
|---|---|---|
| 1 | `asOfRev`, floors, `Room.locative`, readable `Home.location` | **OPEN** (unchanged) |
| 1 | `Home.heroImageUrl` | **DONE** — computed, hash-versioned |
| 2 | device reachability frame, `stateAt`, normalised `TemperatureConfig` | **OPEN** |
| 3 | durable `rev`, `sinceRev` resume, `hello`, `observedAt`/`receivedAt` | **OPEN** |
| 4 | `commandId` / `causedBy` / Hub command `outcome`, idempotency, stable error codes | **OPEN** |
| 5 | `Scene.roomIds`, `Scene.description`, `Scene.phases` | **DONE** (`SceneView`; `roomIds` derived from steps) |
| 5 | per-step desired *state* (`SceneStep.target`) | **DEFERRED by design** — `expectationOf` (TS + Dart, pinned by `state-expectation.json`) derives it from the command; both sides use one predicate |
| 6 | Hub-orchestrated activation: `spaceIds`, 202 + run, phases, per-capability deadlines, partial failure, supersession, `GET /v1/scenes/runs/:id`, `run` frames | **DONE** (`services/gateway/src/scene-runs.ts`) — see the "Phase 3 deviations" note in §6 |
| 6 | client path retired | **DONE** — `CommandTracker.submitGroup` and the per-space command loop are deleted |
| 7 | Mobile authorization on hero routes, ETag/304, versioned URL, `GET\|PUT /v1/home/hero-image` | **DONE**; masks / reference kelvin still LATER |
| 8 | occupancy / arming / contacts / sun | **NOT BUILT** (re-verified: `occupancy.e2e.test.ts` covers an *away-from-home lighting simulation*, `security.e2e.test.ts` covers *gateway hardening*; neither is a sensing/alarm contract) |

Drift gate: `services/gateway/src/wire-shapes.e2e.test.ts` records the gateway's real wire shapes to
`packages/domain-model/fixtures/wire-shapes.json`; `apps/new/shared/test/wire_conformance_test.dart` holds the
Dart simulator to that same fixture.

Legend — **EXISTS** works today · **EXTEND** an existing contract gains a field/route · **NEW** a new
contract · **LATER** only when a driver backs it (never faked meanwhile).

Client rules that do not change whatever the Hub adds:
1. `ResidenceState` is the only client read model and the Hub is its only writer.
2. A command is *confirmed* only by an authoritative device report that satisfies its target.
3. An Experience is *active* only when device state satisfies its targets; a run explains a transition,
   it is never the answer to "is it active".
4. Anything the contract cannot say, the UI does not say.

## 1. Residence state — `GET /v1/home`, `/v1/scenes`

| Need | Today | Gap | Minimum contract |
|---|---|---|---|
| Residence name, rooms | EXISTS `HomeView {home, rooms}` | — | — |
| Snapshot consistency with the stream | none | client cannot tell which stream frames a snapshot already includes (handled by an arrival heuristic) | EXTEND: every snapshot carries `asOfRev` (see §3) |
| Floors | `Room.floor` (int) | no floor name/character; "Ground floor" is inferred from the number | NEW `Home.floors[] {level, name, character?}` |
| Space order | Hub order | no explicit order | EXTEND `Room.sortOrder` |
| Grammar of place ("in the living room" / "on the terrace") | none — a name rule in the client | language guess | EXTEND `Room.locative?` (installer-entered, like `device.metadata.<domain>.kind`) |
| Residence location / time zone | write-only `PUT /v1/home/location` | client cannot compute the residence's own clock or sun | EXTEND `Home.location {lat, lon, timeZone}` readable |

## 2. Device state — `GET /v1/devices`

| Need | Today | Gap | Minimum contract |
|---|---|---|---|
| Per-capability normalised state | EXISTS `Device.state[kind]` | — | — |
| Reachability | EXISTS `status: online\|offline\|unavailable` | not pushed: a device going offline is only learned on the next snapshot | EXTEND stream: `{type:"device", deviceId, status, rev, ts}` |
| Freshness | none in snapshot | client marks snapshot-only state "age unknown" | EXTEND `Device.stateAt: {kind: observedAt}` (when the device last reported that capability) |
| Climate limits/modes | `capabilities[].config.temperatureRange`, `modes` only where a driver supplies them (CoolMaster) | others fall to the contract's documented 16–30 °C / 1° default | NEW normalised `TemperatureConfig {minC,maxC,step,modes}` in domain-model |
| Colour temperature on dimmers | not reported | client cannot say "warm light"; it says "Lights on" | none — only `color` capability may claim it (correct as is) |

## 3. Stream ordering and freshness — `/v1/stream`

| Need | Today | Gap | Minimum contract |
|---|---|---|---|
| Ordering | `seq` per device, **in memory per connection** (resets on reconnect) | not comparable across reconnects; client resets and re-snapshots | EXTEND: durable monotonic `rev` per home; every frame and every snapshot carries it |
| Resume | none | reconnect = full snapshot | NEW `subscribe {sinceRev}` → replay or `resync` frame |
| Hello | none | client cannot know the head | NEW `hello {epoch, headRev}` after authentication |
| Timestamps | one `ts` | ambiguous (device vs Hub) | EXTEND: `observedAt` (device) and `receivedAt` (Hub) |
| Drops | stale frames dropped client-side by `seq` | — | keep; becomes `rev`-based |

## 4. Command acknowledgement — `POST /v1/devices/:id/command`

| Need | Today | Gap | Minimum contract |
|---|---|---|---|
| Acceptance | EXISTS `{accepted, device?}` (`device` = last known, *pre-report*) | `accepted:false` is not returned for driver failures; they are HTTP errors | EXTEND: stable error `code` (`device_unreachable`, `unsupported`, `rejected`) |
| Correlation | none | the client matches a report to a command by *value*; an unrelated physical change to the same value confirms it | EXTEND: response `commandId`; the resulting state frame carries `causedBy: commandId` |
| Hub-side outcome | none | if the device never reports, only the client times out | EXTEND stream: `{type:"command", commandId, outcome: confirmed\|failed\|timeout, reason}` from the State Engine |
| Idempotency | none | a retry can double-apply a relative command | EXTEND: optional `Idempotency-Key` |

Client semantics stay: confirmation comes from state. `causedBy`/`outcome` only make attribution exact.

## 5. Experience targets — `Scene.steps`

Today a step is `{deviceId, capability, values}` where `values` is a **command** (`{action:"set",level:20}`).
The client maps command → expected state (`expectationOf`) for `onoff`, `brightness`, `position`,
`temperature`, `media`; every other capability (toggle, stop, media next, lock, colour…) is *unverifiable*
and an Experience with no verifiable step is shown as neither active nor inactive.

| Need | Minimum contract |
|---|---|
| Desired *state* per step | EXTEND `SceneStep.target {state, tolerance?}` in the state vocabulary; `values` stays the command |
| Multi-space Experiences | EXTEND `Scene.roomIds[]` (contract has one `roomId`; the client already reads `roomIds`) |
| An authored line | EXTEND `Scene.description` (the client derives "Changes lighting, curtains and music." meanwhile) |
| Per-system effect words | LATER, optional; derived from targets meanwhile |
| Choreography | EXTEND `Scene.phases: string[][]` (ordered groups of `stepId`s), see §6 |

## 6. Experience activation — Hub-orchestrated

`POST /v1/scenes/:id/activate` is already Hub-orchestrated: `SceneService.activate` sends every step
concurrently, best-effort, and returns `{activated:true, steps:<count>}`. It cannot express scope,
sequencing, per-step outcome or reconciliation, so today's client (a) calls it for whole-residence
activation and tracks each step's device against its target, and (b) for **one space's share** sends the
same authored steps as tracked device commands. (b) is **temporary client orchestration**; it must not become
permanent (decision D8).

Minimum Hub contract:

* **Request** `POST /v1/scenes/:id/activate {spaceIds?: string[], mode?: "supersede"}` — `spaceIds`
  restricts to steps whose device is in those spaces (multi-space = several ids; omitted = all).
* **Response `202`** `{runId, sceneId, spaceIds, startedAt, steps:[{stepId, deviceId, capability, state:"queued"}]}`
  immediately — never a bare count.
* **Per-device targets** — each step carries its `target` (§5); the run holds the resolved list.
* **Sequencing** — steps in `phases` run phase by phase; a phase starts when every step of the previous one
  has *concluded* (`confirmed`, `failed` or `timeout`) **as decided by the State Engine from device state**,
  never by a timer. Steps in no phase start at once. Concurrency inside a phase is unordered.
* **Partial failure** — best-effort: a failed/timed-out step never blocks the rest. Step states:
  `queued → sent → confirmed | failed(reason) | timeout | skipped(device_unreachable)`. Run status:
  `running → completed | partial | failed`.
* **Final physical-state reconciliation** — the Hub marks a step `confirmed` only when the device's state
  satisfies `target` (the same predicate the client uses). At run end it emits a terminal frame with counts
  and, for `partial`, the unmet steps. Clients still derive Active/Partial/Inactive from device state; the
  run is the explanation of the transition.
* **Observation** — `GET /v1/scenes/runs/:runId` and stream frames `{type:"run", runId, stepId, state, rev}`;
  a run survives a client reconnect (`GET` by id).
* **Supersession / interference** — a newer run over the same steps supersedes; a user command on a step
  device during a run is recorded on the step as `overridden`, not counted as failure.
* **Permissions** — `scene:control`, additionally checked per space for scoped activation.
* **Retirement of the client path** — when this lands, `activateExperience` calls it for every scope and the
  per-space command loop is deleted; the tests that prove Becoming/Active/Partial from device reports stay.

**Phase 3 deviations from this sketch (implemented shape):** the response is `202 {activated, steps, run}` with
the whole `SceneRun` snapshot (not a bare id + step list); `run` frames are full idempotent snapshots rather than
per-step deltas; phases are index groups into `steps` (`number[][]`), not `stepId` lists; a user command during a
run is **not** recorded as `overridden` — a later activation over the same devices supersedes (`supersededBy`);
the per-space permission check is **not** built (scene-level `scene:control` only); runs are in memory and do not
survive a Hub restart. These are listed as risks in `docs/design/phase-3-closure-report.md`.

## 7. Residence / space assets and hero images

Decided in **ADR 0102**: assets belong to the entity they depict and are Hub-served. Minimum: accept Mobile
authorization on `GET /v1/rooms/:id/hero-image`; strong ETag and hash-versioned `heroImageUrl`;
`Home.heroImageUrl` with `GET|PUT /v1/home/hero-image`; metadata (masks, reference kelvin) later as a sibling
field. Not implemented; plates are tonal until it is.

## 8. Occupancy, security, sun — LATER, never faked

| Signal | What production has | What a driver must provide before the UI may show it |
|---|---|---|
| Occupancy | `sensor` with free-string `measure` | a defined `measure:"occupancy"` (bool) on a real presence sensor |
| Security / arming | `lock` capability only | a new `alarm` capability kind: state `{arming: disarmed\|home\|away\|night, alarm:boolean}`, commands, capability-parity test |
| Contacts (doors/windows) | none | `sensor` `measure:"contact"` |
| Sun position | none, and no readable location | nothing server-side: with `Home.location` (§1) the client computes sun elevation/times itself (pure maths) |

Until then Home shows no "Secure/Protected", Spaces no "Occupied", Home no sun line — unchanged since Phase 2.

## 9. What must exist before Phase 3 starts (client side, no backend needed)

See `docs/design/phase-2-closure-report.md` — *Phase 3 entry criteria*.

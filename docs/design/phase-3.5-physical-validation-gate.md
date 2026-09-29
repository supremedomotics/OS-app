# Phase 3.5 — Physical-driver validation gate

**Status: provenance architecture FIXED and regression-tested. Physical-driver validation is NOT done and
NOT claimed.** No KNX bus, shade actuator or media device has been exercised — none is reachable from this
environment. Everything below that says "passes" means a software test passed against the real driver code
with a stand-in for the bus socket; it is not evidence about any physical device. Phase 4 has not started.

## 1. Original failure (finding G1)

A real `KnxProtocolDriver`, behind the real SIL and Hub state feed, on a bus whose actuator never answers:
`command(on)` reached the bus, no telegram returned on the status address, and the Hub **still published
`{onoff, on:true}`** as the device's state, indistinguishable from a device report. `CommandTracker` confirms on
any state satisfying the target, so an unpowered or unreachable actuator showed as confirmed, and
`ResidenceState` held a value no device reported.

## 2. Architectural cause

1. **Drivers published what they asked for as if the device said it.** `knx-driver.ts` `command()` and
   `knx/supreme-knx-driver.ts` (connected and offline-queue paths) ended in `record(optimistic)`, which notifies
   every listener.
2. **The state contract had no provenance.** A state event carried `{deviceId, capability, state, ts}`; nothing
   said whether it was observed, asked for, or assumed.
3. **The Hub trusted every event.** `onBackendState` persisted it (`home.applyState`) and fed automations,
   HomeKit, voice, analytics, keypad feedback, the scene runner (which confirms run steps from state) and the
   native adapter's `getState` cache.
4. **Command and status addresses were conflated.** With no `statusAddress`, the driver observed the *command*
   address (`statusGa` defaulted to `writeGa`): a value there may be another switch, an automation or any other
   writer, not the device.
5. **The contract defaulted unknown to false.** `PositionState.moving` was `z.boolean().default(false)`, and
   the KNX codec hardcoded `moving: false` although DPT 5.001 carries no motion flag.

## 3. Provenance model

`StateProvenance` (`packages/domain-model/src/capabilities.ts`):

| value | meaning | may be persisted as device state | may confirm a command | may feed automations / HomeKit / voice / run steps |
|---|---|---|---|---|
| `observed` | attributable to the device's own report: a declared status/feedback object, a poll of the device, a device-initiated event | yes | yes | yes |
| `commanded` | the value a command asked for | no | **never** | no |
| `assumed` | inferred from a transmit for a device that declares no feedback | no | **never** | no |
| `unknown` | the integration cannot say | no | never | no |

`observed` does **not** mean "a telegram arrived". On KNX it means the telegram arrived on an address the
integration declares as the device's status/feedback. The KNX drivers therefore distinguish the two:

* actuated capabilities (`onoff`, `brightness`, `position`, `color`, `lock`, `fan`) are observed **only** on a
  declared `statusAddress` (plus ETS-declared extra status addresses). The command address is never observed.
* a `statusAddress` equal to the command address is **ambiguous** and is not feedback unless the installer
  explicitly sets `feedbackOnCommandAddress: true`.
* no declared feedback ⇒ the driver observes nothing, claims no state, does not group-read the command address
  on resync, and reports `capabilities[c].config.feedback = "none"` structurally.
* `PositionState.moving` is `boolean | null`; `null` = unknown, and absent parses to `null`, not `false`. The KNX
  codec emits `moving: null`.

Wire: `BackendStateEvent.provenance?` and `StateDeltaFrame.provenance` (default `observed`; pinned in
`wire-shapes.json`, and the Dart simulator conforms). A driver that declares nothing is a **legacy driver** and is
treated as `observed` (unchanged behaviour) — see §7, that default is an audit item, not a guarantee.

## 4. Corrected lifecycle

```
USER ACTION → requested → pending (Hub accepted the write)
   → driver writes to the bus, announces the value as COMMANDED (never state, never a confirmation)
   → device answers on its STATUS address → OBSERVED → Hub persists + publishes it
   → ResidenceState updates from the observed frame → CommandTracker: confirmed (by device report)
   silent / unreachable device → no observed frame → pending → failed(timeout) at the capability deadline
   control that DECLARES feedback:"none" → pending → confirmed with confirmedBy = sentOnly
        ("sent, unverified"; physicallyConfirmed == false; never a timeout; state not fabricated)
```

The `requested → pending → confirmed | failed` phases are unchanged. `ResidenceState`, `CommandTracker`'s core,
`SurfaceProfile` and the UI were not redesigned; the client changes are: ignore non-observed frames (without
advancing the device's sequence), the `sentOnly` outcome for a declared no-feedback control, and
`RoomShades.motionKnown`.

Hub gates (all in the state path): `context.onBackendState` (persist + consumers), scene-run step confirmation,
the Matter bridge feed, `SupremeNativeAdapter`'s state cache; the stream forwards non-observed events labelled.

## 5. Regression evidence (all run in this environment)

| requirement | test |
|---|---|
| silent KNX actuator → pending → fails; Hub holds no state | `gateway/src/knx-state-provenance.e2e.test.ts` "silent actuator…"; `shared/test/state_provenance_test.dart` "silent actuator…" |
| real status telegram → confirms | gateway test "a real status telegram…OBSERVED…"; Dart "a real (observed) status report confirms…" |
| command telegram alone never confirms | gateway "a telegram on the COMMAND address alone…"; Dart "a COMMANDED frame…never confirms, never changes state, never advances seq" |
| no status address → no fabricated observed state | gateway "no status address…" + "same address…ambiguous"; driver `getCapabilityConfig → {feedback:"none"}`; Dart "DECLARES no feedback…sent, unverified" |
| shade movement unknown ≠ not moving | gateway "shade: … moving is unknown (null), never false"; Dart "shade motion: unknown is neither moving nor not moving", "unknown motion never extends a deadline" |
| explicit shared status address is honoured | gateway "an installer may EXPLICITLY declare…" |
| legacy Hub frame (no provenance) still works | Dart "a frame from a Hub that predates provenance…" |

Suites at this state: gateway 105 files / 590 tests; `shared` 415 (includes the live-gateway lifecycle);
mobile 135, touchpanel 27, shared_ui 87, domain-model 87, integration-layer 60; protocols 2071 pass with
**15 pre-existing failures** in `src/matter-controller/*` (`MdnsService unavailable` — the same 15 fail on the
unmodified tree in this sandbox). Existing KNX tests that encoded the optimistic behaviour or "command address =
status address" were **rewritten to the corrected semantics** (`knx-driver.test.ts`,
`supreme-knx-driver.test.ts`, `command-feedback-binding.e2e.test.ts`), not deleted.

## 6. Remaining hardware validation gaps (unverified)

Nothing about real devices has been verified. Still required, per the gate:

* **KNX switching with real bus feedback** — a real KNX/IP interface and a switch actuator with a status object:
  actual telegram timing, whether the status object answers a group write, duplicate/out-of-order telegrams,
  behaviour when the interface drops and reconnects, group-read resync.
* **A long-running device (shade)** — real position-status telegrams during travel, whether the actuator sends
  intermediate values or only the final one, completion and failure (obstruction, timeout), and whether any
  separate moving/status object exists to feed `moving`.
* **An IP/media device** (Sonos, HEOS or AVR) — command/state synchronisation on the real transport.

Per-integration record, honest current state (blank = unverified, needs hardware):

| | KNX switching | KNX shade | Sonos |
|---|---|---|---|
| command transport | KNXnet/IP tunnelling (UDP) via `knxultimate`; GA write | same | UPnP/SOAP :1400 via node-sonos |
| expected feedback | telegram on the declared status GA | position telegram(s) on the status GA | polled transport/volume |
| actual feedback | *unverified* | *unverified* | *unverified* |
| confirmation condition | observed state satisfies `expectationOf` | observed position within tolerance (`moving` unknown) | observed state satisfies target |
| deadline | onoff 10 s | position 90 s | media 10 s |
| unsolicited change | status GA telegram → observed (software-tested only) | same | next poll (≤ 4 s) |
| offline / reconnect | *unverified* | *unverified* | *unverified* |
| duplicate / out-of-order | identical states de-duplicated by the driver; client drops stale `seq` (software-tested) | same | poll snapshots |
| final ResidenceState | after a silent actuator: last observed state, command pending→failed (software-tested) | same | — |

## 7. Remaining audit items surfaced by this work (not fixed here)

* **Every other driver is "legacy"**: it declares no provenance and the Hub treats its events as `observed`. Each
  needs the same audit: a driver that publishes a commanded value as state is still wrong. Known: `coolmaster-driver.ts`
  mentions optimistic behaviour; `Shelly`, `Lutron`, `Casambi` and `integration-layer/apply.ts` still hardcode
  `moving: false`, and `home-service.ts` seeds `moving: false`.
* **Single-GA `temperature`** (reading and setpoint on one address) is deliberately outside the actuated set: its
  ambiguity is real but reinterpreting it would change existing HVAC bindings; it needs an installer-level
  decision.
* **G3 (Sonos)** is untouched: state is device-sourced (observed) but read immediately after a command (can be the
  pre-transition state), polled every 4 s, and `transitioning` is mapped to `playing`.
* `commanded` frames are forwarded to clients but no UI uses them; a "requested" affordance from them would need a
  design decision.
* The KNX no-feedback outcome (`sentOnly`) is a tracker record only; no screen words it differently yet (the UI
  still shows the last observed value, which stays honest).

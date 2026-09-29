# Phase 3.5 — Physical-driver validation gate: INTERIM (gate NOT passed, stopped on an architectural gap)

Status: **stopped, per the gate's own rule** ("if a real driver exposes behavior the current architecture
cannot represent honestly, stop and report the gap"). The final *Phase 3.5 Physical Integration Validation
Report* is **not** produced, and Phase 4 has **not** started.

## 1. What this environment can and cannot prove

* **No physical device, KNX bus, KNX/IP interface, shade actuator or media player is reachable** from this
  cloud container (no LAN, no `knxd`; Docker exists but no device images). Nothing below was verified against
  hardware. "USER ACTION … PHYSICAL DEVICE … REAL DEVICE FEEDBACK" cannot be exercised here, and I will not
  present an emulator I wrote as a physical device: an emulator only encodes my own belief about how an
  actuator answers.
* What *was* exercised: the **real** `KnxProtocolDriver` behind the **real** SIL, `AppContext` state feed
  and event bus, with only the KNXnet/IP socket replaced by a `KnxConnection` stand-in.
* The Sonos MCP tools attached to this session reach a real Sonos account through Sonos's cloud API. That is
  not SupremeOS's driver path (local UPnP/SOAP), so it would prove nothing about the driver; I did not use it
  and did not touch any real speaker.

## 2. Finding G1 — KNX publishes commanded state as if it were device feedback  (PROVEN)

`services/gateway/src/knx-state-provenance.e2e.test.ts` (passes; run it): real driver, silent actuator.

* `sil.command(onoff on)` → group write reaches the bus (`DPT1.001`, `1/1/1`, `true`).
* No telegram ever returns on the status GA `1/1/2`.
* Yet the Hub's state feed (`ctx.onState` — what every WebSocket client is fed from) publishes
  `{kind:"onoff", on:true}` immediately. The event carries only `{deviceId, capability, state, ts}`; nothing
  says it was assumed rather than observed.
* When real feedback later says `false`, the Hub corrects itself — after telling clients it was on.

Cause (code, not inference): `knx-driver.ts` `command()` ends with `record(b, optimistic)`, and
`knx/supreme-knx-driver.ts:330-345` does the same; `record()` notifies every listener.

Consequence for the accepted architecture: `CommandTracker` confirms on any state report that satisfies the
command's target (by design: "physical device reports determine confirmation"). Here that report is the
driver's own guess, so **an unpowered or unreachable actuator shows as confirmed**, and `ResidenceState`
holds a state no device reported, until (if ever) real feedback arrives. The contract has no provenance
field, so neither the tracker nor the UI can tell. The KNX authors already applied the opposite rule to HVAC
modes ("deliberately NOT optimistically recorded — feedback wins"), so the principle exists; the switching,
dimming and position paths do not follow it. `coolmaster-driver.ts` also mentions optimistic behaviour (not
yet inspected in detail).

This cannot be honestly represented without either (A) a provenance field on state events (contract change:
`observed` vs `commanded`; the tracker confirms only on observed) or (B) drivers not publishing optimistic
state at all (driver conformance; the UI then waits for feedback, and a device with no status GA can never
confirm — see G4). Both touch a boundary you told me not to redesign, so I stopped instead of choosing.

## 3. Further gaps found by reading the drivers (not yet exercised)

* **G2 — KNX shade has no intermediate state.** `stateFromValue` for `position` returns `moving:false`
  unconditionally (`knx-codec.ts:154`): DPT 5.001 position status carries no motion flag, so the driver
  *asserts* "not moving" when it does not know. Completion via a position report works; "in motion" cannot be
  represented, and the false `moving:false` also disables the client's movement-extended deadline.
* **G3 — Sonos.** State is read from the player after every command (so it is device-sourced — good), but:
  the read races the transition (it can return the pre-command state), state is otherwise polled every 4 s
  (no UPnP event subscription, so an unsolicited change is seen up to 4 s late), and node-sonos
  `transitioning` is mapped to `playing` (`mapSonosPlayback`), collapsing buffering/starting into a terminal
  value. Production wiring exists (`bootstrap.ts` → `createSonosConnect()`); without the optional `sonos`
  package installed, connecting fails.
* **G4 — a KNX switch with no status GA** (`statusGa` defaults to the write GA): the driver then observes
  its own write address, so the "feedback" may be another writer's telegram or nothing.

## 4. Required per-integration record (what is known so far; blanks are unverified)

| | KNX switching | KNX shade | Sonos |
|---|---|---|---|
| command transport | KNXnet/IP tunnelling (UDP) via `knxultimate`; GA write, DPT1.001 | same; DPT5.001 | UPnP/SOAP to player :1400 via node-sonos |
| expected feedback | telegram on status GA | position telegram(s) on status GA | polled `GetTransportInfo`/volume |
| actual feedback | **unverified (no bus)** | unverified | unverified |
| confirmation condition | client: state satisfying `expectationOf`; **driver also publishes it unobserved (G1)** | same; no `moving` (G2) | state satisfying target from a poll |
| deadline | onoff 10 s (shared table) | position 90 s | media 10 s (poll period 4 s) |
| unsolicited change | KNX bus telegram → state (not tested) | same | only via next poll |
| offline | not tested | not tested | not tested |
| reconnect | not tested (`connection-manager` exists) | not tested | not tested |
| duplicate / out-of-order | driver de-dupes identical JSON (`record`); ordering by arrival | same | poll snapshots |
| final ResidenceState | **wrong after a silent actuator: shows commanded state (G1)** | — | — |

## 5. What I need from you

1. **Hardware or the intent to run it yourself.** If a KNX/IP interface with a switch and a shade actuator,
   and a Sonos (or HEOS/AVR) player, are reachable from a machine that can run the gateway, I will build a
   harness driven by environment variables (`KNX_HOST`, group addresses, player IP) that runs the same
   lifecycle assertions against real devices and records the table above from real telegrams.
2. **A decision on G1**: (A) provenance on state events, (B) drivers publish observed state only, or another
   route. Everything else in this gate depends on it, because until it is decided a real-device test would
   pass or fail depending on whether the actuator happens to answer quickly.
3. Confirmation that an emulator-based result (real driver + protocol emulator, no hardware) is or is not
   acceptable as the gate's evidence. My recommendation: it is not, for the reason in §1.

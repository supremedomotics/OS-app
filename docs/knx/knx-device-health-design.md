# Supreme KNX — Device Health Monitoring: model, evidence rules, test plan

2026-10-18 · branch `claude/great-keller-fmenbn` · implements requirements 4 and 5 of `knx-original-scope-audit.md`. Code: `services/protocols/src/knx/health/`. **Simulator-validated only; no real KNX gateway or device was available.** Not wired to any production driver.

## 1. What can honestly be known about a KNX device

KNX has no ICMP-style ping and no universal "are you there" service. Three kinds of evidence exist; each answers a *different* question and only some can prove absence.

| Layer | Question | Evidence we can obtain | Can it prove "down"? |
|---|---|---|---|
| L1 Gateway reachability | can we reach the KNX/IP interface at all? | tunnel connect/heartbeat success or failure (existing native client); discovery response | yes for the gateway link only |
| L2 KNX interface connectivity | is our tunnel connection up? | tunnel state (`connected`, closed reason), heartbeat RTT | yes for our tunnel |
| L3 Bus communication | does the line carry traffic / accept our frames? | telegrams received from the line; outcomes of our own sends (`confirmed` / `bus_error` / `not_confirmed`) | only weakly: a quiet bus is normal |
| L4 Individual-device responsiveness | does *this* device answer? | (a) **passive**: any telegram whose source address is the device's individual address; (b) **active**: a GroupValueRead of one of the device's *own* readable status objects answered by a GroupValueResponse from the device | **no, silence never proves absence** (§3) |
| L5 Application-level feedback | does the device report its state? | the value in those telegrams (handled by the existing feedback binding; here only used as liveness) | no |

### Evidence classes (normative status of each mechanism)
| Mechanism | Basis in the supplied specifications | Class |
|---|---|---|
| Source address of a received telegram = individual address of the transmitting device | Network Layer v02.01.01 `N_Data_Individual.ind` / `N_Data_Broadcast.ind`: *"source_address: Individual Address of the device that requested the … service"*. Group telegrams carry the same field; the cEMI/Data Link chapters that define it for `L_Data.ind` are **not** supplied | N (individual/broadcast), **I** (group) |
| GroupValueRead is answered by a GroupValueResponse from a device that holds a readable object on that group address | Application Layer v02.01.01 §3.1.2: a read produces a response only if the application *"may respond … the user can decide during configuration, whether or not the A_GroupValue_Read.res primitive shall be generated"*; *"It is left to the user application programmer to decide whether an A_GroupValue_Read.Acon time-out supervision is"* applied (NOTE 1) | N for the service; **a missing response proves nothing**; timeouts are our decision (I) |
| Responses carry the responder's own source address | as row 1 | N/I |
| L_Data.con "confirm" semantics | cEMI chapter not supplied | **U** — used only to *suppress* offline decisions, never to assert a state |
| A_DeviceDescriptor_Read as a presence probe | AL Table 1: T_Data_Individual **O** (optional), T_Data_Connected **M**; devices in security mode may answer FFFFh / 3Fh (still a response) | N for the PDU; requires the Transport Layer connection state machine and individually-addressed cEMI frames → **deferred, not implemented** |
| ICMP ping | not a KNX mechanism; a KNX/IP interface answering ICMP says nothing about bus devices | not used |
| Defaults (timeouts, windows, thresholds, limits) | no specification prescribes them | **I** — configurable |

## 2. Health model

```
HealthSnapshot {
  at, path: { gateway: reachable|unreachable|unknown, interface: up|down|unknown, bus: ok|degraded|unknown, reason }
  devices[]: DeviceHealth
  load: { checksStarted, readsSent, checksSuppressed, … }  // observability of the monitor itself
}
DeviceHealth {
  deviceId, individualAddress | null
  state: online | offline | degraded | unknown
  confidence: high | medium | low | none        // how strongly the evidence supports `state`
  reason: <code>                                 // see §3
  lastSeenAt | null, lastSeenKind: passive_telegram | active_response | null
  lastResponseAt | null, lastResponseLatencyMs | null
  consecutiveFailures, checkMethod: passive_only | group_read, lastCheck {at, outcome} | null
  activeCheck: not_available | candidate | proven | disabled
}
```
`unknown` is the default and the honest answer whenever evidence is missing, stale or untrustworthy. `offline` is rare by construction.

## 3. Evidence rules (ordered; first match wins)

Inputs: device record, clock, path observation, configuration (all durations configurable; defaults in `health-model.ts`).

| # | Condition | State | Reason | Confidence |
|---|---|---|---|---|
| 1 | device not registered / monitoring disabled | unknown | `not_monitored` | none |
| 2 | gateway unreachable **or** interface down | unknown | `path_down` | none — evidence is kept, nothing is blamed on the device |
| 3 | gateway/interface state not yet known | unknown | `path_unknown` | none |
| 4 | bus degraded (consecutive send failures) | unknown | `bus_degraded` | low — active checks are suspended and their outcomes are not counted |
| 5 | `consecutiveFailures ≥ offlineAfterFailures` **and** the device has *ever* answered an active read (`proven`) **and** no evidence of any kind for ≥ `offlineMinSilenceMs` | **offline** | `active_checks_failed` | high |
| 6 | `consecutiveFailures ≥ offlineAfterFailures`, never proven, and no fresh evidence | unknown | `unproven_silent` | low — the object may simply not answer reads (§3.1.2) |
| 7 | **proven** and `consecutiveFailures ≥ degradedAfterFailures` (not yet offline) | degraded | `active_checks_failed` | medium |
| 8 | no evidence ever | unknown | `no_evidence` | none |
| 9 | ≥ `intermittentFailures` failures among the last `ringSize` active outcomes while the latest outcome succeeded | degraded | `intermittent` | medium |
| 10 | latest active response slower than `slowResponseMs` and still fresh | degraded | `slow_response` | medium |
| 11 | latest evidence within its freshness window (`passiveFreshnessMs` / `activeFreshnessMs`) | **online** | `active_response` (high) / `passive_telegram` (medium) | as stated |
| 12 | otherwise (evidence older than its window, no failures) | unknown | `stale_evidence` | low |

Failures of a device that has **never** answered an active read (unproven) never produce `degraded` or `offline` by themselves: its object may not answer reads at all.

Counter rules: **any** evidence (a passive telegram from the device or an active response) resets `consecutiveFailures` to 0 — a device that talks is alive. A check cycle counts as **one** failure only after `maxAttempts` bounded attempts all timed out *and* the cycle was conclusive (path up, bus not degraded, the read was actually sent and not rejected). Inconclusive cycles are recorded (`checksSuppressed`) and counted nowhere.
Silence alone therefore never yields `offline`: rows 5–6 require repeated *active* failure plus prior proof that the device answers reads plus a long silence window.

## 4. Active-check scheduling and load control
* Prefer passive: a device with evidence younger than its check interval is never probed.
* A device is probed only if it has ≥ 1 readable status group address supplied by the integrator (from ETS: communication objects with the Read flag that the device sends on) and `activeCheck` is not `disabled` (e.g. Data Secure groups, where a plain read is not a valid exchange).
* Limits (all configurable): `maxConcurrentChecks = 1`, `minReadGapMs` between any two reads on the bus, `maxChecksPerMinute`, `maxChecksPerTick`, `controlQuietMs` (no probe within that window after control traffic; the integration calls `noteControlTraffic()` for every command it issues), per-device interval `checkIntervalMs` with a shorter `failureRecheckMs` while a device is failing, a slow `offlineProbeIntervalMs` once offline, jitter-free deterministic ordering (most overdue first).
* A check = up to `maxAttempts` GroupValueReads, each waiting `responseTimeoutMs`; success = a GroupValueResponse on that group address whose source address equals the device's individual address.
* **Write safety by construction:** the monitor's only outbound dependency is `ReadOnlyGroupBus { readGroup(destination) }`. There is no write method, no retry of anything but a read, and a test drives a real tunnel client over the simulator and asserts that no frame other than GroupValueRead ever leaves.

## 5. Not included (and why)
* A_DeviceDescriptor_Read / connection-oriented management probes: need individually-addressed cEMI frames (chapter absent) and the Transport Layer connection client; devices may legally not answer connectionless (Table 1 **O**).
* Using L_Data.con failures to *declare* a device down (semantics unspecified here).
* Automatic corrective action (self-healing): the monitor reports; recovery policy is a separate milestone and must obey `docs/architecture/knx-secure-retry-policy-design.md`.
* Wiring to `KnxProtocolDriver`/gateway/UI and ETS-driven registration (a structural helper maps a minimal ETS-shaped device description; the real mapping is the next step).

## 6. Test plan (deterministic, `ManualClock`, no wall time)
1. **Evaluator table tests** — every row of §3, plus ordering conflicts (path down beats offline; proven vs unproven; evidence resets failures).
2. **Monitor state transitions** — online → degraded → offline → recovery by passive telegram and by active response; hysteresis; flapping.
3. **False-offline prevention** — silent but unproven device stays `unknown`; bus degradation and gateway loss do not count failures; one lost read never marks offline; chatty device with unanswered reads stays online.
4. **Timeouts/retries** — bounded attempts, timeout accounting, delayed response within/after the timeout, late response after failure recovers state.
5. **Staleness/freshness windows** — evidence aging to `stale_evidence`, never to offline.
6. **Load** — hundreds of devices over simulated hours: reads ≤ configured rate, min gap respected, concurrency 1, zero probes for passively-fresh devices, deferral during control traffic, no storm after gateway recovery.
7. **Safety** — only reads are emitted (type + wire-level assertion through the real tunnel client and simulated interface); disabled/secure devices never probed.
8. **Simulator scenarios** — responsive, silent, delayed, intermittent, bus-failure, gateway-disconnect/reboot, periodic passive sender.
9. **Resource cleanup** — `stop()` leaves no timers; unregistering cancels pending checks.

## 7. As built and results (2026-10-18)
Files: `services/protocols/src/knx/health/{health-model.ts, health-monitor.ts, tunnel-health-adapter.ts}` + tests `health-model.test.ts` (14), `health-monitor.test.ts` (33), `health-simulator.test.ts` (9). Simulator change: `ActuatorFaults.readResponsePattern` (intermittent responders; additive, existing simulator tests unchanged).
Implemented as designed with these clarifications found during testing: (a) failures of a device that has **never** answered a read never degrade it (rule 7 requires `proven`); (b) recovery from a confirmed outage clears the intermittence ring; (c) a device that speaks *during* an unanswered cycle makes that cycle inconclusive; (d) the global minimum gap between reads is enforced before **every** attempt including retries (a mutation test exposed that retries could previously land 3 s after another cycle's read); (e) a fleet larger than the probe budget ages to `unknown/stale_evidence`, never to offline, and `load.overdueChecks` exposes the saturation (e.g. 300 devices at 6 cycles/min keep ≈ 90 fresh at once).
Mutation checks (each reverted, each failed named tests): offline without proof (6), inconclusive counted as failure (2), probing passively-fresh devices (2), no per-minute cap (1), ignoring control traffic (1), probing disabled/unavailable devices (1), evidence not resetting failures (6), stale ⇒ offline (4), min-gap (1, found a real defect, fixed).
**Evidence level: simulator only.** What a real gateway or device does (read-flag configuration, response latency, interface filtering of group telegrams, L_Data.con semantics) is untested; every default is a configurable decision.
Open items: wiring to drivers/ETS/UI; supervisor re-attachment after reconnect (the tests re-attach manually); optional A_DeviceDescriptor_Read probe; calibration of defaults on real installations.

## 8. Integration slice: ETS → supervised tunnel → monitor → diagnostics (2026-10-18)
Files: `health/ets-registry.ts` (ETS model → registrations, reconciliation), `health/health-service.ts` (composition), `health/health-diagnostics.ts` (document builder), tests `health-integration.test.ts` (20). Reused, not duplicated: `ConnectionManager` (now with an optional injectable clock/jitter — backward compatible, its 9 tests unchanged) for supervision and backoff around a FRESH single-use `KnxTunnelClient` per attempt; the existing `DriverDiagnosticsTracker` for connection counters (`diagnostics().connection.driver` is a standard `DriverDiagnosticsSnapshot`); the single `KnxHealthMonitor` instance lives for the service's life so probe spacing and per-minute budgets survive reconnects. Not wired to any production driver, route or UI.

**ETS eligibility (nothing is invented from a bare group address).** A communication object is an active-check target only if Read flag ∧ Communication flag ∧ exactly one Send group address ∧ that address parses. Devices without any such object are still registered for passive observation. Not registered at all (reported with a code): missing, invalid (e.g. a bare device number without area/line), reserved (0.0.0) or duplicate individual addresses — telegrams could not be attributed. Reported but registered: Read flag without Send address, several Send addresses (which one answers a read is not determinable), communication disabled, unparseable group address, more eligible objects than `maxStatusGroups` (2), a group address shared by several devices, Data Secure devices (never probed). Limitation: the ETS model has no "flag absent" state, so a not-explicitly-enabled Read flag is treated as not readable.
**Reconciliation (idempotent).** Same id → unchanged / reconfigured; id changed but physical address the same → renamed, evidence kept; gone from the project → unregistered; non-ETS registrations are never touched. Evidence policy: evidence is attributed by source address, so a changed physical address resets that device's evidence; a changed status-group set keeps evidence but drops `proven` (and the failure streak) unless a previous group remains; unchanged configuration touches nothing. ETS-derived configuration (flags, texts, DPT, per-object decision) is stored as registration `meta`, separate from evidence, and appears in diagnostics.
**Supervision.** Monitoring starts only after a tunnel connected. On tunnel loss: detach, `monitor.stop()` (in-flight probes are cancelled at once and uncounted; evidence and budgets are kept), path set to down (gateway `unreachable` only for connect_timeout / heartbeat_lost / socket_error), supervisor backs off and reconnects with a new tunnel; on reconnect: single attachment, `monitor.start()` is idempotent. `stop()` cancels everything and leaves no timers/sockets. Read-only boundary unchanged (`ReadOnlyGroupBus`; wire test over the integrated path).
**Diagnostics** (`knx.health.diagnostics.v1`, ISO timestamps, `null` = unknown): per device physical address, name, state, confidence, reason + human text, evidence method, last evidence kind, last seen / last successful response, latency, consecutive **conclusive** failures, stale flag and age, status groups, last check with `certainty` (`confirmed_response` / `confirmed_no_response` / `unknown`), next check, last transition; path (gateway/interface/bus + summary); supervisor metrics, tunnel counts, attachment count; registration report with issues; bounded event log; monitor load counters; static assumptions (including that group-telegram attribution by source address is an implementation assumption without the cEMI chapter). A test scans the output for credential/key/secure-session terms.
**Evidence: simulator only.** Mutation checks (each reverted): eligibility (ignore Read flag, accept ambiguous send groups, accept duplicate addresses), reconcile resetting evidence, supervisor ignoring the clock, duplicate telegram subscription, monitor kept running after tunnel loss / after stop, diagnostics presenting unknown as confirmed — all failed named tests; one defensive line (`detach()` before attach in `connectOnce`) is not independently observable and is documented as such.
**Still open:** gateway route / UI consumption (the service is not instantiated anywhere in production), persistence of health history, supervisor ownership vs the gateway's own 60 s driver retry, real-hardware calibration.

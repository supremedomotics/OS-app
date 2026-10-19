# Native parity evidence — what the 121 driver tests prove, and what they cannot

2026-10-19 · Companion to `knx-native-group-parity-plan.md` §6.1. **Evidence levels used here: S = simulator-tested, U = unit-tested, V = specification-verified, H = hardware-tested. Everything below is S/U; there is no V for any DPT bit layout and no H at all.**

How to reproduce the per-test rows: `KNX_DRIVER_BUS=native KNX_PARITY_REPORT=1 pnpm exec vitest run src/knx-driver.test.ts 2>&1 | grep PARITY-ROW` (one JSON row per test that used a bus: test name, aliased GA count, decode failures, rejected observers, wire writes).

## 1. Corrected counts (measured, not inherited)

| | Count | Source |
|---|---|---|
| Driver tests | 121 | `knx-driver.test.ts`, unchanged assertions, run on the fake (default) and on `NativeKnxConnection` (`KNX_DRIVER_BUS=native`) |
| Tests that instantiate a bus (rows in the report) | 92 | `PARITY-ROW` count; the other 29 are pure codec/mapper tests that never touch a bus, so the transport cannot affect them |
| Of those: used ≥1 **aliased (invalid) group address** | **64** | `aliasedGas > 0` |
| …of which pass **only because a telegram was dropped before the driver** | **4** | `decodeFailures` non-empty |
| …aliased and *not* dropping (the "60") | **60** | 64 − 4 |
| Bus tests using only valid addresses | 28 | 92 − 64 |

The earlier "60 aliased + 4 dropped" wording read as 64 distinct tests *plus* 4; it is 64 in total (the 4 dropped ones are also aliased). No assertion was changed to obtain any of this.

## 2. The aliased tests (64)

**Why aliasing exists.** The tests use synthetic three-level addresses with a main group above 31 (`92/1/3`). KNX three-level addressing has a 5-bit main group, so `NativeKnxConnection` correctly rejects them (`invalid_address` for writes; an inert, recorded observer for `observe`). The harness maps each string to a distinct valid address in main group 31 (a bijection per bus) and maps it back in `writes`.

**What an aliased test proves (S).** Driver logic above the seam runs identically when the transport underneath is the native one: command → real DPT encode → real KNXnet/IP TUNNELLING_REQUEST → virtual gateway → what the *line* received (checked equal to the requested value, loudly, in the harness); feedback value → real cEMI re-parse → telegram bus → strict DPT decode → driver state/provenance merge.

**What it does NOT prove, for every one of the 64:**
1. **Address parsing and formatting.** The string the test names never reaches `parseGroupAddress`; the alias does. A bug that mangled, say, `20/1/5` would not be seen by these tests.
2. **The inbound UDP hop.** `push()` is synchronous and publishes a re-parsed L_Data.ind straight into the bus. Gateway relay, tunnel sequence handling, heartbeat, and reconnect never carry a status telegram in these tests.
3. **Fan-out behaviour on a shared GA.** The fake delivers a pushed value to the *last-registered* observer only; the native bus delivers to *all*. Tests that share a GA assert only what the last-registered observer sees.
4. **Production behaviour for such an address.** In production a binding with main group > 31 is rejected by the native stack where the legacy library silently never matches it. The aliased tests say nothing about that; it is now pinned separately (§4, test 6).
5. **"Survives disconnect/reconnect"** (the `I`, `O`, `N`, `V` tests): these swap the connection *object* via the driver; they never exercise a link outage and supervisor recovery. Pinned separately (§4, test 3).

| Group (describe) | Tests | Specific coverage by the native run | Specific gap beyond 1–5 |
|---|---|---|---|
| 3.3C-2 DPT 20.105 | 10 | Association of the controllingModeExtended role; merge without corrupting other fields; out-of-range 20.105 value ignored; 4-GA coexistence incl. real wire writes; unaffected plain onoff/position bindings | the out-of-range value (`18/19/21-255`) is injected as a decoded number; the transport's own rejection of a *reserved byte* is covered by DPT unit tests, not here |
| 3.3C-3 DPT 1.100 | 13 | heatCool association/merge; command writes DPT 1.100 to the heatCool GA only (wire-verified); command is not optimistic state; unbound-role error; 5-GA coexistence | `E` is one of the four dropped tests (§3) |
| 3.3C-4 DPT 22.101 | 11 | status association/merge; a new status telegram replaces the snapshot; no write path for status (wire shows no write); 6-GA coexistence | **raw status number only**: the native decoder yields the raw number (documented difference D1); bit order is not specification-verified |
| 3.3C-5B DPT 222.100 | 13 | setpoints association/merge, wholesale replacement, update-order tests, no write path; 7-GA coexistence | key case differs from the library (D2); field order not specification-verified |
| 3.3D-FIX temperature commands | 8 | mode-only/advanced-only rejection; valid combinations still write targetC; wire-verified writes | none specific |
| 3.3D-FIX duplicate-GA | 3 | **dropped-telegram tests — §3** | see §3 |
| 3.4B Matter heat/cool routing | 6 | Matter SystemMode.Heat/Cool reach the heatCool role GA with the right DPT 1.100 value (wire-verified); no fabricated fallback GA; feedback beats the request | none specific |

## 3. The four tests that pass because a telegram was dropped

Each pushes a value that the native transport refuses to deliver, and each assertion holds either way. They therefore prove the *driver's* behaviour "no change to state", **not** the transport's behaviour.

| Test | What the native run actually does | Proves | Does not prove |
|---|---|---|---|
| `Phase 3.3C-3 E` — out-of-range heatCool is ignored | The test pushes integer `7` for DPT 1.100. On the wire a one-bit value above 1 is a 6-bit "short" payload; native decode fails (`bad_payload`, counted), the driver never sees it | the previous valid `heatCool` stays; a decode failure is counted and nothing fabricated | that the **driver's own** out-of-range check (the thing the test was written for) ever executed on the native path — the fake run is the only evidence for that |
| `3.3D-FIX A` — primary GA == operatingMode GA | Two observers share the GA (9.001 and 20.102). A pushed 1-byte value decodes for 20.102 but fails 9.001 (`bad_payload`) | no primary state is fabricated from the 1-byte value | the "last-registered wins" rule the test documents — native does not implement it (fan-out), so that rule is *not* parity-tested |
| `3.3D-FIX B` — status GA == setpoints GA | 22.101 (2 B) vs 222.100 (6 B): only one decodes | status is never fabricated from the setpoints payload | same: wins-by-registration order not exercised |
| `3.3D-FIX C` — operatingMode and heatCool share a GA | 20.102 (1 B) vs 1.100 (short): one decodes | operatingMode is never fabricated | same |

Separate valid-address tests for these cases are in §4 (tests 4 and 5): they use a real wire frame and assert the native semantics explicitly (fan-out; per-observer decode; counted drops) instead of relying on the assertions passing "either way".

## 4. Added evidence — `native/driver-valid-address.test.ts` (6 tests, S, valid addresses, full wire path)

1. Seven-GA HVAC entity (the `U` scenario) with main group 20: commands reach exactly the setpoint and heatCool GAs with the right DPT bytes on the line; status and setpoints are never written; every role merges into one state.
2. A command is not state: only a device report, delivered through the gateway, produces `observed`; a disagreeing report wins.
3. Real link outage and recovery: bindings continue, exactly one event per telegram, six bus subscriptions before and after, one connection object, a second gateway connect only for the recovery.
4. The `E` case on a real wire frame: the 6-bit short payload is dropped at the transport and counted (`bad_payload: 1`), prior state kept.
5. The duplicate-GA case on a real wire frame: fan-out to both observers; the undecodable one is dropped and counted; a later 2-byte value reaches the primary as well (documented difference from the fake).
6. An **invalid** address (main group 92) is rejected visibly on the native path: the observer is inert and recorded in diagnostics, and `command` fails `invalid_address`/`not_sent` with nothing on the line.

Still not proven by anything: that *production* configurations never contain such addresses (the ETS import validates them upstream — not re-verified here).

## 5. DPT differential suite

`dpt-differential.test.ts` (39 tests, auto-skips if `knxultimate` is removed) was run: **39 pass**. It compares native decode with `knxultimate` 6.0.1 output and asserts each known difference explicitly (D1 22.101 raw number, D2 222.100 lowercase keys, D3 0x7FFF refused, DPT 1 non-0/1 octet, DPT 17 reserved bits, DPT 14 non-finite, encode rounding, 5.003 half-steps). **Evidence level S/U with the library as the oracle.** No KNX Datapoint Types specification text is in the repository, so none of these is **V**; D3 in particular stays "specification-intended, to be confirmed" and D1/D2 bit and field order stay unverified. The three normative-vector files (`ccm.vectors`, `ip-frames.vectors`, `ip-keys.vectors`, 22 tests) remain skipped for the same reason.

## 6. Addendum 2026-10-20 — state semantics and real-wrapper cancellation
* **Command echo vs observed state (D7/D8).** `state-semantics.test.ts` (10 tests, S) runs one set of scenarios through `KnxProtocolDriver` on the legacy wrapper (modelled client; library-source evidence) and on the native connection (simulator). Proves: a command is `commanded`, never state, no optimistic update; the client's own transmission on a declared shared GA is not observed; an independent write or a GroupValueResponse is observed; a GroupValueRead request is not; identical repeats give one event. Does **not** prove: real-gateway echo behaviour, source-address attribution for shared GAs, or the modelled client's fidelity to the real one beyond what the library source shows.
* **Real library-parsed packets.** `real-library-packets.test.ts` (6 tests, evidence level **L**) feeds KNXnet/IP TUNNELING_REQUEST / cEMI L_Data.ind bytes (authored from the cEMI layout, not produced by the library's encoder) through the installed `knxultimate` 6.0.1 `KNXProtocol.parseMessage`, emits the library's own packet objects on a real, never-connected `KNXClient`, and runs them through the real `wrapKnxUltimate` and `KnxProtocolDriver`: GroupValueWrite and GroupValueResponse are observed, GroupValueRead and `echoed = true` are not, and on a shared GA the echo of our own command is not state while a later report is. Mutation-checked: removing the echo filter fails tests 4 and 5; passing reads through fails test 3. **Limit:** `echoed` is passed the way the library's `write()` does (source reading); a connected real client was not driven, and no gateway was involved. **Known test-quality note:** `state-semantics.test.ts` issues `{ action: "set", on: true }`, which the onoff path does not treat as "on" (the transport write is `false`); its assertions (no state from the echo) hold either way, but it does not send the command it names — not changed here.
* **Real wrapper cancellation.** `real-wrapper-cancel.test.ts` (3 tests) uses the installed `knxultimate` 6.0.1 and real loopback UDP against a minimal fake gateway — evidence level **L (real library, fake gateway)**, below hardware. Results in parity plan §11.

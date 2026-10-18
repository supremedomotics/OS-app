# Plan — native group read/write and telegram-feedback parity with the legacy driver

2026-10-18 · Written as a plan after the health vertical slice (`knx-device-health-design.md` §8); **deliverables 1–5 below are now implemented and simulator-tested** (status and results in §6–§9). Goal: a native implementation of the production driver's bus seam, proven against the legacy driver's own tests, still behind the feature flag. **Evidence level of everything below: simulator-tested (S) and unit-tested (U); specification-verified (V) only where stated; real-hardware-tested (H): none.**

## 1. The seam (verified in code)
`KnxProtocolDriver` (`services/protocols/src/knx-driver.ts`) reaches the bus only through `KnxConnection` (lines 37-48):
`connect()` · `disconnect()` · `write(groupAddress: string, value: KnxValue, dpt: string)` · `observe(groupAddress, dpt, handler(value)): unsubscribe`.
Its 121 tests (`knx-driver.test.ts`) drive the driver with a **fake** `KnxConnection`; they never touch `knxultimate`. Everything above the seam (command/feedback attribution, HVAC multi-GA roles, DPT 20.102/20.105/1.100/22.101/222.100 handling, provenance `commanded` vs `observed`) is therefore independent of the transport and stays untouched. Parity means: **a native class implementing `KnxConnection` behaves like `wrapKnxUltimate` for everything the driver can observe**, with the deliberate deviations already documented (D1 22.101 raw number, D2 222.100 lowercase keys, D3 invalid 0x7FFF).

## 2. Deliverables (in order, each independently testable) — status in the right-hand tag
1. **`NativeTelegramBus`** (`native/telegram-bus.ts`): multi-subscriber per group address, **per-handle unsubscribe** (fixes legacy D4 in the provider; the production wrapper already does per-observer removal), bounded history, source address kept on every telegram, delivery isolation (a throwing handler never affects others), telegram stream fed by `KnxTunnelClient.onTelegram`. The health monitor becomes one more subscriber (replacing its direct `onTelegram` listener). — **DONE** (`native/telegram-bus.ts`, 24 tests; one deliberate change: no separate `onTelegram`-fed health listener yet — the health monitor attaches through the `onLinkUp` hook)
2. **`NativeKnxConnection implements KnxConnection`** (`native/knx-connection.ts`): `connect()` = supervised fresh tunnel (reuse the `ConnectionManager` wiring proven in `health-service.ts`, extracted rather than copied); `write()` = encode via `native/dpt.ts` + `sendGroup(write)`; `observe()` = bus subscription + DPT decode (`native/dpt.ts`), responses **and** writes count as feedback exactly like the wrapper (reads are ignored — already true in `cemi.ts`). — **DONE** (`native/knx-connection.ts` + `supervised-tunnel.ts`; reconnect decision in `knx-reconnect-ownership.md`)
3. **Read facade** `read(ga)` (GroupValueRead trigger for state sync) on the same class, used by `SupremeKnxDriver.syncAll`; shares the health monitor's budget so sync and probing cannot overload the bus. — **DONE as `read()` on the class** (response correlation by group address only; not called by the driver; no budget sharing with the health monitor yet)
4. **Contract suite** `knx-connection.contract.test.ts`: one table of behaviours, executed against (a) the fake used by the legacy tests and (b) `NativeKnxConnection` over the simulator, so both implementations are held to the same observable contract. Cases: write encodes the right bytes per DPT; observe receives writes and responses, not reads; two observers on one GA, unsubscribing one leaves the other; unsubscribe is idempotent; handler exceptions isolated; reconnect restores subscriptions without duplicates; connect failure leaves no listener/socket/timer (legacy leak regression); write while disconnected fails visibly; invalid GA/DPT rejected before any frame is built. — **DONE** (`native/simulator/knx-connection.contract.ts`, run by `knx-connection.contract.test.ts` against legacy and native)
5. **Driver parity run**: parametrise `knx-driver.test.ts`'s fake-bus fixture so the SAME 121 tests run with `KnxProtocolDriver({ connection: new NativeKnxConnection(...simulator...) })`. The tests that depend on library-specific decoding (the three intentional deviations) get explicit paired expectations ("legacy: …, native: …") instead of silent edits. — **DONE** (`KNX_DRIVER_BUS=native`; the 121 tests unchanged)
6. **Differential cases** that stay valid only while `knxultimate` is installed (`dpt-differential.test.ts` already auto-skips when it is gone). — unchanged (`dpt-differential.test.ts`)
7. **Shadow mode** (still no cutover): flag-gated, runs `NativeKnxConnection` read-only alongside the legacy connection on a non-customer installation, compares observed values per GA and reports divergences through the diagnostics service. — **DESIGN ONLY** (`knx-shadow-mode-design.md`)

## 3. Out of scope for that milestone
Secure (blocked), routing (not used by legacy), individually-addressed frames, ETS-driven bindings changes, production registration, removal of `knxultimate`.

## 4. Exit criteria
Contract suite green for both implementations; the 121 driver tests green on the native connection with the three documented deviations asserted explicitly; no new timer/socket/listener after 100 connect/disconnect cycles; no change to `knx-driver.ts` behaviour; hardware-in-the-loop checklist drafted (gate G5) but **not** claimed.

## 5. Risks to watch
Handler ordering and re-entrancy differences from the library (same-tick delivery); string GA canonicalisation (`1/1/1` vs raw); DPT decode differences beyond D1–D3 found only by the differential suite; the legacy driver's own auto-retry in the gateway (60 s) interacting with the supervisor's backoff — decide a single owner of reconnects before wiring.


## 6. Results of this milestone (simulator-tested; no hardware)

| Stage | Result |
|---|---|
| 1 Reconnect ownership | one owner per phase with a hard hand-off — `knx-reconnect-ownership.md`; a previous-milestone defect found and fixed (`KnxHealthService.stop()` during an in-flight connect left a tunnel + running monitor) |
| 2 Telegram bus | bounded, typed, per-handle; 24 tests incl. 200 000-telegram volume, listener errors, malformed input, close-from-handler |
| 3 `NativeKnxConnection` | 34 tests: lifecycle, 100 connect/disconnect cycles (0 residue), recovery, observers/attribution, reads, write outcomes, observe-only, health hook |
| 4 Contract + parity | contract suite 78 cases (legacy 39 + native 39, differences asserted on both sides); **121/121 legacy driver tests pass on both buses** |
| 5 Shadow | design document |

Mutation checks: 18 deliberate defects were injected into the new code (reconnect, cancellation, bus delivery, filtering, outcome classification, observe-only, hook cleanup, health fix, single-slot); **all 18 were detected**. Two initially survived (read filtering was enforced only incidentally by a decode error; a cancellation race needed a stub tunnel) and the tests were strengthened.

### 6.1 The 121 driver tests on the native connection — what "pass" means here
* All 121 pass **unchanged** (assertions untouched; only the bus fixture is selected by `KNX_DRIVER_BUS`). Default runs still use the in-memory fake: 121/121.
* **60 tests use synthetic group addresses with a main group above 31** (e.g. `92/1/3`); KNX three-level addressing has a 5-bit main group, so the native connection correctly rejects them (`invalid_address`). The harness maps each to a distinct valid address in main group 31 and maps back in `writes`. This is a property of the fixtures, not of the driver — but it means those 60 tests do **not** exercise address parsing, and production would reject such a binding where the legacy library silently never matches it.
* **`push()` is synchronous** (the legacy tests assert right after it), so it encodes the value, builds and re-parses a real cEMI L_Data.ind and publishes into the bus: everything but the UDP hop. **Writes are real**: `writes` is what the virtual gateway received over the tunnel, and the harness fails a test if the wire value differs from the request.
* **4 tests pass because the native transport dropped a telegram the fake delivered**: `Phase 3.3C-3 E` (heatCool value 7 is a 6-bit short value on the wire → refused as `bad_payload` before the driver sees it) and the three `Phase 3.3D-FIX — duplicate HVAC GA assignment` tests (two observers share one GA with different DPTs; one decode fails). Their assertions hold either way.
* The fake delivers a pushed value only to the **last-registered** observer on a GA; the legacy wrapper and the native bus deliver to **all**. The native run is therefore closer to production than the fake — and shows the legacy suite never asserted fan-out.
* Intermediate failures while building the harness (60 from address validity, 10 from value representation) were all harness issues; **no native defect was found by the 121 tests**, and none was hidden or loosened.

## 7. The three known decoding differences — classification

Evidence for the legacy side is `knxultimate` 6.0.1 library output (dptlib run directly) and the production codec source; **no KNX Datapoint Types specification text is in the repository** (see the scope audit, requirement 7), so nothing below is *specification-verified (V)*.

| # | Difference | Legacy (library) | Native | Classification | Evidence / confidence |
|---|---|---|---|---|---|
| D1 | DPT 22.101 `0x0103` | object `{Fault, StatusEcoH, HeatCoolMode, …}` | number `259` | **Intentional; the legacy path has a compatibility defect.** `decodeHvacStatus` does `Number(value)`, so the object form yields `NaN → null`: HVAC status never populates in production. The bit-field object is *also* a legitimate reading of a flag type; the point is that it is not what the production decoder consumes. | **[Certain]** for the incompatibility (library output + `knx-codec.ts`). **[Guessing]** that the bit order of the native raw number matches the spec: `decodeHvacStatus`'s bit map is itself unverified against the DPT text. |
| D2 | DPT 222.100 `0c1a 0c9a 0b00` | `{Comfort:21, Standby:23.56, Economy:15.36}` | `{comfort:21, standby:23.56, economy:15.36}` | **Intentional.** Values are identical; key case is an API convention (`KnxSetpoints`/`isKnxSetpoints` require lowercase), not something the DPT defines. Legacy keys make HVAC setpoints decode to `null` in production. | **[Certain]** (both sides run in the contract suite). Field order comfort/standby/economy matches the library; spec order unverified. |
| D3 | DPT 9.001 `0x7FFF` | `670760.96` delivered as a reading | refused, counted (`invalid_data`), previous good value kept; a later valid value is delivered | **Specification-intended (to be confirmed against the DPT text) and a legacy defect.** The project's own driver already treats `670760.96` as invalid inside DPT 222.100 fields, so the legacy path is internally inconsistent: a plain DPT 9 sensor would publish 670760.96 °C. Inside DPT 222.100 native keeps the same sentinel as the library (`F16_INVALID_VALUE`) so field-level invalidation in `decodeHvacSetpoints` is unchanged. | **[Likely]** that 0x7FFF is the DPT 9 invalid code (library constant + project code agree; spec not held). **[Certain]** about the observable difference. |

Other documented native-stricter differences remain in `dpt-differential.test.ts` (DPT 1 non-0/1 octet, DPT 17 reserved bits, DPT 14 non-finite, encode rounding, 5.003 half-steps); the 121 driver tests do not exercise them (they inject decoded values).

## 8. New legacy-path findings (contract suite D5–D8) — all behavioural, none changed in production

| id | Finding | Impact | Evidence |
|---|---|---|---|
| D5 | one throwing observer aborts delivery to the others and the exception escapes into the library's receive path | one buggy handler can silence every other observer of that GA | **[Certain]** wrapper source + contract test (modelled client) |
| D6 | observers stay registered on a disconnected client | leak; harmless only because the library stops emitting | **[Certain]** wrapper source |
| D7 | `knxultimate` emits an `indication` for its **own** outgoing write (`echoed = true`) and the wrapper ignores the flag | a binding with `feedbackOnCommandAddress` would record the transmitted command as *observed* state — inferring execution from transmission, the thing the driver's design forbids. Native never delivers own writes. **Behavioural risk of switching: such a device would stop showing an "observed" state until it genuinely reports.** | **[Certain]** library source (`KNXClient.js` tunnel branch of `write()`; `d.ts` types the 2nd argument); **[Likely]** it applies on the production `TunnelUDP` path; not run against a real client |
| D8 | a GroupValueRead indication carries `dataValue = Buffer.alloc(1, apci & 0x3f)` and is not filtered | a read on a status GA (another device, a health probe) would appear as value 0/false | **[Certain]** `NPDU.js`; **[Likely]** the client forwards read indications (`KNXClient.js` ~2222 forwards every L_DATA_IND) |

D5–D8 evidence comes from a *modelled* `KNXClient` built from that source reading (`simulator/contract-harnesses.ts`); confirming them on the real client is hardware-list item H-3 below.

## 9. Remaining work, specification gaps and hardware tests

**Not done / open:** (a) no tap, runner, comparator or guards for shadow mode; (b) `KnxHealthService` still owns its own tunnel — moving it onto `NativeKnxConnection`'s link hook is a follow-up; (c) the driver cannot show link-down and cannot cancel its own in-flight connect (proposals in `knx-reconnect-ownership.md` §5; both need a driver change); (d) `read()` is not used by `SupremeKnxDriver.syncAll` and shares no budget with the health monitor; (e) no factory/registration — `createSingleSlotConnectionFactory` is an unwired helper; (f) gateway KNX e2e suites still cannot load in this sandbox and were not re-run.

**Specification gaps:** KNX Datapoint Types text (D1 bit order, D2 field order, D3 invalid code, all DPT correctness beyond the library oracle); KNXnet/IP Core v2/Overview (status codes, DESCRIPTION for tunnel-slot count — also blocks shadow option A's slot check); whether an interface relays a tunnel's frames to other tunnels and sends L_Data.con only to the sender.

**Hardware tests required (none run):** H-1 gateway reboot/power-loss recovery and dead-channel lifetime on a 1-slot gateway; H-2 abort during CONNECT_RESPONSE (orphan lifetime); H-3 real `KNXClient` behaviour for D5–D8 and the legacy path after a gateway reboot; H-4 write → status feedback round trip with a real actuator (ACK vs L_Data.con vs device report) and attribution of the source IA; H-5 many-subscriber/high-rate traffic on a real line; H-6 DPT decode of real devices for 22.101 / 222.100 / 9.xxx invalid markers; H-S1…S4 from the shadow design.

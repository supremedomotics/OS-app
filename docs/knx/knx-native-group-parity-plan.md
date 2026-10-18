# Plan — native group read/write and telegram-feedback parity with the legacy driver

2026-10-18 · **Plan only; no code in this milestone.** Follows the health vertical slice (`knx-device-health-design.md` §8). Goal: a native implementation of the production driver's bus seam, proven against the legacy driver's own tests, still behind the feature flag.

## 1. The seam (verified in code)
`KnxProtocolDriver` (`services/protocols/src/knx-driver.ts`) reaches the bus only through `KnxConnection` (lines 37-48):
`connect()` · `disconnect()` · `write(groupAddress: string, value: KnxValue, dpt: string)` · `observe(groupAddress, dpt, handler(value)): unsubscribe`.
Its 121 tests (`knx-driver.test.ts`) drive the driver with a **fake** `KnxConnection`; they never touch `knxultimate`. Everything above the seam (command/feedback attribution, HVAC multi-GA roles, DPT 20.102/20.105/1.100/22.101/222.100 handling, provenance `commanded` vs `observed`) is therefore independent of the transport and stays untouched. Parity means: **a native class implementing `KnxConnection` behaves like `wrapKnxUltimate` for everything the driver can observe**, with the deliberate deviations already documented (D1 22.101 raw number, D2 222.100 lowercase keys, D3 invalid 0x7FFF).

## 2. Deliverables (in order, each independently testable)
1. **`NativeTelegramBus`** (`native/telegram-bus.ts`): multi-subscriber per group address, **per-handle unsubscribe** (fixes legacy D4 in the provider; the production wrapper already does per-observer removal), bounded history, source address kept on every telegram, delivery isolation (a throwing handler never affects others), telegram stream fed by `KnxTunnelClient.onTelegram`. The health monitor becomes one more subscriber (replacing its direct `onTelegram` listener).
2. **`NativeKnxConnection implements KnxConnection`** (`native/knx-connection.ts`): `connect()` = supervised fresh tunnel (reuse the `ConnectionManager` wiring proven in `health-service.ts`, extracted rather than copied); `write()` = encode via `native/dpt.ts` + `sendGroup(write)`; `observe()` = bus subscription + DPT decode (`native/dpt.ts`), responses **and** writes count as feedback exactly like the wrapper (reads are ignored — already true in `cemi.ts`).
3. **Read facade** `read(ga)` (GroupValueRead trigger for state sync) on the same class, used by `SupremeKnxDriver.syncAll`; shares the health monitor's budget so sync and probing cannot overload the bus.
4. **Contract suite** `knx-connection.contract.test.ts`: one table of behaviours, executed against (a) the fake used by the legacy tests and (b) `NativeKnxConnection` over the simulator, so both implementations are held to the same observable contract. Cases: write encodes the right bytes per DPT; observe receives writes and responses, not reads; two observers on one GA, unsubscribing one leaves the other; unsubscribe is idempotent; handler exceptions isolated; reconnect restores subscriptions without duplicates; connect failure leaves no listener/socket/timer (legacy leak regression); write while disconnected fails visibly; invalid GA/DPT rejected before any frame is built.
5. **Driver parity run**: parametrise `knx-driver.test.ts`'s fake-bus fixture so the SAME 121 tests run with `KnxProtocolDriver({ connection: new NativeKnxConnection(...simulator...) })`. The tests that depend on library-specific decoding (the three intentional deviations) get explicit paired expectations ("legacy: …, native: …") instead of silent edits.
6. **Differential cases** that stay valid only while `knxultimate` is installed (`dpt-differential.test.ts` already auto-skips when it is gone).
7. **Shadow mode** (still no cutover): flag-gated, runs `NativeKnxConnection` read-only alongside the legacy connection on a non-customer installation, compares observed values per GA and reports divergences through the diagnostics service.

## 3. Out of scope for that milestone
Secure (blocked), routing (not used by legacy), individually-addressed frames, ETS-driven bindings changes, production registration, removal of `knxultimate`.

## 4. Exit criteria
Contract suite green for both implementations; the 121 driver tests green on the native connection with the three documented deviations asserted explicitly; no new timer/socket/listener after 100 connect/disconnect cycles; no change to `knx-driver.ts` behaviour; hardware-in-the-loop checklist drafted (gate G5) but **not** claimed.

## 5. Risks to watch
Handler ordering and re-entrancy differences from the library (same-tick delivery); string GA canonicalisation (`1/1/1` vs raw); DPT decode differences beyond D1–D3 found only by the differential suite; the legacy driver's own auto-retry in the gateway (60 s) interacting with the supervisor's backoff — decide a single owner of reconnects before wiring.

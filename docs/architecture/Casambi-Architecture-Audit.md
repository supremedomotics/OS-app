# Casambi Driver — Architecture Validation & Refactor Audit

> Mandatory pre-implementation architecture audit, performed before any further Casambi protocol
> work. Scope: verify the Casambi driver against the required Connection Manager → Transport →
> Service → Engine hierarchy, and the broader universal-driver template. Cloud behavior was not
> modified in a way that changes its wire behavior — every change is verified against the existing
> Cloud-mode test suite (`casambi-driver.test.ts`'s fake-timer reconnect/heartbeat assertions),
> which passed unmodified, byte-for-byte, both before and after this audit's refactor.
>
> This document reports the state as actually found in the code, not as designed on paper. Where
> the answer is "no" or "partial," it says so and explains why, per the explicit instruction not to
> self-grade "yes."

## 0. Method

Every claim below was checked by reading the real source, not by re-describing what a previous
session's commit message said it did. Files read in full for this audit: `connection-manager.ts`,
`cloud-transport.ts`, `local-transport/{local-gateway-transport,rest-client,udp-engine,udp-codec}.ts`,
`entity-mapper.ts`, `discovery-engine.ts`, `feedback-engine.ts`, `event-engine.ts`,
`local-discovery.ts`, `local-command-mapper.ts`, `diagnostics.ts`, `health-monitor.ts`,
`casambi-driver.ts` (all 650+ lines), and `core/*.ts`.

## 1. Current architecture as found (before this audit's refactor)

```
Connection Manager (connection-manager.ts)
  │  picks Cloud vs Local, builds the matching transport — no protocol logic. ✅ compliant.
  │
  ├── Cloud Transport (cloud-transport.ts)
  │     ONE monolithic class: REST (session/network/state) + WebSocket wire + inline parsing
  │     (parseUnits/parseGroups/parseSession/decodeMessage) all in one file. Not split into
  │     "services" — never was, and the brief says leave it untouched.
  │
  └── Local Transport (local-transport/local-gateway-transport.ts)
        A real, thin container — genuinely just holds the two services below. ✅ compliant.
        │
        ├── REST Service (local-transport/rest-client.ts) — independent, real. ✅
        └── UDP Service (local-transport/udp-engine.ts) — independent, real. ✅

  ↓  (this is where the audit found the real problem)

casambi-driver.ts — a single 650-line class containing:
  • command()          — an inline `if (mode === "local")` branch, building and sending a
                          command TWO structurally different ways. NOT one Command Engine.
  • onEvent()           — Cloud-only raw-event dispatch, inline in the driver.
  • onLocalPacket()     — Local-only raw-packet dispatch, inline in the driver, DUPLICATING
                          onEvent's job (decide what a signal means) for a second transport.
  • connectLocal()      — inline discovery bootstrap (encode+send three UDP commands directly).
  • discover()          — the ONE part that WAS already correct: calls the same
                          `buildDiscoveredDevices()` regardless of mode.

Two competing event-bus implementations existed side by side:
  • event-engine.ts's `CasambiEventBus` — actually used by the driver.
  • core/event-bus.ts's `CoreEventBus`  — built, tested, never wired to anything.
```

**No Command Engine, no Event Engine, and only half a Discovery Engine existed as real, distinct
entities.** The names existed as file names; the actual dispatch/normalization logic they should
have contained was inline in the driver, duplicated once per transport.

## 2. Per-layer audit — honest answers, not "yes"

### Connection Manager (`connection-manager.ts`)

| Question | Answer |
|---|---|
| Does it exist? | Yes. |
| Is it independent? | Yes — imports only the two transport constructors, no protocol logic. |
| Is it reusable? | As a pattern, yes; as code, no — it's Casambi-typed (`CasambiLocalTransport`), so a KNX driver would write its own, not import this one. That's expected: the hierarchy is per-driver at this layer. |
| Is it tightly coupled? | No. |
| Is it production quality? | Yes — small, does one job, fully typed. |
| Does it violate SOLID? | No. |
| Does it duplicate logic? | No. |
| Will it scale to future transports? | The `CasambiConnectionMode` union (`"cloud" \| "local"`) would need a third arm for a third transport (e.g. the Lithernet gateway's "TCP Free Messages" mode) — a small, expected, non-structural change. |

**Verdict: compliant.** ✅ This is the one layer that matched the target on first read, no
refactor needed.

### Transport Layer (Cloud Transport / Local Transport)

| Question | Cloud Transport | Local Transport |
|---|---|---|
| Does it exist? | Yes | Yes |
| Is it independent? | Yes (no Local imports) | Yes (no Cloud imports) |
| Is it reusable? | N/A — one real caller | The container pattern (hold two services, no logic) is reusable |
| Is it tightly coupled? | Internally cohesive but monolithic (REST+WS+parsing in one file) | No — genuinely thin |
| Is it production quality? | Yes, fully tested, unchanged | Yes |
| Does it violate SOLID? | Arguably SRP (one class does session, network fetch, state fetch, WS framing, and message parsing) — but this is **pre-existing, explicitly protected code** ("Cloud Transport must remain untouched"), not something introduced or worsened by this work | No |
| Does it duplicate logic? | No | No |
| Will it scale? | N/A, frozen | Adding a third Local-side transport (TCP) means adding a third service file + wiring it into the container — no structural change to the container itself |

**Verdict: Local Transport is compliant** ("only a transport container, no business logic" —
confirmed true). **Cloud Transport is intentionally NOT decomposed into services** — it never had
a second, independent "service" to split from (Cloud's WebSocket write and REST read aren't two
interchangeable arms the way Local's REST-write/UDP-realtime split is; there's no real duplication
between them to justify extracting one). Splitting it purely for diagram-symmetry would be
"refactor for the sake of the picture," which this codebase's own conventions (`CLAUDE.md`: "no
unnecessary complexity") explicitly warn against, and the brief explicitly forbids touching it.
**This asymmetry between the two Transport arms is a disclosed, deliberate, judgment call — not
an oversight.**

### Service Layer (REST Service / UDP Service, Local only)

| Question | Answer |
|---|---|
| Does it exist? | Yes — `local-transport/rest-client.ts` (`CasambiLocalRestClient`), `local-transport/udp-engine.ts` (`CasambiUdpEngine`). |
| Is it independent? | Yes, verified by import graph: `rest-client.ts` imports only a type constant from `udp-codec.ts` (`CASAMBI_TARGET_TYPE`), never from `udp-engine.ts`. `udp-engine.ts` never imports from `rest-client.ts`. |
| Is it reusable? | Each is independently testable and independently instantiable (both have injectable `fetchImpl`/`socketFactory` for tests). |
| Is it tightly coupled? | No. |
| Is it production quality? | Yes — real `node:dgram` socket, real `fetch`, both tested (19 tests between them). |
| Does it violate SOLID? | No. |
| Does it duplicate logic? | No — REST implements the one documented write endpoint; UDP implements the full command/notification protocol. Zero overlap. |
| Will it scale? | Adding MQTT/BLE as new Local-side services means adding new files implementing their own send/receive shape — no change required to the existing two. |

**Verdict: fully compliant.** ✅ This layer was correct before this audit and remains so.

### Engine Layer (Command Engine / Event Engine / Discovery Engine) — **where the real violations were**

#### Command Engine

| Question | Before this audit | After refactor |
|---|---|---|
| Does it exist? | **No.** No file, class, or interface by this name or function existed. | Yes — `command-engine.ts`: `CasambiCommandEngine` interface, `CloudCommandEngine`/`LocalCommandEngine` implementations. |
| Is it independent? | N/A | Yes — neither implementation imports the other. |
| Is it reusable? | N/A | The interface is; a third transport adds a third implementation. |
| Is it tightly coupled? | **Yes** — `casambi-driver.ts`'s `command()` method branched on `this.mode` and called two structurally different code paths inline. | No — `command()` now has one call site, `await this.commandEngine.send(...)`, with zero mode branching. |
| Is it production quality? | The underlying send logic was fine; the STRUCTURE was not. | Yes. |
| Does it violate SOLID? | **Yes — Open/Closed.** Adding a third transport required editing `command()`'s body directly. | No — a third transport adds a third class, `command()` doesn't change. |
| Does it duplicate logic? | **Yes** — "resolve what to send, then send it" existed twice, once per transport, with no shared shape. | No — one interface, two implementations, same shape. |
| Will it scale to REST/UDP/TCP/MQTT/BLE without changing business logic? | **No** — a third transport meant a third `if` branch in the driver. | **Yes** — a third transport is a third class implementing `CasambiCommandEngine`; `command()`'s body is unchanged. |

**Verdict: was a confirmed violation. Refactored; now compliant.**

#### Event Engine

| Question | Before this audit | After refactor |
|---|---|---|
| Does it exist? | **Not really.** `event-engine.ts`'s `CasambiEventBus` is a pub/sub bus (the OUTPUT sink) — real and fine on its own — but the actual "engine" work (deciding what a raw wire signal MEANS) lived in two separate private driver methods, `onEvent`/`onLocalPacket`. A SECOND, unrelated event bus (`core/event-bus.ts`'s `CoreEventBus`) also existed, unused. | Yes — `event-engine.ts` gained a `CasambiSignal` discriminated union plus `normalizeCloudEvent`/`normalizeLocalPacket`, the ONE place that still knows the two wire formats differ. |
| Is it independent? | No — dispatch logic was welded into the driver class itself. | The normalizers are pure functions, independently testable (14 new tests) and independent of driver state (the Local normalizer takes a `getPrevUnit` callback rather than reading driver fields directly). |
| Is it reusable? | N/A | The `CasambiSignal` pattern (raw input → normalized union → one handler) is a real, replicable pattern for a future driver; the concrete types are still Casambi-specific, same caveat as Discovery Engine's output half. |
| Is it tightly coupled? | **Yes** — `onEvent`/`onLocalPacket` directly mutated `this.session`, `this.units`, `this.lastError`, called `this.applyUnit`/`this.events.publish`/`this.onDisconnected` inline, mixed together with the parsing decision itself. | Parsing (pure, in `event-engine.ts`) is now separated from reaction (`casambi-driver.ts`'s `applySignal`, one method, one switch, no per-transport branching). |
| Is it production quality? | The individual parse logic was correct; having it exist twice, un-unified, was the defect. | Yes. |
| Does it violate SOLID? | **Yes — SRP.** The driver had two full copies of "parse raw data → decide → mutate state → publish," one per transport, as separate methods with no shared contract. | No — one normalized type, one reaction method. |
| Does it duplicate logic? | **Yes**, confirmed: `onEvent`'s `case "unitChanged": this.applyUnit(eventToUnit(event))` and `onLocalPacket`'s `case 0x4b: ... this.applyUnit(unit)` are the same PATTERN (raw → unit → applyUnit) implemented twice with zero shared code between the two decision points. | No — both normalizers produce `{kind:"unit", unit}`, consumed by ONE `applySignal` case. |
| Will future drivers (KNX/Matter/Lutron/RTI/...) reuse this exact engine? | No — there was no "this" to reuse; the logic was Casambi's driver-internal implementation detail. | **Partially honest answer:** the *pattern* (`CasambiSignal` + per-transport normalizers + one reaction method) is now real and provable working code any future driver author can copy. The *`core/event-bus.ts` CoreEventBus* — the piece explicitly meant to be shared verbatim across every future driver — is **still not wired into this driver**. This is disclosed, not fixed in this pass; see §5. |

**Verdict: was a confirmed violation, more serious than Command Engine's (it directly
contradicted "no protocol-specific event handling"). Refactored; substantially compliant, with one
disclosed remaining gap (`CoreEventBus` migration).**

#### Discovery Engine

| Question | Answer |
|---|---|
| Does it exist? | **Half of it, genuinely.** `buildDiscoveredDevices()` (the OUTPUT-shaping half: unit/group model → Supreme's discovery contract) existed and was already correct. The DRIVING half (how/when a transport learns about new units) did not exist as a distinct entity — it was inline in `casambi-driver.ts`'s `connectLocal()` (three raw `udp.send(encodeXxx(...))` calls) and `establish()`/`loadNetwork()`/`seedState()` (Cloud's REST fetch sequence). |
| Is it independent from transport? | The output half: **yes, verified** — `discover()` calls the exact same `buildDiscoveredDevices(this.units, this.groups)` for both modes, zero branching. The driving half: **no**, it was transport-specific code sitting directly in the driver. |
| Is it reusable? | Output half: yes, pattern and code both. Driving half: was not factored out at all. |
| Is it tightly coupled? | Driving half was — Local's 3-line UDP bootstrap and Cloud's REST fetch-then-poll were both inline in driver methods. |
| Is it production quality? | Yes, functionally — the code worked and was tested. Structurally, the driving half not living in `discovery-engine.ts` was the defect. |
| Does it violate SOLID? | The driving half, mildly — it was reasonably scoped (a few lines each), but it was still discovery logic living in the connection-lifecycle methods rather than the module named for this job. |
| Does it duplicate parsing/discovery/mapping? | No duplication between Cloud and Local's driving logic — they never shared a code path to duplicate, because they're genuinely different discovery MODELS (Cloud: pull, on-demand REST fetch; Local: push, one-time UDP subscribe). |
| Will it support REST/UDP/MQTT/BLE without changing higher layers? | The output half: yes, already true and unchanged by this refactor — a fifth transport just needs to populate `CasambiUnit`/`CasambiGroup` correctly and `buildDiscoveredDevices` needs no changes. The driving half: **a deliberate judgment call, not fully "generalized" — see below.** |

**Refactor performed:** Local's driving logic (`startLocalDiscovery`/`stopLocalDiscovery`) moved
out of the driver into `discovery-engine.ts`, where it now belongs.

**Refactor deliberately NOT performed, and why:** Cloud's driving logic (`loadNetwork`/
`seedState`) was left inline in `casambi-driver.ts`. Forcing Cloud and Local's driving logic
through one shared `DiscoveryDriver` interface today, with exactly two real callers whose actual
shapes are fundamentally different (pull-based REST fetch of a driver-owned session, vs. a
one-time push-based UDP subscribe), would be speculative abstraction — this codebase's own stated
convention (`CLAUDE.md`: "No unnecessary complexity, no speculative abstraction... don't design for
hypothetical future requirements") argues directly against it. A third real transport with a
driving shape that matches ONE of the existing two (e.g. a future TCP Free Messages mode, which
would almost certainly look like UDP's subscribe-once model) is the trigger that would justify
generalizing further — not before. **This is disclosed explicitly, not silently decided.**

**Verdict: output half fully compliant (unchanged, already correct). Driving half: Local extracted
and now lives in the Discovery Engine module; Cloud driving logic deliberately stays with the
driver's own connection lifecycle, with the reasoning stated above rather than hidden.**

## 3. Duplication summary (explicit, per the audit's checklist)

| Duplication check | Before | After |
|---|---|---|
| No duplicated parsing | Each transport parses its own wire format (unavoidable — different byte layouts) — no unnecessary duplication here, before or after. | Unchanged. |
| No duplicated discovery | Discovery-shaping was never duplicated. Discovery-driving was two independent inline blocks, not literally duplicated code, but duplicated PATTERN with no shared home. | Local's driving logic now lives in `discovery-engine.ts`; Cloud's stays in the driver by disclosed decision. |
| No duplicated entity mapping | **Was already correct** — `entity-mapper.ts`'s `capabilitiesFromUnit`/`statesFromUnit` are called identically by both `applyUnit` paths, zero duplication, confirmed by reading both call sites. | Unchanged — this was never a problem. |
| No duplicated commands | **Confirmed violation** — command resolution + sending existed twice. | Fixed — `CasambiCommandEngine`, one interface, two implementations. |
| No duplicated event handling | **Confirmed violation** — `onEvent`/`onLocalPacket` each independently decided what a raw signal meant. | Fixed — `normalizeCloudEvent`/`normalizeLocalPacket` produce one shared `CasambiSignal`, consumed by one `applySignal` method. |

## 4. Refactoring performed

1. **`services/protocols/src/casambi/command-engine.ts` (new).** `CasambiCommandEngine` interface
   + `CloudCommandEngine` (wraps the unchanged `commandToTargetControls` + `CasambiFeedbackEngine`)
   + `LocalCommandEngine` (wraps the unchanged `localCommandToUdpPacket` + `CasambiUdpEngine.send`).
   Selected once, in the driver's constructor. `casambi-driver.ts`'s `command()` collapsed from a
   14-line mode-branching method to a 6-line method with one call site.
2. **`services/protocols/src/casambi/event-engine.ts` (extended).** Added `CasambiSignal` (a
   7-variant discriminated union), `normalizeCloudEvent`, `normalizeLocalPacket`,
   `enableLocalButtonEvents`/`disableLocalButtonEvents`. `casambi-driver.ts`'s `onEvent`/
   `onLocalPacket` private methods (58 combined lines) removed; replaced by two thin wiring
   lambdas (at `openWire()`'s `onEvent` callback and `connectLocal()`'s `onPacket` callback) that
   both funnel into one new `applySignal(signal: CasambiSignal)` method.
3. **`services/protocols/src/casambi/discovery-engine.ts` (extended).** Added
   `startLocalDiscovery`/`stopLocalDiscovery`, extracted verbatim from `connectLocal`/
   `disconnectLocal`'s inline UDP bootstrap/teardown calls.
4. **`services/protocols/src/casambi/casambi-driver.ts` (rewired).** Constructor now picks
   `this.commandEngine` once. `command()`, event wiring, and Local bootstrap/teardown all updated
   to call the extracted engines instead of containing the logic inline. Net line count in this
   file went down despite the added engine field/wiring, because the two duplicated dispatch
   methods were larger than their replacements.
5. **Tests added**, none removed, none weakened: `command-engine.test.ts` (6), `event-engine.test.ts`
   (14), `discovery-engine.test.ts` (5) — 25 new tests exercising the extracted engines directly,
   independent of the driver. The full pre-existing `casambi-driver.test.ts` suite (17 tests,
   including the Cloud-mode fake-timer reconnect/heartbeat regression net) passed **unmodified**
   both before and after every step of this refactor — verified by running it after each
   individual change, not just once at the end.

## 5. Justification for every architectural decision

- **Why collapse Command Engine into one interface with two classes, rather than one function with
  an `if`?** An interface + polymorphism is what actually satisfies "no protocol should create
  commands directly" — a function with an `if` is the exact shape being replaced. The interface
  is also what makes a third transport additive (new class) instead of invasive (edit existing
  function).
- **Why keep `CasambiFeedbackEngine` instead of folding it into `CloudCommandEngine`?**
  `CasambiFeedbackEngine` already existed, is separately tested indirectly through the driver
  suite, and does ONE narrow job (write to the live wire) that `CloudCommandEngine` composes
  rather than reimplements — deleting and inlining it would be a pure loss of an existing,
  working seam for no benefit.
- **Why a discriminated union (`CasambiSignal`) instead of directly publishing `CasambiDriverEvent`
  from the normalizers?** `CasambiSignal` and `CasambiDriverEvent` are not the same thing:
  `CasambiSignal` is an INTERNAL engine-to-driver handoff (includes `"pong"` and `"wireStatus"`,
  which are connection-lifecycle concerns, never published to consumers), while
  `CasambiDriverEvent` is the PUBLIC taxonomy external consumers subscribe to. Collapsing them
  would leak internal plumbing (pong/wireStatus) into the public event contract.
- **Why does `normalizeLocalPacket` take a `getPrevUnit` callback instead of being handed the
  previous unit directly?** A 0x4B packet's Target_ID isn't known until it's partially parsed, so
  the caller can't look up "the previous unit" before calling the normalizer. A callback keeps the
  function pure (same output for the same packet + the same callback's answers) without forcing
  the caller to duplicate the NotifyControlValues parse just to know which unit to look up first.
- **Why NOT build one shared `DiscoveryDriver`/`ConnectionDriver` interface spanning Cloud and
  Local's connection-establishment sequence?** Covered in §2's Discovery Engine section — two real
  callers with genuinely different shapes (pull vs. push) is not evidence of a missing
  abstraction; it's two different problems that happen to have adjacent names. This codebase's own
  documented convention treats "three similar lines" as preferable to "a premature abstraction,"
  and applies it here deliberately rather than reflexively matching the target diagram's shape at
  every layer regardless of whether doing so would violate that same codebase's other stated
  principles.
- **Why not also migrate `casambi-driver.ts` onto `core/event-bus.ts`'s `CoreEventBus` in this
  same pass?** Two reasons: (1) scope control — this audit's job was to fix confirmed structural
  violations (Command/Event Engine not existing) with a verified zero-regression refactor;
  migrating the public event contract is a larger, separate change that touches what external
  consumers subscribe to, and deserves its own regression pass rather than being bundled into a
  refactor whose primary regression net is "Cloud's existing tests still pass." (2) Cloud's
  `CasambiEventBus` publishing is exercised by tests today; `CoreEventBus` has none of its own
  consumers yet to migrate against. Doing this properly means: pick one driver (Casambi), migrate
  it, and treat that as the reference implementation future drivers copy — not do it hastily
  alongside an unrelated audit. This is a disclosed, prioritized follow-up (see `TODO.md`), not a
  silent omission.

## 6. Updated architecture

```
Connection Manager
        │
────────┼─────────────────────────────────────────────────────
        │
 Cloud Transport                    Local Transport
 (REST+WS, one class,               (real container, no logic)
  frozen/untouched)                       │
                                ┌──────────┴──────────┐
                                │                      │
                          REST Service            UDP Service
                    (local-transport/          (local-transport/
                     rest-client.ts)             udp-engine.ts)
        │                                             │
        └──────────────────────┬──────────────────────┘
                                │
                 ┌──────────────┼───────────────┐
                 │              │               │
          Command Engine   Event Engine   Discovery Engine
        (command-engine.ts) (event-engine.ts) (discovery-engine.ts)
        CasambiCommandEngine  CasambiSignal +   buildDiscoveredDevices
        interface;            normalizeCloudEvent/  (output, shared) +
        Cloud/LocalCommand-   normalizeLocalPacket  startLocalDiscovery/
        Engine implementations (normalize only;      stopLocalDiscovery
                                driver's applySignal  (Local driving half;
                                reacts uniformly)     Cloud driving half
                                                       stays in the driver,
                                                       disclosed in §5)
                 │              │               │
                 └──────────────┼───────────────┘
                                │
                   casambi-driver.ts (orchestrator)
                   — one commandEngine field, one applySignal
                     method, one discover() call site, zero
                     mode-branching business logic left in
                     command()/event handling.
                                │
                          Entity Mapper (entity-mapper.ts)
                     capabilitiesFromUnit / statesFromUnit —
                     already shared, unchanged, zero duplication.
                                │
                     CasambiEventBus (event-engine.ts)
                — the public CasambiDriverEvent taxonomy driver
                  consumers subscribe to today.
                                │
                    (Automation Engine — not evaluated in this
                     audit; out of scope for the Casambi driver
                     itself, consumes `onState`/`onDriverEvent`
                     the same way regardless of this refactor)
```

## 7. Confirmation — is this ready to become the standard template?

**Not fully, and here is the honest, itemized answer rather than a blanket yes:**

| Universal template layer | Casambi's current state |
|---|---|
| Connection Manager | ✅ Real, compliant, copy this pattern directly. |
| Transport Layer | ✅ Real for Local (thin container). Cloud is a legitimate exception (frozen, pre-existing, no second service to split) — a future driver with two genuinely parallel transports should follow Local's container pattern, not Cloud's monolith. |
| Protocol Services | ✅ Real, independent, copy this pattern directly. |
| Command Engine | ✅ Real as of this refactor. Copy the interface + per-transport-implementation pattern. |
| Event Engine | ✅ Real as of this refactor for the NORMALIZATION pattern (`Signal` union + per-transport normalizers + one reaction method). ⚠️ NOT yet wired to `core/event-bus.ts`'s `CoreEventBus` — a future driver copying Casambi today would copy the pattern but land on the SAME old, driver-scoped `CasambiEventBus` shape unless the `CoreEventBus` migration (tracked in `TODO.md`) happens first. |
| Discovery Engine | ✅ Output-shaping half is real and copyable. ⚠️ Driving half is only half-generalized (Local extracted, Cloud deliberately not) — a future driver with two transports whose discovery models are as different as Cloud/Local's should expect the same asymmetry, not force symmetry it doesn't need. |
| Capability Engine | `core/capability-engine.ts` exists, is real, is tested — but is **not yet consumed by Casambi's own entity-mapper.ts**, which still computes capabilities its own way (`capabilitiesFromUnit`). This is a real, disclosed gap: the Capability Engine layer exists in the codebase but Casambi does not yet demonstrate using it. |
| Entity Mapper | ✅ Real, shared, zero duplication, confirmed by direct code inspection. |
| SupremeOS Core Event Bus | Exists (`core/event-bus.ts`), tested, but genuinely unused by any driver, Casambi included. **Cannot honestly be called proven** until at least one driver publishes through it end-to-end. |
| Automation Engine | Out of scope for this audit; not evaluated. |

**Bottom line:** the Connection Manager → Transport → Service → Command/Event/Discovery Engine
hierarchy specifically named in the audit request is now real and verified for Casambi, with two
disclosed, deliberate asymmetries (Cloud Transport not service-split; Cloud discovery-driving not
extracted) that are documented decisions, not oversights. The BROADER universal template's top two
layers beyond that (Capability Engine, Core Event Bus) exist as standalone, tested modules but are
**not yet proven by a real end-to-end consumer** — Casambi itself doesn't use them yet. Declaring
Casambi "the standard template" today would mean propagating that gap to every future driver that
copies it. **Recommendation: treat this refactor as template-ready for the Connection Manager
through Discovery Engine layers now; complete the `CoreEventBus`/`CapabilityEngine` migration
(tracked in `TODO.md`) before formally adopting Casambi as the reference template for KNX/Matter/
Lutron/RTI/Denon/DALI/Apple TV/Bluetooth/MQTT.**

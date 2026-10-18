# KNX shadow mode — design (non-production; nothing activated)

2026-10-18 · Stage 5 · **Design only.** What exists in code today is the enforcement primitive (`NativeKnxConnection` `mode: "observe_only"`, tested) and the building blocks listed in §7. No shadow runner, comparator, flag or wiring exists, and none is switched on anywhere.

## 1. Question and non-goals

*Question:* before the native stack carries real traffic, can we compare what it **observes** against what the legacy path observes, on real KNX traffic, without being able to change anything on the bus?
*Non-goals:* proving the write path, ACK/retry behaviour, reconnect behaviour, or command execution. A shadow that cannot write cannot prove any of those; they need the hardware-in-the-loop gate (G5) with a dedicated lab device. Shadow also does not exercise health probing (GroupValueRead is a bus frame and is refused in observe-only).

## 2. One authoritative command path

The legacy `KnxProtocolDriver` stays the **only** component that writes, reads, publishes state, owns devices, or feeds scenes/automations. The native side is constructed as `new NativeKnxConnection({ mode: "observe_only", … })`:

* `write()` and `read()` reject `observe_only / not_sent` **before** any frame is built — asserted by counting L_Data.req frames at the virtual gateway (zero) and by a mutation (M11: removing the guard makes the test fail).
* It is **not registered** with the engine (`registerDriver`), never calls `onState`, never touches `ownerByDevice`, bindings, ETS data, scenes or the state bus. Its only outputs are counters and comparator records written locally.
* The protocol-level control plane is unavoidable and is *not* bus traffic: CONNECT, CONNECTIONSTATE heartbeats, DISCONNECT and the TUNNELLING_ACK for each indication. A shadow tunnel therefore **occupies a tunnel slot** (asserted: 2 channels open).

## 3. Can both paths observe the same traffic? — three options

| | Mechanism | Observes the same telegrams? | Needs | Compares |
|---|---|---|---|---|
| **A** | second tunnel, native observe-only, next to the production tunnel | **Simulator: yes** — the virtual interface relays the live tunnel's write to the other tunnel with the sender's individual address (test `[simulator model only] a second observe-only connection…`). **Real interface: unknown.** Whether an interface forwards a frame sent by tunnel A to tunnel B as L_Data.ind is implementation-dependent and no document held by this project says it must. | a **free tunnel slot** (many interfaces offer one; slot count is not discoverable by the current code — `DESCRIPTION` is unimplemented) and hardware proof of relay semantics (H-S1) | end-to-end: native tunnel + decode vs legacy tunnel + decode, as value sequences in a time window |
| **B** | **tap** the legacy client's indication stream and feed the same raw octets to the native decoder | **Yes, by construction** — same telegram, no second slot | an additive optional tap in `wrapKnxUltimate` (a change to `knx-driver.ts`, not made here) that forwards `{destination, dataValue, kind, echoed}` | exact per-telegram: native `decodeDpt` + service filter vs the legacy dptlib result. Does **not** exercise the native tunnel, ACKs or reconnects |
| **C** | **record and replay**: capture raw indications from the tap in a lab, replay them through the native bus and decoder offline | replayed, not live | the tap (B) once, then nothing | the same as B, repeatable and deterministic, no hardware at replay time |

**Recommendation:** B → C first (no second slot, exact pairing, zero bus risk), and A only on a **lab** installation with a confirmed free slot and after H-S1 passes. If the gateway has one slot or does not relay across tunnels, A is *not possible* and shadow is limited to B/C — that limitation is accepted; do not fall back to a second writer or to routing tricks.

## 4. Why exact pairing matters: the legacy path has artefacts

The legacy wrapper observes things a device never sent (contract suite D7, D8; evidence is knxultimate 6.0.1 source reading, **not** a live bus): the client echoes its own outgoing write to every indication listener (`echoed = true`, which the wrapper ignores) and a GroupValueRead is handed to observers as the value 0/false. A naive stream comparison would flag these as "native missing data". The comparator therefore needs a **known-difference table**, so each divergence is classified, not guessed:

| id | Legacy | Native | Classification |
|---|---|---|---|
| D1 | DPT 22.101 → bit-field object | raw 16-bit number | intentional (driver decoder needs the number) |
| D2 | DPT 222.100 keys `Comfort/Standby/Economy` | lowercase keys | intentional (API convention) |
| D3 | DPT 9 `0x7FFF` → 670760.96 published | refused and counted | specification-backed (invalid-data code) / legacy defect |
| D5 | a throwing handler aborts siblings | isolated | legacy defect |
| D6 | observers survive `disconnect()` | released | intentional |
| D7 | own write echoed to observers | never delivered | legacy defect (infers feedback from transmission) |
| D8 | read delivered as value 0/false | ignored | legacy defect |

Anything that matches no row is an **unclassified divergence** and is the signal shadow exists to find. (Option A cannot separate D7/D8 from real traffic without the tap's `echoed`/kind flags, which is another reason to prefer B.)

## 5. Data model and report (design)

Record per telegram: `{ ts, ga, dpt, legacy: value | absent, native: value | dropped(code) | absent, class: equal | known(D#) | unclassified | timing }`. Option B pairs by telegram identity; option A pairs by `(ga, value)` within a window (default 2 s, configurable) and by order per GA.
Report (local file / diagnostics only, never the state bus): per-GA match rate, counts per known-difference id, unclassified divergences with the raw octets (for the DPT report), native `decodeFailures` by code, bus `listenerErrors`/`overflowDropped`, tunnel diagnostics.
**Promotion evidence** (a proposal, not a gate that exists): ≥ N telegrams per used DPT main type, zero unclassified divergences across a stated period, every known-difference id seen at most as classified. It supports gate G5; it does not replace the write-path hardware tests.

## 6. Activation guards — never in a customer installation

None of this is implemented; it is the rule any future runner must satisfy. **All** of the following must hold, each checked independently and fail-closed (the existing `native-flags.ts` style):

1. A dedicated variable (e.g. `SUPREME_KNX_SHADOW=lab`; the literal `on` is *not* accepted) parsed by its own fail-closed parser. It is not part of `readNativeFlags`.
2. An installation marked as a lab installation in configuration (**no such field exists today** and must be introduced deliberately).
3. An explicit allow-list entry for the gateway host.
4. `SUPREME_KNX_NATIVE` is **off** (shadow and an active native path are mutually exclusive).
5. The shadow module is not imported by the production bootstrap path (checked like the existing "no production source imports the simulator" test), so a customer build cannot reach it by configuration alone.

Rollback is removing the variable: the shadow keeps no state and has changed nothing on the bus.

## 7. What exists now (and what each piece is for)

| Piece | State |
|---|---|
| `NativeKnxConnection` `mode: "observe_only"` | implemented, tested (zero L_Data.req; M11) |
| `observeTelegrams()` (value + source IA + service) | implemented — the comparator's native input |
| `diagnostics()` (decodeFailures, rejected observers, listener errors, bus overflow) | implemented — the report's native counters |
| Contract suite D1–D8 with both sides asserted | implemented — the known-difference table's executable form |
| Tap in `wrapKnxUltimate`; comparator; runner; guards; lab flag | **not built** (design only) |

## 8. Hardware / lab evidence needed

H-S1: does a real KNX/IP interface forward a frame sent by tunnel A to tunnel B as L_Data.ind, and does it send L_Data.con only to the sender? H-S2: a lab gateway with ≥ 2 tunnel slots. H-S3: confirm D7/D8 on the real `KNXClient` (loopback gateway or hardware) before relying on them for classification. H-S4: ≥ 24 h of real traffic through B on a lab installation.

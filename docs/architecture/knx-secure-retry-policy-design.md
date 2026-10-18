# Per-capability command retry policy — design (no implementation)

2026-10-18 · branch `claude/great-keller-fmenbn` · **Design only. No retry engine exists or is added by this document.** It contains no protocol-specific assumption: every rule is phrased on
*evidence about a command's fate*, supplied by whichever driver carries it. KNX is used only as the "current mapping" example in §2. Evidence classes: **N** normative text read · **T** conformance-test
material · **I** SupremeOS decision · **U** unsupported by available evidence. Everything in §3–§6 is **I** (a product-safety decision), because no KNX document prescribes application-level retry.
It extends parity-matrix stage 7 ("per-capability replay policy") and the replay review in `knx-ip-secure-security-review.md` §10 (strategy S1–S6).

## 1. Problem statement (why a policy is needed at all)
The secure session guarantees that one authenticated wrapper is acted on at most once and never across sessions (N). It cannot make *intent* exactly-once: a re-sent command is a **new** authenticated message and is executed again.
After a session loss, or a timeout without confirmation, the outcome of the last command is **unknown** — it may still execute later (a withheld frame can be released within the server's session timeout; a late confirmation can arrive after the timeout).
Therefore the only safe decision procedure is evidence-based and category-based.

## 2. Delivery-state semantics (evidence ladder)
A command's state is the **highest evidence level reached**, never inferred from a lower one. Levels are transport-neutral; the right column is today's KNX mapping (verified against the code, `tunnel-client.ts`).

| Level | Meaning | Evidence that proves it | Current KNX mapping | Proves device acted? |
|---|---|---|---|---|
| L0 `rejected_locally` | refused before anything was written (validation, link closed, no session) | synchronous error; nothing sent | `sendGroup` rejects (`invalid_argument`, `not_connected`, `queue_full`, `session_closed` on a refused write) | n/a — definitely **not** sent |
| L1 `handed_to_link` | the carrier accepted the frame | carrier-specific | stream: receipt `transportAck: "none"`; UDP: `transportAck: "ack"` (gateway ACK, TUN §2.6.1 N) | **No** |
| L2 `link_confirmed` | the interface reports it transmitted the telegram | interface confirmation | `confirmation: "confirmed"` (L_Data.con without error) | **No** — the interface sent it; the device may have missed or ignored it |
| L2e `link_error` | the interface reports it could not transmit | interface error | `confirmation: "bus_error"` (L_Data.con with error flag) | n/a — treated as "probably not executed", still verify before any resend |
| L3 `state_confirmed` | the target device's own status shows the target state, newer than the command | status feedback (§4) | **not implemented** (needs the feedback integration; no field today) | **Yes** (as far as the device's status is honest) |
| U `unknown` | handed over, but neither L2/L2e nor L3 within the windows, or the carrier died first | absence of evidence | `confirmation: "not_confirmed"`; session close with sends outstanding | **Unknown — may still execute** |
| X `expired` | the intent's TTL passed | clock | n/a (policy-level) | n/a |

Rules: (1) levels only move up; (2) `unknown` is **never** silently converted to "failed" or "succeeded" — only L3 feedback or an explicit read-back resolves it; (3) a late L2/L3 after U is still recorded
(KNX: `unmatchedConfirmations`, state feedback) and resolves the record, but the original receipt promise stays as issued; (4) counters such as `framesSent`/`framesAccepted` (`sessionDiagnostics()`) and `ignoredAcks` are
**protocol bookkeeping, not evidence** at any level (pinned by `secure/delivery-semantics.test.ts`); (5) UI/automation text must say "sent", "reported sent by the interface", "confirmed by the device" — never "executed" below L3.

## 3. Command categories (capability-driven; no protocol wording)
Classification is a property of the **capability and operation** (declared per capability in the device model), never guessed from a telegram.

| Cat | Name | Examples (capability operations) | Repeat semantics |
|---|---|---|---|
| A | Idempotent absolute set | on/off *set*, brightness *set N*, colour *set*, setpoint *set*, absolute volume, absolute position, mode *set* (explicit value) | repeating converges to the same state |
| B | Relative / incremental / toggle | toggle, dim up/down step, volume step, blind step/nudge, next/previous, increment setpoint | each repeat changes the state again |
| C | Trigger / momentary / sequence | scene recall, impulse output (gate, garage, doorbell), pulse, start program, play-once | each repeat re-fires a physical or time-dependent effect |
| D | Security / safety critical | lock/unlock, alarm arm/disarm, door/gate release, safety shutters, anything the owner marked sensitive | a repeat or a late execution can be harmful or unauthorised |
| E | Stateful mode with side effects | HVAC operating-mode change, heating/cooling enable, pump/compressor enable (even when absolute) | idempotent in value but cycling/wear/energy side effects; rate-sensitive |
| F | Read / query | status read, value read | side-effect free |
| G | Unverifiable | any operation whose capability declares **no** feedback (§4) | cannot tell whether a repeat is needed |

A command that cannot be classified is **G**. Unknown capability ⇒ G. A category may only be *tightened* by the owner, never loosened below its default.

## 4. Feedback requirements (what makes L3 possible)
Each controllable capability must declare, in the device model (not in a driver):
* `statusSource`: `none` | `passive-feedback` (device publishes its state) | `active-readback` (we may query) — `none` ⇒ category G;
* `settleTimeMs`: how long a physical actuator needs before its status can be trusted (blinds, valves, dimmer ramps);
* `matchRule`: exact or tolerance (e.g. ±N for levels/positions/temperatures) — how "target reached" is judged;
* `freshness`: feedback only counts if received **after** the command was handed over; a pre-existing matching state proves nothing (record the pre-state; if it already equals the target the command is a no-op and resending is harmless for A);
* independence: feedback must come from the device's status source, never from an echo of our own command (the tunnel does not echo it back — tested).

## 5. Automatic retry rules (proposed defaults, owner decision — class I)
"Uncertain" = state U, or L2e, or any state below L3 when the carrier was lost.

| Cat | Auto-retry after an uncertain outcome | Conditions when allowed | Max attempts | Intent TTL | After reconnect |
|---|---|---|---|---|---|
| A | **Conditional, once** | only after `active-readback`/feedback shows the target state **not** reached, `settleTimeMs` elapsed, and the intent is within TTL | 1 | short (configurable; default order of seconds–tens of seconds) | may be re-issued once under the same conditions; never blindly replayed from a queue |
| B | **Never** | – | 0 | until user re-issues | dropped; user/automation must re-issue with fresh intent after seeing the current state |
| C | **Never** | – | 0 | – | dropped |
| D | **Never**, and never queued for later delivery | explicit new user intent with authentication only | 0 | very short or none | dropped; never replayed after reconnect |
| E | **Conditional, once, rate-limited** | as A, plus a minimum interval between attempts to avoid cycling | 1 | short | as A |
| F | **Yes**, bounded | side-effect free; back-off | small | – | allowed |
| G | **Never** | – | 0 | – | dropped |

Additional rules: (R1) no automatic retry while the session is closed/unknown-alive; first re-establish and re-read state. (R2) protocol-level retransmission (UDP tunnel repeat with the *same* sequence number, TUN §2.6.1 N) is a different layer and
is not an application retry; stream mode has none (N: no ACK). (R3) a retry is a **new intent attempt** with its own record; a record keeps `attempt n of max`, category, evidence level, decision and reason. (R4) rate limit per target to prevent
retry storms across many capabilities after one outage. (R5) retries of one capability never reorder relative to a newer user intent: a newer intent supersedes and cancels pending retries for the same target. (R6) a queued command whose
TTL expired is dropped with outcome X, not sent late (late delivery of stale intent is the hazard the replay review's G-R1 describes).

## 6. What must never happen
* Auto-resend of B, C, D, G after any uncertain outcome. * Reporting "done/executed" below L3. * Treating `not_confirmed` as "failed, safe to repeat". * Replaying a queue across a reconnect. * Retrying a security command because
a UI timeout fired. * Deduplicating inbound telegrams by content (it would swallow genuine repeated events; not a specification behaviour — S4).

## 7. Audit and observability
Every decision (retry/skip/expire) is logged with category, evidence level, reason code, attempt number, target — **no payload secrets, no credentials**; an uncertain outcome is shown to the user as "unconfirmed" with the
pending-resolution state, and resolves on late evidence.

## 8. Tests required when implemented (not now)
Table-driven over categories × evidence levels: B/C/D/G never retried at U/L2e; A retried at most once and only with read-back evidence; E honours the minimum interval; TTL expiry drops; reconnect never replays; newer intent cancels retries;
late `unmatchedConfirmations` resolves a record without a retry; mutation tests on each "never" row; a property test that no code path emits a second frame for a B/C/D/G command without a new user intent.

## 9. Evidence still needed
None of this depends on missing KNX documents. Its *inputs* do: reliable receive-path freshness (Core liveness, blocker B4), error-code meanings (Overview, B1) and per-device feedback conventions (device profiles/Volume 6) will refine
`settleTimeMs`/`freshness` defaults. Until then the defaults above are conservative decisions (I), not claims about any device.

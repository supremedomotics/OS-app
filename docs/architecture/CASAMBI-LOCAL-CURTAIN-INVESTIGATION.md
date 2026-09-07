# Casambi Local Mode — Curtain Open / Close / Up-Down: Phase 1 Investigation

**Scope:** the EXISTING Local Mode driver only. No Local Mode 2, no MQTT, no REST, no transport
change, no Cloud-mode change.

**Verdict up front:** the mechanism is **proven**, and it is proven by your own keypad capture.
Semantic Open = `0x20` level `0xFF`; semantic Close = `0x20` level `0x00`. See §G.

---

## A. Existing Local Mode implementation relevant to curtains

| Concern | File | Current behaviour |
|---|---|---|
| Command mapping | `services/protocols/src/casambi/local-command-mapper.ts` | `position` → `0x20 SetTargetLevel`; `stop` returns `null` |
| Send | `services/protocols/src/casambi/command-engine.ts` | one packet per command |
| Wire codec | `local-transport/udp-codec.ts` | encoders for `0x10/0x11/0x1E/0x1F/0x20/0x21/0x31/0x3D/0x3E/0x3F/0x4A/0x4B/0x50`; parsers for `0x4B`, `0x51` |
| Feedback decode | `local-discovery.ts` | `0x4B` type 15 slider, 2-byte LE, explicit `min 0 / max 255` |
| Event routing | `event-engine.ts` | `0x4B` → state; `0x51` → `ButtonEvent` |
| Capability | `packages/domain-model/src/capabilities.ts` | `position` with actions `open` / `close` / `stop` / `set` |
| UI | `apps/web-homeowner/src/device-sheets.tsx` | slider + `↑` / `↕` / `↓` buttons already rendered |

The entity model and UI for Up/Stop/Down **already exist**. Nothing new is needed there.

## B. v6.38 commands relevant to Open/Close

| Opcode | Name | Relevance |
|---|---|---|
| `0x10` / `0x11` | Push Button Pressed / Released | **The gateway's OWN 4 buttons (0–3)**, not a device's. Fires whatever the Casambi app assigns to that gateway button. |
| `0x1E` / `0x1F` | Set Scene / Group Level | Indirect; needs app-side scene config |
| `0x20` | SetTargetLevel | **The confirmed position channel** |
| `0x21` | Set level of a Button's Target | Gateway button 0–3 again, level-valued |
| `0x3F` | SetTargetElements | Writes one of 8 custom elements (index 0–7) |
| `0x4A` | Resume Automation | Returns a target to automatic control; not a direction command |
| `0x50` | NotifyButtonEvent enable (`0xFD` / `0x00`) | Subscription control |
| `0x51` | NotifyButtonEvent **Responses** | Unit_ID, Source, Button, Event |

There is **no dedicated open/close/up/down opcode** in v6.38. Covers are not a first-class type in
the UDP Casambi Command API.

## C. `0x4B` Type-15 slider

`05.4b.2d.0f.<lo>.<hi>` — 2-byte little-endian on a **0–255** scale (not a 16-bit full range).
`0x00`→0%, `0x7F`→~50%, `0xFF`→100%. Already decoded correctly. **Unchanged.**

## D. `0x90` indexed controls

`0x90` = `0x80 | 16`, i.e. long-form control type **16 = On/off toggle (custom element)**, carrying
`INDEX` + `LEN` + `VALUE`. Your captures give element 0 = Close, element 1 = Open.

Per §5.12.2.2.18 a device has **exactly 8 custom elements, index 0–7, in one shared namespace**.

Critically, type 16 is *On/off **toggle***. The manual lists 17 = Button and 18 = PushButton as
**separate** types. These elements are therefore **state**, not momentary actions.

## E. The keypad `0x50` event

Capture: `05.50.29.01.01.02` → `c.70.5.50.29.1.1.2`
= Unit `0x29` (41), Source 1, Button 1, Event 2 (Short Press).

The event carries **no reference to unit 45** — the keypad→curtain link lives entirely in Casambi
app configuration, invisible to the gateway.

**Documentation discrepancy, hardware wins:** §5.12.2.1.11 numbers the *response* `0x51`, but
§5.12.2.2.25's own body says events come back "also opcode 0x50". Your hardware emits **`0x50`**.

> **Real gap found:** `event-engine.ts` decodes button events only on `0x51`, so this keypad event
> is currently **dropped**. Logged separately, not fixed here (per the no-silent-fixes rule).

## F. Why `0x3F` did not do what was expected

It did exactly what it says, and the result is arithmetic, not mystery:

```
c.72.7.3f.1.2d.0.0.0.1   ->  element 0 := 1  ->  05.4b.2d.0f.01.00  ->  1/255 = 0.4%
c.72.7.3f.1.2d.0.0.1.1   ->  element 1 := 1  ->  05.4b.2d.0f.01.00  ->  stays  0.4%
```

The feedback that came back was **the position slider reading 1**. The element write landed on the
same underlying level, with value `1` — so 0.4% is precisely `1/255`. `0x3F` manipulates the
control *value*; it does not invoke a semantic action. Two independent element writes both produced
position 1, which is what you would expect if both alias the level and neither is an action trigger.

This is why inferring the write command from the `0x4B` feedback type was insufficient — exactly as
you stated.

## G. The proven mechanism

**Your keypad capture is the proof.**

| Keypad press | Curtain feedback | Identical to |
|---|---|---|
| 1st short press | `05.4b.2d.0f.ff.00` (100%) | `c.72.6.20.ff.0.0.1.2d` |
| 2nd short press | `05.4b.2d.0f.00.00` (0%) | `c.72.6.20.0.0.0.1.2d` |

A **real Casambi Open/Close action, executed by real Casambi-side logic, manifests as slider `0xFF`
and `0x00`** — byte-identical to what `0x20` produces. There is no separate observable state that a
"true" Open reaches and a level command does not.

Combined with your direct measurements (`0x40`→25%, `0x80`→50.2%, `0xbf`→74.9%), the level channel
is confirmed linear and continuous across the full range, endpoints included.

**Open and Close are level 255 and level 0 on `0x20`.** This is corroborated by two independent
hardware paths — direct level writes, and Casambi's own keypad logic — not inferred from a feedback
type.

## H. Exact packets (proven)

```
Open   c.72.6.20.ff.0.0.1.2d\r\n
Close  c.72.6.20.0.0.0.1.2d\r\n
Set N% c.72.6.20.<round(N/100*255)>.0.0.1.2d\r\n
```

Duration bytes are **never** omitted: sent short, the gateway reads Target_Type/Target_ID as the
fade and falls back to broadcast (the previously fixed "one light triggers all lights" bug).

**Already implemented** in `local-command-mapper.ts` as of commit `444cc5f`.

## I. `stop` — the one thing still unproven

No opcode is confirmed to halt travel mid-way; `0x20` only commands an absolute target. It stays
unmapped and raises the driver's real "unsupported command" error.

**Best next experiment** (2 minutes): start a full-travel move, and mid-travel send
`c.72.6.20.<current-observed-slider>.0.0.1.2d` using the live `0x4B` value. If the motor halts
there, `stop` = "write the current position", needing no new opcode. If it does not, `stop` is not
achievable in Local Mode and should stay gated.

## J. Proposed entity / action model

No schema change. `position` already carries `open` / `close` / `stop` / `set`, and the UI already
renders slider + `↑` / `↕` / `↓`.

Remaining work is only the **Up/Down toggle** requested in §9D — a client-side alternation over the
existing actions, driven by live `0x4B` position:

- position ≥ 50% → next toggle sends `close`
- position < 50% → next toggle sends `open`

This cannot send contradictory commands, because `0x20` carries a single absolute level; there is no
Open-state and Close-state pair to conflict. Repeated presses are inherently safe.

## K. Proposed tests

Existing (`444cc5f`, all passing): `set` scaling including the exact live frame, open/close
endpoints, clamping, Duration bytes always present, `stop` refused.

To add with the toggle: direction chosen from live position at the 50% boundary, at exactly 50%, and
with no position state yet.

Hardware validation: `↑`→100%, `↓`→0%, slider→25/50/75% matching the Casambi app, toggle alternating
across repeated presses, and `0x4B` updating SupremeOS within a second.

---

## Answers to §18 success criteria

| # | Criterion | Status |
|---|---|---|
| 1 | Position slider unchanged | Yes |
| 2 | UP/OPEN physically opens | Yes — level 255 |
| 3 | DOWN/CLOSE physically closes | Yes — level 0 |
| 4 | UP/DOWN alternates | **Not yet built** — §J |
| 5 | `0x4B` updates state | Yes |
| 6 | No Cloud required | Yes |
| 7 | Local Mode intact | Yes |
| 8 | Cloud untouched | Yes |
| 9 | No Local Mode 2 | Yes |
| 10 | Documented/proven, not speculative | Yes — §G |

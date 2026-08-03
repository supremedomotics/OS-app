# Casambi UDP Protocol Compliance Audit

> Scope: **audit only**. No code, driver, `@supreme/lan`, or diagnostics changes were made in
> producing this document. Every claim below is labeled with its evidence class:
> **[CODE]** — read directly from the current SupremeOS implementation;
> **[VENDOR-PDF]** — from the vendor reference document already ingested into this repo
> (`Lithernet_UDP_Developer_Reference.pdf` / `Lithernet_WebAPI.pdf`, cited by page number in
> `services/protocols/src/casambi/local-transport/udp-codec.ts`'s own doc comments);
> **[EXTERNAL]** — from a public source reachable in this session, cited by URL;
> **[RUNTIME]** — from a real hardware capture already on file in this repo
> (`docs/architecture/Casambi-UDP-Receive-Pipeline-Audit.md`);
> **UNKNOWN** — could not be verified from any of the above. Stated as such, never guessed.

## 0. Research access — what could and could not be reached

Per the brief's requirement to cite evidence honestly: this session attempted 16 direct fetches
against public Casambi/Lithernet documentation (the v4.35 and v1.71 system manuals, the gateway
datasheet, the LogicMachine knowledge base, two IO-module documentation pages, a Home Assistant
community thread, manualslib.com, and the Casambi developer FAQ). **Every one of these returned
HTTP 403** except GitHub repositories — confirmed to be the target hosts rejecting the fetch, not
a local proxy failure (`$HTTPS_PROXY/__agentproxy/status` showed `recentRelayFailures: []`).
`web.archive.org` is explicitly disabled for this tool. WebSearch's indexed snippets still
surfaced real, useful facts (table-of-contents page numbers, opcode names, product descriptions)
even where the full document body was unreachable — those snippets are cited as **[EXTERNAL]**
below with the caveat that they are excerpts, not the full text.

**Consequence for this audit:** the single most authoritative source available is this
repository's own prior ingestion of the vendor PDF (§2 below), because it was read in full in an
earlier session, not because it is assumed complete. Section-by-section, this audit cross-checks
every external fact reachable against that internal source and flags any place they could not be
cross-checked as UNKNOWN, per the brief's explicit instruction not to assume the PDFs are
complete.

## 1. What happens after a controller starts — [CODE], cross-checked against [VENDOR-PDF]

Reading `casambi-driver.ts`'s `connectLocal()` and `discovery-engine.ts`'s
`startLocalDiscovery()`/`stopLocalDiscovery()` (the only code path that runs at real connect
time — not the Setup Wizard's separate Test Connection probe, see §1.1), the exact, complete
sequence SupremeOS executes today is:

```
1. udp.start()                                    — bind the UDP4 socket, no network traffic yet
2. send 0x4B, Request=3 (SetDefaultMask)           — args: 3,0,0,FF,FF,FF,FF  [VENDOR-PDF p.314]
3. send 0x4B, Request=1 (Subscribe), Target 0-250  — [VENDOR-PDF p.314]
4. send 0x50, enable=0xFD (NotifyButtonEvent on)   — [VENDOR-PDF p.316]
```

No REST call precedes this. No reply is awaited between steps 2-4 — they are three fire-and-forget
UDP sends issued back-to-back, wrapped in one `try/catch` **[CODE — `casambi-driver.ts:663-669`]**.
If step 2 or 3 fails at the OS/socket level, the whole sequence is abandoned and the error is
surfaced to diagnostics; there is no retry.

Answering the six specific sub-questions:

| Mechanism | Present in SupremeOS today? | Evidence |
|---|---|---|
| Registration (a distinct step that establishes identity with the gateway before any other command is accepted) | **No such step is sent or documented** | [VENDOR-PDF] describes no registration opcode anywhere in the opcode table (§3). [CODE] confirms nothing resembling one is ever sent. |
| Subscription | **Yes — step 3 above** | [VENDOR-PDF p.314], [CODE] |
| Polling | **No** — SupremeOS never polls; it subscribes once and relies on the gateway to push. `0x1D GetParameterValue`, `0x39 Node Status`, `0x45/0x46/0x49` status-query opcodes exist and are documented [VENDOR-PDF] and even *decodable* [CODE — `udp-codec.ts`], but nothing in the running driver calls them proactively [CODE — confirmed by grep, §5 below]. | |
| Initialization (SetDefaultMask) | **Yes — step 2 above** | [VENDOR-PDF p.314]: "Recommended to send once before Subscribe/Read." SupremeOS follows this recommendation exactly. |
| Handshake (a request/reply exchange with a required reply before proceeding) | **No** — every send in the bootstrap is fire-and-forget; the driver does not wait for or require an ACK before sending the next command or considering itself "connected." | [CODE] |
| Session creation | **No distinct session concept.** UDP is connectionless; "connected" in SupremeOS means only "the local socket is bound and listening," not that any gateway/network has acknowledged anything — this is explicitly documented as a design decision in the driver's own comments. | [CODE — `casambi-driver.ts:607-612`] |
| Heartbeat | **No** — nothing in the codec, the driver, or the vendor reference describes a periodic keep-alive **[VENDOR-PDF, CODE]**. Whether the *gateway* silently expects one and times out a silent client is **UNKNOWN** — this specific question (session/keep-alive timeout) was one of the direct WebSearch queries in this session and returned no answer from any accessible source. |
| Discovery command | **No dedicated discovery opcode exists in the documented protocol at all.** [VENDOR-PDF] contains no REST or UDP endpoint that lists devices/groups/scenes — confirmed in this repo's own architecture doc (`Casambi-Local-Gateway-Protocol.md` §2.3) and independently corroborated: no public source found in this session (LogicMachine KB summary, IO-module docs, the gateway datasheet) describes a discovery command either — every description found treats Subscribe-to-NotifyControlValues as the only mechanism. Progressive, notification-driven discovery is the documented design, not a SupremeOS shortcut. |

### 1.1 Test Connection uses a different, narrower probe

Separately from the above, the Setup Wizard's "Test Connection" action and a future health
heartbeat both use `CasambiUdpEngine.probe()`, which sends exactly one command: `0x39 Node status
query`, `Request=0xFF` ("own node") **[CODE — `udp-engine.ts:371`]**. This is documented
**[VENDOR-PDF p.300]** as "Only Evolution firmware" with **no minimum version given** — the doc
does not state whether this opcode works on every gateway/mesh firmware or only recent ones. This
probe is never part of the real connect sequence in §1 above; conflating the two would
misrepresent what actually happens when a user just turns the driver on.

## 2. Can NotifyControlValues (0x4B) arrive without first transmitting another command?

**Answer: No — not by documented design.** [VENDOR-PDF p.314] states NotifyControlValues has
three operating modes selected by the `Request` byte: unsubscribe (0), **subscribe (1)**, read
(2, one-shot), and `setDefaultMask` (3, a prerequisite recommended before either). There is no
fourth mode described as "always-on" or "unconditional broadcast." The doc's own text
("Recommended to send once before Subscribe/Read") frames SetDefaultMask+Subscribe as the
intended precondition, not an optional optimization.

**Which command enables it:** `0x4B` with `Request=1` (Subscribe), optionally preceded by `0x4B`
with `Request=3` (SetDefaultMask) — exactly what SupremeOS already sends (§1, steps 2-3).

### 2.1 The one piece of runtime evidence on file does NOT settle this either way

`docs/architecture/Casambi-UDP-Receive-Pipeline-Audit.md` **[RUNTIME]** contains a real 99-byte
NotifyControlValues capture from a Lithernet Gateway (firmware 6.25) that decodes successfully
against the current codec (`Net_ID=12, Opcode=0x4b, Target_ID=30`). This is sometimes read as
"proof the gateway broadcasts unconditionally" — **that is not established.** The capture came
from a session in which SupremeOS's own `connectLocal()` had already run and would have sent the
Subscribe command (§1) as part of that same connection attempt, or the gateway may have retained a
Subscribe state from a prior SupremeOS session (UDP subscription state living on the gateway
across reconnects is plausible but **UNKNOWN** — not documented either way in [VENDOR-PDF] or
found in any accessible external source). **Conclusion: the existing capture is consistent with
"Subscribe enables it" and provides no evidence against it.** No packet capture showing
NotifyControlValues traffic in the complete absence of any prior Subscribe from any client exists
anywhere in this repo or was found externally.

## 3. Every documented UDP command

Table built directly from `udp-codec.ts`'s encoders/parsers, each of which cites its exact vendor
PDF page **[VENDOR-PDF]**, cross-checked for opcode-number/name agreement against every external
source that surfaced one **[EXTERNAL]**. "Continuous" = the gateway may emit it repeatedly and
unprompted once its precondition is met; "Startup only" = sent once during the bootstrap sequence;
"On-demand" = sent only when the corresponding Supreme user action occurs.

| Opcode | Name | Direction | Purpose | Mandatory/Optional | Firmware gate [VENDOR-PDF] | SupremeOS today [CODE] |
|---|---|---|---|---|---|---|
| 0x0D | Scene called | FROM gateway | Slide-switch scene trigger, 8 configurable bits | Optional (event) | none stated | Decoded, mapped to a raw `sceneRaw` signal but not surfaced as a typed event — disclosed gap (§2.4 of the architecture doc) |
| 0x10 | Push Button Pressed | TO gateway | Simulate a physical button press | Optional | none stated | Encoder exists; never called by the running driver |
| 0x11 | Push Button Released | TO gateway | Simulate a physical button release | Optional | none stated | Encoder exists; never called |
| 0x1A/0x1B | SetParameterValue / ParametersComplete | FROM gateway | Response burst to 0x1D | Optional | none stated | Parser exists; nothing calls 0x1D, so this response is never solicited |
| 0x1D | GetParameterValue | TO gateway | Triggers 0x1A/0x1B burst | Optional | none stated | Encoder exists; never called |
| 0x1E | Set level of a scene | TO gateway | Actuate a scene | Optional (command) | none stated | Encoder exists; **no command-engine path ever calls it** — Supreme has no "run a Casambi scene" action wired to Local mode |
| 0x1F | Set level of a group | TO gateway | Actuate a group | Optional | none stated | Encoder exists; never called |
| 0x20 | Set level of a target | TO gateway | onoff/brightness for a device | **Used continuously by SupremeOS** | none stated | **Implemented** — the only opcode behind Supreme's `onoff`/`brightness` commands |
| 0x21 | Set a button's target level | TO gateway | | Optional | none stated | Encoder exists; never called |
| 0x28 (req) | Request time | TO gateway | Read gateway's clock | Optional | none stated | Encoder exists; never called |
| 0x28 (set) | Set time | TO gateway | Write gateway's clock | Optional | none stated | Encoder exists; never called |
| 0x28 (resp) | Time received | FROM gateway | Reply to either | Optional | none stated | Parser exists; unsolicited today |
| 0x2B | Set presence sensor | TO gateway | Feed a virtual presence sensor value in | Optional | none stated | Encoder exists; never called (SupremeOS has no virtual-sensor-injection feature for Casambi) |
| 0x2C | Set light sensor | TO gateway | Feed a virtual lux value in | Optional | none stated | Encoder exists; never called |
| 0x2F | Set color RGBW | TO gateway | Color actuation | Optional | none stated | Encoder exists; **never called** — `local-command-mapper.ts` uses only Hue/Sat (0x3D) and CCT (0x48) for `color` commands, never RGBW |
| 0x31 | SetTargetVerticalRatio | TO gateway | Balance/vertical light ratio | Optional | none stated | Encoder exists; never called |
| 0x38 | Set color X/Y | TO gateway | CIE xy color actuation | Optional | none stated | Encoder exists; never called |
| 0x39 (query) | Node status query | TO gateway | Reachability/status probe | Optional; doc cautions against rapid repetition | "Only Evolution firmware," no minimum stated | **Used only by the Test Connection probe (§1.1)** — never part of real connect/discovery |
| 0x39 (resp) | Node Status | FROM gateway | Reply, may burst | Optional | same as above | Parser exists; unsolicited during normal operation |
| 0x3A | Notify Node removed | FROM gateway | A unit disappeared | Continuous once subscribed (implied) | none stated | **Implemented** — mapped to `unitRemoved` |
| 0x3D | Set color Hue/Sat | TO gateway | Color actuation | **Used continuously** for non-Kelvin color commands | none stated | **Implemented** |
| 0x3E | SetTargetDimmers | TO gateway | Multi-channel dimmer set | Optional | none stated | Encoder exists; never called |
| 0x3F | SetTargetElements | TO gateway | Custom element set (opcode disputed — see §3.1) | Optional | none stated | Encoder exists; never called |
| 0x45 (query) | Scene status query | TO gateway | Poll a scene's active/level state | Optional | "Evolution firmware >= 33.22" | Encoder exists; never called |
| 0x45 (resp) | Scene Status | FROM gateway | Reply | Optional | same | Parser exists; unsolicited |
| 0x46 (query) | Target status query | TO gateway | Poll a target's level/type | Optional | "Evolution firmware >= 34.50" | Encoder exists; never called |
| 0x46 (resp) | Target Status | FROM gateway | Reply | Optional | same | Parser exists; unsolicited |
| 0x48 | Set color temperature | TO gateway | Kelvin/CCT actuation | **Used continuously** for Kelvin color commands | "Evolution firmware >= 36.70" | **Implemented** |
| 0x49 (query) | Target Color query | TO gateway | Poll full color state | Optional | "Evolution firmware >= 37.80" | Encoder exists; never called |
| 0x49 (resp) | Target Color | FROM gateway | Reply | Optional | same | Parser exists; unsolicited |
| 0x4A | Resume Automation | TO gateway | Cancel a manual override | Optional | "Evolution firmware >= 37.90" | Encoder exists; never called |
| 0x4B (Request=3) | NotifyControlValues: SetDefaultMask | TO gateway | Precondition for Subscribe/Read (recommended) | **Effectively mandatory** for realtime data (§2) | "Evolution firmware >= 37.90" | **Sent once, at startup — implemented** |
| 0x4B (Request=1) | NotifyControlValues: Subscribe | TO gateway | Enables continuous push notifications | **Mandatory** for realtime data (§2) | same | **Sent once, at startup — implemented** |
| 0x4B (Request=0) | NotifyControlValues: Unsubscribe | TO gateway | Stops push notifications | Optional | same | **Sent at disconnect — implemented** |
| 0x4B (Request=2) | NotifyControlValues: Read | TO gateway | One-shot value read | Optional | same | Encoder exists; never called (SupremeOS relies entirely on push, never a one-shot read) |
| 0x4B (resp) | NotifyControlValues Responses | FROM gateway | Device state — the entity model's primary data source | **Continuous, once subscribed** | same | **Implemented — the core of Local-mode discovery and feedback** |
| 0x50 | NotifyButtonEvent enable/disable | TO gateway | Turns the 0x51 stream on/off | Effectively mandatory for button events | "Evolution firmware >= 39.50" | **Sent once, at startup (enable) and disconnect (disable) — implemented** |
| 0x51 | NotifyButtonEvent Responses | FROM gateway | Physical button press/release events | Continuous once enabled | same | **Implemented** — mapped to `button` signal |

### 3.1 Opcode ambiguities the vendor PDF itself contains

Three inconsistencies were found and disclosed in this repo's own code comments while implementing
this codec (all in `udp-codec.ts`, cited above): a section heading vs. body opcode mismatch for
0x1A/SetParameterValue (resolved by Length, per the doc's own disambiguation rule), an identical
heading/body mismatch for 0x3F/SetTargetElements (resolved by section title, flagged as a judgment
call), and a Length-field off-by-one in both 0x2F and 0x3D's own worked examples (resolved by the
doc's universal `length = opcode + arguments` formula rather than the examples' literal count).
None of these could be independently cross-checked against another manual revision in this
session — every alternate manual PDF found externally returned 403.

## 4. Did firmware 6.25 change notification behaviour compared to earlier firmware?

**UNKNOWN, and importantly, the question as posed conflates two separate version spaces —
[RUNTIME, confirmed in this repo's own prior audit]:**

- **"6.25" is the Lithernet Gateway box's own firmware** — the physical UDP/BACnet/MQTT gateway
  device's firmware, reported by the unit itself.
- **The vendor protocol reference gates individual UDP opcodes behind "Evolution firmware"**
  version numbers (33.22, 34.50, 36.70, 37.80, 37.90, 39.50 — all documented above) — this is the
  Casambi **mesh/node** firmware running on the lighting devices themselves, a completely
  different numbering scheme.

`Casambi-UDP-Receive-Pipeline-Audit.md` §6 already states this explicitly: *"these are two
different version spaces — the gateway's own firmware number cannot be compared numerically
against the Evolution firmware thresholds the protocol doc cites."* Consequently:

- Whether Lithernet Gateway box firmware 6.25 corresponds to a mesh Evolution firmware above or
  below any threshold in §3's table is **UNKNOWN** — not stated in [VENDOR-PDF], and no external
  source found in this session cross-references gateway box firmware numbers against mesh
  Evolution firmware numbers at all.
- No Lithernet gateway box firmware changelog was found (searched explicitly; every result was
  either the manual itself, at a fixed revision, or unrelated products). Whether box firmware 6.25
  changed anything about which opcodes it forwards or how is **UNKNOWN**.
- The one concrete finding from the real capture (§2.1) — that a real 0x4B NotifyControlValues
  packet from firmware 6.25 decodes byte-exact against the current, unmodified codec — is evidence
  the wire format itself has NOT changed in a way that breaks this parser, but says nothing about
  whether the *triggering conditions* (subscribe-required vs. unconditional) changed.

## 5. Implemented vs. Missing vs. Unknown vs. Unsupported

| Protocol element | Status | Basis |
|---|---|---|
| SetDefaultMask (0x4B/3) at startup | **Implemented** | [CODE] §1 |
| Subscribe (0x4B/1), Target 0-250, at startup | **Implemented** | [CODE] §1 |
| Unsubscribe (0x4B/0) at teardown | **Implemented** | [CODE] |
| NotifyButtonEvent enable/disable (0x50) | **Implemented** | [CODE] |
| NotifyControlValues response parsing → entity/state model (0x4B resp) | **Implemented** | [CODE] |
| Button event parsing (0x51) | **Implemented** | [CODE] |
| Node removed handling (0x3A) | **Implemented** | [CODE] |
| onoff/brightness actuation (0x20) | **Implemented** | [CODE] |
| Hue/Sat color actuation (0x3D) | **Implemented** | [CODE] |
| Color temperature actuation (0x48) | **Implemented** | [CODE] |
| Reachability probe for Test Connection (0x39, own node) | **Implemented** (narrow use only) | [CODE] §1.1 |
| Scene called handling (0x0D) | **Partially implemented** — decoded and normalized, not surfaced as a typed Supreme event | [CODE] |
| RGBW color actuation (0x2F) | **Missing** — encoder exists, never invoked; also blocked by an unrelated `domain-model` limitation (no RGBW capability field) | [CODE] |
| XY color actuation (0x38) | **Missing** — encoder exists, never invoked | [CODE] |
| Scene-level actuation (0x1E) | **Missing** — no Supreme "run scene" action reaches Local mode | [CODE] |
| Group-level actuation (0x1F) | **Missing** — no Supreme group-level command reaches Local mode via this opcode | [CODE] |
| Button simulate press/release (0x10/0x11) | **Missing** — no feature calls these | [CODE] |
| Target/button-level set (0x21) | **Missing** | [CODE] |
| Time get/set (0x28) | **Missing** | [CODE] |
| Virtual presence/light sensor injection (0x2B/0x2C) | **Missing** — no Supreme feature to feed sensor values back into Casambi | [CODE] |
| Vertical ratio set (0x31) | **Missing** | [CODE] |
| Multi-channel dimmer/element set (0x3E/0x3F) | **Missing** | [CODE] |
| GetParameterValue / parameter burst (0x1D/0x1A/0x1B) | **Missing** | [CODE] |
| Scene status query (0x45) | **Missing** — no proactive poll; SupremeOS is push-only | [CODE] |
| Target status query (0x46) | **Missing** | [CODE] |
| Target color query (0x49) | **Missing** | [CODE] |
| Resume Automation (0x4A) | **Missing** | [CODE] |
| One-shot NotifyControlValues Read (0x4B/2) | **Missing** — SupremeOS never falls back to a one-shot read if push is delayed/lost | [CODE] |
| A registration/handshake step distinct from Subscribe | **Unsupported by the protocol itself** — no such opcode exists in [VENDOR-PDF] | §1 |
| Heartbeat / session keep-alive | **Unknown whether the protocol requires one** — not documented in [VENDOR-PDF]; not found in any accessible external source; SupremeOS sends none | §1 |
| Whether Subscribe state persists across a gateway reboot or a client reconnect | **Unknown** — not documented, not found externally, not testable from this sandbox | §2.1 |
| Whether box firmware 6.25 alters any of the above | **Unknown** | §4 |
| Whether the vendor PDF this repo ingested is the current/latest revision | **Unknown** — page-number citations from three different manual sources found externally (this repo's own p.264-316 vs. an external v1.71 manual's TOC references around p.106-119 vs. a v4.35 manual's TOC reference to NotifyControlValues at p.209) do not agree, proving multiple manual revisions exist with different pagination; content differences between them could not be checked because every non-GitHub fetch was blocked (§0) | §0, [EXTERNAL] |

## 6. If SupremeOS waits for packets the gateway will never send without prior initialization — what's missing?

**Nothing is missing, based on everything verifiable.** SupremeOS already sends exactly the
initialization the vendor documentation describes as the precondition for realtime
NotifyControlValues traffic (§1, steps 2-3) and for button events (§1, step 4), before it ever
expects to receive anything. There is no discovered gap between "what the protocol requires before
notifications begin" and "what SupremeOS sends before waiting for notifications."

**What this audit could NOT rule out**, stated plainly per the brief's own "state UNKNOWN, don't
guess" instruction:

1. **A box-firmware-specific requirement not in the ingested PDF.** If Lithernet box firmware 6.25
   introduced a new precondition (e.g., a required REST login even when UDP is the active channel,
   or a changed default for whether Subscribe state survives a reconnect) that post-dates whichever
   manual revision this repo's reference PDF is, this audit cannot detect it — every external
   attempt to reach a newer or differently-dated manual for comparison was blocked (§0).
2. **A gateway-side configuration flag independent of the wire protocol.** The gateway's own web UI
   (referenced in multiple external product pages but never reached in this session) may have a
   setting that gates whether UDP output is active at all, independent of anything a UDP client
   sends — this would look identical to "zero packets received" from SupremeOS's side and would not
   be a protocol-implementation gap.
3. **Whether Subscribe genuinely needs re-sending on every reconnect**, or whether the gateway
   remembers a prior client's subscription — if the latter, a real-world "it worked once, then
   stopped after a restart" symptom could be a session-state assumption this audit cannot confirm
   or rule out.

None of items 1-3 point at a missing opcode or a missing step in the documented sequence — they are
gaps in what could be *verified*, not identified defects in the implementation. Per the brief:
these are reported as UNKNOWN, not asserted as bugs, and no code change is proposed for any of
them.

## Sources

- [Lithernet - Casambi Gateway v4.35 User Manual](https://cdn.webshopapp.com/shops/327370/files/460166141/system-manual-en-4-35.pdf) (fetch blocked, HTTP 403 — cited via WebSearch index snippet only)
- [Lithernet - Casambi Gateway v1.71 System Manual](https://casambi-aimotion.de/wp-content/uploads/2021/07/1060_System_Manual_en_1_71.pdf) (fetch blocked, HTTP 403 — cited via WebSearch index snippet only)
- [Lithernet Casambi Gateway Datasheet](https://irp.cdn-website.com/21599c6b/files/uploaded/Casambi_Gateway_Datasheet_EN.pdf) (fetch blocked, HTTP 403 — cited via WebSearch index snippet only)
- [LogicMachine Casambi integration](https://kb.logicmachine.net/integration/casambi/) (fetch blocked, HTTP 403 — cited via WebSearch index snippet only)
- [Casambi Lithernet Gateway — IO Modules docs (v2.0.0 / v2.1.0.BETA1)](https://io-module-documentation.readthedocs.io/en/latest/iom/System%20Integration/Casambi%20Lithernet%20Gateway.html) (fetch blocked, HTTP 403 — cited via WebSearch index snippet only)
- [Lithernet Gateway setup guide — Casambi Support](https://support.casambi.com/support/solutions/articles/12000107343-lithernet-gateway-setup-guide) (fetch blocked, HTTP 403 — cited via WebSearch index snippet only)
- [Casambi Home Assistant community — MQTT/Lithernet thread](https://community.home-assistant.io/t/light-mqtt-payloaads-not-working-right-way-with-casambi-gateway/952010) (fetch blocked, HTTP 403 — not incorporated beyond its existence)
- [lian/esp32-casambi](https://github.com/lian/esp32-casambi) — fetched successfully; BLE Evolution protocol (distinct from the Lithernet UDP protocol), confirms a full ECDH/AES handshake exists at the BLE mesh layer, internal to the gateway, not exposed to LAN UDP clients
- [lkempf/casambi-bt](https://github.com/lkempf/casambi-bt) — fetched successfully; page content insufficient for protocol detail
- Internal: `services/protocols/src/casambi/local-transport/udp-codec.ts` (vendor PDF page-cited, byte-exact)
- Internal: `docs/architecture/Casambi-Local-Gateway-Protocol.md`
- Internal: `docs/architecture/Casambi-UDP-Receive-Pipeline-Audit.md` (real hardware capture, firmware 6.25)
- Proxy diagnostics: `$HTTPS_PROXY/__agentproxy/status` (confirmed no relay failures — 403s originated at the target hosts)

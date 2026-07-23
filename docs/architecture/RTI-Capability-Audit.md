# RTI-Only / RTI-Leads Capability Audit

> **Analysis document only — no code was changed to produce this file.** Scope: every capability
> the [RTI Driver Knowledge Base](./RTI-Driver-Knowledge-Base.md)'s comparison table marked as an
> RTI advantage over SupremeOS (i.e. every "RTI ✓ / SupremeOS ✗" or "RTI leads" row). Each one is
> re-audited here using **only** three sources: the official Denon AVR control protocol PDF
> (Ver.8.6.0, AVR-1713/AVR-1613, 18 pages, read in full), the official HEOS CLI Protocol
> Specification (v1.17, read in full), and the extracted RTI driver
> (`SystemFunctions.xml`/`SystemVariables.xml`/`Den4308.js`/`upnp_stack.js`/`singleDiscovery.js`/
> `instructions.rtf`). RTI is treated strictly as *behavioral evidence that a capability might be
> real* — never as a substitute for official protocol documentation. Where RTI is the only source
> for a token, that is stated plainly, not upgraded to "officially confirmed."

## Classification definitions used below

- **A — Officially supported and implementable.** The official Denon or HEOS documentation states
  the exact command/interface and (where relevant) its parameter encoding. Ready to build with no
  further evidence-gathering.
- **B — Officially supported, but evidence incomplete.** The *capability class* is officially
  documented (a confirmed sibling command, or a confirmed mechanism that plausibly extends), but a
  specific piece of evidence needed to implement *this exact* variant with confidence is missing —
  named explicitly per item.
- **C — RTI-specific abstraction built from official commands.** Not a distinct wire capability at
  all — an application-layer pattern (state machine, pacing, probe reuse, UI escape hatch) that
  RTI built entirely out of commands that are *already* independently confirmed official (mostly
  the `?`-suffixed query family). Reproducible without any new protocol evidence.
- **D — No evidence of official support.** Neither the Denon PDF nor the HEOS spec mentions the
  token or mechanism at all. RTI is the sole source. Documented with the specific reason it cannot
  currently be implemented safely.

Fourteen distinct capability items are audited below (some KB comparison-table rows collapsed
into one item where they're the same underlying command family — e.g. Zone 3 power/volume/mute
are one item, not three).

---

## Category A — Officially supported and implementable

### A.1 — Subwoofer On/Off

- **Protocol/Interface**: Telnet, `PSSWR ON<CR>` / `PSSWR OFF<CR>` / `PSSWR ?<CR>`.
- **Evidence**: Official Denon PDF, p.15, `PS` command table — `SWR ON`/`SWR OFF` rows, function
  "SW ON/OFF," example commands `PSSWR ON<CR>`/`PSSWR OFF<CR>` given verbatim.
- **Confidence**: High — exact token, exact page, no parameter ambiguity (it's a bare on/off, no
  numeric range to guess).
- **Recommended implementation strategy**: same pattern as the Audyssey-family additions this
  session already shipped — a fixed two-value `select`-kind `advancedControls` entry
  (`{id:"on"}`/`{id:"off"}`), encode `PSSWR ${on ? "ON" : "OFF"}`, parse `PSSWR ON`/`PSSWR OFF`
  echoes into a new `MediaCache.subwoofer?: boolean` field, add `PSSWR ?` to the `hasAudyssey`-style
  init-burst gate (or its own separate `hasSubwoofer` flag, since a subwoofer toggle is
  conceptually unrelated to Audyssey calibration despite living in the same `PS` command family —
  worth a distinct installer-declared flag rather than folding it into `hasAudyssey`). Zero new UI
  code needed (reuses the existing generic select renderer).

### A.2 — Cinema / Music / Game / Pro Logic Mode

- **Protocol/Interface**: Telnet, `PSMODE:MUSIC<CR>` / `PSMODE:CINEMA<CR>` / `PSMODE:GAME<CR>` /
  `PSMODE:PRO LOGIC<CR>` / `PSMODE: ?<CR>`.
- **Evidence**: Official Denon PDF, p.12 — "MODE:MUSIC / MODE:CINEMA / MODE:GAME / MODE:PRO LOGIC"
  rows, function "CINEMA / MUSIC / GAME / PL mode change," with the explicit note "This parameter
  can change DOLBY PL2,PL2x,NEO:6 mode" and a further note that which values are legal depends on
  the currently-selected DSP mode (GAME can toggle PL2/PL2x depending on a separate `SB` setting;
  PL can only reach PL2).
- **Confidence**: High for the four token values and their meaning; Medium for the "legality
  depends on current DSP mode" interaction the PDF itself flags — that's a real constraint to
  encode, not just a flat 4-value enum.
- **Recommended implementation strategy**: a `select`-kind `advancedControls` entry, same shape as
  A.1. The DSP-mode-dependent legality nuance is best handled the same way SupremeOS already
  handles other mode-dependent state (surface all four options always, let the receiver reject an
  illegal combination and simply not echo a state change — matching the existing "never guess,
  never pre-validate a device-side interaction we don't have full rules for" posture already used
  elsewhere in this codebase).

### A.3 — Cinema EQ On/Off

- **Protocol/Interface**: Telnet, `PSCINEMA EQ.ON<CR>` / `PSCINEMA EQ.OFF<CR>` / `PSCINEMA EQ. ?<CR>`.
- **Evidence**: Official Denon PDF, p.12, exact tokens and examples given verbatim.
- **Confidence**: High.
- **Recommended implementation strategy**: identical pattern to A.1 — a two-value select.

### A.4 — Loudness Management

- **Protocol/Interface**: Telnet, `PSLOM ON<CR>` / `PSLOM OFF<CR>` / `PSLOM ?<CR>`.
- **Evidence**: Official Denon PDF, p.12, exact tokens and examples given verbatim.
- **Confidence**: High.
- **Recommended implementation strategy**: identical pattern to A.1.

### A.5 — Tone Control On/Off (Marantz-generation token)

- **Protocol/Interface**: Telnet, `PSTONE CTRL ON<CR>` / `PSTONE CTRL OFF<CR>` /
  `PSTONE CTRL ?<CR>`.
- **Evidence**: Official Denon PDF, p.12, exact tokens and examples given verbatim.
- **Confidence**: High.
- **Recommended implementation strategy**: **this one is already partially built** —
  `avr-driver.ts`'s `onLinkConnect()` init burst already sends `PSTONE CTRL ?` and the existing
  capability matrix records it as "Partial — queried but not surfaced as a homeowner toggle." The
  remaining work (not done here, per "no implementation") is purely wiring the already-queried
  state into a settable `advancedControls` entry, identical in shape to every other item in this
  category — no new protocol evidence required, this is the closest item in the whole audit to a
  same-session follow-up.

---

## Category B — Officially supported, but evidence incomplete

### B.1 — Zone 3 and Zone 4 (power, volume, mute, tone)

- **Protocol/Interface (the confirmed part)**: the `Z<n>`-prefixed zone-command mechanism itself
  is officially documented and confirmed — Official Denon PDF pp.17–18 fully specify `Z2`/`Z2MU`/
  `Z2SLP` for a second zone, explicitly noting "Z2 COMMAND is valid at AVR-1913 NA model only" (a
  model-scoping footnote, not a statement that no other zone token exists).
- **What's missing**: no page in this session's PDF documents `Z3` or `Z4` at all — the source PDF
  targets the AVR-1713/1613, a 2-zone-max unit, so a 3rd/4th zone simply isn't in scope for the
  document itself, not evidence the mechanism doesn't exist on other models. RTI's driver — built
  and revised against real physical units up through the AVR-X8500 (a flagship, well-documented as
  a multi-zone-capable model), per its own revision history — implements `Z3`/`Z4` using the
  *identical* token shape as the confirmed `Z2` family (same `ON`/`OFF`/`?`/volume-adjust grammar,
  just a different digit). This is why it's classified B, not D: the *pattern* is officially
  confirmed for one instance (`Z2`); what's missing is a page confirming the pattern literally
  repeats for `3`/`4` rather than diverging.
- **Confidence**: Medium — the structural-analogy argument is reasonably strong (RTI is a real,
  revision-tested commercial product built against real hardware spanning many models, not a
  guess), but this session has zero page-citable confirmation for `Z3`/`Z4` specifically.
- **Recommended implementation strategy**: do **not** implement speculatively. The correct next
  evidence-gathering step is a newer official PDF or protocol excerpt covering a confirmed 3- or
  4-zone model (e.g. an AVR-X4xxx/X6xxx-class unit), or — if this SDK ever gets access to real
  hardware — a guided verification pass sending `Z3?`/`Z4?` and observing whether a real unit
  responds. Until then, extending `AvrZone` past `"main" | "zone2"` should stay parked.

### B.2 — Extra channel-trim targets (Subwoofer 2, Surround Back L/R/combined, Front Height L/R, Front Wide L/R)

- **Protocol/Interface (the confirmed part)**: the `CV<channel> <nn>` mechanism itself is fully
  confirmed for six channels (FL/FR/C/SW/SL/SR) — Official Denon PDF, p.7, exact `38`–`62`/`50`=0dB
  encoding given verbatim.
- **What's missing**: no page confirms the same `CV<channel>` grammar extends to the eight
  additional two/three-letter channel codes RTI's driver uses (`SW2`/`SBL`/`SBR`/`SB`/`FHL`/`FHR`/
  `FWL`/`FWR`) — again a "this specific PDF covers a lower-channel-count model" scoping issue, not
  a stated absence. RTI's `ChanVolume` function reuses the identical token shape and parameter
  range convention (`-120`..`120`, tenths of a dB) for all 14 channels uniformly, which is
  reasonable circumstantial evidence the mechanism generalizes, but is RTI-only.
- **Confidence**: Medium, same reasoning as B.1 — plausible by structural analogy to a confirmed
  sibling, not independently page-cited.
- **Recommended implementation strategy**: same posture as B.1 — do not implement until either a
  newer official PDF (covering a unit with front-height/wide/dual-sub channels — i.e. an Atmos/
  DTS:X-era model) or a real-hardware verification pass confirms the exact encoding for the 8 extra
  channel codes. When that evidence exists, the implementation itself is low-effort: extend the
  already-designed (but currently unbuilt, per the prior Universal AVR SDK pass's own deferred-item
  note) channel-trim UI's channel list from 6 to 14 entries — no new architecture needed, just more
  rows in an already-planned table.

### B.3 — Tone Defeat (Denon-generation token, `PSTONE DEFEAT`)

- **Protocol/Interface (the confirmed part)**: the *concept* — an on/off toggle for whether tone
  (bass/treble) shaping is applied at all — is officially documented, just under a **different**
  token for a different receiver generation: `PSTONE CTRL ON/OFF` (see A.5), confirmed p.12.
- **What's missing**: RTI's driver implements `PSTONE DEFEAT ON`/`PSTONE DEFEAT OFF` as a
  **separate, sibling** function explicitly labeled for older/non-Marantz-branded Denon units — no
  page in this session's PDF uses the string "DEFEAT" anywhere. Since the PDF's own source unit
  (AVR-1713/1613) is a Denon-branded (non-Marantz) model and only documents `PSTONE CTRL`, it's
  possible the PDF's own vintage simply predates or never used the `DEFEAT` wording, or that RTI's
  two functions are two names for testing across a longer receiver lineage than this one PDF
  covers.
- **Confidence**: Medium — the underlying *capability* (tone defeat as a feature) is certainly
  real (confirmed via `PSTONE CTRL`); the *specific alternate token spelling* RTI uses is
  RTI-only evidence.
- **Recommended implementation strategy**: do not implement `PSTONE DEFEAT` as a separate command.
  Build A.5 (`PSTONE CTRL`) first — it's fully evidenced and already half-wired. If a future
  evidence pass (broader official spec, or a real device trace) confirms `PSTONE DEFEAT` is a
  genuinely distinct token (not just an older name for the same thing), reconsider then; sending an
  unconfirmed token risks a silent no-op at best, an unintended side effect at worst.

---

## Category C — RTI-specific abstractions built from official commands

Every item below is not itself a wire capability — it's an application-layer pattern RTI built
entirely from commands independently confirmed elsewhere in this audit chain (mostly the
`?`-suffixed query family, which the official PDF confirms extensively). No new protocol evidence
is required for any of these; the "strategy" is purely architectural.

### C.1 — Connection-readiness state machine (4-state, gated on a fully-drained init burst)

- **How RTI built it from official primitives**: RTI's driver already knows every `?`-suffixed
  query is officially documented (each one individually confirmed across the PDF's own command
  tables — `PW?`, `MV?`, `SI?`, `MS?`, `ZM?`, `Z2?`, etc.). It simply tracks how many of a
  fixed list it has sent versus how many replies it has received, and treats "queue empty" as the
  signal to transition its own internal readiness flag from "Initializing" to "Connected," firing
  its own (RTI-internal, not Denon-protocol) "Connected and Initialized" event.
- **How SupremeOS could reproduce it**: entirely in `AvrProtocolDriver` / `DriverDiagnosticsSnapshot`
  — no new command evidence needed. Track the init-burst token list already sent in
  `onLinkConnect()`, decrement/mark-received as each corresponding reply is parsed by
  `parseAvrLine()`, and expose a new readiness signal (e.g. a 4th `connectionStatus` value, or a
  separate boolean) once the list is empty. Purely a SupremeOS-side bookkeeping change.
- **Confidence**: High that this is reproducible with zero new protocol evidence (every token
  involved is already independently confirmed A-grade elsewhere in this codebase's own capability
  matrix).
- **Recommended implementation strategy**: a genuinely low-risk, evidence-complete follow-up — the
  highest-value item in this entire audit, since it requires no further protocol research at all,
  only an architecture change. Flagged already as Finding 3.1 in the RTI Knowledge Base.

### C.2 — Init-burst pacing (response-paced, not a single write)

- **How RTI built it from official primitives**: same init-token list as C.1; instead of writing
  them all at once, it sends one, waits for `OnCommRx` to fire (any line, dispatched through the
  normal per-prefix parser), then sends the next queued one.
- **How SupremeOS could reproduce it**: change `onLinkConnect()` from one `socket.write(tokens.join
  ("\r") + "\r")` call to a small internal queue drained one token at a time from within `onLine()`
  — same commands, same order, different write cadence. No protocol evidence needed; this is
  exclusively about *when* to write already-confirmed tokens, not *which* tokens.
- **Confidence**: High.
- **Recommended implementation strategy**: pairs naturally with C.1 (both touch the same
  `onLinkConnect()`/`onLine()` code path) — a reasonable single follow-up scoped to cover both.

### C.3 — Explicit AVR/Telnet keepalive probe

- **How RTI built it from official primitives**: reuses `PW?` (whole-unit power query, p.7,
  A-grade confirmed elsewhere) as a cheap, harmless, already-necessary probe, sent only when the
  connection has otherwise been quiet for a configured interval; any real received traffic also
  counts as proof of life.
- **How SupremeOS could reproduce it**: a small addition to `AvrProtocolDriver`, structurally
  identical to the `HeosProtocolDriver.heartbeat()` method already built this session — except AVR/
  Telnet has no protocol-native no-op, so it would send `PW?` (already an existing, parsed token —
  `parseAvrLine` already handles `PWON`/`PWSTANDBY` replies) and resolve based on whether a reply
  arrives within a timeout, mirroring the exact `{ ok, latencyMs }` shape HEOS's `heartbeat()`
  already returns.
- **Confidence**: High.
- **Recommended implementation strategy**: directly modeled on `heartbeat()` (already built,
  already tested this session) — the lowest-effort item in this whole audit precisely because a
  working reference implementation for the *shape* of the feature already exists in this codebase,
  just for the sibling HEOS driver.

### C.4 — Raw/escape-hatch command string

- **How RTI built it from official primitives**: a free-text field that appends a trailing CR and
  writes whatever the installer typed, with zero validation — legitimate only because *every*
  token it could possibly send is already one of the officially-documented (or RTI-observed)
  tokens covered elsewhere in this audit; the feature itself adds no new protocol surface, it's a
  generic pass-through over the same vocabulary already in scope.
- **How SupremeOS could reproduce it**: a devMode-gated raw-token command path on
  `AvrProtocolDriver.command()`, bypassing `commandToAvr()`'s typed dispatch for a literal string
  the installer supplies — matching the existing devMode-only Diagnostics/Protocol-Trace UI
  convention (visible only to installers/developers, never homeowners).
- **Confidence**: High that it's buildable; the judgment call is product/safety, not evidence —
  a raw-command field bypasses the capability-schema safety net `commandToAvr()` otherwise
  provides, so it trades safety for flexibility. Recorded, not recommended without a product
  decision on that tradeoff.
- **Recommended implementation strategy**: if pursued, gate behind the same `devMode` flag as the
  Protocol Trace panel, with an explicit UI warning that no validation is applied.

---

## Category D — No evidence of official support

For every item below, neither the Denon PDF nor the HEOS spec mentions the token or mechanism.
RTI is the sole source in this session's evidence set. Each is real (RTI is a shipped commercial
product), but "real capability of some Denon/Marantz unit" and "confirmed by evidence this session
can cite" are different claims — these stay unbuilt until the latter is true.

### D.1 — All Zone Stereo

- **Evidence**: RTI only — `SystemFunctions.xml`'s `SetCommand:AllZoneStereo`
  (`MNZST ON`/`MNZST OFF`) and the matching `SystemVariables.xml` variable. No `MN`-prefixed
  command of any kind appears anywhere in the official Denon PDF this session has.
- **Why it cannot currently be implemented**: zero official corroboration for the `MN` command
  prefix at all (not even a partial/sibling match the way B-category items have) — this isn't a
  "same mechanism, different model" gap, it's a completely unconfirmed command family.
- **Confidence this is a real Denon capability**: Medium (RTI is a real, tested commercial driver)
  — but confidence that *this specific token* is correct is Low without independent confirmation.
- **What would unblock it**: an official spec page or an independent open-source implementation
  (the way `denonavr`/openHAB's binding served as cross-checks for the AppCommand-family claims
  elsewhere in this project) showing the `MN`-prefixed command family.

### D.2 — Surround Back Speaker Mode / Front Speaker A+B Select

- **Evidence**: RTI only — `SetCommand:SurrBack` (`PSSB:MTRX ON`/`PSSB:NON MTRX`/`PSSB:PL2X
  CINEMA`/`PSSB:PL2X MUSIC`/`PSSB:ON`/`PSSB:OFF`) and `SetCommand:Fronts`
  (`PSFRONT SPA`/`PSFRONT SPB`/`PSFRONT A+B`). Notably, `Den4308.js`'s own startup query burst
  includes `PSFRONT ?` — i.e. RTI's own driver treats this as live, queryable state, not a rarely-
  used legacy toggle — which raises its real-world plausibility without changing its official-
  evidence status.
- **Why it cannot currently be implemented**: no `PSSB`/`PSFRONT` token appears anywhere in the
  official PDF.
- **Confidence**: Medium (real capability, actively queried by RTI) / Low (specific token
  correctness, unconfirmed).
- **What would unblock it**: same as D.1 — an official page or independent cross-check source.

### D.3 — D.Comp / DCO

- **Evidence**: RTI only — `SetCommand:DCO` (`PSDCO LOW`/`PSDCO MID`/`PSDCO HIGH`/`PSDCO OFF`),
  explicitly a **separate** function from the already-confirmed `PSDRC` (Dynamic Range
  Compression, Category A elsewhere in this codebase — see `AVR-Universal-Capability-Matrix.md`).
  RTI's own `SystemVariables.xml` also tracks `DCOSetting` as a distinct variable from
  `DRCSetting`.
- **Why it cannot currently be implemented**: no `PSDCO` token in the official PDF, and — unlike
  B.3's tone-defeat case — there's no confirmed sibling command whose *purpose* obviously matches
  (DRC and DCO read as related compression concepts by name alone, but RTI treats them as
  genuinely distinct controls, so "it's just another name for DRC" cannot be assumed without
  evidence either way).
- **Confidence**: Low — real enough to be a distinct RTI function, but with no way from this
  session's evidence to say what it actually does differently from DRC.
- **What would unblock it**: an official page distinguishing DCO from DRC, or a real hardware trace
  showing both commands produce independently observable effects.

### D.4 — Video-Output Routing (Scaling / Aspect Ratio / Resolution / HDMI Audio Routing)

- **Evidence**: RTI only, four related functions:
  - Video Scaling — `VSMONIAUTO`/`VSMONI1`/`VSMONI2` (which physical HDMI monitor-out port)
  - Aspect Ratio — `VSASPNRM`/`VSASPFUL`
  - Video Resolution (composite/component path) — `VSSCAUTO`/`VSSC48P`/`VSSC72P`/`VSSC10I`/
    `VSSC10P`/`VSSC10P24`
  - Video Resolution (HDMI path) — the `VSSCH*` variant of the same value set
  - HDMI Audio Output — `VSAUDIO AMP`/`VSAUDIO TV`

  All five are independently corroborated as **live, actively-queried state** by `Den4308.js`'s own
  startup burst (`VSSCH ?`, `VSAUDIO ?`, `VSMONI ?` all appear in the 24-token init list) — this is
  not a rarely-used or speculative RTI feature, it's core, always-synced state in their driver.
- **Why it cannot currently be implemented**: the official Denon PDF this session has (2012,
  AVR-1713/1613) predates or simply doesn't cover HDMI-audio-output routing and multi-output video
  scaling as receiver features at all — no `VS`-prefixed video-routing command appears anywhere in
  its 18 pages.
- **Confidence**: Medium-High that this is a real, current capability on modern Denon/Marantz units
  (RTI's own driver treats it as core always-synced state, and HDMI audio/video routing is a
  well-known real feature category on modern AVRs generally) / Low on the exact token/parameter
  correctness for any specific current-generation model, since the only source is one dated RTI
  export.
- **What would unblock it**: a newer official Denon/Marantz protocol PDF (this session's is over a
  decade old) or an independent cross-check source (the `denonavr`/openHAB pattern already used
  successfully elsewhere in this project's evidence chain) confirming the `VS`-prefixed command
  family for a current-generation model.

---

## Summary table

| # | Capability | Category | Confidence | Blocking evidence needed (if any) |
|---|---|---|---|---|
| A.1 | Subwoofer On/Off (`PSSWR`) | A | High | — ready to build |
| A.2 | Cinema/Music/Game/Pro Logic mode (`PSMODE:`) | A | High (values) / Medium (mode-dependent legality) | — ready to build |
| A.3 | Cinema EQ On/Off | A | High | — ready to build |
| A.4 | Loudness Management (`PSLOM`) | A | High | — ready to build |
| A.5 | Tone Control On/Off, Marantz token (`PSTONE CTRL`) | A | High | — ready to build, already half-wired |
| B.1 | Zone 3 / Zone 4 (power/volume/mute/tone) | B | Medium | Official spec page for a 3/4-zone model |
| B.2 | Extra channel trims (8 targets) | B | Medium | Official spec page for a taller-channel-count model |
| B.3 | Tone Defeat, Denon token (`PSTONE DEFEAT`) | B | Medium | Confirmation it's distinct from `PSTONE CTRL`, not an alternate name |
| C.1 | Connection-readiness state machine | C | High | — reproducible now, zero new evidence needed |
| C.2 | Init-burst pacing | C | High | — reproducible now, zero new evidence needed |
| C.3 | AVR/Telnet keepalive probe | C | High | — reproducible now, mirrors existing `heartbeat()` |
| C.4 | Raw-command escape hatch | C | High (buildable) | — product/safety decision, not evidence |
| D.1 | All Zone Stereo (`MNZST`) | D | Medium (real) / Low (token) | Independent source confirming `MN` command family |
| D.2 | Surround Back mode / Front A+B select (`PSSB`/`PSFRONT`) | D | Medium (real) / Low (token) | Independent source confirming `PSSB`/`PSFRONT` |
| D.3 | D.Comp (`PSDCO`) | D | Low | Independent source distinguishing it from DRC |
| D.4 | Video-output routing (`VS*` family) | D | Medium-High (real) / Low (token) | Newer official spec or independent cross-check |

**Net result**: 5 items are ready to build today with no further research (Category A, plus all
four Category C architecture patterns — 9 of 16 total). 3 items need one more piece of official
evidence before implementation should proceed (Category B). 4 items remain genuinely unconfirmed
and are correctly left unbuilt (Category D) — consistent with this project's standing rule to
never guess a wire command, doubly important for anything that writes state to real hardware.

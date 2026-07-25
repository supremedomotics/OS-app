# Denon Cheat Sheet Audit

> Audits an installer/engineer cheat sheet ("Dan's Denon Cheat Sheets," Denon section only —
> the user confirmed no HEOS section or further content exists) against the SupremeOS Universal
> AVR SDK. Per the user's explicit instruction, the cheat sheet is treated as **reference only,
> never as an implementation source**. The authority hierarchy used throughout this document:
>
> 1. Official Denon AVR Control Protocol PDF (Ver.8.6.0, Telnet, port 23) — highest authority.
> 2. Official HEOS CLI Protocol Specification (v1.17).
> 3. Live hardware verification (this session had none available — see
>    `RTI-Capability-Audit.md`'s Phase 3 addendum for why, and its guided-capture procedure).
> 4. Dan's cheat sheet — reference/checklist only, never sufficient on its own to implement
>    anything.
>
> **Copyright note on method**: nothing in this document — no table row, no example, no URL
> string, no field name — was copied from the cheat sheet. Every capability the cheat sheet
> raised was independently re-derived and verified this session by fetching and reading the
> real, MIT-licensed `denonavr` library source directly from GitHub (the same independent
> cross-check source this project has used since the original HTTP AppCommand pass — see
> `Universal-AV-SDK.md`), and by re-reading SupremeOS's own already-implemented Telnet/AppCommand
> code (`avr-codec.ts`, `avr-http-codec.ts`, `avr-driver.ts`). Every literal string, field name,
> or URL path that appears below is cited to that independent source, not to the cheat sheet.
> Where independent corroboration could not be found, that is stated plainly and the finding is
> marked "document only, no implementation."

## What the cheat sheet actually describes

Read at the engineering-observation level (not reproduced verbatim): the cheat sheet documents
a Denon/Marantz receiver's **third HTTP control surface** — an older, GET-request-based web
interface on port 80, distinct from both the Telnet interface (port 23, `avr-codec.ts`) and the
`AppCommand.xml` interface (port 8080, `avr-http-codec.ts`) SupremeOS already implements. It
covers: fetching a full zone-state snapshot in one request; power/volume/mute/input control
via individual write requests; a percent-to-decibel volume conversion; the three-different-names
problem for input sources (remote-label name, internal wire code, user-editable display name);
and two different mechanisms for discovering renamed input labels (one embedded in the full-state
snapshot, one requiring an HTML setup page to be scraped) — the cheat sheet's own text flags both
of those mechanisms as incomplete/unreliable in its own words, a caveat this audit treats as
real signal, not something to override.

## Independent verification performed this session

Fetched and read directly (not summarized): `denonavr`'s `const.py`, `foundation.py`,
`input.py`, and `volume.py` (raw.githubusercontent.com, MIT-licensed, the same library Home
Assistant's own Denon integration is built on and the same source this project's existing
`avr-http-codec.ts` was verified against). This confirmed, refuted, or refined every claim below
independently of the cheat sheet.

## Per-capability audit

| Capability | Exists in official Telnet protocol? | Exists in HEOS? | Already implemented in SupremeOS? | Missing? | Requires hardware verification? | Recommended implementation | Confidence | Notes |
|---|---|---|---|---|---|---|---|---|
| **Legacy full-zone-state HTTP snapshot** (one GET returns power/mute/volume/input together) | No — Telnet has no single-call full-state dump, only individual `?`-suffixed per-field queries (confirmed prior sessions, re-confirmed here) | No | No | Yes, for the *read fallback* use case only | No — read-only, independently corroborated twice | **Implement (read-only fallback)** | High | Independently confirmed via `denonavr/const.py`'s `MAINZONE_URL`/`STATUS_URL` constants and `foundation.py`'s real fallback logic: this is the receiver's legacy status endpoint, used by `denonavr` specifically when a unit does **not** support `AppCommand.xml` (`use_avr_2016_update == False`). Field names `Power`, `ZonePower`, `Mute`, `MasterVolume`, `InputFuncSelect` independently confirmed via `denonavr`'s own `status_xml_attrs` search-string dictionaries in `foundation.py`/`volume.py`/`input.py`. |
| **Receiver-generation / HTTP-port auto-detection** (probe 8080 first, fall back to 80, else assume legacy) | N/A — a client-side workflow, not a wire capability | N/A | **No — this is the real root gap** | Yes | No — read-only probe | **Implement** | High | `avr-driver.ts` hardcodes `httpPort` to a fixed `8080` (`opts.httpPort ?? 8080`, no fallback, no detection). `avr-probe.ts` passes this straight through with no auto-detection of its own. Independently confirmed via `denonavr/foundation.py`'s real `async_identify_receiver()`: it tries `Deviceinfo.xml` on port 8080, then port 80, and falls back to a plain legacy `AVR` type on port 80 if neither answers as an AVR-X unit. SupremeOS has no equivalent step today — a pre-2016 unit silently gets **zero** HTTP-sourced data (no renamed inputs, no album art) with no error surfaced beyond the existing Protocol Trace log. |
| **Album art fetch on pre-2016 (port-80) units** | N/A (HTTP-only capability) | N/A (separate from HEOS's own artwork path) | Partially — `albumArtUrl()`/`getArtwork()` already exist and are tested, but always target the fixed `httpPort` (8080) | Yes, for pre-2016 units specifically | No | **Implement, as a direct consequence of port auto-detection above** | High | `getArtwork()` calls `albumArtUrl(b.host, this.httpPort)` — same fixed-8080 root cause. Independently confirmed via `denonavr`'s own `STATIC_ALBUM_URL` usage: it is templated with whatever port `async_identify_receiver()` actually detected (`self._device.api.port`), not hardcoded — i.e. the static album-art file is served by the receiver's embedded web server on *either* port depending on generation, confirming this is a real, currently-silent gap for older units, not a hypothetical one. |
| **Renamed/hidden input labels for pre-2016 units** | No (Telnet `SI` has no rename/delete query, confirmed prior sessions) | No | No (2016+ only, via `AppCommand.xml`'s `GetRenameSource`/`GetDeletedSource`) | Yes, for pre-2016 units | Partially — the fallback source is confirmed real but confirmed *incomplete* | **Document only for now; do not implement as an equal-confidence fallback** | Medium | The legacy full-state snapshot embeds a partial rename list, but both the cheat sheet's own text and this session's independent read of `denonavr` treat it as incomplete (`denonavr` doesn't even use it as a rename fallback — `GetRenameSource`/`GetDeletedSource` remains its only rename mechanism, gated the same 2016+ way SupremeOS already gates it). Implementing a known-partial source as if it were equivalent to the already-shipped, complete 2016+ mechanism would violate this project's "never fabricate completeness" rule. If pursued later, it must be labeled honestly (e.g. a distinct, lower-confidence `source` value), not merged into the existing `device_reported` field un-flagged. |
| **HTML-scraped SETUP rename page** | No | No | No | Yes (but see recommendation) | N/A | **Do not implement** | Low | The cheat sheet's own text calls this mechanism unreliable (inconsistent naming, incomplete coverage) — the source's own admission is being treated as real signal, not overridden. `denonavr` doesn't use an HTML-scrape mechanism anywhere in the files read this session. Scraping a settings-form HTML page is inherently fragile across firmware revisions in a way an XML/AppCommand response isn't. SupremeOS's existing 2016+ mechanism is already strictly better; there is no unit class where this would be the *best available* option, only the *only* remaining option on pre-2016 units — where the (lower-confidence, still-better) `VideoSelectLists`-equivalent snapshot field is a safer partial fallback than parsing HTML. |
| **Zone power on/off via legacy HTTP write** | Yes — Telnet's `ZM ON`/`ZM OFF`/`PW ON`/`PW STANDBY` already covers this, on every receiver generation (the official Telnet PDF's own source unit predates 2016) | No | Yes — via Telnet, already shipped, already the realtime-push channel | No — Telnet already covers every generation | N/A | **Do not implement** | High | Telnet is universal across generations (unlike `AppCommand.xml`, which is 2016+ only); a legacy HTTP write path would be 100% redundant with an already-shipped, already-tested, already-realtime control path. Also: independent verification found `denonavr`'s own legacy-generation write path uses a **different** URL family (`formiPhoneAppPower.xml?1+PowerOn`/`PowerStandby`) than the cheat sheet describes — the cheat sheet's specific write-command URL shape is *not* corroborated by a second source. |
| **Volume set / mute toggle / input select via legacy HTTP write** | Yes — Telnet's `MV<nn>`, `MU ON`/`MU OFF`, `SI<source>` already cover all three, on every generation | No | Yes — via Telnet | No | N/A | **Do not implement** | High | Same reasoning as above: fully redundant with an already-shipped, universal, realtime Telnet path. Independent check: `denonavr`'s legacy volume/mute writes also use the `formiPhoneApp*.xml` family (`formiPhoneAppVolume.xml?1+{volume}`, `formiPhoneAppMute.xml?1+MuteOn`), not the cheat sheet's `index.put.asp?cmd0=` shape — a second point of non-corroboration for that specific URL pattern. |
| **Generic remote-keypress simulation** (`/keypress/{key}`-style endpoint) | Not applicable in the same form — Telnet has no "simulate a physical button" concept, only typed state commands | No | No | Unclear — no evidence either way | **Yes, explicitly** | **Document only; create a hardware verification task** | Low | No independent corroboration found in `denonavr`'s source (no keypress-style endpoint anywhere in the files read). Could conceivably matter for on-screen-menu navigation (cursor/enter/info) that neither Telnet nor `AppCommand.xml` clearly expose — but that's speculation, not evidence. Per the implementation rules, an uncorroborated, non-official capability with a plausible-but-unverified use case gets documented and a verification task, never implemented. |
| **Volume dB range and percent↔decibel conversion** | Yes — Telnet's `MV` scale is 0–98 in half-steps, official-PDF-confirmed prior sessions | N/A | Yes, and already correct | No | No | **No action — already correct and already better** | High | SupremeOS's existing `dbFromMv()` (`avr-codec.ts`) already computes `step − 80`, giving the exact −80.0dB…+18.0dB range. This is independently corroborated by `denonavr`'s own Telnet `MV` callback (`self._volume = -80.0 + float(parameter)`) *and* its HTTP-write docstring ("Minimum is −80.0, maximum at 18.0dB") — both agree with SupremeOS's existing math, not with the cheat sheet's slightly different −79.5dB figure (a ~0.5dB discrepancy, most likely a minor documentation imprecision in the cheat sheet rather than a real different scale, given two independent sources agree with each other and with SupremeOS). |
| **Surfacing volume as dB (not just raw step number) to the installer** | — | — | **Yes, already shipped** | No | No | **No action — already better than the cheat sheet's own stated workflow** | High | The cheat sheet author explicitly notes confusion between the front-panel's 0–98 display and the API's dB value. `apps/web-homeowner`'s `VolumeDial` component already renders `volumeDb.toFixed(1)` with an explicit "dB" unit label whenever it's available — the exact confusion the cheat sheet flags is already resolved in SupremeOS's UI. |
| **Input source triple-naming** (remote label / internal wire code / user display name) | Wire code side: yes, `SI<source>` tokens are official-PDF-confirmed | No | **Yes, already shipped for 2016+ units** | No, for 2016+; yes, for pre-2016 (see the dedicated row above) | No, for the already-shipped mechanism | **No action for 2016+ — already implemented via the stronger, official-adjacent mechanism** | High | SupremeOS's `GetRenameSource`/`GetDeletedSource` (`avr-http-codec.ts`, already shipped) is independently confirmed as `denonavr`'s own **primary** (not fallback) mechanism for exactly this problem — i.e. SupremeOS already uses the more reliable of the two mechanisms a second real, independent implementation also treats as primary. |

## Bonus finding (discovered during evidence verification, not sourced from the cheat sheet)

While independently verifying the cheat sheet's claims against `denonavr`'s source, a real,
separate gap was found in `input.py`: for receivers on the **legacy** (non-`AppCommand.xml`)
update path, a real now-playing metadata source exists — `denonavr`'s own `status_xml_attrs`
mapping resolves title/artist/album for its "NetAudio"-category sources (AirPlay, Media Server,
iPod/USB, Bluetooth — a legacy pre-HEOS streaming module, distinct from the modern HEOS
integration). This directly extends, rather than contradicts, the existing
`AVR-Universal-Capability-Matrix.md` claim: that document's "no verified source for non-HEOS
inputs" finding was scoped to Tuner/USB checked against the `AppCommand.xml`/2016+ path
specifically; it did not check the older, separate legacy status-XML path this session
independently confirmed. **Not implemented this pass** — it needs its own scoped design
decision (a second, legacy-only metadata source class) and is out of scope for a cheat-sheet
audit. Recorded as a new, well-evidenced `TODO.md` item instead (see below).

## Gap matrix

| Capability | Official Docs | Cheat Sheet | SupremeOS | Status |
|---|---|---|---|---|
| Full zone-state read (power/mute/volume/input in one call) | N/S | ✓ (reference) | ✗ | **Ready to Implement** |
| HTTP-port / receiver-generation auto-detection | N/S | Implied | ✗ | **Ready to Implement** |
| Album art on pre-2016 (port-80) units | N/S | N/A | ✗ (silently fails today) | **Ready to Implement** (consequence of the above) |
| Renamed inputs on pre-2016 units | N/S | ✓ (flagged incomplete by the source itself) | ✗ | **Needs Hardware Verification** before treating as equal-confidence |
| HTML-scraped SETUP rename page | N/S | ✓ (flagged unreliable by the source itself) | ✗ | **Unsupported** |
| Zone power/volume/mute/input write via legacy HTTP | Yes (via Telnet) | ✓ | ✓ (via Telnet) | **Already Better than Cheat Sheet** |
| Generic remote-keypress simulation | N/S | ✓ | ✗ | **Needs Hardware Verification** |
| Volume dB range + conversion | Yes (via Telnet) | ✓ (with a ~0.5dB discrepancy) | ✓ | **Already Better than Cheat Sheet** |
| Volume shown as dB in the installer/homeowner UI | N/S | N/A (workflow complaint only) | ✓ | **Already Better than Cheat Sheet** |
| Input triple-naming (2016+ units) | Partial (wire codes only) | ✓ | ✓ (stronger mechanism) | **Already Better than Cheat Sheet** |
| Legacy NetAudio now-playing metadata (bonus finding) | N/S | Not mentioned | ✗ | **Ready to Implement** (separate scoped follow-up, not this pass) |

*(N/S = not specified in the cited official document; both Telnet PDF and HEOS spec were checked
for every row — none of these are HEOS-layer capabilities at all, since HEOS governs streaming
playback, not receiver zone/power/HTTP-web-interface control.)*

## Universal AVR SDK review — where each finding belongs

Per this project's standing rule (`CLAUDE.md`): never add Denon-specific logic to the shared SDK
unless the *pattern* is genuinely generic and has 2+ real callers today — matching the precedent
already set for `HttpPollClient`/`AdaptivePoller` (built once AVR needed a second HTTP-transport
caller, deliberately *not* force-migrated onto Yamaha without a second real need).

- **Receiver-generation / port auto-detection**: **Denon adapter only** (`avr-driver.ts`/
  `avr-probe.ts`). This is a Denon-specific fact (only Denon/Marantz has a 2016 AppCommand.xml
  generational split in this fleet) — HEOS and Yamaha have no equivalent split. Belongs in the
  **Discovery Layer** and **Capability Engine** conceptually, but as Denon-adapter code, not a new
  SDK primitive — there is no second brand driver with this exact problem shape today.
- **Legacy full-zone-state HTTP read**: **Denon adapter only** (`avr-http-codec.ts`, alongside
  the existing `AppCommand.xml` codec). Belongs conceptually to the **State Engine** (a resync
  source, not a push source) and **Media Engine**/**Audio Engine** (the fields it carries). Uses
  the SDK's existing `HttpPollClient` transport primitive (already generic) — no new SDK module
  needed, this is a second real HTTP endpoint for the same brand's existing HTTP client.
- **Album art on pre-2016 units**: **Denon adapter only** — `getArtwork()` already exists and is
  generic at the `IBackendAdapter`/gateway `ArtworkCache` layer (**Artwork Engine**, already ✓ in
  `Universal-AVR-SDK-Roadmap.md`); only the port passed into it needs to change, which is
  Denon-specific plumbing.
- **Generic keypress endpoint** (if ever verified): would be **Denon adapter only** — no other
  driver in the fleet has an equivalent "simulate a physical remote button" concept, and Telnet/
  `AppCommand.xml` already cover every typed-command need for every other brand.
- **Legacy NetAudio metadata** (bonus finding, not implemented this pass): **Denon adapter only**
  if built — feeds the existing, generic **Metadata Engine** concept (`Universal-AVR-SDK-Roadmap.md`
  already tracks Metadata Engine as "Partial"), same as the existing HEOS-routed metadata path.

**No new SDK-layer (`services/protocols/src/av-sdk/`) module is warranted by this audit.** Every
finding here is either (a) Denon-adapter-specific plumbing reusing SDK primitives that already
exist (`HttpPollClient`), or (b) explicitly not implemented. This is consistent with — not a
gap in — the SDK's existing "extract only with 2+ real callers" discipline.

## Implementation performed this pass

Per the stated implementation rules ("only implement when official protocol supports them, OR
independently verified — otherwise document only"), the **only** items implemented are the ones
above marked **Ready to Implement** with **High confidence** and **no hardware verification
required**:

1. **Receiver-generation / HTTP-port auto-detection** — a new, best-effort, read-only probe run
   once per host on `bind()` (mirroring the existing UPnP-description enrichment's "never block
   Telnet control" posture): try `Deviceinfo.xml` on port 8080 first, fall back to port 80 on
   failure, and use whichever port answered for all subsequent HTTP calls (input enrichment,
   album art, and the new legacy full-state read below) instead of a fixed `8080`.
2. **Legacy full-zone-state HTTP read** (`avr-http-codec.ts`) — a new, narrowly-scoped parser for
   exactly the fields independently confirmed via `denonavr`'s own `status_xml_attrs` mappings
   (power, zone power, mute, master volume, current input) — used **only** as a best-effort
   supplementary read when the detected generation is legacy (pre-2016/port-80), **never** as a
   write path, and **never** replacing Telnet as the realtime/authoritative source.
3. **Album art port fix** — `getArtwork()`/`albumArtUrl()` now use the detected port instead of
   the fixed `8080` default, unlocking album art for pre-2016 units as a direct, evidenced
   consequence of finding #1.

**Deliberately not implemented**, consistent with the rules above: any legacy HTTP *write* path
(fully redundant with Telnet, and the cheat sheet's specific write-URL shape isn't independently
corroborated anyway), the generic keypress endpoint (uncorroborated), the HTML-scraped SETUP
rename page (unreliable by the source's own admission), and the legacy NetAudio metadata bonus
finding (out of scope, needs its own design pass).

## Hardware verification tasks created

Two items from this audit genuinely need a real unit and cannot be resolved from documentation
alone. Both use the existing devMode tooling (Raw Command / Protocol Trace / Heartbeat /
Diagnostics) built during the RTI Capability Audit pass — with one honest caveat noted below.

1. **Renamed inputs on pre-2016 units, via the legacy full-state snapshot's partial rename
   list** — once a real pre-2016 unit is reachable, compare the partial list this snapshot
   reports against the unit's actual current input names (read off the front panel or OEM app)
   to determine how incomplete it really is in practice, before ever treating it as
   installer-facing "device_reported" data. Procedure: with `devMode` on, open **Protocol
   Trace** and use **Diagnostics**/**Refresh Capabilities** to trigger the new legacy read, then
   manually compare.
2. **Generic keypress endpoint** — send a probe HTTP request to the cheat-sheet-referenced path
   against a real unit and observe whether it responds at all, and if so, to what.
   **Caveat, stated honestly rather than overstated**: the existing **Raw Command** devMode tool
   (`AvrProtocolDriver.sendRaw()`) only writes to the Telnet socket — it has no equivalent for an
   arbitrary HTTP request. Verifying this specific item today requires a manual, out-of-band
   request (e.g. a browser or `curl` against the unit's IP) run by whoever has the hardware, not
   something the current in-app tooling covers. This gap is recorded as a `TODO.md` item in its
   own right (an HTTP-request equivalent of Raw Command, if this kind of verification becomes a
   recurring need) rather than silently worked around.

No result is fabricated for either item — both stay exactly as classified (Needs Hardware
Verification) until someone runs the real check.

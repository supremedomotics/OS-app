# AVR Universal Capability Matrix — Denon/Marantz Reference Implementation

> Companion to [Universal-AV-SDK.md](./Universal-AV-SDK.md) (the architecture this matrix
> justifies) and [avr-sdk-developer-guide.md](./avr-sdk-developer-guide.md). Every row below is
> either implemented and tested against real, cited evidence, or explicitly gated with a
> documented reason — nothing here is guessed or fabricated.

## Methodology and honest constraints (read before the table)

This matrix was originally produced without access to real Denon/Marantz hardware and without
access to the official Denon protocol PDF spec (every fetch attempt to `assets.denon.com` and
similar hosts returned HTTP 403 in this sandbox). **Updated in a later pass**: the user directly
supplied three primary sources — "DENON AVR control protocol Ver.8.6.0" (application model
AVR-1713/AVR-1613, official Denon PDF), the official "HEOS CLI Protocol Specification" v1.17 PDF,
and a real, exported RTI (Remote Technologies Inc.) commercial driver file
(`Denon_Marantz_Receiver.rtidriver`, an OLE2/CFB compound document — extracted and read stream-
by-stream: `SystemVariables.xml`, `SystemFunctions.xml`, `DeviceDescription.xml`,
`ConfigSettings.xml`, `DriverManifest`). These are now cited directly, by page/section, wherever
they back a claim — no fetch-403 workaround needed for those three documents specifically. Every
"Official Interface" claim below is backed by one or more of:

1. **The existing, already-tested SupremeOS Telnet codec** (`services/protocols/src/avr-codec.ts`),
   itself verified against the official Denon AVR control protocol spec v8.6.0 in an earlier
   session (that spec excerpt is no longer directly re-fetchable, but the resulting token table
   is real, working, and covered by 44 passing integration tests against a protocol-accurate fake
   receiver).
2. **`ol-iver/denonavr`** (`raw.githubusercontent.com/ol-iver/denonavr`, fetched and read directly
   this session, file by file — not summarized secondhand) — the Python library Home Assistant's
   own official `denonavr` integration is built on. Its real `appcommand.py` (`AppCommands` enum,
   verbatim cmd_id/cmd_text pairs), `input.py` (actual XML parsing code), `api.py` (actual request-
   body builder), and `const.py` (actual URL/string constants) are the primary source for every
   HTTP AppCommand claim in this matrix.
3. **A dedicated XML-dump tool** (`ol-iver/misc_python_tools/denonavr/denon_receiver_xml.py`, same
   author, fetched directly) — used specifically to confirm what is *not* parsed by anyone,
   corroborating genuine absence rather than under-research.
4. **`openhab/openhab-addons`'s `org.openhab.binding.denonmarantz`** (fetched directly) — a
   decade-old, actively maintained binding, used as a second independent cross-check: if a
   10-year-old mature project hasn't stabilized a field into a typed channel, that's real signal
   the field is genuinely unstable/unpublished, not just overlooked.
5. **HEOS CLI Protocol Specification** (cited in this codebase's existing `heos-codec.ts`, now
   directly cross-checked against the official v1.17 PDF) and **Yamaha MusicCast YXC**
   (`yamaha-codec.ts`'s existing `getFeatures` implementation) — both already real, tested,
   working interfaces in this fleet, cited here only for capabilities where HEOS/Yamaha genuinely
   provide something Denon Telnet+AppCommand cannot.
6. **The official Denon AVR control protocol PDF** (Ver.8.6.0, AVR-1713/AVR-1613) — the direct
   primary source, superseding "existing tested codec" as the citation wherever a command it
   documents was re-verified against it this pass (Audyssey-family `PS` commands, channel-volume
   `CV` commands).
7. **The real RTI `Denon_Marantz_Receiver.rtidriver`** — used strictly as a **behavioral**
   reference per the user's explicit instruction ("never copy proprietary code... use them to
   identify missing capabilities"). Its `SystemVariables.xml`/`SystemFunctions.xml` were read to
   discover what a commercial driver models (e.g. Front Height/Wide/dual-subwoofer channel trims
   beyond what the Denon PDF's example model exposes, per-zone bass/treble/HPF for Zones 2-4,
   "Connection State" diagnostics) — cited only to flag capabilities SupremeOS doesn't yet cover,
   never as a source for a command token or parameter encoding (no RTI script/table content is
   reproduced here or in any implementation file).

**RTI**: as of this pass, this session **does** have a real, user-supplied RTI driver export —
used exclusively per item 7 above (behavioral gap-finding, zero code/token reuse). The RTI column
in the tables below is **still marked N/S**, not filled in with checkmarks: confirming "RTI
implements X" for every row would require a systematic, row-by-row audit of its
`SystemFunctions.xml`/`SystemVariables.xml` against this matrix, which this pass did not do —
only a targeted read for the specific gaps cited above. Marking N/S here is the honest
reflection of "not yet independently, systematically cross-checked," not "no evidence exists."

**Crestron / Control4 / Savant**: this session has **no access** to any of these three systems'
driver source code, SDKs, or dealer documentation — they remain proprietary/NDA-gated. The
user was asked whether they could share any such material; the question was declined for the
initial pass. Per this session's established pattern (state the default, proceed), these three
columns (plus RTI, per the note above) are marked **N/S (not independently sourced)** throughout
— used only as the feature-completeness bar the user named, never as fabricated evidence. A
checkmark never appears in these columns.

**Confidence** reflects how directly the "Official Interface" claim is cited, not whether
SupremeOS implements it: **High** = a real XML/token shape was fetched and read verbatim this
session, or an existing tested codec already implements it. **Medium** = a command/token is
confirmed to exist (verbatim source), but its exact parameter encoding/response schema was not
independently verified. **Low** = inferred from protocol-family convention, not directly
verified.

## Power, Zones, Volume, Mute

| Property | Official Interface | RTI | Crestron | Control4 | Savant | Current SupremeOS | Recommended Interface | Confidence |
|---|---|---|---|---|---|---|---|---|
| Power (main zone) | Telnet `ZM?`/`ZMON`/`ZMOFF` | N/S | N/S | N/S | N/S | ✓ Implemented, live push | Telnet event | High |
| Power (whole-unit standby) | Telnet `PW?`/`PWON`/`PWSTANDBY` | N/S | N/S | N/S | N/S | ✓ Implemented (distinct from `ZM`, never conflated) | Telnet event | High |
| Zone 2 power | Telnet `Z2?`/`Z2ON`/`Z2OFF` | N/S | N/S | N/S | N/S | ✓ Implemented, live push | Telnet event | High |
| Zones (presence/enumeration) | None — no feature-query command anywhere in Telnet or AppCommand | N/S | N/S | N/S | N/S | Installer-declared at commissioning (`AudioCapabilityConfig.source: "installer_declared"`) | Installer config | High (absence confirmed, not assumed) |
| Master volume | Telnet `MV?`/`MV<nn>` | N/S | N/S | N/S | N/S | ✓ Implemented, live push | Telnet event | High |
| Zone 2 volume | Telnet `Z2<nn>` (same 0–98 scale as `MV`) | N/S | N/S | N/S | N/S | ✓ Implemented, live push (corrected this codebase's own earlier false-negative) | Telnet event | High |
| Mute (main) | Telnet `MU?`/`MUON`/`MUOFF` | N/S | N/S | N/S | N/S | ✓ Implemented, live push | Telnet event | High |
| Zone 2 mute | Telnet `Z2MU?`/`Z2MUON`/`Z2MUOFF` | N/S | N/S | N/S | N/S | ✓ Implemented, live push | Telnet event | High |

## Input / Source

| Property | Official Interface | RTI | Crestron | Control4 | Savant | Current SupremeOS | Recommended Interface | Confidence |
|---|---|---|---|---|---|---|---|---|
| Input selection | Telnet `SI?`/`SI<token>` | N/S | N/S | N/S | N/S | ✓ Implemented, live push | Telnet event | High |
| Friendly source names (spec-derived) | Telnet `SI` token table + Denon's own OSD naming convention | N/S | N/S | N/S | N/S | ✓ Implemented (`DENON_INPUT_LABELS`, e.g. `NET`→"HEOS Music") | Static label map | High |
| Renamed input labels (installer-set, via OEM app) | HTTP AppCommand `GetRenameSource` — real XML shape `<functionrename>/<list>/<name>+<rename>` (verified verbatim from `denonavr/input.py`) | N/S | N/S | N/S | N/S | ✓ Implemented for `AppCommand.xml`-capable (2016+) units — fetched on bind, refreshed every 15 min while connected, filtered/relabeled into `AudioCapabilityConfig.inputs`. **Pre-2016 units** (§ Denon Cheat Sheet Audit): the driver now auto-detects this generation split (`resolveHttpPort()`) and correctly skips the doomed `AppCommand.xml` attempt, but does **not** treat the legacy `formMainZone_MainZoneXml.xml` snapshot's embedded partial rename list as an equal-confidence substitute — that list is independently confirmed incomplete (`denonavr` itself never uses it as a rename source either), so pre-2016 units stay on `installer_declared` labels until a real hardware capture confirms it's safe to promote. See `docs/architecture/Denon-CheatSheet-Audit.md`. | HTTP AppCommand (POST), 2016+ only | High (2016+) / Medium, unverified (pre-2016 fallback) |
| Hidden/deleted inputs | HTTP AppCommand `GetDeletedSource` — real XML shape `<functiondelete>/<list>/<FuncName>+<use>` (`use="0"`→hidden, verified verbatim) | N/S | N/S | N/S | N/S | ✓ Implemented for `AppCommand.xml`-capable (2016+) units — filtered out of the selectable input list entirely. Not available on pre-2016 units, same reasoning as Renamed input labels above. | HTTP AppCommand (POST), 2016+ only | High |
| Network source names (streaming service identity) | HEOS `player/get_now_playing_media`'s `sid` field (HEOS CLI spec, cross-verified against `pyheos`) | N/S | N/S | N/S | N/S | ✓ Implemented on the sibling HEOS device (`av-sdk/network-source-resolver.ts`) — genuinely out of scope for Telnet/AppCommand, which carry no per-stream service identity | HEOS event | High |
| Bluetooth (as an input) | Telnet `SI` — no dedicated BT token confirmed in this codebase's existing spec-derived table | N/S | N/S | N/S | N/S | Not implemented — no verified token | — | Low |
| AirPlay | No dedicated token/sid — confirmed via Denon's own published support docs: AirPlay rides the same `NET`/"HEOS Music" input as every other HEOS-routed service | N/S | N/S | N/S | N/S | Correctly represented as "HEOS Music" (not a gap — this *is* what the receiver's own front panel shows) | — | High |
| Spotify (Spotify Connect) | HEOS `sid` (Spotify Connect) | N/S | N/S | N/S | N/S | ✓ Implemented via HEOS's now-playing `sid` resolution | HEOS event | High |
| HEOS (whole subsystem) | HEOS CLI protocol (TCP port 1255) | N/S | N/S | N/S | N/S | ✓ Fully implemented as a separate, real, tested driver (`heos-driver.ts`) | HEOS CLI (TCP push) | High |
| Tuner | Telnet `SI TUNER` (selection only — no station-name query confirmed) | N/S | N/S | N/S | N/S | ✓ Selection implemented; station/preset name not implemented (no verified query) | Telnet event (selection only) | Medium |
| USB | Telnet `SI USB/IPOD` (selection only) | N/S | N/S | N/S | N/S | ✓ Selection implemented | Telnet event | High |
| Media Server (DLNA) | Telnet `SI SERVER` (selection only) | N/S | N/S | N/S | N/S | ✓ Selection implemented | Telnet event | High |

## Sound Mode / DSP / Tone

| Property | Official Interface | RTI | Crestron | Control4 | Savant | Current SupremeOS | Recommended Interface | Confidence |
|---|---|---|---|---|---|---|---|---|
| Sound mode (set/read current) | Telnet `MS?`/`MS<mode>` | N/S | N/S | N/S | N/S | ✓ Implemented, live push, fixed spec-derived list including evidenced `AUTO` | Telnet event | High |
| Supported-sound-mode-list (per-unit, filter to only what this model supports) | **No command exists** — confirmed absent from `denonavr`'s complete, real `AppCommands` enum; Telnet has no feature-query command either | N/S | N/S | N/S | N/S | ✗ Not implemented — genuinely unavailable, not a gap in research | — | High (absence confirmed) |
| Listening mode (alias for sound mode in this fleet) | Same as Sound mode | N/S | N/S | N/S | N/S | ✓ Same implementation (`ListeningModeSelector` UI) | Telnet event | High |
| Decoder mode / incoming audio format (e.g. "Dolby Atmos", "DTS:X", sample rate/bit depth) | HTTP AppCommand `GetAudioInfo` — command confirmed to exist (referenced across multiple sources); exact response XML tag names not independently verified anywhere reachable this session | N/S | N/S | N/S | N/S | ✗ Not implemented — UI slot (`advanced.audioFormat`/`sampleRateKHz`/`bitDepth`) already exists and renders defensively, stays dormant until a verified source lands | HTTP AppCommand (unverified schema) | Medium (command exists) / Low (schema) |
| Pure Direct / Direct / Stereo | Telnet `MS` tokens (`PURE DIRECT`, `DIRECT`, `STEREO` — already in the spec-derived mode list) | N/S | N/S | N/S | N/S | ✓ Implemented, same mechanism as Sound mode | Telnet event | High |
| DSP modes (Movie/Music/Game/Matrix/…) | Telnet `MS` tokens | N/S | N/S | N/S | N/S | ✓ Implemented, same mechanism as Sound mode | Telnet event | High |
| Bass | Telnet `PSBAS ?`/`PSBAS <nn>` | N/S | N/S | N/S | N/S | ✓ Implemented, live push. **UI added this sprint** — real data existed with zero rendering surface until now | Telnet event | High |
| Treble | Telnet `PSTRE ?`/`PSTRE <nn>` | N/S | N/S | N/S | N/S | ✓ Implemented, live push. **UI added this sprint** | Telnet event | High |
| Tone defeat (tone control on/off) | Telnet `PSTONE CTRL ?`/`PSTONE CTRL ON`/`OFF` — queried at connect, not currently exposed as a settable control | N/S | N/S | N/S | N/S | Partial — queried but not surfaced as a homeowner toggle | Telnet event | Medium |
| Dialog enhancer | HTTP AppCommand — no confirmed dedicated command; likely folded into `SetAudyssey`/tone family, unverified | N/S | N/S | N/S | N/S | ✗ Not implemented — no verified command | — | Low |
| Subwoofer level | HTTP AppCommand — command family confirmed to exist in general (Audyssey/channel-level commands reference sub level), exact command name/encoding not independently verified | N/S | N/S | N/S | N/S | ✗ Not implemented | HTTP AppCommand (unverified) | Low |
| Channel trims (per-speaker level, FL/FR/C/SW/SL/SR) | **Telnet `CV<ch> <nn>`** — official Denon AVR control protocol PDF (Ver.8.6.0, p.7), directly supplied and read this session: exact encoding confirmed (`38`–`62` ASCII, `50`=0dB, `00`=OFF for SW). Superseded HTTP AppCommand `SetChLevel` as the cited interface — Telnet is both confirmed AND the existing realtime channel. | N/S | N/S | N/S | N/S | ✗ **Not yet wired** — encoding is now real evidence, not guessed, but implementing the 6-channel trim range UI is separate, UI-verification-bound scope not taken up this pass (tracked as a follow-up, not silently dropped). RTI's own driver (`SystemVariables.xml`, directly inspected this session) models additional channels this PDF doesn't confirm (Front Height/Wide, dual subwoofer, Surr Back) — those stay unimplemented since no equivalent SupremeOS evidence exists for them. | Telnet `CV` | **High** (protocol evidence) / gated on UI work |
| Speaker layout / channel activity | HTTP AppCommand `GetActiveSpeaker` — command referenced as real; exact response schema not independently verified | N/S | N/S | N/S | N/S | ✗ Not implemented | HTTP AppCommand (unverified) | Medium (name) / Low (schema) |
| Dynamic EQ | **Telnet `PSDYNEQ ON`/`OFF`** — official Denon AVR control protocol PDF (Ver.8.6.0, p.13), directly supplied and read this session. A fixed on/off enum, not a guessed numeric range — the safety concern that gated this via HTTP AppCommand's `SetAudysseyDynamicEQ` doesn't apply to a closed, spec-quoted token set. | N/S | N/S | N/S | N/S | ✓ **Implemented** this pass, live push + write, via `denonCapabilityConfig`'s installer-declared `hasAudyssey` opt-in (defaults `false` — Telnet has no feature-query command, so presence isn't wire-discoverable; see Reference Level row for the same caveat) | Telnet `PSDYNEQ` | **High** |
| Dynamic Volume | **Telnet `PSDYNVOL HEV`/`MED`/`LIT`/`OFF`** — same PDF, p.13. Fixed enum. | N/S | N/S | N/S | N/S | ✓ **Implemented** this pass, live push + write, gated on `hasAudyssey` | Telnet `PSDYNVOL` | **High** |
| Dynamic Range Compression (DRC) | **Telnet `PSDRC AUTO`/`LOW`/`MID`/`HI`/`OFF`** — same PDF, p.14. Fixed enum. Not previously in this matrix at all (newly discovered this pass, not merely un-gated). | N/S | N/S | N/S | N/S | ✓ **Implemented** this pass, live push + write, gated on `hasAudyssey` | Telnet `PSDRC` | **High** |
| Audyssey MultEQ mode | **Telnet `PSMULTEQ:AUDYSSEY`/`BYP.LR`/`FLAT`/`MANUAL`/`OFF`** — same PDF, p.13. Fixed enum. | N/S | N/S | N/S | N/S | ✓ **Implemented** this pass, live push + write, gated on `hasAudyssey` | Telnet `PSMULTEQ:` | **High** |
| Reference Level Offset | **Telnet `PSREFLEV 0`/`5`/`10`/`15`** — same PDF, p.13. Fixed enum (dB). | N/S | N/S | N/S | N/S | ✓ **Implemented** this pass, live push + write, gated on `hasAudyssey`. **Model caveat, stated honestly**: the source PDF targets the 2012-era AVR-1713/1613; whether a specific bound unit has Audyssey calibration at all still isn't wire-discoverable, so this stays an explicit installer opt-in rather than assumed present on every Denon/Marantz. | Telnet `PSREFLEV` | **High** (command evidence) / installer-declared (presence) |

## Video

| Property | Official Interface | RTI | Crestron | Control4 | Savant | Current SupremeOS | Recommended Interface | Confidence |
|---|---|---|---|---|---|---|---|---|
| Video format | HTTP AppCommand `GetVideoInfo` — command confirmed to exist; exact response schema not independently verified | N/S | N/S | N/S | N/S | ✗ Not implemented | HTTP AppCommand (unverified) | Medium (command) / Low (schema) |
| HDR mode | Same `GetVideoInfo` family — not independently confirmed to include HDR flags specifically | N/S | N/S | N/S | N/S | ✗ Not implemented | HTTP AppCommand (unverified) | Low |
| Resolution | Same `GetVideoInfo` family | N/S | N/S | N/S | N/S | ✗ Not implemented | HTTP AppCommand (unverified) | Low |

## Now-Playing Metadata, Artwork, Transport

| Property | Official Interface | RTI | Crestron | Control4 | Savant | Current SupremeOS | Recommended Interface | Confidence |
|---|---|---|---|---|---|---|---|---|
| Track / Title | HEOS `player/get_now_playing_media` (real, tested) for HEOS-routed content; **no verified source for Tuner/USB via the 2016+ AppCommand.xml path specifically** — no library, including a dedicated XML-dump tool by the endpoint's own documenting author, parses this from any AppCommand/Status XML endpoint. **§ Denon Cheat Sheet Audit (bonus finding, unrelated to the cheat sheet itself)**: a genuinely different, older path — the pre-2016 `formNetAudio_StatusXml.xml` endpoint's `szLine` array — is independently confirmed (via `denonavr/input.py`) to carry title/artist/album for its own "NetAudio"-category sources (AirPlay, Media Server, iPod/USB, Bluetooth — a legacy pre-HEOS streaming module, not modern HEOS). Not implemented — needs its own scoped design pass, see `Denon-CheatSheet-Audit.md` and `TODO.md`. | N/S | N/S | N/S | N/S | ✓ Implemented for HEOS-routed content (sibling HEOS device); ✗ not implemented for Tuner/USB via AppCommand, and not implemented (documented only) for the legacy NetAudio path either | HEOS event (HEOS-routed only) | High (HEOS) / High-absence (AppCommand path) / Medium (legacy NetAudio path exists but unimplemented) |
| Artist | Same as Track | N/S | N/S | N/S | N/S | Same as Track | HEOS event (HEOS-routed only) | Same as Track |
| Album | Same as Track | N/S | N/S | N/S | N/S | Same as Track | HEOS event (HEOS-routed only) | Same as Track |
| Genre | Not present in the HEOS `get_now_playing_media` response shape this codebase's `heos-codec.ts` already parses, nor anywhere else confirmed | N/S | N/S | N/S | N/S | ✗ Not implemented | — | High (absence confirmed for the interfaces checked) |
| Elapsed / remaining time | HEOS progress events (real, tested, `heos-codec.ts`) | N/S | N/S | N/S | N/S | ✓ Implemented for HEOS-routed content | HEOS event | High |
| Album art | HTTP static URL `http://{host}:{port}/img/album%20art_S.png` — confirmed real, literal string constant (`denonavr/const.py`), no XML/schema involved at all; also `http://{host}:{port}/NetAudio/art.asp-jpg?{hash}` for station-type sources. Independently confirmed to work on **any** generation — `denonavr` templates this URL with whatever port its own generation probe detected, never hardcoded to 8080. | N/S | N/S | N/S | N/S | ✓ Implemented — `getArtwork()` fetches this directly, proxied through the gateway (`ArtworkCache`, same pattern as the Apple TV driver). **§ Denon Cheat Sheet Audit**: now uses the auto-detected port (`resolveHttpPort()`) instead of a fixed `8080`, so this genuinely works on pre-2016 units too — previously silently failed there for the exact same fixed-port reason renamed inputs did. | HTTP static fetch | High |
| Artwork cache | SupremeOS's own `ArtworkCache` (LRU + 60s TTL, `services/gateway/src/artwork-cache.ts`) — a SupremeOS-side concern, not a receiver capability | N/S | N/S | N/S | N/S | ✓ Implemented (pre-existing, reused unmodified) | Gateway-side cache | High |
| Queue | HEOS `player/get_queue` (real, tested) | N/S | N/S | N/S | N/S | ✓ Implemented (HEOS device only — Telnet/AppCommand have no queue concept) | HEOS event/request | High |
| Transport (play/pause/next/seek) | HEOS transport commands (real, tested); **not available at all via Telnet/AppCommand** — confirmed no such commands in either interface | N/S | N/S | N/S | N/S | ✓ Implemented (HEOS device only) | HEOS command | High |

## Device Info

| Property | Official Interface | RTI | Crestron | Control4 | Savant | Current SupremeOS | Recommended Interface | Confidence |
|---|---|---|---|---|---|---|---|---|
| Manufacturer | UPnP device description XML (`<manufacturer>`) — standard UPnP, confirmed via `ol-iver/denonavr`'s own SSDP parser | N/S | N/S | N/S | N/S | ✓ Implemented at discovery | UPnP description | High |
| Model | UPnP device description XML (`<modelName>`) | N/S | N/S | N/S | N/S | ✓ Implemented at discovery, threaded into Diagnostics | UPnP description | High |
| Serial | UPnP device description XML (`<serialNumber>`) | N/S | N/S | N/S | N/S | ✓ Implemented at discovery, threaded into Diagnostics | UPnP description | High |
| Firmware | **No source found anywhere** — not in Telnet, not in the UPnP description, not in any AppCommand response this session could verify | N/S | N/S | N/S | N/S | ✗ Genuinely unavailable — stays honestly `null`, never fabricated | — | High (absence confirmed) |
| MAC | Local ARP-table best-effort read (`arp-lookup.ts`) — a host-side technique, not a receiver capability | N/S | N/S | N/S | N/S | ✓ Implemented (best-effort; correct on the same L2 segment, `null` otherwise) | Local ARP table | High |
| IP | The address the installer/discovery already has | N/S | N/S | N/S | N/S | ✓ Implemented | — | High |
| Temperature (internal) | No command found in Telnet, UPnP, or AppCommand | N/S | N/S | N/S | N/S | ✗ Not implemented — genuinely unavailable | — | High (absence confirmed) |
| Receiver HTTP generation (2016+/`AppCommand.xml`-capable vs. pre-2016/legacy) | `Deviceinfo.xml` on port 8080 (2016+) vs. port 80 (pre-2016) — real, independently confirmed via `denonavr/foundation.py`'s actual `async_identify_receiver()` (§ Denon Cheat Sheet Audit) | N/S | N/S | N/S | N/S | ✓ **Implemented this pass** (`resolveHttpPort()`/`detectHttpGeneration()`) — a best-effort, cached-per-host probe run once on first bind; an explicit `httpPort` config always overrides it. Previously the driver silently assumed every unit was 8080-capable. | HTTP GET probe | High |

## Diagnostics

| Property | Official Interface | RTI | Crestron | Control4 | Savant | Current SupremeOS | Recommended Interface | Confidence |
|---|---|---|---|---|---|---|---|---|
| Connected interface / active protocol | SupremeOS-side (which transport this link is using) | N/S | N/S | N/S | N/S | ✓ Implemented (`protocol`/`connectionStatus` in `DriverDiagnosticsSnapshot`) | — | High |
| Reconnect count | SupremeOS-side (`ReconnectScheduler`) | N/S | N/S | N/S | N/S | ✓ Implemented | — | High |
| Average latency | SupremeOS-side — real rolling window computed from `recordSend`/`recordReceive` timestamps, automatic for every driver | N/S | N/S | N/S | N/S | ✓ Implemented this sprint (`averageLatencyMs`, distinct from the pre-existing single-shot `responseTimeMs`) | — | High |
| Packet loss | **Not a meaningful metric over Telnet/HTTP** — both are reliable-delivery TCP; there is no "packet" to lose the way there would be over UDP/wireless | N/S | N/S | N/S | N/S | ✗ Deliberately not implemented — reconnect count + last error + average latency are the honest equivalent | — | High (the reason, not the absence, is the point) |
| RX/sec, TX/sec | SupremeOS-side — derivable from `packetsSent`/`packetsReceived` + a time window; not implemented as a distinct rate field this pass | N/S | N/S | N/S | N/S | Partial — raw counters implemented (`packetsSent`/`packetsReceived`), a derived per-second rate is not | — | High |
| Last command / last event | SupremeOS-side | N/S | N/S | N/S | N/S | ✓ Implemented (`lastCommand`/`lastCommandAt`, `lastResponse`/`lastResponseAt`) | — | High |
| Heartbeat (Telnet/AVR) | No protocol-native no-op ping exists in the Telnet spec; `PW?` (whole-unit power query, p.7, already a real necessary command) doubles as a harmless, on-demand liveness probe — the same pattern RTI's own driver uses for this purpose (§ RTI Capability Audit, Category C.3) | N/S | N/S | N/S | N/S | ✓ **Implemented** — `AvrProtocolDriver.heartbeat(deviceId)` sends `PW?` and resolves `{ ok, latencyMs }` on any received line (not just a `PW`-prefixed echo), 5s timeout. This row was stale (predated the heartbeat work landing) and is corrected here, not new evidence. | Telnet `PW?` | High |
| Heartbeat (HEOS) | **`system/heart_beat`** — official HEOS CLI Protocol Specification v1.17 §4.1.5, directly supplied and read this session: a real, documented, on-demand liveness/round-trip command distinct from any player query. | N/S | N/S | N/S | N/S | ✓ **Implemented** this pass — `HeosProtocolDriver.heartbeat(deviceId)` sends it and resolves `{ ok, latencyMs }`, correlated per shared link (no pid in the response) with a 5s timeout | HEOS `system/heart_beat` | High |
| Capability report | Installer-declared config + real HTTP-sourced input enrichment, surfaced via `getCapabilityConfig()` | N/S | N/S | N/S | N/S | ✓ Implemented | Mixed (installer + HTTP) | High |
| Protocol trace | SupremeOS-side ring buffer, automatically fed by every real `recordSend`/`recordReceive` call | N/S | N/S | N/S | N/S | ✓ Implemented this sprint (`GET /v1/devices/:id/diagnostics/trace`, UI panel) | — | High |
| Realtime event log | Same mechanism as Protocol trace | N/S | N/S | N/S | N/S | ✓ Implemented (same trace buffer/panel) | — | High |

## Known operational constraint (not a bug)

**Denon/Marantz Telnet allows exactly one concurrent connection.** If SupremeOS holds it (which
it does, continuously, for realtime push), the OEM Denon Remote app cannot also open a Telnet
session to the same receiver at the same time (confirmed via community source). The HEOS app is
unaffected — it speaks the separate HEOS CLI protocol on its own port. This is a real, documented
protocol limitation to make visible to installers, not something SupremeOS can or should "fix."

## What "N/S" does NOT mean

An "N/S" cell is not a claim that RTI/Crestron/Control4/Savant lack the capability — it means
this session has no legitimate way to know either way. Where the user's brief named a specific,
verifiable behavior from one of these systems (none were provided), this matrix would cite it
directly; none were available. Treat the four columns as the *feature-completeness bar* the user
asked for, not as absent competitor data being hidden.

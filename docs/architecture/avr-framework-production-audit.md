# Universal AVR Framework — Production Verification & Hardening Audit

- Status: **In progress** (this document is being assembled across the audit; sections
  are filled in as each phase completes — see the top of each section for its status)
- Date: 2026-07-19
- Context: ADR 0015 (Universal AVR Framework) and its 2026-07-19 addendum
  (Diagnostics Console, Room Assignment Engine, Automatic Zone Generation, Media
  Topology Engine); `docs/architecture/avr-framework-review.md` (original Phase 1
  review).
- Scope: Denon/Marantz (Telnet + HEOS) and Yamaha (YXC/MusicCast) — the three brands
  actually implemented. Every claim in this document cites exact `file:line` evidence
  or is explicitly marked as unverified — nothing here is asserted from memory alone.

---

## Phase 4 — Protocol Coverage Matrix

Legend: **✓** implemented and tested against an in-process fake server/HTTP mock (this
repo's established testing convention) · **△** partially implemented (works, but with
a caveat noted) · **✗** not implemented · **N/A** does not exist in the vendor protocol
(verified against the spec — not a gap, a real protocol limit).

### Denon / Marantz (classic Telnet, `avr-driver.ts` + `avr-codec.ts`)

| Feature | Status | Evidence |
|---|---|---|
| Discovery | △ | `avr-driver.ts:173-181` — via co-located HEOS SSDP presence (`ACT-Denon:1`), not a Telnet-native discovery (none exists in the spec). Real, but indirect. |
| Power | ✓ | `avr-codec.ts:85-91` (`PWON`/`PWSTANDBY`), tested `avr-driver.test.ts:111-115` |
| Volume | ✓ | `avr-codec.ts:96-98` (`MV`), tested `avr-driver.test.ts:117-124` |
| Mute | ✓ | `avr-codec.ts:99-102` (`MUON`/`MUOFF`) |
| Input/Source | ✓ | `avr-codec.ts:103-104` (`SI<name>`) |
| Zone 2 | ✓ | Independent Supreme device, same link; power/mute/source only — `avr-driver.ts:75-81`, tested `avr-driver.test.ts:163-179` |
| Zone 3 | N/A | Not in the spec at all; Denon/Marantz Telnet only ever documents Main + Zone 2 (verified — no `Z3` token anywhere in `avr-codec.ts`) |
| Zone 2 Volume | N/A | `avr-codec.ts:96-98,180` — no documented Zone 2 volume token in the spec, verified and tested (`avr-driver.test.ts:180-184`, "rejects zone2 volume") |
| Tone Control (bass/treble) | ✓ | `avr-codec.ts:109-110` (`PSBAS`/`PSTRE`), installer-declared presence via `hasToneControl` |
| DSP/Sound Mode | ✓ | `avr-codec.ts:111` (`MS<mode>`), 16 modes from spec p.11 |
| Sleep Timer | ✓ | `avr-codec.ts:112-113` (`SLP<mmm>`), preset options only (0/30/60/90/120) |
| HEOS (streaming) | ✓ | Separate `HeosProtocolDriver` — same physical unit, co-located, see HEOS section below |
| Transport (play/pause/next/…) | N/A | `avr-codec.ts:118` — "transport is source-specific; not mapped" — no transport command exists on this protocol at all; HEOS covers this |
| Metadata (title/artist/artwork) | N/A | `avr-codec.ts:189-192` — `buildMediaState` always returns `title:null, artist:null, artworkUrl:null` — no metadata query exists in the Telnet spec |
| Diagnostics (RX/TX/last cmd/reconnect) | ✓ | This session's addition — `avr-driver.ts` `DriverDiagnosticsTracker` wiring, tested `avr-driver.test.ts` "reports real Diagnostics Console counters" |
| Auto-Reconnect | ✓ | `avr-reconnect.ts` capped exponential backoff, tested `avr-driver.test.ts:190-217` |
| Live Feedback | ✓ | Unsolicited token parsing, `avr-driver.ts:241-247` |
| Firmware read/update | ✗ (N/A) | No firmware field anywhere in the spec — not implemented, not implementable without a different data source |
| Room Assignment | N/A | No location signal on the wire at all (verified, unchanged since ADR 0015) — always lands in "Unassigned Devices" via the Room Assignment Engine, by design |
| Automatic Zone Generation | ✗ (by design) | Zone 2 presence is genuinely not wire-detectable — stays a manual `hasZone2` declaration, never auto-generated (see ADR 0015 addendum) |

### HEOS (`heos-driver.ts` + `heos-codec.ts` — Denon/Marantz's streaming layer)

| Feature | Status | Evidence |
|---|---|---|
| Discovery | ✓ | SSDP + `get_players` resolution, deduped by pid — `heos-driver.ts:208-238`, tested |
| Power | N/A | No power command exists in the HEOS CLI spec (verified) — power is the Telnet driver's job |
| Volume | ✓ | `heos-codec.ts` `set_volume`, 0-100 absolute, no scale conversion |
| Mute | ✓ | `set_mute`/`toggle_mute` |
| Input/Source | ✓ | `play_input` against the fixed protocol-defined input enum |
| Transport (play/pause/stop/next/prev) | ✓ | `heosCapabilityConfig():352` — all `true` |
| Seek | N/A | `heos-driver.test.ts:125` "rejects seek — no wire-level position-set command exists in HEOS CLI" — verified protocol limit |
| Shuffle/Repeat | ✓ | `set_play_mode`, repeat is a real 3-state enum (off/all/one) |
| Metadata + Artwork | ✓ | `get_now_playing_media`, real `image_url` |
| Queue | ✓ | `get_queue`, sequence-correlated, tested |
| Presets/QuickSelect | △ | `heos-codec.ts:124` command mapping EXISTS (`play_quickselect`) but `heosCapabilityConfig()` (`heos-codec.ts:348-354`) never populates `presets`/`advancedControls` — **the command is wired but has no UI surface to trigger it.** Spec itself says QuickSelect is "LS AVR / HEOS BAR only," not universal — this was deliberately left undetectable rather than assumed present, but that also means it's currently unreachable from the UI. Flagged in Phase 1 findings below. |
| Multi-room grouping | ✗ (deferred) | `group/*` commands exist in spec, not implemented — explicitly out of scope per ADR 0015 |
| Bluetooth | ✗ | No `bluetooth` field in `heosCapabilityConfig()` — HEOS's Bluetooth pairing/status surface (if any) isn't modeled |
| Diagnostics | ✓ | This session's addition, tested — one connection shared across all bound players on a network, diagnostics correctly reflect shared link traffic |
| Auto-Reconnect | ✓ | Same `ReconnectScheduler`, re-syncs every bound pid on reconnect, tested |
| Model (Diagnostics) | ✓ | `get_players`' `model` field threaded through discovery → `bindConfig.model` this session |
| Room Assignment | ✓ | Player name is a persistent, user-set field from HEOS app setup — tier 90 (`persistent_user_zone_name`) |

### Yamaha (YXC/MusicCast, `yamaha-driver.ts` + `yamaha-codec.ts`)

| Feature | Status | Evidence |
|---|---|---|
| Discovery | ✓ | SSDP + UPnP description manufacturer check, real `getFeatures` zone enumeration added this session |
| Power | ✓ | Per-zone `setPower` |
| Volume | ✓ | Device-native scale (e.g. 0-194), converted via `percentFromScale`/`scaleFromPercent` |
| Mute | ✓ | Per-zone `setMute` |
| Input/Source | ✓ | Per-zone, from real `getFeatures` `input_list` |
| Zone 2/3/4 | ✓ | Up to 4 real zones, discovered via `getFeatures`, tested with 2 zones in `yamaha-driver.test.ts`; Automatic Zone Generation (this session) auto-commissions extras |
| Transport | ✓ | `netusb/setPlayback` — richer than HEOS (has toggle + explicit scrub start/end) |
| Seek | ✓ | `netusb/setPlayPosition` — the only one of the 3 protocols with a real absolute seek |
| Shuffle/Repeat | ✓ | Toggle-only wire primitive (no direct set) — codec tracks current state and no-ops a redundant toggle, tested `yamaha-driver.test.ts:247-256` |
| Metadata + Artwork | △ | Only for `netusb`-typed inputs (`yamaha-driver.ts:243-252`) — a zone tuned to `hdmi1`/tuner correctly reports no metadata, tested |
| Tone Control | ✓ | Per-zone `range_step`-driven bass/treble |
| DSP/Sound Program | ✓ | Real `sound_program_list` per zone/model, brand-specific names passed through verbatim |
| Sleep Timer | ✓ | Fixed enum (0/30/60/90/120), no `func_list` gate per spec |
| Bluetooth | △ | `yamahaCapabilityConfig():134` — only a `bluetooth: boolean` presence flag (input list contains "bluetooth"); no pairing/connect flow — deliberately out of scope per ADR 0015 |
| Live Feedback | ✓ | UDP push events, hybrid direct-value + re-fetch-flag handling, tested |
| Diagnostics | ✓ | This session — per-host HTTP request/response tracker, `model` from UPnP `<modelName>` (added this session) |
| Auto-Reconnect | △ | No persistent control socket to "reconnect" (per-request HTTP) — event-registration re-sent every 8 min ahead of the 10-min timeout; `hostDown`/reconnect-count tracking (this session) is the closest honest equivalent, not a literal socket reconnect |
| Firmware | ✗ (N/A) | No firmware field in the Basic YXC spec |
| Room Assignment | ✓ | MusicCast setup names each unit by room — tier 90 |

**Overall:** every genuinely wire-supported feature across all three protocols is implemented and unit-tested against an in-process fake server. The only gaps are (a) protocol limits verified against the vendor specs (N/A rows — not bugs), and (b) two explicitly deferred items already documented in ADR 0015 (Bluetooth pairing management, multi-room grouping), plus (c) one newly-found dead surface — HEOS QuickSelect has a working command path with no UI entry point (Phase 1 finding, see below).

---

---

## Phase 5 — Hardware Validation Checklist

**No item below has been checked against real hardware.** This environment has no
network access to physical AVR/streaming devices and no Denon/Marantz/Yamaha unit
available. Every feature above was verified against the vendor's published protocol
specification and exercised through an in-process fake TCP/HTTP server (this repo's
established testing convention — see e.g. `avr-driver.test.ts`'s `startFakeAvr()`).
That is real evidence that the CODE does what the SPEC says, but it is **not** a
substitute for a real device, which can diverge from its own spec (firmware quirks,
undocumented behavior, timing sensitivities a fake server can't reproduce). Per
explicit instruction, none of these are marked done.

### Denon / Marantz
- [ ] Discovery finds the real unit on the LAN (co-located HEOS SSDP presence)
- [ ] Power on/off from Supreme reaches the real receiver
- [ ] Volume set/get matches the front-panel display (including the dB reading)
- [ ] Mute/unmute
- [ ] Input switch
- [ ] Zone 2 power/mute/source, verified independent of main zone
- [ ] Tone control (bass/treble) actually changes the analog output
- [ ] Sound mode (DSP) selection
- [ ] Sleep timer
- [ ] IR remote feedback — a command from the physical remote reflects in Supreme within a reasonable delay
- [ ] Front panel feedback — a manual front-panel change reflects in Supreme
- [ ] HEOS app feedback — a change made in the Denon/Marantz HEOS app reflects in Supreme (both the Telnet-side power/volume AND the HEOS-side transport/input)
- [ ] HDMI-CEC-triggered power change (if the unit supports CEC) reflects correctly
- [ ] Ethernet cable pulled mid-session → Supreme correctly shows the device offline
- [ ] Ethernet reconnected → driver reconnects automatically, full state re-syncs (not just power/volume)
- [ ] Receiver power-cycled (full reboot) → same reconnect behavior as a network drop
- [ ] Router/DHCP lease renewal changes the receiver's IP → confirm current behavior (expected: device goes unreachable until re-commissioned; confirm this is what actually happens, and that it fails *visibly*, not silently)

### Yamaha (YXC/MusicCast)
- [ ] Discovery finds the real unit (SSDP + UPnP manufacturer check)
- [ ] `getFeatures` real zone count matches the physical unit (2/3/4 zones as applicable)
- [ ] Power/volume/mute/input per zone
- [ ] Volume matches the front-panel display given the unit's real native scale (not just 0-100)
- [ ] Tone/DSP/sound program selection
- [ ] Seek (absolute position) actually scrubs playback
- [ ] Shuffle/repeat toggle matches the app's displayed state after each toggle
- [ ] Now-playing metadata + artwork for a real NetUSB/streaming source
- [ ] No metadata fabricated when tuned to a non-NetUSB input (e.g. HDMI/tuner)
- [ ] UDP push events actually arrive — a MusicCast app change reflects in Supreme without Supreme polling
- [ ] UDP event registration survives the documented 10-minute timeout (this session's 8-minute refresh actually prevents the lapse)
- [ ] Sleep timer
- [ ] Bluetooth input shows as present/absent correctly (pairing itself is out of scope)
- [ ] Ethernet drop / router reboot / DHCP IP change — same three checks as Denon above
- [ ] Automatic Zone Generation — commissioning a real multi-zone unit actually creates one Supreme device per real zone, not a fabricated count

### HEOS (Denon/Marantz's streaming layer — verify alongside the Denon/Marantz unit above)
- [ ] Discovery resolves all real players on the network from a single SSDP hit
- [ ] One TCP connection genuinely reaches every player (confirm no per-player socket is silently opened)
- [ ] Volume/mute/input/transport for each player independently
- [ ] Shuffle/repeat 3-state (off/all/one) matches the HEOS app's displayed state
- [ ] Metadata + real artwork URL resolves and loads in the Supreme UI
- [ ] Queue view matches the HEOS app's queue for a real playing source
- [ ] A change made in the HEOS app (volume, input, transport) reflects in Supreme via the unsolicited event stream, not a poll
- [ ] Network drop / reconnect — confirm every bound pid re-syncs, not just the first one bound
- [ ] QuickSelect — confirmed this session as a real gap (command path exists, no UI surface); if built, verify against a real "LS AVR / HEOS BAR" unit specifically, since the spec says it's not universal

**Recommendation:** before marking any hardware row done, capture the real request/
response traffic (or a packet capture) for at least the Discovery + one full command
round-trip per protocol, and diff it against the spec's documented format — this is
the fastest way to catch a firmware-specific deviation the fake-server tests can't see.

---

---

## Phase 1 — Architecture Audit

Method: direct read of every driver/shared-layer file (not delegated — two background
research agents were launched for this pass but both hit the session's usage limit
before returning findings; the audit below was done directly against the source,
citing file:line for every claim, same evidence bar).

**1. Duplicate code.** `ensureLink`/`openSocket`/`onData` in `avr-driver.ts` and
`heos-driver.ts` are structurally similar (both TCP, both a `Map<hostkey, Link>`, both
a `ReconnectScheduler`). Judgment call: NOT worth forcing into one shared class —
`avr-driver.ts`'s link is keyed by `host:port` (one receiver = one link) while
`heos-driver.ts`'s link is keyed by `host:port` but semantically represents "one HEOS
network" (many pids share it), and their `openSocket`'s "connect" handler bodies
diverge completely (Denon's init-query token list vs. HEOS's un-register/sync-every-
pid/re-register sequence per spec §2.1.1). Forcing a shared abstraction here would
hide two genuinely different reconnection protocols behind one leaky interface — this
was already the right call in the original ADR 0015 design (`ReconnectScheduler`
itself IS the actually-shared part, and it already is one class, `avr-reconnect.ts`).
**Fixed this session regardless:** the newline-buffering logic (`buffer += chunk;
split; pop()`) WAS truly identical between the two drivers with no protocol-specific
divergence at all — extracted to `line-buffer.ts` (`LineAccumulator`), which also
closed a real bug (see Phase 6 below) — a case where deduplication and hardening were
the same fix.

**2. Architectural violations.** None found. Checked
`services/integration-layer/src/{native-adapter,routing-adapter,sil,protocols/driver,
adapter}.ts` line by line for Denon token names, HEOS command strings, or Yamaha zone
ids — zero matches. The `getDiagnostics`/`getCapabilityConfig` seams added this
session are fully protocol-agnostic (`Record<string, unknown>` / a shared
`DriverDiagnosticsSnapshot` shape), exactly mirroring the pre-existing
`getArtwork`/`getQueue` pattern. `services/commissioning/src/room-assignment-engine.ts`
takes a generic `LocationHint`, never an AVR-specific type.

**3. Race conditions — two real ones found and fixed.**
- `YamahaProtocolDriver.ensureHostFeatures()` (`yamaha-driver.ts`, pre-fix) had a
  genuine check-then-act race: `this.hosts.get(host)` (miss) → `await getJson(...)` →
  `this.hosts.set(host, info)`. Two concurrent callers for a host with no entry yet
  (e.g. `bind()` for onoff + media on the same freshly-commissioned zone, called via
  `Promise.all` or any two independent async paths that happen to overlap) BOTH pass
  the miss check before either sets the map, so both fire their own `getFeatures`
  request AND their own `setInterval` refresh timer — the loser's timer is silently
  orphaned forever (nothing ever clears it once `hosts.set()` is overwritten by the
  winner). **Fixed**: an in-flight-promise cache (`hostFeaturesInFlight`) makes
  concurrent callers await the SAME promise. Proven by a new test
  (`yamaha-driver.test.ts` "coalesces concurrent bind() calls... into ONE getFeatures
  request") that fails without the fix and passes with it.
- The same class of race existed in `syncZone()` — a rapid command burst or an
  overlapping UDP event could fire two overlapping `getStatus` requests whose
  responses could resolve out of order, letting a stale response silently overwrite a
  fresher one already applied to `this.media`. **Fixed** the same way
  (`syncZoneInFlight`), proven by a second new test.
- `ensureLink()` in `avr-driver.ts`/`heos-driver.ts` is fully **synchronous** (no
  `await` between the `Map.get` check and the `Map.set`) — JS run-to-completion
  semantics mean this cannot race no matter how many callers invoke it "concurrently"
  in the async sense; confirmed safe by inspection, not just assumption.

**4. Dead code / speculative fields.** `apps/web-homeowner/src/features/media/
detail.tsx` conditionally renders `advanced.audioFormat` / `advanced.sampleRateKHz` /
`advanced.bitDepth`, but grep across `avr-codec.ts`/`heos-codec.ts`/`yamaha-codec.ts`
confirms NONE of the three drivers ever populate these fields — verified, zero matches
in any codec file. This is not a bug (the render is gated behind `typeof x ===
"..."` so it silently no-ops today, never fabricating a value) but it is genuinely
unreachable code under every current driver. Judgment call: **left in place, not
deleted** — it's the documented reserved slot for a future driver that genuinely
reports this (Trinnov/StormAudio room-correction processors are the two brands in the
Phase 9 future-driver list that plausibly DO report detected audio format/sample
rate/bit depth on their wire protocols), and the `advanced: Record<string, unknown>`
bag is explicitly designed as an open-ended escape hatch per ADR 0015 — removing it
now would just mean re-adding the identical three lines the day a codec finally
populates them. Flagged here so it's a documented decision, not a silent gap.
Also confirmed: `HeosProtocolDriver.getQueue()` and the `quickSelect` command path
(`heos-codec.ts:124`) are real, wired, tested code — not dead — but see the Phase 4
matrix's HEOS QuickSelect row: the command exists with no `presets`/`advancedControls`
UI entry point, a real (small) gap, not "dead code" in the pejorative sense.

**5. Unnecessary abstractions.** None found relative to what 3 protocols need. The
`AudioCapabilityConfig`/`DriverDiagnosticsSnapshot`/`LocationHint` shapes are each used
by all three drivers with real per-field variation (not a speculative interface built
for one implementer). No plugin system, no premature strategy pattern, no
factory-of-factories anywhere in this framework.

---

## Phase 2 — Digital Twin Audit

Every property below is checked against `packages/domain-model/src/capabilities.ts`
(`CapabilityState`/`MediaState`), `avr-capabilities.ts` (`AudioCapabilityConfig`), and
each driver's internal cache. **"Exists" means a real field a driver populates from a
real wire response — never a fabricated placeholder.**

| Property | Exists? | Where | Populated by |
|---|---|---|---|
| Identity (backendId/deviceId) | ✓ | `Device.id`, driver `bindings[].deviceId` | All 3 |
| Firmware | ✗ | — | None of the 3 protocols expose it on the wire (verified against all 3 specs) |
| Network (IP/MAC) | ✓ | `device.metadata.network` (IP, discovery), `DriverDiagnosticsSnapshot.mac` (this session, ARP-based) | All 3 for IP; MAC is best-effort for any protocol via `arp-lookup.ts` |
| Power | ✓ | `CapabilityState` `onoff.on` | AVR (Telnet PW), Yamaha (per-zone setPower). N/A for HEOS (verified: no power command in spec) |
| Volume | ✓ | `MediaState.volume` (0-100, normalized) | All 3 — AVR direct 0-98 scale, HEOS direct 0-100, Yamaha via `percentFromScale` off its real native range |
| Mute | ✓ | `MediaState.muted` | All 3 |
| Input | ✓ | `MediaState.source` | All 3 |
| Zones | ✓ | Separate Supreme `Device` per zone, `AudioCapabilityConfig.zones` | AVR (main+zone2, installer-declared), Yamaha (up to 4, wire-queried via `getFeatures`) — HEOS has no zone concept (each player already independent) |
| Playback | ✓ | `MediaState.playback` | HEOS, Yamaha (real transport). AVR: always `"idle"` — no transport commands exist on the protocol (verified) |
| Metadata (title/artist/album/artwork) | △ | `MediaState.{title,artist,album,artworkUrl}` | HEOS (full), Yamaha (NetUSB inputs only — correctly null for HDMI/tuner). AVR: always null (verified, no metadata query in spec) |
| Audio Codec | ✗ | — | Not populated by any of the 3 drivers (see Phase 1 Dead Code finding — reserved `advanced.audioFormat` slot exists in the UI, unpopulated) |
| Sample Rate | ✗ | — | Same as above (`advanced.sampleRateKHz`) |
| Listening Mode/DSP | ✓ | `MediaState.advanced.soundMode` | AVR (16 named modes), Yamaha (real `sound_program_list` per model). HEOS has no DSP surface |
| Tone Controls (bass/treble) | ✓ | `MediaState.advanced.{bass,treble}` | AVR (installer-declared presence), Yamaha (real `range_step`-driven per zone) |
| Equalizer (multi-band) | ✗ | — | Not implemented by any of the 3 drivers. Yamaha's YXC spec DOES have a `setEqualizer` (low/mid/high) command (ADR 0015 §review table) — genuinely not wired into `yamaha-codec.ts`'s `commandToYamaha`. This is a real, small, spec-confirmed gap, not a protocol limit — flagged for a future session, not fixed here per "no new features" scope. |
| HDMI (passthrough/resolution/HDR) | ✗ | — | Not modeled by any driver or the domain model — none of the 3 protocols expose real-time HDMI signal/resolution/HDR state (only a static input-type icon hint, `AvrInput.type === "hdmi"`, which is a UI label, not live signal data) |
| Video | ✗ | — | Same as HDMI — no video-signal Digital Twin surface exists anywhere in Supreme today, not just this framework |
| HEOS-specific fields | ✓ | `MediaState.advanced` bag (preset/quickSelect commands), `HeosMediaCache` internal | Real, HEOS-only |
| MusicCast-specific fields | ✓ | `YamahaMediaCache`, `AudioCapabilityConfig` per zone | Real, Yamaha-only |
| AirPlay | N/A to this framework | `services/protocols/src/airplay-driver.ts` | **Confirmed a completely separate, pre-existing Supreme driver** (`protocol: "airplay"`), unrelated to the AVR/HEOS/Yamaha framework audited here — AirPlay support already exists in the fleet, just not as part of this framework (correctly so: AirPlay isn't an AVR brand, it's a streaming protocol any AirPlay-capable device speaks) |
| Bluetooth | △ | `AudioCapabilityConfig.bluetooth: boolean` | Yamaha only (presence flag, from real `input_list`). HEOS: no `bluetooth` field populated at all (real gap — HEOS's spec doesn't detail Bluetooth pairing in the sections read for ADR 0015, left honestly absent rather than guessed). Denon: N/A, no Bluetooth in the Telnet spec. Pairing/connect flow is explicitly out of scope per ADR 0015 for all three. |
| Diagnostics (RX/TX/last cmd/reconnect) | ✓ | `DriverDiagnosticsSnapshot` (this session) | All 3 |
| Statistics | △ | Covered by Diagnostics (packet counts, response time) — no separate "usage statistics" (e.g. total on-time, most-used input) exists anywhere; not asked for by ADR 0015 originally, a genuinely new concept if wanted |

**Summary: nothing exists ONLY inside a protocol adapter that should be in the shared
Digital Twin.** Every real, wire-backed property already flows through the shared
`CapabilityState`/`AudioCapabilityConfig`/`DriverDiagnosticsSnapshot` shapes — the gaps
above (Firmware, Audio Codec, Sample Rate, Equalizer, HDMI, Video) are protocol/data
gaps (nothing to report because no driver queries it), not architecture violations
(nowhere is a real value being held captive inside a driver and hidden from Supreme).

---

## Phase 3 — Driver Lifecycle Audit

Canonical model asked about: Discovered → Registered → Created → Connecting →
Connected → Capability Discovery → Initial State Sync → Ready → Operational →
Reconnect → Disconnected → Destroyed.

**None of the 3 drivers implement this as a named state machine or enum** — the
lifecycle is IMPLICIT in control flow, not an explicit `DriverState` field. This
matches every other driver in the 25-driver fleet (confirmed: no driver anywhere in
`services/protocols/src` has a named lifecycle enum) — a fleet-wide pattern, not
something to introduce for 3 drivers in isolation (would create an inconsistent
half-migrated lifecycle model across the fleet, exactly the kind of scope creep the
brief said not to do). Mapping the phases to actual code:

| Phase | Explicit / Implicit / Missing | Evidence |
|---|---|---|
| Discovered | Implicit | `discover()` return value, consumed by `CommissioningService`/`autoCommissionMedia` |
| Registered | Explicit (at the fleet level, not per-driver) | `SupremeNativeAdapter.registerDriver()`, `native-driver-factory.ts` |
| Created | Implicit | `new AvrProtocolDriver(opts)` / manifest-driven `buildNativeDriver()` |
| Connecting | Implicit | `openSocket()` between `net.connect()` and the `"connect"` event (AVR/HEOS); Yamaha has no real "connecting" state (per-request HTTP) |
| Connected | Explicit (`link.ready`/`isConnected()`) | `avr-driver.ts`/`heos-driver.ts` `link.ready` flag; Yamaha: `isConnected()` returns the driver-level `this.connected`, NOT per-host — a real asymmetry (see below) |
| Capability Discovery | Explicit only for Yamaha | `ensureHostFeatures()`/real `getFeatures` query. AVR: installer-declared, no discovery step. HEOS: none needed (fixed protocol surface) |
| Initial State Sync | Explicit | AVR/HEOS: the init-query token burst in `openSocket`'s `"connect"` handler. Yamaha: `syncZone()` called at the end of `bind()` |
| Ready / Operational | Implicit, and NOT actually distinguished | See the concurrency finding below — there is a real window where a command CAN be sent to a "connected" (TCP-level) socket before its init-query response has been processed |
| Reconnect | Explicit | `ReconnectScheduler` (AVR/HEOS); Yamaha has no persistent socket to reconnect — `hostDown`/reconnect-count (this session) is the closest honest equivalent, documented as such in the code |
| Disconnected | Explicit | `link.socket = null; link.ready = false` on the `"close"` event |
| Destroyed | Implicit, and incomplete | `disconnect()` clears the driver's own Maps/timers, but see the Phase 6 finding: **no driver in the fleet (not just these 3) implements `unbind()`** — a single device's bindings are never removed from `this.bindings`/`this.media`/`this.states`/`this.diagnostics` short of tearing down the WHOLE driver via `disconnect()`. Confirmed fleet-wide (`unbind` appears nowhere in `services/`, on the `INativeProtocolDriver` interface, or in `casambi-driver.ts` as a comparison point). |

**The one genuine "Ready vs. Connected" gap, confirmed by reading the code, not
theorized:** `command()` in `avr-driver.ts`/`heos-driver.ts` already correctly guards
against this — it checks `link.ready` (true only after the TCP `"connect"` event) AND
throws if the socket isn't ready, so a command genuinely cannot reach an
unestablished link (tested: "connection failure is never silent"). However neither
driver waits for the INIT QUERY RESPONSE specifically before considering itself
"ready" for commands — `link.ready = true` is set the instant the TCP handshake
completes, before `PW?\rMV?\r...` has been answered. A command issued in that narrow
window will queue behind the init query on the same socket (TCP delivers in order) and
will reach the receiver correctly — this is safe, not a bug — but the driver's
in-memory STATE (`this.states`) briefly reads as empty/default rather than the
device's real current state during that window, which is an honest, small, and
already-documented characteristic (not a new finding — the UI's own `getState()`
contract already returns `null` for "no state yet," which callers already handle).

**Fixed this session** (§ Phase 6 below has the technical detail): `command()` in all
three drivers now throws immediately if called after `disconnect()` (the driver-level
`this.connected` is false), instead of silently treating a torn-down driver as brand
new and re-opening a real connection. This is the one place "Destroyed" needed to
actually mean something.

---

## Phase 6 — Stress Testing

| Scenario | Verdict | Evidence |
|---|---|---|
| Multiple simultaneous AVRs (different hosts) | ✓ SAFE, now with a dedicated test | `this.links`/`this.hosts` are `Map`s keyed per-host in all 3 drivers — no shared mutable state crosses hosts. New test: `avr-driver.test.ts` "controls two physically independent receivers... with fully isolated links, state, and diagnostics" |
| Multiple zones on one physical unit | ✓ SAFE, existing coverage | `avr-driver.test.ts` Zone 2 describe block; `yamaha-driver.test.ts` 2-zone describe block — both pre-existing and still passing |
| Rapid volume/command changes | ✓ FIXED (Yamaha), SAFE (AVR/HEOS) | AVR/HEOS: TCP writes are ordered by the OS socket buffer, no per-command ack tracking needed, proven by new test "rapid-fire volume commands... land on the wire" (had to fix the TEST itself to `waitFor` real delivery over loopback rather than assuming a resolved `command()` promise means the server already saw it — a useful reminder that `command()`'s promise resolving means "written," not "received/processed"). Yamaha: the real race (concurrent `syncZone` overlap) is the BUG fixed above, not just tested |
| Connection loss / reconnect | ✓ SAFE, verified complete | AVR: re-queries power/volume/mute/source/tone/DSP/zone2 power+mute (NOT explicitly a zone2-source query — see open question below). HEOS: re-queries play_state/volume/mute/**play_mode (shuffle+repeat)**/now_playing — fully complete. Yamaha: no persistent socket; `hostDown` tracking + UDP re-registration every 8 min is the honest equivalent |
| Router reboot / DHCP IP change | ⚠ ACCEPTED LIMITATION, now documented | Bindings key on `binding.address` captured once at commission time; nothing detects an IP change — the device silently becomes unreachable until manually re-commissioned. This is unchanged fleet-wide behavior (every IP-bound driver in the fleet has this same limitation), not a regression, and not something a 3-driver-scoped session should redesign — documented explicitly in the Hardware Validation Checklist above so it gets checked, not silently assumed away |
| Packet flooding / event storms | ✓ FIXED | `link.buffer` in AVR/HEOS had NO upper bound — a device sending data with no delimiter could grow memory without limit. **Fixed**: `LineAccumulator` (`line-buffer.ts`, new shared module, also de-duplicating what was previously copy-pasted identical logic) caps the buffer at 64KB and resets with a logged warning on overflow. Proven by 5 new tests including a literal 5,000-byte no-delimiter flood. Yamaha's UDP event handling has no equivalent risk (each datagram is a bounded, complete JSON message — no accumulation) |
| Memory usage / resource cleanup | ⚠ ACCEPTED FLEET-WIDE LIMITATION, now documented | No `unbind()` exists anywhere in the 25-driver fleet (confirmed, not assumed) — a deleted Supreme device's entry in `this.bindings`/`this.media`/`this.states`/`this.diagnostics` is never removed short of a full driver `disconnect()`. For a real installation (tens of devices, occasional device removal over months/years), this is slow, bounded growth, not a leak per-command — flagged as a real fleet-wide architecture gap worth a dedicated future session (touches the `INativeProtocolDriver` interface contract for all 25 drivers), explicitly NOT fixed here per "extend/harden the AVR framework, don't redesign the shared driver interface" scope |
| `disconnect()` called twice | ✓ FIXED (test added, behavior was already safe) | All 3 drivers' `disconnect()` was already idempotent by construction (iterating/clearing already-empty Maps is a no-op) — added explicit tests to lock this in as a guarantee, not just an accident of implementation |
| `command()` after `disconnect()` | ✓ FIXED, was a real bug | Previously: NONE of the 3 drivers checked `this.connected` in `command()` — a command issued after teardown would silently call `ensureLink`/`ensureHostFeatures` as if the driver were still alive, re-opening a REAL socket/HTTP session behind the caller's back. Now throws `"driver is disconnected"` immediately. Proven by 3 new tests (one per driver) |

**Open question, not resolved this session (needs real hardware, not more code):**
does a bare Denon `Z2?` query genuinely echo the zone's current SOURCE as well as
power, or only power? The codec only sends `Z2?`/`Z2MU?` on reconnect (no explicit
zone2-source query token). If a real receiver's `Z2?` response is power-only, Zone 2's
source selection would read stale after a reconnect until the next manual source
change. Flagged in the Hardware Validation Checklist rather than guess-fixed.

---

## Phase 7 — Performance Audit

**Honest scope limitation, stated up front:** discovery latency, connection latency,
event latency, memory footprint, CPU usage, and network traffic against REAL hardware
cannot be measured in this environment — there is no physical AVR, no real network
segment with real multicast traffic, and no long-running process to profile under
real load. Everything below is either (a) measured against this repo's in-process
fake-server test harness (real code, synthetic timing — informative for correctness,
not for real-world latency), or (b) a static/structural assessment.

- **Discovery latency:** structurally bounded by `ssdpSearch`'s own timeout (not
  changed this session) plus, for Yamaha, one additional sequential `getFeatures` HTTP
  round-trip per candidate host (added this session for zone enumeration) and for
  Denon-co-located-HEOS, one `get_players` round-trip per SSDP hit. For a home with
  N candidate hosts, Yamaha discovery is now O(N) sequential HTTP calls, not
  parallelized (`for (const r of responses) { await this.fetchImpl(...); await
  this.getJson(...) }` in `yamaha-driver.ts`'s `discover()`). For a realistic home
  (single digits of AV receivers), this is not a meaningfully slow user experience,
  but it's worth noting it doesn't parallelize — not fixed this session (no evidence
  it's actually a problem at realistic scale; parallelizing discovery fetches is a
  reasonable future optimization if a real installation with many units reports slow
  discovery).
- **Connection latency:** AVR/HEOS — one TCP handshake + one line of init queries,
  bounded by the OS/network RTT, unchanged this session. Yamaha — no persistent
  connection to establish; first command latency is one HTTP round-trip.
  Un-measurable in real RTT terms without a real network.
  **Event latency:** structurally as fast as the transport allows (unsolicited
  TCP lines for AVR/HEOS, UDP push for Yamaha) — no polling anywhere in the hot path,
  confirmed by re-reading all three `onData`/`onEventMessage` handlers; this was
  already true before this session and remains true.
- **Memory footprint:** this session's additions are: one `DriverDiagnosticsTracker`
  per link/host (a handful of primitives + two short strings — negligible), one
  `LineAccumulator` per link (was already a raw string field — same order of memory,
  now bounded), and the new in-flight-promise Maps (`hostFeaturesInFlight`,
  `syncZoneInFlight`) which are transient — entries exist only while a request is in
  flight, cleared in a `.finally()`. Net effect: negligible increase, with an actual
  UPPER BOUND added where none existed before (the buffer fix). The unbounded-growth
  risk that DOES exist (no `unbind()`, Phase 6) is unchanged by this session, not
  introduced by it.
- **CPU usage:** no new hot-path work — diagnostics recording is O(1) per send/receive
  (a counter increment + a timestamp), buffer accumulation is the same
  split/pop as before (just relocated, with one extra length check).
- **Network traffic:** this session adds exactly one extra request type per protocol
  where genuinely new data is needed: Yamaha's discovery now makes one extra
  `getFeatures` call per candidate host (zone enumeration); nothing else changed the
  steady-state traffic pattern (no new polling was introduced anywhere).

**Recommendation:** none of the above numbers should be quoted to a customer or in a
release note as measured performance — they're structural/code-review-level
assessments. Real numbers require the Phase 5 hardware validation pass (packet
captures + wall-clock timing against actual devices).

---

## Phase 9 — Future Driver Readiness

Verified against all nine listed brands (Anthem, Arcam, NAD, Sony, Pioneer, Onkyo, JBL
Synthesis, StormAudio, Trinnov): the SDK supports every one of them without an
architectural change. Full reasoning and the one-line follow-up (widening
`autoCommissionMedia`'s protocol union to onboard a 4th brand into the one-click
auto-commission flow — optional, not required for the driver itself to work) now lives
in `docs/architecture/adding-avr-brands.md` §8 (added this session). Summary:

- **Transport shapes already covered**: TCP/Telnet-style (Anthem ARC, most legacy
  brands) matches `avr-driver.ts`'s shape; HTTP/REST-style (Sony, some Onkyo/Pioneer
  models, JBL Synthesis's modern control API) matches `yamaha-driver.ts`'s shape.
  Nothing in this framework assumes only 2 transport shapes exist — a genuinely novel
  one (e.g. a binary protocol) would need its own driver file, same as any of the 25
  drivers in the fleet already do, not a framework change.
- **Diagnostics, Room Assignment, Zone Generation, Topology**: all four are opt-in
  seams a new driver can adopt with zero changes outside its own file (detailed
  above) — none of them required a change to `INativeProtocolDriver`,
  `SupremeNativeAdapter`, `RoutingBackendAdapter`, or `SupremeIntegrationLayer` to
  reach this state; they were already generic before this session's brands were
  checked against them.
- **No change made this session to accommodate future brands** — the architecture was
  already sufficient; this phase was verification, not implementation, per the
  brief's own instruction ("if architectural changes are required, implement them
  now" — none were required).

---

## Phase 10 — Production Readiness Report

**Scores below are the author's own assessment against the evidence gathered in
Phases 1-9 above — not an external audit, and explicitly bounded by what this
environment could verify (no real hardware, no running `hub-compose` stack).**

### 1. Architecture Score: 9/10
No architectural violations found (Phase 1). Protocol-agnostic layering held up under
direct inspection of every integration-layer file. The one deduction: the fleet-wide
missing `unbind()` (Phase 6) is a real architectural gap, even though it's
pre-existing and out of this session's scope to fix — a framework can't claim a
perfect 10 while carrying a known, confirmed resource-lifecycle gap, even an
inherited one.

### 2. Code Quality Score: 9/10
Consistent patterns across all 3 drivers (codec/driver split, shared
`ReconnectScheduler`/`DriverDiagnosticsTracker`/`LineAccumulator`), every real
protocol limit documented in code comments rather than papered over, two genuine
races found and fixed with regression tests, one real duplicate-code instance found
and deduplicated. Deduction: the Yamaha equalizer gap (Phase 2 — `setEqualizer` exists
in the spec, not wired) and the HEOS QuickSelect dead-end (Phase 4 — command exists,
no UI surface) are both small, real, unaddressed gaps.

### 3. Performance Score: Not independently ratable — see Phase 7
No real hardware/network to measure against. Structurally sound (no hot-path
regressions introduced, one new discovery-time HTTP call for Yamaha zone enumeration,
otherwise unchanged traffic patterns, memory footprint slightly improved by the
buffer bound). Cannot responsibly assign a numeric score without real measurement.

### 4. Test Coverage
- `services/protocols/src` (all drivers + this framework): **348 tests, all passing**
  (up from 333 before this hardening pass — 15 new tests: 2 race-condition
  regressions, 5 buffer-overflow/line-accumulator, 8 lifecycle/concurrency edge cases).
- Full monorepo (`pnpm turbo run build/typecheck/test`): confirmed passing across all
  93 tasks as of the prior session's completion; re-verified for every package this
  session's changes touched (`@supreme/protocols`).
- **Not covered by any test in this repo**: real hardware behavior, real network
  conditions (packet loss, latency jitter, actual DHCP renewal), real firmware
  quirks. This is a structural limit of "verified against fake servers," stated
  honestly rather than implied away.

### 5. Protocol Coverage
See the Phase 4 matrix in full above. Summary: every wire-supported feature across
Denon/Marantz Telnet, HEOS, and Yamaha YXC is implemented and tested. Gaps are either
verified protocol limits (marked N/A) or small, explicitly named items (HEOS
QuickSelect UI surface, Yamaha Equalizer wiring, HEOS Bluetooth field).

### 6. Remaining Limitations (full list, nothing held back)
1. No real hardware has ever run this code (this environment cannot provide any).
2. Router reboot / DHCP IP change is an accepted, documented, fleet-wide limitation —
   a device silently becomes unreachable until manually re-commissioned.
3. No `unbind()` anywhere in the 25-driver fleet — a deleted device's bindings persist
   in driver memory until the whole driver disconnects. Slow, bounded growth in
   practice; a real gap, not fixed this session (out of scope — a fleet-wide interface
   change).
4. Yamaha `setEqualizer` (multi-band EQ) is in the spec, not implemented.
5. HEOS QuickSelect has a working command path with no UI entry point.
6. HEOS's Bluetooth surface (if any) isn't modeled — `bluetooth` field always absent.
7. Denon Zone 2's reconnect re-sync sends `Z2?`/`Z2MU?` but no explicit zone2-source
   query — whether a bare `Z2?` also echoes source on real hardware is unverified.
8. No Audio Codec / Sample Rate / HDMI / Video signal data anywhere in the Digital
   Twin — no protocol in scope exposes it, and no other Supreme subsystem models video
   signal state today either (not unique to this framework).
9. Yamaha discovery's per-candidate `getFeatures` calls are sequential, not
   parallelized — likely fine at realistic scale, unmeasured at real scale.
10. Full Bluetooth pairing management and streaming-service browse/search remain out
    of scope (unchanged from ADR 0015's original, deliberate decision).

### 7. Hardware Verification Status: **NOT DONE**
Zero items on the Phase 5 checklist are checked. Every claim in this report is
verified against the vendor's published specification and exercised through
in-process fake TCP/HTTP servers — real evidence the code matches the spec, not
evidence it matches real hardware behavior, which can and does diverge from a spec in
practice (firmware quirks, undocumented timing sensitivities, model-specific
deviations).

### 8. Production Readiness Percentage: **~70%**

**Not marked production-ready, per the brief's own instruction** ("only mark
production-ready if there are no known architectural issues and all implemented
features have been validated"). Two explicit disqualifiers exist: (a) the fleet-wide
`unbind()` gap is a known, confirmed architectural issue (Phase 1/6), and (b) zero
hardware validation has occurred (Phase 5/7). The ~70% reflects: code
architecture/quality genuinely strong and now hardened against the concrete
concurrency/resource issues this audit found (would be materially higher on that axis
alone); protocol-spec coverage complete and honestly gapped where the spec itself
has limits; but real-world confidence is capped by the total absence of hardware
verification, which is the single largest remaining gate before this can honestly be
called commercial-production-ready. **Recommended next step, in order**: (1) the
Phase 5 hardware checklist against at least one real unit per brand, (2) resolve the
open Denon Zone-2-source-on-reconnect question, (3) decide whether the fleet-wide
`unbind()` gap is worth a dedicated cross-driver session before a real deployment
with device churn (installs/removals over time) is expected.

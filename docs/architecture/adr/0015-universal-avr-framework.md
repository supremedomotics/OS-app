# ADR 0015 — Universal AVR Framework (Denon/Marantz, HEOS, Yamaha)

- Status: **Accepted**
- Date: 2026-07-10
- Context: `docs/architecture/avr-framework-review.md` (Phase 1 architecture review);
  ADR 0001 (SIL / native protocol driver seam). Invariant **I1**: the hub works fully
  offline — every driver here is local IP control, no cloud dependency.

## Context

The brief: real, production-grade multi-brand AVR/streaming control — Denon/Marantz
(classic Telnet + HEOS), Yamaha (Extended Control/MusicCast) — with multiple
independent receivers across a home, each with its own connection/state/zones/
capabilities, **never** hardcoding a brand's model capabilities into the UI. Reuse the
existing `INativeProtocolDriver` seam (ADR 0001) rather than inventing a parallel
media stack.

Three real, protocol-verified facts shaped the design (verified against the attached
Denon AVR Telnet spec v8.6.0, HEOS CLI spec v1.17, and Yamaha Extended Control API
spec v1.10 — nothing below is assumed):

1. **Dynamic capability detection is not equally possible everywhere.** Yamaha's
   `/system/getFeatures` genuinely enumerates a device's zones, inputs, sound
   programs, and volume/tone ranges on the wire. HEOS's core surface is
   protocol-uniform (same fixed input enum on every unit) — nothing to detect.
   Classic Denon/Marantz Telnet has **no feature-query command at all** (verified: none
   exists in the spec) — a unit's zone/tone-control presence is not a wire-discoverable
   fact.
2. **HEOS and YXC/MusicCast are each ONE protocol, not several.** An early plan treated
   YXC and MusicCast as separate drivers; YXC's own spec Preface states it controls
   "MusicCast enabled devices" — they're the same wire protocol.
3. **HEOS has no power command; Yamaha has a real seek but only toggle-based
   repeat/shuffle; HEOS has no seek at all.** Each of these was verified by its absence
   from the respective spec, not inferred.

## Decision

### Capability model: additive, not brand-specific

`MediaState`/`CapabilityCommand` (media) gained `durationSec`, `positionSec`,
`shuffle`, `repeat`, and one generic `advanced: record<string, unknown>` escape hatch
— every brand-specific DSP/tone/sound-program parameter (Denon's `soundMode`, Yamaha's
`soundProgram`+`bass`/`treble`, HEOS's `preset`/`quickSelect`) lives there under its
own native key, never folded into a shared cross-brand enum. `ProtocolKind` gained
`avr` | `heos` | `yamaha`. Both changes are purely additive — every existing driver,
route, and test kept working unmodified.

### One shared `AudioCapabilityConfig` (`avr-capabilities.ts`)

The `DeviceCapability.config` shape every AVR/media driver publishes: inputs, sound
modes, volume/tone ranges, zones, transport support, presets, bluetooth. Carries a
`source: "device_reported" | "installer_declared"` tag so the Installer/Developer UI
reads honestly — Yamaha and HEOS populate this from a real wire query; Denon Telnet's
comes from installer-set binding config, because the protocol has nothing to query. A
single generic UI component renders this shape regardless of which driver produced it
— **no brand's input list or DSP vocabulary is ever hardcoded in the client.**

### One shared `ReconnectScheduler` (`avr-reconnect.ts`)

Capped exponential backoff (reset on success, stopped on driver teardown), extracted
from the pattern already proven in the Casambi driver so `AvrProtocolDriver` and
`HeosProtocolDriver` share one implementation instead of two near-identical copies.

### Multiplexing pattern: many Supreme devices, one physical connection

Every driver here reuses the same shape the fleet already established for shared
links: a `ProtocolBinding.config` discriminator selects which logical unit a binding
targets, sharing one socket.

- **AvrProtocolDriver** — `config.zone: "main" | "zone2"` selects Denon Telnet's zone
  prefix (`Z2ON`/`Z2MU…`); Zone 2 becomes its own Supreme device on the same TCP link.
- **HeosProtocolDriver** — `config.pid` selects which HEOS player a binding addresses;
  this is the protocol's *own* topology (ONE TCP connection reaches every player on
  the network by pid), not a Supreme invention.
- **YamahaProtocolDriver** — `config.zone: "main" | "zone2" | "zone3" | "zone4"`
  selects which of a unit's up to 4 zones a binding targets, sharing one HTTP host +
  one shared UDP event listener.

### Real-time state: each protocol's actual push mechanism, not polling

- Denon/Marantz Telnet: unsolicited status tokens on the same socket (`PWON`, `MV55`,
  …) — driver sends an init query on connect, parses every echoed token.
- HEOS: `register_for_change_events` + unsolicited `event/*` JSON lines on the same
  socket; `get_queue` is correlated over that same multiplexed stream via the spec's
  own documented `sequence` argument (§2.1.3) rather than a fabricated request-id.
- Yamaha: HTTP GET commands + a UDP-unicast push channel registered via
  `X-AppName`/`X-AppPort` request headers (re-registered on a timer ahead of the
  spec's 10-minute timeout); hybrid payloads apply direct fields immediately and
  trigger a full re-fetch when their `status_updated`/`play_info_updated` flags
  require it.

### Artwork cache + queue endpoint

`gateway/artwork-cache.ts` is a small in-process LRU+TTL cache fronting
`SupremeIntegrationLayer.getArtwork` (existing seam) so now-playing polling doesn't
re-fetch the same image bytes every refresh; concurrent misses for one device share a
single in-flight fetch. A new, symmetric `getQueue` optional seam
(`IBackendAdapter`/`INativeProtocolDriver`, mirroring `getArtwork` exactly) backs a new
`GET /v1/devices/:id/media/queue` route — implemented only where a queue genuinely
exists on the wire (HEOS); Denon Telnet and Yamaha correctly return null/empty rather
than a fabricated queue.

## Consequences

- **No duplicated media stack.** Every new driver implements the same
  `INativeProtocolDriver` seam as KNX/DALI/Zigbee/etc.; no parallel "AVR engine" was
  built. `getArtwork`/`getQueue` are optional interface members exactly like the
  fleet's existing pattern, not a new abstraction.
- **Backward compatible.** `MediaState`/`CapabilityCommand`/`ProtocolKind` changes are
  additive; the pre-existing `AvrProtocolDriver` test suite (power/volume/media) passed
  unchanged through the zone/reconnect/tone rewrite, proving the extension didn't
  regress the original Denon/Marantz surface.
- **Honesty over polish.** Every protocol limit found during verification (no Denon
  feature-query command, no HEOS power command, no HEOS/Denon seek, toggle-only
  Yamaha repeat/shuffle) is preserved and commented in the code rather than
  papered over with a plausible-looking fake implementation.
- **Extension Center visibility (post-review correction):** an initial pass shipped
  AVR/HEOS/Yamaha as boolean env-gated only (the WiiM/Devialet/Sonos precedent),
  reasoning that manifests.ts was for single-host, credential-configured drivers. That
  precedent turned out to be a pre-existing product gap, not a pattern worth
  extending — the Extension Center is populated *entirely* from the manifest registry
  ("any current or future extension appears automatically"), so a driver with no
  manifest is invisible and un-installable from the UI, discoverable only by editing
  `.env`. Fixed: `supreme-avr`/`supreme-heos`/`supreme-yamaha` manifests were added
  with an **empty `configSchema`** (there's nothing global to set — each physical unit
  is still added by IP, and each Zone 2+/pid by `ProtocolBinding.config`, through Bus
  Binding after the extension is installed and enabled), plus matching
  `native-driver-factory.ts` entries. `SupremeNativeAdapter.registerDriver` replaces
  any same-protocol instance on register, so this coexists safely with the pre-existing
  env-wired `bootstrap.ts` path — exactly like KNX/MQTT/Modbus/Casambi already do.
- **Trade-off / follow-ups:** full Bluetooth-pairing management and browse/search
  (HEOS `browse/*`, Yamaha `netusb/getListInfo`) are out of scope — this framework
  covers the transport/zone/DSP/now-playing surface the brief asked for, not a full
  music-service browser. See `docs/architecture/adding-avr-brands.md` for how a future
  brand (Onkyo, Pioneer, Sony, Arcam, Anthem, NAD, JBL Synthesis, StormAudio, Trinnov)
  plugs into this same seam.

## Addendum (2026-07-19) — Universal AV Driver SDK: Diagnostics, Room Assignment, Zone
Generation, Topology

A follow-up brief asked for the remaining pieces of a formal "Universal AV Driver SDK":
a Diagnostics Console, automatic room/zone creation, and a Media Topology Engine. A gap
analysis (citing exact file:line evidence) confirmed the framework above already covers
Discovery/Capability Engine/Connection Recovery/Event Engine/multi-zone/manifests — this
addendum documents only the genuinely new work, and one deliberate policy change.

**Explicitly supersedes §2.3 of `docs/architecture/avr-framework-review.md`** ("AVR
discovery gives no reliable room signal, installer always assigns the room"). That was
correct for classic Denon Telnet specifically (still true — verified, no room concept
on the wire) but was applied as a blanket policy across every AVR/media protocol. The
new policy: a confidence-based **Room Assignment Engine**
(`services/commissioning/src/room-assignment-engine.ts`, generic — NOT AVR-specific,
intentionally reusable by any future protocol's live discovery) auto-creates/auto-assigns
a room when a driver supplies a trustworthy `LocationHint`, and only falls back to a
fixed "Unassigned Devices" room when it doesn't — never a silent guess, never a device
dropped. Three fixed confidence tiers: `explicit_attribute` (100, a real protocol room
attribute — none of AVR/HEOS/Yamaha have one today, but Matter's Room cluster or a KNX
ETS room would), `persistent_user_zone_name` (90 — HEOS player names, Yamaha MusicCast
zone names, both genuinely set by the homeowner/installer during that protocol's own
setup flow), `friendly_name_heuristic` (70 — a generic SSDP friendlyName, normalized by
stripping brand/category/zone noise words; below 70 after normalization is never
auto-applied). This is a **different, complementary** engine from
`services/commissioning/src/knx/room-assignment-engine.ts` (`assignRooms`), which
resolves rooms from a parsed ETS **project file's** tree — a different input shape for
a different job; that engine is untouched.

**Automatic Zone Generation** is honest, not uniform: Yamaha's `discover()` now also
queries `/system/getFeatures` per candidate (a genuine wire call, same as `bind()`
already made) and reports every real zone the unit has; `InstallerServices.
autoCommissionMedia()` (`services/gateway/src/installer-context.ts`, routed at
`POST /v1/commissioning/auto-media`) auto-creates a sibling Supreme device per extra
zone, sharing the same physical connection, in the same resolved room. Denon Telnet's
Zone 2 is **deliberately not auto-generated** — the protocol has no wire-level way to
detect it (unchanged fact from the original ADR), so it stays the documented manual
`hasZone2` declaration in `avr-codec.ts`. Auto-commissioning any protocol replays the
existing `CommissioningService`-adjacent dedup (`registry.reverseLookup`) so a repeat
run never re-commissions or re-expands an already-bound unit.

**Diagnostics Console**: a shared `DriverDiagnosticsTracker`
(`services/protocols/src/driver-diagnostics.ts`, generalized from the counter pattern
already proven in `knx-ultimate-provider.ts`) now backs an optional
`INativeProtocolDriver.getDiagnostics?(deviceId)`, plumbed through
`SupremeNativeAdapter`/`RoutingBackendAdapter`/`SupremeIntegrationLayer` exactly like
the existing `getCapabilityConfig` seam (fixing, in passing, a real pre-existing gap —
`RoutingBackendAdapter` never actually implemented `getCapabilityConfig`, so a
routed device's capability config silently never reached the UI; both are now
implemented together) and surfaced at `GET /v1/devices/:id/diagnostics` →
`DiagnosticsSection` in the web client. Every field (RX/TX packet counts, last
command/response + timestamps, response time, reconnect count, last error, model,
firmware, IP, MAC) is a real counter or an honest `null` — Denon/HEOS/Yamaha genuinely
expose no firmware field on the wire (verified against all three specs), so that stays
`null` rather than fabricated. MAC is a best-effort local ARP-table read
(`services/protocols/src/arp-lookup.ts`, Linux `/proc/net/arp` only, never active
probing). Model is threaded through from real wire data where it exists (HEOS
`get_player_info`, Yamaha's UPnP `<modelName>`) and stays `null` for Denon Telnet,
which has none.

**Media Topology Engine**: `packages/domain-model/src/media-topology.ts` —
installer-declared HDMI-input/output/zone → connected-thing graph, stored in the
existing free-form `device.metadata.avrTopology` (no persistence/migration change,
same pattern as `metadata.climate.kind`). No AVR protocol here reports what's
physically plugged into a port (verified: none of the three specs models this), so the
graph is always installer-entered — rendered + edited from the AVR console's sidebar
(`apps/web-homeowner/src/features/media/detail.tsx`, devMode-gated for editing).

**Discovery enrichment**: multicast-only (SSDP) discovery stands — an active subnet
scan was deliberately NOT built (SSDP/mDNS already cover every brand in scope
non-intrusively; a blind scan is the wrong default for a luxury local-first platform).
What was added: the ARP MAC lookup above, and Yamaha's UPnP description parsing now
also reads `<modelName>`.

New/changed files this addendum: `services/commissioning/src/room-assignment-engine.ts`
(+ test), `services/protocols/src/{driver-diagnostics,arp-lookup}.ts` (+ tests),
`packages/domain-model/src/media-topology.ts` (+ test), `services/gateway/src/
installer-context.ts` (`autoCommissionMedia`), `services/gateway/src/routes/
{devices,installer}.ts`, `packages/supreme-contracts/src/rest.ts`
(`DeviceDriverDiagnostics`), `apps/web-homeowner/src/{api,device-detail-sections,
features/media/detail}.tsx`, plus the `getDiagnostics` addition across
`services/integration-layer/src/{adapter,native-adapter,routing-adapter,sil,
protocols/driver}.ts` and the corresponding `avr-driver.ts`/`heos-driver.ts`/
`yamaha-driver.ts` wiring. `services/gateway/src/auto-commission-media.e2e.test.ts`
is the end-to-end proof: discover → confidence-scored room assignment → auto zone
generation → bind → live control, plus the Unassigned-bucket and repeat-run-is-a-noop
cases.

**Not done this session** (documented gap, not silently skipped): live verification
against real Denon/HEOS/Yamaha hardware (this environment has none — every claim above
is verified against the vendor specs and exercised through in-process fake TCP/HTTP
servers, the repo's established testing convention); a whole-home Media Dashboard
topology *graph view* (only the per-device connections list was built); Playwright
visual verification of the new Topology UI at every responsive tier (the
`hub-compose` backend stack wasn't running this session — `tsc`/`vite build` both pass
clean, but that is not a substitute for driving it in a real browser against live
data, per this project's own testing standard).

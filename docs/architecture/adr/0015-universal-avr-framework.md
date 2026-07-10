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
- **Trade-off / follow-ups:** HEOS/Yamaha have no manifest entry in
  `services/drivers/src/manifests.ts` by design — that file is for single-host,
  credential-configured drivers the Driver Manager UI provisions end-to-end; AVR-style
  "many independent physical units, each added by IP at commissioning" drivers
  (matching the pre-existing AVR/WiiM/Devialet/Sonos/Shelly/AirPlay/AppleTv/Tuya
  precedent) are boolean env-gated and rely on the protocol-binding commissioning flow
  for per-device config instead. Full Bluetooth-pairing management and browse/search
  (HEOS `browse/*`, Yamaha `netusb/getListInfo`) are out of scope — this framework
  covers the transport/zone/DSP/now-playing surface the brief asked for, not a full
  music-service browser. See `docs/architecture/adding-avr-brands.md` for how a future
  brand (Onkyo, Pioneer, Sony, Arcam, Anthem, NAD, JBL Synthesis, StormAudio, Trinnov)
  plugs into this same seam.

# Architecture Review — Universal AVR Framework

- Status: **Draft — awaiting approval** (Phase 1 deliverable; no implementation code included)
- Date: 2026-07-10
- Context: blueprint §3 (protocol drivers), §7 (SIL abstraction guarantee), §9 (driver
  framework), §11 (media subsystem); ADR 0001 (Supreme Integration Layer), ADR 0014
  (licensing + driver framework)
- Scope: analysis of the existing SupremeOS repository and a plan for a Universal AVR
  Framework (Denon/Marantz Telnet + HEOS, Yamaha YXC + MusicCast). **No code in this
  document.** Phase 2 begins only after this is approved.

---

## 0. Document-scope caveat (read first)

**Update:** the HEOS CLI Protocol Specification (v1.17) has now been supplied and fully
read (44 pages, every command/event section) — see §2.11 for the resulting design. Two
documents are in hand now:

- `Denon_API.pdf` — Denon AVR Telnet control protocol, v8.6.0 (24-Feb-2012), application
  model AVR‑1713/AVR‑1613 — the classic ASCII-over-Telnet command set (`PW`, `MV`, `MU`,
  `SI`, `SD`, `DC`, `SV`, `SLP`, `MS`, `PS`, `Z2`).
- `HEOS_CLI_ProtocolSpecificationVersion1.17.pdf` — the HEOS CLI protocol (Telnet port
  1255, `heos://` command URIs, JSON responses) — Denon/Marantz/HEOS's streaming and
  multi-room layer, fully independent of the Telnet protocol above.

**Still outstanding: no Yamaha document (YXC / MusicCast) has been attached.** Phase 3
cannot start on Yamaha without it — see §8.

The attached Telnet spec is from a 2012 entry-level model. Denon/Marantz have kept this
command set essentially additive and backward-compatible across generations (confirmed
by cross-referencing the shape already implemented in this repo — see §2.1), so it is
usable as the *baseline* grammar, but current flagship models (X4800H, AV10) add
commands this document doesn't list (Dolby Atmos/DTS:X specific `MS` values, HDMI-output
selection, newer `PS` audyssey/DSP parameters). This is a completeness risk for Phase 3,
not a Phase 1 blocker — and it is now largely *mitigated* for the homeowner-facing
surface (power/volume/mute/transport/input/NowPlaying/queue) because HEOS covers all of
that ground with a modern, fully-specified protocol; the Telnet protocol is only load-
bearing now for install-time zone/tone/DSP control (§7).

---

## 1. Method

I read the actual source (not just docs) for every subsystem this framework touches:
the existing AVR driver and its test, the driver framework/manifest/config-schema
system, the SIL and native-adapter routing, the capability/command domain model, every
comparable media driver (Sonos, WiiM, Devialet, Apple TV, AirPlay), the discovery
primitives (SSDP, mDNS), the commissioning/room-assignment pipeline, the messaging
event bus, persistence migrations, the gateway's artwork proxy route, and the
homeowner-facing Media UI. Findings below cite exact files.

---

## 2. What already exists

### 2.1 A real AVR driver already ships — Denon/Marantz Telnet, minimal

`services/protocols/src/avr-driver.ts` + `avr-codec.ts` (+ `avr-driver.test.ts`)
implement `AvrProtocolDriver`, wired at boot behind `SUPREME_AVR_ENABLED`
(`services/gateway/src/bootstrap.ts:184-186`, `config.ts:107-108,224`). It already:

- Opens **one TCP link per bound host** (`Map<hostport, AvrLink>`), so **multiple AVRs
  already work simultaneously** with independent sockets and independent per-device
  state (`Map<DeviceId, MediaCache>`, `Map<bindingKey, CapabilityState>`) — the
  multi-device requirement in Phase 2/3 is **already the shape of this file**, not a
  gap.
- Speaks exactly the ASCII grammar in the attached PDF: `PWON`/`PWSTANDBY`, `MV**`,
  `MUON`/`MUOFF`, `SI**`, parses unsolicited echoes back into `onoff` + `media` state.
- Is tested with an in-process fake TCP server that answers `?` queries and echoes
  commands (`avr-driver.test.ts:13-45`) — this is the established testing convention
  for every Telnet-ish driver in the repo (KNX, CoolMaster, Lutron all use the
  identical shape).

**What it does NOT have** (the real gap this framework fills):
- No reconnect. `socket.on("close")` just nulls the link (`avr-driver.ts:133-136`); a
  dropped connection only reopens lazily on the *next* `command()` call
  (`ensureLink`, line 119). No backoff, no periodic health probe.
- No discovery. `discover()` returns `[]` unconditionally (line 110-112) — "AVRs are
  added by IP" is a hardcoded design choice, not a stub.
- No zones beyond main (no `Z2`/`Z3` handling), no tone/EQ/DSP, no play/pause/transport,
  no artwork, no HEOS.
- `commandToAvr`'s `media` case only maps `volume`/`mute`/`unmute`; `play`/`pause`/
  `next`/`previous` fall through to `null` ("transport is source-specific; not mapped",
  `avr-codec.ts:50`) — true for the Telnet protocol (it has no transport commands),
  which is exactly why HEOS is needed for a complete implementation.

### 2.2 The driver seam every protocol (including AVR) implements

`services/integration-layer/src/protocols/driver.ts` — `INativeProtocolDriver`:
`connect/disconnect/isConnected`, `bind/manages`, `command/getState`, `discover`,
`onState(listener)`, optional `getArtwork(deviceId)`. This is **the entire contract**.
17 drivers implement it today (KNX, Modbus, MQTT, Matter, Zigbee, DALI, AVR, CoolMaster,
SIP, WiiM, Devialet, Sonos, Ajax, Shelly, AirPlay, Apple TV, Lutron, Tuya, Casambi — 25
counting the ones added this session). A Universal AVR Framework is **not a new
architecture** — it's several more implementations of this exact interface, following
the exact pattern already used by 17+ drivers.

`SupremeNativeAdapter` (`services/integration-layer/src/native-adapter.ts`) fronts an
array of these drivers, re-emits their `onState` events upward uniformly, and supports
runtime `registerDriver`/`unregisterProtocol` (the manifest↔runtime bridge — §2.5).
`RoutingBackendAdapter` picks HA vs. native per domain; a device bound to a native
driver always routes there regardless of migration state
(`routing-adapter.ts:106-114`). **Nothing here needs to change.**

### 2.3 Device lifecycle, discovery, and room assignment — already generic

- **Discovery primitives are real and reusable:** `ssdp.ts` (SSDP M-SEARCH over UDP
  multicast, used today by Sonos/WiiM) and `mdns.ts` (mDNS/Bonjour browse + resolve,
  used today by Shelly/AirPlay/Apple TV) are protocol-agnostic UDP libraries with
  injectable sockets for testing. Yamaha (SSDP `urn:schemas-upnp-org:device:
  MediaRenderer:1`, matching the WiiM precedent almost exactly) and HEOS (SSDP, search
  target `urn:schemas-denon-com:device:ACT-Denon:1`, confirmed in the HEOS CLI spec §2)
  both fit `ssdp.ts` without new infrastructure.
- **Discovery → commission → bind is one generic pipeline**, not per-protocol code:
  `CommissioningService` (`services/commissioning/src/index.ts`) aggregates
  `adapter.discover()` across every registered driver, tags each result with its
  owning protocol, and `commission()` turns a `DiscoveredDevice` into a Supreme device
  + binds every capability. `InstallerServices.commissionDevice`
  (`services/gateway/src/installer-context.ts:248-270`) does discover→commission→bind
  in one call when a `protocol` is given.
- **Automatic room assignment already exists as a pattern**, built this session for
  Casambi: `POST /v1/commissioning/auto` (`installer-context.ts` `autoCommission`)
  discovers a protocol's devices, creates rooms from a `raw.room` hint the driver
  supplies, and commissions everything in one step. **Caveat for AVRs specifically:**
  neither SSDP nor mDNS carries a "room" hint the way a Casambi group name does — Sonos/
  WiiM/AirPlay/Apple TV, the four IP-discovered media drivers already in this repo,
  **all leave room assignment to the installer** (discovery surfaces the device;
  a person assigns the room once, same as every AV receiver install today). The
  Universal AVR Framework should follow that same honest precedent rather than invent
  a room-guessing heuristic with no reliable signal behind it. Where a friendly name
  contains an obvious room word (SSDP `friendlyName` "Living Room", MusicCast Zone
  naming), passing it through as `suggestedName`/a `raw.room` hint costs nothing and
  helps the installer — but it is a hint, not a guarantee.

### 2.4 No zone / parent-device concept exists — and none is needed

`packages/domain-model/src/entities.ts` has no notion of a "zone" or parent/child
device. Every `Device` is flat: its own id, one `roomId`, its own capabilities. This is
actually the right fit for AVR zones with **zero domain-model change**: a receiver's
Zone 2 becomes its own Supreme `Device` (own id, own room, `onoff`+`media`
capabilities) bound to the **same physical connection** the main-zone device uses —
exactly the pattern `AvrProtocolDriver` already supports today (multiple bindings,
keyed by `deviceId`+`capability`, sharing one `host:port` link). This mirrors how KNX
already binds many Supreme devices onto one bus connection. **Living Room / Theatre /
Master Bedroom / Outdoor, each with a different brand, and any receiver's extra zones,
are all just more entries in the same `bindings` array of the relevant driver instance
— no schema change, no new relationship table.**

### 2.5 Driver framework — manifests are the plugin system

`services/drivers/src/manifests.ts` + `catalog.ts` + `driver-manager.ts`, backed by
`packages/domain-model/src/drivers.ts` (`DriverManifest`, `DriverConfigField`,
`DriverConfigSchema`). A manifest declares `capabilities`, `protocols`,
`backend: {type: "native"|"ha-integration"}`, and a **declarative `configSchema`** —
the Driver Manager UI auto-generates a config page from it, so a new driver needs a
manifest, not a UI change (ADR 0014). `services/gateway/src/native-driver-factory.ts`
maps a `protocol` string to a driver constructor at runtime
(`NATIVE_DRIVER_FACTORIES`), currently `knx`/`mqtt`/`modbus`/`casambi` — this is where
each new AVR protocol driver gets registered. `ProtocolKind`
(`packages/domain-model/src/drivers.ts:30-44`) is the enum of known protocol
identifiers; it does not yet include `avr`, `heos`, `yxc`, or `musiccast` — additive
zod-enum change, same as when `casambi` was added.

### 2.6 State management, "event bus" — two different things, easy to conflate

Device state does **not** flow over `services/messaging`'s `IEventBus`. It flows:
driver `onState(listener)` → `SupremeNativeAdapter`/`RoutingBackendAdapter` →
`SupremeIntegrationLayer.subscribe()` → the gateway's `/v1/stream` WebSocket. Every
existing driver (including today's AVR driver) only ever needs to call its own
`record()`/`emitFor()` helper and the rest is automatic — no pub/sub wiring, no event
bus interaction required from a driver. `services/messaging`'s `IEventBus` (in-process
or NATS) is a *separate*, lower-usage mechanism for cross-instance presence/scale-out
coordination (`services/gateway/src/context.ts:204`, `bootstrap.ts:125`), consumed only
at the gateway/bootstrap level — **the AVR framework does not need to touch it.**

### 2.7 Media subsystem — already a unified, brand-agnostic surface

`apps/web-homeowner/src/media.tsx` — the "Media" screen already shows **every**
`media`-capable device from **every** driver together, grouped by room
(`media.tsx:42-45`), each opening the same `MediaSheet` (`device-sheets.tsx:216-254`).
Sonos, WiiM, Devialet, Apple TV, AirPlay and today's AVR driver all already appear
here identically — **"one unified SupremeOS Media Entity regardless of manufacturer"
already exists**; a correctly-populated `media` capability is all any new driver needs
to slot into it with zero UI-routing change.

What `MediaSheet` does **not** yet have: an artwork image, a progress/duration bar,
shuffle/repeat, a real (non-hardcoded) input list — `MEDIA_SOURCES` at
`device-sheets.tsx:215` is a literal hardcoded array, exactly the kind of hardcoding
the brief wants eliminated. This is genuine, scoped UI work, not a new screen.

`CapabilityState`'s `MediaState` (`packages/domain-model/src/capabilities.ts:69-77`)
carries `playback, volume, muted, title, artist, source, artworkUrl` — **no
`durationSec`/`positionSec`/`shuffle`/`repeat`**. `CapabilityCommand`'s `media` case
(`capabilities.ts` media command block) has actions `play/pause/stop/next/previous/
volume/mute/unmute/source` — **no `seek`/`shuffle`/`repeat`**. Both need **additive**
extension (new optional fields / new enum values), the same low-risk pattern already
used for `TemperatureState`'s optional `targetLowC/targetHighC/humidity`. "Queue" is
a list, not a scalar field — pushing it on every state delta over the WS stream to
every client is the wrong shape (heavy, mostly-idle payload); it should be a pull
endpoint (`GET /v1/devices/:id/media/queue`), matching the existing artwork proxy's
pull-on-demand pattern (§2.8), fetched only when a client opens the queue view.

### 2.8 Artwork — a real proxy exists, no cache exists

`GET /v1/devices/:id/media/artwork` (`services/gateway/src/routes/devices.ts:138-153`)
calls `ctx.sil.getArtwork(deviceId)` → the owning driver's `getArtwork()` → raw bytes,
streamed straight through with only an HTTP `cache-control: max-age=60` hint — **no
in-memory or on-disk cache today.** `AppleTvProtocolDriver` is the existing reference
implementation of `getArtwork` (`apple-tv-driver.ts:236-240`) plus an `artworkUrlFor`
injected URL-builder so the driver never has to know the gateway's public base URL.
**"Artwork Cache" is correctly identified in the brief as new work** — there is
nothing to reuse here beyond the proxy route and the `getArtwork` contract; the cache
itself (keyed by device + a content hash/etag so it invalidates when the track
changes) is a genuinely new, small module. It should be an in-process LRU (artwork is
inherently transient — invalid the moment the track changes), not a DB table; no
migration needed.

### 2.9 Persistence — nothing AVR-specific needed

`services/persistence/migrations/0007_protocol_bindings.sql`: a fully generic
`(device_id, capability, protocol, address, config)` table already persists every
protocol's bindings (KNX, Casambi, AVR, everything), re-bound on boot
(`installer-context.ts` `rebindProtocols`). The free-form `config` JSON column is
exactly where a zone identifier, a HEOS `pid`, or a MusicCast `zone_id` belongs — no
new table, no migration required for basic binding persistence.

### 2.10 Config, logging, coding conventions

- **Config:** `services/gateway/src/config.ts` — flat env-driven `GatewayConfig`,
  secrets via the `*_FILE` convention (never plaintext in env), one `xEnabled`/`xHost`
  flag pattern per protocol (`avrEnabled` already exists at line 108). New AVR-related
  flags follow the identical shape.
- **DI:** no framework — plain constructor injection, wired by hand once in
  `bootstrap.ts` (`nativeDrivers.push(new XProtocolDriver(...))` per enabled protocol)
  and again at runtime via `native-driver-factory.ts` for manifest-driven install. This
  is consistent across all 25 drivers; the AVR framework follows the same two wiring
  points.
- **Logging:** Fastify/pino at the gateway boundary; drivers themselves don't log
  directly (state changes are observable via `onState`, errors surface through thrown
  `Error`s that the calling command route converts to a typed `SupremeError`). No
  driver in the repo does its own file/console logging — the AVR framework shouldn't
  either.
- **Coding standard:** no CONTRIBUTING.md; the standard is the pattern itself — dense
  header doc-comments explaining *why* (with `§` blueprint references), the
  injectable-transport-for-testing convention (`fetchImpl`/`createSocket`/`connect`
  seam so tests run against an in-process fake, never a real network), strict
  TypeScript (`tsc --noEmit` is the enforced "lint" gate — no ESLint in this repo),
  Zod schemas as the single source of truth for shapes shared client↔server.
- **Build:** pnpm + Turborepo monorepo (`turbo.json`); every package independently
  `build`/`typecheck`/`test`able; `services/protocols` is the home for every native
  protocol driver + its codec + its test, one file pair per protocol.

### 2.11 HEOS CLI protocol (v1.17) — read in full; here is the design it implies

Transport: Telnet, **port 1255**, commands are `heos://group/command?k=v&k2=v2\r\n`
strings; responses are JSON with a `command`/`result`/`message` envelope plus an
optional `payload`. The `message` field itself is a `&`-delimited `key=value` string
(not nested JSON) — the codec needs a small `parseHeosMessage(str) →
Record<string,string>` helper, the HEOS analogue of `parseAvrLine`.

**Architecturally important — HEOS is not "one link per host."** Unlike the classic
Denon Telnet protocol (§2.1, strictly one connection per receiver), a single HEOS
socket connection to **any one** HEOS speaker on the network gives control over
**every player in the whole HEOS ecosystem**, addressed by `pid` (player id) —
confirmed in §2 of the spec ("recommended not to establish socket connection to each
HEOS speaker... [use] one connection to listen for change events and one to handle
user actions"). This means `HeosProtocolDriver` should hold **one persistent
connection per network** (two sockets: one for commands, one for the event stream,
per the spec's own recommendation), not one per bound device — a genuinely different
connection topology from `AvrProtocolDriver`, and the concrete reason HEOS is its own
driver file rather than a mode of the existing one (§5 in the main review already
called this out; the spec confirms it precisely).

**Driver init sequence** (spec §2.1.1, straightforward to follow exactly):
un-register for change events → optional `sign_in` → snapshot via `get_players` /
`get_groups` / `get_now_playing_media` / `get_volume` / `get_play_state` per player →
`register_for_change_events?enable=on`. A `heart_beat` command exists for keep-alive,
matching the heartbeat pattern already used by the Casambi driver built this session.

**Command → Supreme capability mapping** (all confirmed against the actual spec text):

| Supreme | HEOS command(s) |
|---|---|
| `onoff` | HEOS has no explicit power command — a player is "on" whenever it's part of the HEOS system; power for the underlying AVR is still the classic Telnet `PW` command (§2.1). HEOS augments, doesn't replace, power control. |
| `media.playback` (play/pause/stop) | `player/set_play_state` (`state=play\|pause\|stop`) |
| `media.volume` | `player/set_volume` (0–100 absolute) + `volume_up`/`volume_down` (relative step 1–10) |
| `media.muted` | `player/set_mute`, `toggle_mute` |
| `media.source` (input) | `browse/play_input?input=inputs/<name>` — a **fixed, protocol-defined enum** of ~35 input identifiers (`inputs/hdmi_in_1`, `inputs/optical_in_1`, `inputs/tv`, …, spec §4.4.9). The enum itself is a wire-protocol constant (safe to embed in the codec, same as Denon `SI` parameter names); *which* of those a specific physical unit exposes is installer configuration, not something to hardcode as "this model has these." |
| `media.title/album/artist/artworkUrl` | `player/get_now_playing_media` (`song`, `album`, `artist`, `image_url`) — **no duration/position in this response** |
| `media.durationSec`/`positionSec` (new, §4 of the main review) | **`event/player_now_playing_progress`** — `cur_pos=position_ms&duration=duration_ms`, pushed unsolicited. This is the confirming evidence for the `MediaState` extension already proposed in §4 — the field exists in the real protocol, not just a Denon/Marantz theory. |
| `media` next/previous | `player/play_next`, `player/play_previous` |
| `media.shuffle`/`repeat` (new command actions, §4) | `player/set_play_mode?repeat=on_all\|on_one\|off&shuffle=on\|off` — **repeat is 3-state, not boolean** (off / all / one-track-repeat). The `repeat` field proposed in §4 should be a 3-value enum, not `boolean`, to carry this losslessly. |
| Queue (pull endpoint, §4) | `player/get_queue` (range-paginated, ≤100/response), `play_queue`, `remove_from_queue`, `clear_queue`, `move_queue_item`, `save_queue` — confirms the "pull on demand, not pushed in every state delta" design already recommended. |
| Presets | `player/set_quickselect` / `play_quickselect` / `get_quickselects` — **explicitly "LS AVR / HEOS BAR only"** in the spec; not every HEOS-capable device supports this. Feeds directly into the dynamic-capability-detection design (§7): presence of QuickSelect is per-model, detected not assumed. |
| Multi-room grouping | `group/get_groups`, `set_group`, `group/set_volume` — a HEOS-native concept with no Supreme domain-model equivalent today. Recommendation: **out of scope for the core unified `media` capability**; if wanted, expose as an Installer/Developer-mode action (same tier as tone/DSP, §7), not a homeowner capability, since Sonos/WiiM/AirPlay grouping isn't modeled in Supreme today either — this would be new ground for every media driver, not an AVR-specific gap. |

**Change events** (`event/*`, spec §5) are exactly the shape needed to drive
`onState()` reactively with zero polling: `player_state_changed`,
`player_now_playing_changed` (triggers a `get_now_playing_media` refetch),
`player_now_playing_progress` (duration/position, likely pushed ~1/sec while
playing — the spec doesn't state an exact interval; to be confirmed empirically
against real hardware in Phase 3), `player_volume_changed` (carries level **and**
mute together), `repeat_mode_changed`, `shuffle_mode_changed`,
`player_queue_changed`, `players_changed`/`groups_changed`/`sources_changed`
(topology changes → re-run `get_players`), `player_playback_error` (surfaced as a
thrown driver error, not silently dropped).

**Error handling:** `{"result":"fail","message":"eid=<code>&text=<text>"}` — a flat
numeric error-code enum (spec §6.2). Straightforward `HeosError` mapping, same shape
as every other driver's typed error throw.

---

## 3. What should be reused, unmodified

- `INativeProtocolDriver` interface, `SupremeNativeAdapter`, `RoutingBackendAdapter`,
  `SupremeIntegrationLayer` — the entire device-lifecycle/state-routing stack.
- `ssdp.ts`, `mdns.ts` — discovery primitives.
- `CommissioningService`, `InstallerServices.commissionDevice` /
  `autoCommission` / `bindProtocol` — discovery→commission→bind pipeline.
- `protocol_bindings` persistence table and its re-bind-on-boot path.
- Driver manifest / `configSchema` / Driver Manager UI generation.
- `GET /v1/devices/:id/media/artwork` proxy route + `getArtwork` driver contract.
- `apps/web-homeowner/src/media.tsx` (the unified Media screen) and
  `DeviceSheet`'s routing (`device-sheets.tsx`) — devices simply need to report
  correctly; no new screen.
- The Flutter mirror of the above (`apps/mobile/lib/screens/device_sheet.dart` and
  a media-equivalent list) — same reuse story on mobile, per the standing
  cross-platform requirement from this session.
- Testing convention: in-process fake TCP/HTTP server + injectable transport seam.

## 4. What should be extended

| What | File(s) | Why additive, not new |
|---|---|---|
| `AvrProtocolDriver` gains reconnect, zones, tone/DSP passthrough, artwork | `services/protocols/src/avr-driver.ts`, `avr-codec.ts` | Same class, same binding model; today's power/volume/mute/source keeps working unchanged |
| `MediaState` gains `durationSec?`, `positionSec?`, `shuffle?`, `repeat?` | `packages/domain-model/src/capabilities.ts` | Optional fields, exactly like `TemperatureState`'s pattern; every existing media driver/consumer keeps compiling |
| `media` command gains `seek`, `shuffle`, `repeat` actions | `packages/domain-model/src/capabilities.ts` | New zod-enum members, additive |
| `ProtocolKind` gains `avr`, `heos`, `yxc`, `musiccast` | `packages/domain-model/src/drivers.ts` | Same pattern as adding `casambi` |
| `NATIVE_DRIVER_FACTORIES` gains entries for the new protocols | `services/gateway/src/native-driver-factory.ts` | One-line-per-protocol, existing shape |
| `GatewayConfig` gains AVR-brand flags/secrets | `services/gateway/src/config.ts`, `.env.example` | Same `xEnabled`/`xHost`/`*_FILE` shape as every other protocol |
| `MediaSheet` gains artwork image, progress bar, shuffle/repeat, dynamic (not hardcoded) input list | `apps/web-homeowner/src/device-sheets.tsx` + Flutter equivalent | Same component, richer body; capability-detected, not brand-hardcoded (§7) |
| Driver manifests for each brand | `services/drivers/src/manifests.ts` | New manifest entries, same shape as every existing one |

## 5. What genuinely needs new modules — and why no existing extension point fits

1. **`HeosProtocolDriver`, `YamahaExtendedControlDriver`, `MusicCastProtocolDriver`** —
   new files in `services/protocols/src/`, one codec+driver pair per protocol,
   identical shape to every existing driver. These are new *because* they're different
   wire protocols (HEOS = JSON/pipe-delimited over TCP 1255; YXC = HTTP/JSON + a UPnP
   event subscription; MusicCast = HTTP/JSON + UDP multicast events) — not because the
   framework needs a new pattern.
2. **Artwork cache** (§2.8) — a small new in-process module (e.g.
   `services/gateway/src/artwork-cache.ts`), because none exists at any layer today.
3. **A capability-detection helper shared across the AVR drivers** — see §7. New
   *because* dynamic capability detection per model doesn't exist anywhere in the repo
   today (every other driver's capability set is either static or derived once at
   discovery, e.g. Casambi's `capabilitiesFromUnit`); AVRs need it because "which
   inputs / DSP modes / zones does *this* model have" varies per SKU and must be
   queried, not hardcoded.
4. **A reconnect/backoff helper**, likely shared (not per-driver copy-paste) —
   several drivers already hand-roll their own capped-backoff reconnect (Casambi
   built this session, KNX has a simpler version); a small shared utility used by all
   three new AVR drivers plus the extended `AvrProtocolDriver` avoids four copies of
   the same loop. New because no shared version exists yet (each driver currently
   reimplements it independently) — this is a genuine, worthwhile de-duplication.

No new capability kind, no new database table, no new UI screen, no new event bus, no
new DI mechanism, no new discovery transport.

## 6. Files — modified vs. added (Phase 2/3 scope, no code yet)

**Modified:**
- `packages/domain-model/src/capabilities.ts` (MediaState + media command extension)
- `packages/domain-model/src/drivers.ts` (ProtocolKind extension)
- `services/protocols/src/avr-driver.ts`, `avr-codec.ts` (reconnect, zones, tone/DSP,
  artwork, HEOS-aware where applicable)
- `services/protocols/src/index.ts` (new exports)
- `services/gateway/src/native-driver-factory.ts`, `config.ts`, `bootstrap.ts`
- `services/drivers/src/manifests.ts` (Denon/Marantz/Yamaha manifests)
- `services/gateway/src/routes/devices.ts` (queue endpoint; artwork route gains cache)
- `apps/web-homeowner/src/device-sheets.tsx` (+ Flutter `device_sheet.dart` /
  equivalent) — richer MediaSheet
- `infra/hub-compose/.env.example`

**Added:**
- `services/protocols/src/heos-codec.ts`, `heos-driver.ts` (+ `.test.ts`) — one
  persistent per-network connection (command socket + event socket), addressing every
  `pid` on the network, per §2.11 — not the "one link per bound host" shape
  `AvrProtocolDriver` uses for classic Telnet.
- `services/protocols/src/yxc-codec.ts`, `yxc-driver.ts` (+ `.test.ts`) — Yamaha
  Extended Control
- `services/protocols/src/musiccast-codec.ts`, `musiccast-driver.ts` (+ `.test.ts`)
- `services/protocols/src/avr-reconnect.ts` (shared backoff helper) — or folded into
  an existing shared location if one is agreed in review
- `services/protocols/src/avr-capabilities.ts` (shared dynamic-capability-detection
  helper, §7)
- `services/gateway/src/artwork-cache.ts` (+ `.test.ts`)
- `docs/architecture/adr/00XX-universal-avr-framework.md` (formal ADR once this
  review is accepted — Phase 4 deliverable)

## 7. How dynamic capability detection actually works here (no hardcoding)

Every brand exposes a different discoverable surface (Denon: `SSINFOAISPARAM`/HEOS
player info; Yamaces: `getFeatures`/`getDeviceInfo` on YXC, `getFeatures` on
MusicCast). The pattern, consistent with how Casambi's codec derives capabilities from
each unit's advertised `controls` rather than a hardcoded per-model table
(`services/protocols/src/casambi-codec.ts` `capabilitiesFromUnit`):

- At `bind()` time, each driver queries the model's real feature/capability endpoint
  once and derives (a) which Supreme capabilities apply (`onoff`, `media`, and — for
  zone devices — the same, per zone) and (b) a **capability-config payload** (input
  list, DSP/surround-mode list, tone-control range, zone count) stored on
  `DeviceCapability.config` (already a free-form `z.record(z.unknown())` field,
  `entities.ts:87-90` — built for exactly this).
- The homeowner-facing UI never hardcodes a brand's input/DSP list; it renders
  whatever `config` the device reports, the same way the Driver Manager already
  renders any manifest's `configSchema` without knowing the driver in advance (ADR
  0014). This keeps DSP/tone/EQ — genuinely brand-specific, install-facing detail —
  out of the shared `CapabilityKind` enum (which every client's UI switches on) and
  out of homeowner view by default, consistent with this repo's standing rule that
  homeowners never see protocol/technical detail; advanced audio controls surface in
  Installer/Developer mode, exactly like every other protocol-specific admin surface
  in this app.

## 8. Open items requiring your input before Phase 2 starts

1. **Yamaha spec is still missing.** Please attach the YXC (HTTP/JSON) and MusicCast
   API docs — Phase 3's Yamaha work cannot start without them. ~~HEOS spec is
   missing~~ **— resolved: HEOS CLI v1.17 supplied and fully analyzed, §2.11.**
2. **Tone/DSP/EQ modeling confirmation** — §7 proposes keeping these out of the core
   `media` capability and out of the shared `CapabilityKind` enum, surfaced instead as
   a dynamically-rendered `DeviceCapability.config` payload in Installer/Developer
   mode. Confirm this matches your intent before it's built, since it's the one
   genuinely new architectural pattern in this plan (everything else is direct reuse).
3. **Multi-room grouping (HEOS `group/*`)** — §2.11 proposes treating this as an
   Installer/Developer-mode action rather than a new homeowner-facing Supreme
   capability, since no media driver in this repo (Sonos/WiiM/AirPlay included) models
   cross-device grouping today. Confirm, or say if HEOS grouping should be a
   fast-follow homeowner feature — that would be new ground affecting the media
   capability model generally, worth deciding deliberately rather than bolting on.
4. **Room assignment expectation** — confirm the honest position in §2.3 (SSDP/mDNS
   give no reliable room signal; installer assigns rooms once, matching every existing
   IP-discovered driver) is acceptable, rather than a heuristic that would occasionally
   guess wrong.
5. **Artwork cache eviction policy** — in-process LRU by default (simplest, matches
   the transient nature of album art); say if you want it disk-backed for a hub
   restart to preserve currently-playing artwork across a reboot.

---

**This is Phase 1 only. No implementation code has been written.** HEOS is fully
spec'd and ready to build against. Denon/Marantz (Telnet + HEOS) could start on your
approval alone; **Yamaha is still blocked on its protocol documents.** Let me know
whether to (a) wait for the Yamaha docs and start Phase 2 on everything together, or
(b) begin Phase 2 (the shared framework) + Phase 3's Denon/Marantz driver now, and
slot Yamaha in once its docs arrive.

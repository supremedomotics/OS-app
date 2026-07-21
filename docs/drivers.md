# Supreme OS — Native Protocol Driver Matrix

> The 20 first-party native drivers in `@supreme/protocols`. Each fronts the
> `INativeProtocolDriver` seam and is surfaced to the SIL through
> `SupremeNativeAdapter` (§3, §7), so the same Supreme capability commands drive
> every ecosystem without HA in the path. Drivers are **gated at the boot edge** —
> none start unless its env var(s) are set — and configured via `infra/hub-compose`
> (`.env.example` + compose).

> **Keypads/input hardware**: none of the drivers below implement the Universal
> Keypad Framework's optional `getKeypadCapabilities`/`onInputEvent`/
> `sendKeypadFeedback` members yet (ADR 0016 — Phase 1 shipped the framework only,
> no real keypad driver). See `Universal-Keypad-Framework.md` and
> `Keypad-Driver-Author-Guide.md` for the seam a future KNX push-button/Casambi
> keypad/Lutron Pico/Matter switch/MQTT button/RTI keypad/Zigbee remote/BLE fob/DALI
> push-button driver plugs into.

## Legend

- **Authenticity** — *Real wire protocol*: the driver speaks the device's actual
  protocol over the network/bus (codec implemented in-repo and tested against an
  in-process server). *Library seam*: the protocol needs a heavy/native or
  proprietary client, so a third-party library sits behind an injectable seam (the
  real impl is wired at the edge; tests use a fake). *Cloud/proprietary seam*: the
  ecosystem is closed (per-device keys or vendor cloud), so the client is a seam.
- **Discovery** — how devices are found on the LAN (or that discovery is N/A and
  devices are bound by config).
- **Tested** — how the driver is verified in CI.

## Matrix

| Driver | Capabilities | Transport / authenticity | Discovery | Boot gate (env) | Tested |
|--------|--------------|--------------------------|-----------|-----------------|--------|
| **KNX** | onoff, brightness, position, sensor | KNXnet/IP; **real** DPT codec in-repo, bus via `knx` lib seam | ETS group-address import (CSV/XML → cards) | `SUPREME_KNX_HOST` | DPT codec + fake bus |
| **MQTT** | onoff, brightness, sensor | **real** MQTT (`mqtt`) | Zigbee2MQTT bridge topics | `SUPREME_MQTT_URL` | end-to-end vs `aedes` broker |
| **Modbus** | onoff, sensor | **real** Modbus TCP (`modbus-serial`) | — (register map by config) | `SUPREME_MODBUS_HOST` | in-process `ServerTCP` |
| **Matter** | onoff, brightness, color, lock, position, sensor | `@matter/main` controller seam (opt-in, off by default) | fabric/commissioned nodes | `SUPREME_MATTER_ENABLED` | fake fabric |
| **Zigbee** | onoff, brightness, color, position, sensor | `zigbee-herdsman` coordinator seam | paired devices on coordinator | `SUPREME_ZIGBEE_PORT` | fake coordinator |
| **DALI** | onoff, brightness, color | **real** IEC 62386 codec in-repo, USB gateway seam | — (short address by config) | `SUPREME_DALI_PORT` | codec + fake bus |
| **AVR** | onoff, media (zones, DSP/tone via `advanced`) | **real** Denon/Marantz Telnet control — auto-reconnect, Zone 2 as an independent Supreme device on the same link | — (host + `config.zone` by config) | `SUPREME_AVR_ENABLED` | in-process server (power/volume/media + zone2 + reconnect + tone/DSP) |
| **HEOS** | media | **real** HEOS CLI (Denon/Marantz whole-home streaming) — ONE TCP connection reaches every player on the network by `pid`; play queue via the spec's own `sequence`-correlated `get_queue` | SSDP (`ACT-Denon:1`) | `SUPREME_HEOS_ENABLED` | in-process server (multi-pid isolation, reconnect + re-sync, queue correlation) |
| **Yamaha** | onoff, media (up to 4 zones, DSP/tone via `advanced`) | **real** Yamaha Extended Control (YXC/MusicCast — one protocol, covers both standalone streamers and MusicCast AVRs) — HTTP commands + a real `/system/getFeatures` dynamic-capability query + UDP-unicast push events | SSDP `MediaRenderer` + UPnP description (`manufacturer=Yamaha`) | `SUPREME_YAMAHA_ENABLED` | in-process HTTP + fake UDP event socket (zone isolation, netusb-typed-input gating, direct vs full-refetch events) |
| **CoolMaster** | onoff, temperature | **real** CoolMasterNet TCP line protocol | — (unit ids by config) | `SUPREME_COOLMASTER_HOST` | in-process bridge |
| **SIP** | lock, sensor (door ring) | SIP UA seam (intercom/door station) | — (registrar by config) | `SUPREME_SIP_SERVER` | unit tests |
| **WiiM** | media | **real** LinkPlay HTTP API | SSDP | `SUPREME_WIIM_ENABLED` | in-process HTTP |
| **Devialet** | media | **real** HTTP `/ipcontrol` API | mDNS | `SUPREME_DEVIALET_ENABLED` | in-process HTTP |
| **Sonos** | media | `node-sonos` real transport (wired) behind seam | SSDP | `SUPREME_SONOS_ENABLED` | fake device |
| **Ajax** | sensor | cloud/proprietary seam | — (cloud account) | `SUPREME_AJAX_ENABLED` | unit tests |
| **AirPlay** | media | sender seam (AirPlay is a streaming, not control, protocol) | **real** mDNS (`_airplay._tcp`) | `SUPREME_AIRPLAY_ENABLED` | discovery test |
| **Apple TV** | media (full transport + volume/mute; now-playing: foreground **app** + content) | MRP via the bundled pyatv bridge (`services/appletv-py`); encrypted + PIN-paired | **real** mDNS (`_mediaremotetv._tcp`) | `SUPREME_APPLETV_ENABLED` + `SUPREME_APPLETV_URL` | mapping + discovery + fake-client + bridge-HTTP + Python-bridge tests |
| **Shelly** | onoff, brightness, position, sensor | **real** Gen2 JSON-RPC over HTTP (`POST /rpc`) | mDNS (`_shelly._tcp`), enriched via `Shelly.GetStatus` | `SUPREME_SHELLY_ENABLED` | in-process RPC + enriched discovery |
| **Lutron** | onoff, brightness, position | **real** Lutron Integration Protocol (LIP) over Telnet — one driver covers **wired** RadioRA 2 / HomeWorks QS **and wireless** Caséta Smart Bridge Pro | — (integration ids by config) | `SUPREME_LUTRON_HOST` | in-process LIP bridge (auth + set + report) |
| **Tuya** | onoff, brightness, position | cloud/proprietary seam (`tuyapi` / Tuya Cloud); DPS mapping both ways | — (per-device keys) | `SUPREME_TUYA_ENABLED` | fake DPS device |

## Discovery transports (shared)

- **SSDP** — raw UDP datagram `M-SEARCH` + response parsing (`ssdp.ts`). Used by
  WiiM, Sonos, HEOS (Denon's `ACT-Denon:1` search target), and Yamaha (standard UPnP
  `MediaRenderer`, filtered by fetching each hit's device-description XML and checking
  `<manufacturer>`).
- **mDNS / DNS-SD** — hand-rolled DNS codec over raw datagram (`mdns.ts`), no native
  dependency. Used by Devialet, AirPlay, Apple TV (`_mediaremotetv._tcp`), and Shelly
  (Shelly then enriches each hit with a `Shelly.GetStatus` call to learn the device's
  real capability set).
- **MQTT bridge** — Zigbee2MQTT `bridge/devices` topic discovery (`mqtt-discovery.ts`).

## Authenticity at a glance

- **Real wire protocol implemented in-repo (codec + tested vs in-process server):**
  KNX (DPT), MQTT, Modbus, DALI (IEC 62386), AVR (Denon/Marantz Telnet), HEOS (Denon/
  Marantz CLI), Yamaha (Extended Control/MusicCast), CoolMaster, WiiM (LinkPlay),
  Devialet, Shelly (Gen2 RPC), Lutron (LIP).
- **Library seam (heavy/native client wired at edge, faked in tests):** Matter,
  Zigbee, Sonos, SIP, AirPlay, Apple TV (pyatv-backed MRP).
- **Cloud/proprietary seam (closed ecosystem, per-device keys or vendor cloud):**
  Ajax, Tuya.

All three categories present the *same* `INativeProtocolDriver` contract upward, so
the SIL and everything above it are protocol-agnostic — a seam-based driver can be
swapped for a fuller native implementation with no change above the seam.

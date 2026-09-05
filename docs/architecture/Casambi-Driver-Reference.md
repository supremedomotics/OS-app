# SupremeOS Casambi Driver — Complete Technical Reference

> Status: branch `native-linux`. Run `git log -1 --oneline -- services/protocols/src/casambi` for the exact revision this describes.
> Scope: the native Casambi protocol driver in `services/protocols/src/casambi/`, its two
> connection modes, every command/state mapping, the gateway REST surface, setup/configuration,
> and the honest list of what is *not* supported and why.

---

## 1. Architecture in one paragraph

SupremeOS speaks Casambi through **one driver class** (`CasambiProtocolDriver`) that supports **two
completely different transports** behind **one unified entity model**:

| | **Cloud mode** | **Local Gateway mode** |
|---|---|---|
| Transport | Casambi Cloud REST + WebSocket (`door.casambi.com`) | Lithernet Gateway on the LAN: UDP "Casambi Command" protocol + one REST write endpoint |
| Internet required | Yes | **No** (except optional one-time Cloud enrichment) |
| Live state | WebSocket `unitChanged` events, always open | UDP `NotifyControlValues` (opcode `0x4B`) subscription |
| Discovery | Instant, full network enumeration via REST | **Progressive** — a unit appears when its first UDP notification arrives |
| Fixture names | From the Cloud account | **Not available on the wire at all** — Cloud sync only |
| Group names / rooms | From the Cloud account | **Not available on the wire at all** — Cloud sync only |

The unified model means `discover()`, `command()`, `getState()` and the capability derivation are
**identical in both modes**; only the transport-specific mapper differs
(`entity-mapper.ts` for Cloud JSON, `local-command-mapper.ts` + `local-discovery.ts` for UDP bytes).

**Design rule that governs the whole driver:** capabilities are derived from each unit's *advertised
controls*, never hard-coded per device model, and never fabricated. A capability the transport
cannot actually execute is either not claimed or is gated with the real reason.

---

## 2. Setup & configuration

Driver manifest: `services/drivers/src/manifests.ts` (key `casambi`, SKU `pro`).
The Driver Manager UI **generates the config form from this schema**, and `connectionType` acts as a
discriminator — fields are validated *only* in the mode they belong to (`requiredIf`).

### 2.1 Common

| Field | Type | Notes |
|---|---|---|
| `connectionType` | select `cloud` \| `local` | Default `cloud`. Discriminator for everything below. |

### 2.2 Cloud mode fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `apiKey` | password | if cloud | WebSocket-enabled key issued by Casambi Support. **Normally not typed by installers — see §2.4.** |
| `email` | text | if cloud | Casambi **network admin** account (per project). |
| `password` | password | if cloud | Network admin password. |
| `networkId` | text | optional | Casambi's **internal network ID**, *not* the display name. A display name here causes HTTP 404. Blank = authenticate against whatever network the account has. |

### 2.3 Local Gateway fields

Ordered to match the physical commissioning flow.

| Field | Type | Required | Notes |
|---|---|---|---|
| `gatewayIp` | host | if local | e.g. `192.168.1.50`. No auto-discovery exists (see §10). |
| `restPort` | port | if local | Default `80`; `443` if the gateway's web server has SSL enabled. |
| `gatewayUsername` | text | if local | The **gateway's own web-server login**, not a Casambi account. Used for HTTP Basic Auth on every Local REST request. |
| `gatewayPassword` | password | if local | Stored independently of any Casambi Cloud credential. |
| `udpPort` | port | if local | The gateway's "UDP Casambi Command" port. Gateway **sends and receives on the same port**. |
| `netId` | number 0–254 | — | Must match the gateway's UDP Casambi Command page. 255 is reserved for broadcast. |
| `dataFormat` | select `hex-dot` \| `dec-hash` | — | Must match the gateway's "DEC or HEX" setting exactly or nothing parses. |

Local mode *also* accepts `email`/`password`/`networkId` — used **only** for the optional one-time
Cloud enrichment actions in §6, never for a live connection.

### 2.4 The fleet-wide API key

The Casambi **API key** is the one credential Supreme Domotics owns rather than the customer.
It is shipped as AES-256-GCM ciphertext in `services/gateway/src/casambi-embedded-key.ts` and
decrypted at boot, so an installer never sees or types it.

Resolution precedence (`services/gateway/src/config.ts`):

```
SUPREME_CASAMBI_API_KEY (env or _FILE)   →   embedded encrypted key   →   ""
```

`email` / `password` / `networkId` are **per project** and always come from the driver's own config
(with optional `SUPREME_CASAMBI_EMAIL` / `_PASSWORD` deployment defaults). Each field falls back
independently — an apiKey-only fleet default plus per-driver email/password is the normal production
shape.

---

## 3. Connection lifecycle

### 3.1 Cloud (`connectCloud`)

```
createSession()      POST /v1/networks/session[?networkId=…]   → sessionId
loadNetwork()        GET  /v1/networks/{id}                    → units (structural) + groups
seedState()          GET  /v1/networks/{id}/state              → units WITH controls
openWire()           WebSocket, API key as subprotocol         → live unitChanged stream
startHeartbeat()     ping every 240 s (server drops idle wires at ~300 s)
```

Auto-reconnect on socket drop with exponential backoff (`reconnectBaseMs` 2 s → `reconnectMaxMs` 60 s),
creating a **fresh session** each attempt. `reconnects` resets once a wire opens successfully.

### 3.2 Local (`connectLocal`)

```
UDP socket bind (via @supreme/lan)
startLocalDiscovery():
   0x4B SetDefaultMask   args [3, 0, 0, FF, FF, FF, FF]
   0x4B Subscribe        args [1, 0, 250]        ← subscribe to units 0-250
enableLocalButtonEvents(): 0x50 with 0xFD
```

There is **no reconnect loop** in Local mode — UDP is connectionless, so there is nothing to
reconnect to. "No reply yet" is never treated as a failure.

The UDP socket is owned by the separate **`supreme-lan`** systemd service, reached over NATS
(`NatsUdpTransportClient`) in production, or bound in-process (`LocalDirectUdpTransport`) in
single-process dev. RPC calls are bounded at 5 s.

---

## 4. The unified entity model

```ts
interface CasambiUnit {
  id: number;             // Casambi unit id — the addressing key everywhere
  name?: string;          // Cloud only
  type?: string;          // Cloud only
  fixtureId?: number;     // Cloud only
  groupId?: number;       // Cloud only → drives room mapping
  address?: string;       // BLE mesh address
  online?: boolean;
  on?: boolean;
  dimLevel?: number;      // 0..1
  activeSceneId?: number;
  controls?: { type, value?, min?, max?, … }[];   // ← capability source of truth
  sensors?: Record<string, unknown>;
}
```

### 4.1 Capability derivation (`capabilitiesFromUnit`)

Evaluated in this order:

1. `type === "sensor"`, or has `sensors` and **no** dimmer control → `["sensor"]`
2. has `slider` or `vertical` control, and **no** dimmer/colour → `["position"]` (a cover)
3. otherwise: `dimmer` present → `brightness`, else → `onoff`
4. plus `color` if any of `color` / `rgb` / `xy` / `cct` / `colortemperature` present

Control-type matching is **case-insensitive**. A unit with no controls at all still yields
`["onoff"]` — it is commissionable, just minimally.

`colorConfigFromUnit()` additionally reports the *structural* RGB-vs-CCT split
(`{ colorModes: { rgb, cct } }`) from the advertised controls — never inferred from live state.

---

## 5. Commands — complete matrix

`command(deviceId, cmd)` → resolves the binding's `unitId` → `commandEngine.send(unitId, cmd, prev)`.

| Capability / action | **Cloud** (`controlUnit` JSON) | **Local** (UDP) |
|---|---|---|
| `onoff` on/off/toggle | `{ OnOff: { value: 0\|1 } }` | `0x20` SetTargetLevel, level `0`/`255` |
| `brightness` set (0–100) | `{ Dimmer: { value: 0..1 } }` | `0x20`, level `round(pct/100*255)` |
| `brightness` on / off | `{ Dimmer: { value: 1\|0 } }` | `0x20`, level `255`/`0` |
| `color` kelvin | `{ ColorTemperature:{value:K}, Colorsource:{source:"TW"} }` | `0x48` SetColorTemperature, Tc = real Kelvin |
| `color` hue/sat | `{ RGB:{hue:0..1,sat:0..1}, Colorsource:{source:"RGB"} }` | `0x3D` SetColorHueSat, hue 16-bit, sat 0–254 |
| `position` open | `{ Slider: { value: 100 } }` | `0x3F` SetTargetElements `[index 1, value 255]` |
| `position` close | `{ Slider: { value: 0 } }` | `0x3F` SetTargetElements `[index 1, value 0]` |
| `position` set % | `{ Slider: { value: pct } }` | `0x3F` `[index 1, round(pct/100*255)]` |
| `position` stop | ❌ null | ❌ null (no documented element) |

Element **index 1 is the position slider**, and a slider element's value *is* the position on a
0–255 scale — open and close are simply the two ends of its travel, not separate controls. This is
live-confirmed: writing value `1` parked a real curtain at 0.4% (= 1/255).

An unmapped command throws `casambi: unsupported command for <capability>` — it is never silently
dropped and never fabricated.

### 5.1 Local UDP wire format

```
<netId> . <direction> . <length> . <opcode> . <args…> \r\n      ("hex with dot")
```
* `direction`: `0x72` = to Casambi, `0x70` = from Casambi
* `length` = `1 + args.length` (opcode counts, arguments follow)
* `dec-hash` format uses `#` separators and decimal — selected by `dataFormat`

**Targeting** (identical across every targeted opcode):

| Target_Type | Target_ID | Meaning |
|---|---|---|
| 0 | 0 | Broadcast |
| **1** | **1–250** | **Device address ← what this driver always uses** |
| 2 | 0 / 1–255 | Ungrouped devices / group address |
| 3 / 4 | 1–255 | Scenes (active only / all) |
| 5 | 0–255 | All luminaires of one manufacturer |

**Critical implementation note (`0x20`):** its `Duration` field is *optional* per the docs, but a
real Lithernet gateway parses the opcode **positionally** against the full layout. Sent short, it
reads the Target_Type/Target_ID bytes as Duration and falls back to Target_Type 0 / Target_ID 0 —
**broadcast**. The driver therefore **always** sends an explicit `0` fade:

```
correct:  c.72.6.20.ff.0.0.1.18     level=FF, dur=0, TT=1, TID=0x18  → one unit
broken:   c.72.4.20.ff.1.18         gateway reads 1,18 as duration   → whole network
```

---

## 6. Discovery

### 6.1 Cloud
`GET /v1/networks/{id}` enumerates every unit and group instantly. `raw.room` is populated from the
unit's `groupId` → group name, which the Room Assignment Engine uses at commissioning.

### 6.2 Local (progressive, UDP-only)
Units materialise from `0x4B NotifyControlValues` packets. `updateUnitFromControlValues()` decodes:

| Type | Meaning | Size | Mapped to |
|---|---|---|---|
| 1 | Dimmer channel | 1 | `dimLevel`, `dimmer` control |
| 6 | Device temperature | 1 | `sensors.temperature` |
| 7 | Battery level | 1 | `sensors.battery_level` |
| 10 | Colour temperature | 1 | `colortemperature` control (normalised byte) |
| **15** | **Slider (custom element)** | **2 LE** | **`slider` control, min 0 / max 255 → `position`** |
| 16 | On/off toggle | 1 | `on` |
| 20 | Light sensor lux | 2 | `sensors.lux` |
| 21 | Presence sensor | 1 | `sensors.presence` |

Deliberately unmapped: 3 (hue/sat), 4 (XY), 5 (colour-source selector), 11 (white channel) — their
byte layouts are documented but not enough to build a Supreme state without guessing.

Long-form entries (`0x80` bit set) carry `INDEX` and `LEN`, e.g. `0x90` = indexed on/off element.

### 6.3 Cloud-assisted enrichment for Local mode

Local UDP carries **no names, no groups, no fixture metadata**. Three optional one-time actions fill
that in. None of them create a standing Cloud dependency — command, feedback and live state stay on
Local UDP unconditionally.

| Method | What it does |
|---|---|
| `syncNamesFromCloud(creds)` | Renames units already discovered locally. Returns `{matched, total, networkName}`. |
| `discoverFromCloud(creds)` | Pre-populates the fixture list before local UDP has heard anything: `createSession` → `fetchNetwork` → `fetchState` → **brief WebSocket burst** → merge. New units are flagged `awaitingLocalSignal` until a real UDP packet confirms them. Returns `{discovered, total, networkName}`. |
| `discoverGroups()` | Group-level view of the cached model; membership derived from each unit's own `groupId`. |

**Why `discoverFromCloud` opens a short WebSocket:** `GET /v1/networks/{id}` returns *structural
fields only* (no `controls`), and even `/state` was live-confirmed to under-report a real
DALI-bridged CCT fixture as "Dimmer" only. The Cloud mode's own always-open wire reports `CCT`
correctly for the same unit — so Local's one-time enrichment opens that same wire for ~1.5 s, merges
what it reports, and closes it.

**Merge rules (important):** controls are unioned **by control type**, and structural fields
(`groupId`, `fixtureId`, `type`, `address`) fill gaps only — a real local value is never overwritten
by the Cloud's older copy, and a later partial UDP update can never delete a control type already
known.

---

## 7. State & feedback

`statesFromUnit(unit)` produces one Supreme `CapabilityState` per derived capability:

| Capability | State shape |
|---|---|
| `onoff` | `{ kind:"onoff", on }` |
| `brightness` | `{ kind:"brightness", on, level 0-100 }` |
| `color` | `{ kind:"color", on, level, hue, saturation, kelvin }` |
| `position` | `{ kind:"position", position 0-100, moving:false }` (normalised via the slider's own min/max) |
| `sensor` | `{ kind:"sensor", value, unit, measure }` |

Kelvin is only reported when the value is `>= 0x400` (a real Kelvin reading). The Local
`NotifyControlValues` CCT byte is a *normalised* 0–255 value with no per-fixture range available, so
`kelvin` is honestly left `null` there while the `color` capability itself is still surfaced.

Signals are normalised by `event-engine.ts` into one transport-independent taxonomy —
`unit`, `unitRemoved`, `button`, `scene`, `networkUpdated`, `wireStatus`, `pong` — consumed by
`applySignal()` regardless of which transport produced them. Subscribe via `onState()` (capability
state) or `onDriverEvent()` (device / button / scene / sensor / network / diagnostic events).

---

## 8. Gateway REST surface

All under `services/gateway/src/routes/installer.ts`, authenticated + permission-checked.

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/drivers/:id/casambi/diagnostics` | Full driver diagnostics snapshot |
| GET | `/v1/drivers/:id/casambi/transport-monitor` | Layered Transport / Adapter / Driver / NATS view |
| POST | `/v1/drivers/:id/casambi/sync-names` | One-time Cloud name sync (Local mode) |
| POST | `/v1/drivers/:id/casambi/discover-from-cloud` | One-time Cloud device pre-discovery (Local mode) |
| GET | `/v1/drivers/:id/casambi/groups` | List groups + real unpaired counts |
| POST | `/v1/drivers/:id/casambi/groups/:groupId/pair` | Commission every unpaired member into the room named after the group |
| POST | `/v1/commissioning/casambi/test-connection` | Staged Local REST + UDP connectivity report |
| POST | `/v1/commissioning/casambi/discover-gateway` | Honest "not available" explanation (no discovery API exists) |

**Group → room pairing** passes `roomNameHint = <group name>` into the shared
`resolveOrCreateRoom()` every protocol uses: match an existing Supreme room by (punctuation- and
case-normalised) name, else create it. Already-owned members are excluded by the same rule that
stops rescans duplicating devices, so re-pairing a group is idempotent; one member failing never
aborts the rest.

---

## 9. Module map

| File | Responsibility |
|---|---|
| `casambi-driver.ts` | The driver class; lifecycle, bindings, command dispatch, state cache |
| `connection-manager.ts` | Mode selection / connection construction |
| `cloud-transport.ts` | Cloud REST + WebSocket (`HttpCasambiTransport`) |
| `local-transport/udp-codec.ts` | Byte-exact packet encode/decode, opcode table, control-type table |
| `local-transport/udp-engine.ts` | Socket lifecycle, counters, latency, packet traces |
| `local-transport/rest-client.ts` | Gateway REST (HTTP Basic Auth) — the one documented write endpoint |
| `entity-mapper.ts` | Unit → capabilities/state; Supreme command → Cloud `targetControls` |
| `local-command-mapper.ts` | Supreme command → UDP packet |
| `local-discovery.ts` | `NotifyControlValues` → unit model |
| `discovery-engine.ts` | Unit/group maps → Supreme discovery contract; UDP discovery start/stop |
| `command-engine.ts` | `CloudCommandEngine` / `LocalCommandEngine` |
| `event-engine.ts` | Cloud events + UDP packets → one signal taxonomy |
| `feedback-engine.ts` | Cloud `controlUnit` framing |
| `health-monitor.ts`, `diagnostics.ts`, `transport-monitor.ts`, `receive-pipeline.ts` | Health verdicts, diagnostics snapshots, staged receive-path verification |

---

## 10. Known limitations (honest, by design)

### 10.1 No gateway auto-discovery
The Lithernet documentation defines **no** network discovery API — no REST enumeration, no
SSDP/mDNS profile. The gateway IP must be entered manually. Implementing a speculative scan would be
fabricating a protocol the vendor never defined.

### 10.2 No names or rooms over Local UDP
Verified against every locally reachable interface (UDP, the full WebAPI, the web UI, `.ceg` export,
the Diagnostics console). Names and group names exist only in the Casambi Cloud account.

### 10.3 Curtain position: fully supported; "stop" is not
Open, close and set-to-X% all drive custom element **index 1** (the position slider) with `0x3F`,
value scaled to 0–255. Position **status** is read from the type-15 slider notification on the same
scale (live-confirmed: `0x88` = 136 = 53.3%).

`stop` remains unmapped — no documented element corresponds to it, and inventing one would be
fabricating a wire address.

### 10.4 Not fetchable from Casambi at all
| Feature | Status |
|---|---|
| Groups | ✅ fetchable (`GET /v1/networks/{id}` → `groups`) |
| Scenes | ✅ fetchable (same call → `scenes`) — **currently parsed away, not yet surfaced** |
| Automations | ❌ no enumeration; only a "start/resume automation" *write* (`0x4A`) |
| Timers / schedules | ❌ no enumeration; only observable as a priority code on a unit (11 = date timer, 12 = clock timer) |
| Animations | ❌ no API at all |

### 10.5 Other documented gaps
* RGB/XY colour **inference from Local control values** is not implemented (types 3/4/5/11 unmapped).
* Packet capture into the binary `PacketRecorder` framework is not wired up (text tracing works).
* In-memory only: units, groups and names are **not persisted**, so a gateway restart clears them
  until the next Cloud sync (fixtures re-appear from UDP by themselves; groups and names do not).

---

## 11. Live-confirmed bug fixes worth knowing

These were all found against real hardware and are the reason several behaviours look the way they do.

| Fix | Root cause |
|---|---|
| Level commands hit the whole network | `0x20` sent without the optional Duration bytes; the gateway parsed the target bytes as duration and fell back to broadcast. Now always sends an explicit `0` fade. |
| Session creation 404 | `networkId` was posted as a URL **path segment**; the real API takes it as a **query parameter** on `/v1/networks/session`. |
| Fixtures stuck as "dimmable" | Three separate causes: `discoverFromCloud` skipped already-known units; `mergeUnit` replaced the whole controls array on partial updates; and `fetchNetwork` alone never returns `controls` (needs `/state` + a WebSocket burst). |
| Groups and room hints always empty in Local mode | The merge for already-known units copied only `controls`, never `groupId` — and local UDP never sets it, so every unit had `groupId === undefined`. |
| `0x3E` vs `0x3F` ambiguity | System Manual 6.38 §5.12.2.2.18 states `0x3F` in both heading and body, confirming the encoder was already correct. |
| Curtain parked at 0.4% whatever was commanded | Open/close were written as an on/off "press" (`value 1`). Element 1 is the *slider*, so the gateway applied 1 as a position — 1/255 = 0.39%. A slider element's value is the position itself. |
| Curtain position always read as 100% | Cloud advertises `"Slider"` (min 0 / max 100) and Local builds `"slider"` (min 0 / max 255); controls were deduped by **case-sensitive** type, so both survived and state normalised against whichever came first. Now keyed by lowercased type. |

---

## 12. Quick operational runbook

**Local mode, from scratch:**
1. Extension Center → Supreme Casambi → set Connection type = *Local Gateway*.
2. Enter Gateway IP, REST port, gateway username/password, UDP port, Net ID, Data format → **Save configuration**.
3. **Test Connection** — expect REST ✓, HTTP Auth ✓, Gateway ✓, UDP ✓.
4. Enter the project's Casambi network admin email/password → **Save configuration**.
5. **Discover devices from Cloud** → **Sync names from Cloud** (gives names, groups, full capabilities).
6. Discover Devices → **Rescan** → pair fixtures individually, or use the **Groups** chip to pair a whole group into its room.

> After **any** gateway restart or `update.sh`, repeat step 5 — group names and Cloud-derived
> capabilities live in memory only.

**Cloud mode:** set Connection type = *Cloud*, enter email/password (+ optional internal network id),
save, connect. Groups, names and capabilities are all available immediately.

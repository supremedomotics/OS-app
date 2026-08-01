# Casambi Local Gateway Protocol & SupremeOS Core — Architecture

> Companion to `services/protocols/src/casambi/` (the driver) and
> `services/protocols/src/core/` (the cross-driver primitives this PR introduced). For session-
> level history see `SESSION_HANDOFF.md`; for open follow-up work see `TODO.md`.

## What this is, in one sentence

The Casambi driver now speaks a **real** local wire protocol — the Lithernet gateway's "UDP
Casambi Command" mode — alongside its existing, unchanged Casambi Cloud (REST + WebSocket) path,
and both share a new, protocol-agnostic **SupremeOS Core** (`services/protocols/src/core/`) that
every future native driver (KNX/Matter/Lutron/RTI/Denon/DALI/Apple TV/Home Assistant/Bluetooth/
MQTT) can build on without inventing its own event taxonomy, capability-flag logic, or health/
metrics scoring.

## 1. SupremeOS Core (`services/protocols/src/core/`)

Five modules, none Casambi-specific:

| Module | Purpose |
|---|---|
| `event-bus.ts` | `CoreEventBus` + a 13-category event taxonomy (Device/Button/Sensor/Lighting/Media/Climate/Automation/Scene/Group/Diagnostic/Driver/Network/Health). Every interface's doc comment states which driver actually emits it today. |
| `capability-engine.ts` | `computeEntityCapabilities()`/`computeDriverCapabilities()` — pure functions turning a device's real `CapabilityKind[]` + structural color config into flat boolean flags. Never a device-type or protocol check. |
| `packet-recorder.ts` | `PacketRecorder` — a bounded ring buffer (capture/query/filter/export), architecture only per design: no protocol-specific parsing lives here. |
| `driver-health-engine.ts` | `computeDriverHealth()` — one health score + verdict from five lifecycle states + error/warning/reconnect/packet-loss counters. |
| `driver-metrics-engine.ts` | `DriverMetricsEngine` — sliding-window rate counters (packets/commands/events per sec) + cumulative counters (REST requests/UDP events/reconnects/dropped) + latency tracking. |

**Honesty note:** `casambi-driver.ts` does not yet publish through `CoreEventBus` — it still uses
the Foundation-session, Casambi-only `event-engine.ts`. Migrating it is real, scoped follow-up
work (see `TODO.md`), deliberately not done in the same change that added the real Local UDP
protocol, to avoid re-touching tested Cloud event-emission code in the same pass.

## 2. The Lithernet "UDP Casambi Command" protocol

Source: `Lithernet_UDP_Developer_Reference.pdf` §5.10 (the operating mode itself), plus §5.14
(`Lithernet_WebAPI.pdf`, the one REST endpoint). Both are reproduced byte-exact in
`services/protocols/src/casambi/local-transport/udp-codec.ts`'s doc comments, with page-number
citations — read that file's top-of-file comment before touching any encoder/parser.

### 2.1 Wire shape

```
Net_ID . Command_Direction . Length . Opcode . Args...  \r\n     (hex-with-dot, dot-separated, lowercase hex)
Net_ID # Command_Direction # Length # Opcode # Args...  \r\n     (dec-with-hash, decimal)
```

- `Net_ID`: 0-254 (255 = broadcast to all gateways on the network).
- `Command_Direction`: `0x70` (from Casambi) / `0x72` (to Casambi).
- `Length`: `1 + argument count` (opcode itself counts as 1) — this codec always **derives** Length
  from the actual argument list via this formula, never from a per-opcode caption, because two of
  the doc's own worked examples (0x2F, 0x3D) contradict their own caption by exactly one (see
  §3 below).
- Both text formats are supported; the gateway's own "DEC or HEX" setting picks one, and the
  driver's Local Gateway config (`dataFormat`) must match it exactly or nothing parses.

### 2.2 Module map

| File | Role |
|---|---|
| `local-transport/udp-codec.ts` | Byte-exact encode/decode. Every opcode this reference documents (encoders for commands *to* Casambi, parsers for responses *from* Casambi), plus the Target_Type/Target_ID addressing scheme, fade-time (10ms units) helpers, and the NotifyControlValues short/long-form control-type table. |
| `local-transport/udp-engine.ts` | Real `node:dgram` UDP4 socket (injectable `socketFactory` for tests). `send()`, `onPacket()`/`onError()`/`onDecodeError()`, and `probe()` — a safe, never-actuating reachability check (opcode 0x39, `Request=0xFF` "own node") used by both Test Connection and (potentially) a future health heartbeat. |
| `local-transport/rest-client.ts` | The one documented REST endpoint, `GET /set/target_value` (§5.14.1). `fetchNetwork`/`fetchState` honestly reject — no such endpoint exists anywhere in the supplied reference set. `testConnection()` never calls the write endpoint. |
| `local-discovery.ts` | `updateUnitFromControlValues()` — folds a NotifyControlValues (0x4B) response into the SAME `CasambiUnit` shape Cloud already uses, so `entity-mapper.ts`'s `capabilitiesFromUnit`/`statesFromUnit` need no Local-specific branch. |
| `local-command-mapper.ts` | `localCommandToUdpPacket()` — the Local analogue of `entity-mapper.ts`'s `commandToTargetControls()`, mapping a Supreme command onto a real UDP opcode. |
| `casambi-driver.ts` | Orchestrates the above: `connect()` starts the UDP engine and sends the documented bootstrap sequence (SetDefaultMask → Subscribe → NotifyButtonEvent enable); incoming packets route by opcode; `command()` sends real UDP for onoff/brightness/color. |

### 2.3 Why discovery is progressive, not instant

No REST or UDP endpoint anywhere in the supplied reference set lists devices, groups, or scenes.
The only real signal is subscribing to NotifyControlValues (0x4B) for all devices (Target_ID 0) —
each unit's *set of reported control-value TYPE ids* tells us which Supreme capabilities it
actually has, mirroring exactly how Cloud's `capabilitiesFromUnit` reads a unit's `controls`
array. This means a unit only becomes visible once its first NotifyControlValues packet arrives —
an honest architectural difference from Cloud's instant `/units` REST fetch, not a bug, and it
must stay visible in Diagnostics rather than presented as equivalent to Cloud's behavior.

### 2.4 What Local mode does NOT do (honest, disclosed gaps)

- **Color capability inference.** `local-discovery.ts` does not map NotifyControlValues types
  2 (Color Temperature), 3 (Hue/Saturation), 4 (XY color), 5 (Color Source Selector), or 11 (White
  channel) into the `color` capability. Type 2's one documented byte has no stated Kelvin range or
  normalization at this layer (unlike the SET-side opcode 0x48, which documents both a direct
  Kelvin range and a separate normalized form) — reporting a `kelvin` value from it would be a
  guess. A dimmable+color Casambi luminaire commissioned over Local today only exposes
  `onoff`/`brightness`.
- **RGBW as a Supreme capability**, full stop — this is a `core/capability-engine.ts` limitation
  that predates and is independent of Local Gateway: `packages/domain-model`'s `ColorCapabilityConfig`
  has no distinct white-channel field, so `supportsRGBW` is hard-coded `false` everywhere, even
  though Casambi's own wire protocol (0x2F, 0x49) has a real, independent `W` component.
- **Reconnect loop.** UDP is connectionless; a lost socket or an unresponsive gateway is not
  automatically detected or recovered from today (Cloud's capped-exponential-backoff reconnect
  loop has no Local equivalent yet).
- **0x0D Scene called → a typed event.** Currently logged via the tracer only. Its 8-bit,
  installer-app-configured payload has no unitId/sceneId — `SceneEvent`'s contract doesn't fit it.
- **Packet Recorder wiring.** `core/packet-recorder.ts` exists and is tested; nothing feeds the
  real UDP engine's datagrams into it yet, so the Driver Manager's "Packet Capture" toggle stays a
  disabled placeholder.
- **`CoreEventBus` migration** — see §1's honesty note.

## 3. Documentation inconsistencies found (flagged, not silently resolved)

Three real inconsistencies were found in the supplied Lithernet reference PDFs while implementing
this codec byte-exact. Each is called out in a code comment at the exact function it affects, in
`local-transport/udp-codec.ts`:

1. **0x1A vs 0x1B (SetParameterValue / ParametersComplete).** §5.10.2.1.2's section heading reads
   "0x1A - SetParameterValue" but its own body states "Opcode: 0x1B" — identical to the very next
   section's opcode for the unrelated ParametersComplete marker. Disambiguated by the declared
   Length field (3 vs 1), exactly as both sections themselves specify.
2. **0x3E vs 0x3F (SetTargetDimmers / SetTargetElements).** §5.10.2.2.18's heading reads "0x3F -
   SetTargetElements" but its body states "Opcode: 0x3E" — identical to SetTargetDimmers
   immediately above it. Resolved by following the section title (a judgment call, not a verified
   fact — flag this if real hardware ever contradicts it).
3. **0x2F/0x3D Length undercounts by one.** Both opcodes' own worked examples (`0.72.7.2f...` and
   `0.72.7.3D...`) show a Length token of `7` immediately followed by 7 data bytes, which
   contradicts the document's own universal framing rule (`length = opcode + arguments`, i.e.
   `1 + 7 = 8`). This codec always derives Length from that universal formula, never a per-opcode
   caption — see `udp-codec.test.ts` for the byte-exact case demonstrating why matching the doc's
   literal example would silently break interoperability with a gateway that implements the
   formula correctly (as it does for every other multi-field opcode).

## 4. Testing

`services/protocols/src/casambi/local-transport/udp-codec.test.ts` (39 tests) verifies the frame
codec, every encoder/parser, and both flagged Length/opcode inconsistencies — several assertions
are byte-exact against the reference PDF's own worked examples. `udp-engine.test.ts` (13, fake
`node:dgram` socket) and `rest-client.test.ts` (6, fake `fetch`) exercise the two real transports
without a live gateway. `local-discovery.test.ts` (8) and `local-command-mapper.test.ts` (10)
cover the discovery/command mapping layers. `casambi-driver.test.ts` has a dedicated "Local
Gateway, fake UDP socket" suite (12 tests) covering the full connect/bootstrap/discover/
command/button-event/node-removal/diagnostics lifecycle end to end. `core/*.test.ts` (5 files)
cover the cross-driver primitives independently of Casambi.

None of this has been verified against a real Lithernet gateway — see `TODO.md`.

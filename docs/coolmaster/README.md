# Supreme CoolMaster Driver

A native driver for CoolAutomation's **CoolMasterNet / CoolLinux** HVAC gateway — VRF/VRV
air-conditioning bridges (Daikin, Mitsubishi, Toshiba, and other CoolMasterNet-supported
brands). Speaks the gateway's **ASCII_IF** protocol (TCP) and **REST v2** API on the local
network — no cloud dependency, no Home Assistant, no Node-RED.

This is a ground-up rewrite. The previous driver (`coolmaster-driver.ts` /
`coolmaster-codec.ts`, ASCII_IF-only, `onoff` + `temperature` only) has been fully removed;
nothing of its architecture, parsing, or command set was reused.

## Reference material

The six protocol-outline documents this driver was built against live alongside this file
in `docs/coolmaster/`. **Important context**: those documents are a detailed *requirements
scaffold*, not filled-in vendor documentation — every section is explicitly marked with
notes like *"NOTE: Populate this document with the official PRM syntax... This document
provides the implementation framework"*. They correctly enumerate the full ASCII_IF command
surface and give some concrete REST details (port 10103, URL shape, JSON field names), but
they do not specify exact wire syntax, response envelopes, or parameter encodings for every
command. Where a command's exact grammar wasn't available anywhere in the provided material,
this driver says so explicitly (see **Limitations** below) rather than fabricating one —
per the standing instruction to never guess when a genuine answer isn't available.

## Architecture

Flat, prefixed files in `services/protocols/src/` (`coolmaster-*.ts`), matching this
repo's convention for every other protocol driver (no nested per-driver folders):

| File | Responsibility |
|---|---|
| `coolmaster-types.ts` | Shared TypeScript types (UID/unit/gateway/config shapes) |
| `coolmaster-constants.ts` | Documented defaults (ports, poll intervals, HTTP status classification) |
| `coolmaster-errors.ts` | Typed error hierarchy with a `retryable` flag |
| `coolmaster-logger.ts` | Structured, debug-gated logging |
| `coolmaster-capabilities.ts` | `ClimateCapabilityConfig` — declares which advanced controls a unit actually supports |
| `coolmaster-ascii-protocol.ts` | Raw ASCII_IF TCP transport (FIFO request/response framing) |
| `coolmaster-rest-protocol.ts` | REST v2 JSON transport (status polling only — see below) |
| `coolmaster-connection.ts` | Owns both transports, picks REST-if-usable/ASCII-otherwise, exponential-backoff reconnect |
| `coolmaster-parser.ts` | Parses both wire formats into typed models |
| `coolmaster-commands.ts` | Builds outgoing ASCII_IF command strings, one function per documented command |
| `coolmaster-mapper.ts` | The **only** file that imports `@supreme/domain-model` — translates wire models ↔ Supreme capabilities |
| `coolmaster-discovery.ts` | Full discovery pass: gateway, lines, units, groups, water heaters, ventilation |
| `coolmaster-cache.ts` | Per-unit state cache with change detection + missed-poll → offline tracking |
| `coolmaster-events.ts` | Internal pub/sub, decoupled from Supreme's `StateListener` |
| `coolmaster-polling.ts` | Fast/slow/discovery poll scheduler + priority/dedup command queue |
| `coolmaster-driver.ts` | `CoolMasterProtocolDriver` — the `INativeProtocolDriver` orchestrator |

```
Gateway
 └── HVAC Line (L1, L2, …)
      └── Indoor Unit (onoff + temperature, with fan speed/swing/filter/
          demand/fault/lock/inhibit riding in temperature.advanced)
 └── Group (onoff + temperature, aggregated from member units)
 └── Water Heater (onoff + temperature, heat-only)
 └── Ventilation / VAM (fan)
 └── Main Controller (onoff)
```

## Transport strategy: REST vs ASCII_IF

Per the requirement *"REST should be preferred for JSON status retrieval. ASCII_IF should
be used where required by the protocol"*:

- **REST v2** (`GET /v2.0/device/{serial}/ls2`) is used for routine status polling when
  reachable and `protocol` isn't forced to `"ascii"` — native JSON, no line parsing.
- **ASCII_IF** carries every command (on/off/mode/temp/fan speed/swing/lock/inhibit/…),
  full discovery (gateway info, HVAC lines, secondary device types), and status polling
  whenever REST isn't reachable.

**REST v1 (ASCII-over-REST) is intentionally not implemented.** The reference material
names it ("Purpose: Execute ASCII_IF commands through REST") but never specifies its
response envelope beyond "Response object - Exit code", with no example. Fabricating a
JSON shape with no way to verify it against a real gateway would violate the "don't guess"
instruction and would likely just be wrong. REST v2 (documented, JSON, `ls`/`ls2`) plus
ASCII_IF (everything else) together already satisfy the stated requirement without this gap
— see `coolmaster-rest-protocol.ts` for the full reasoning.

Gateway identity (serial number, needed to build any REST URL) is always bootstrapped via
one ASCII_IF `info` command on connect, regardless of the configured protocol mode — REST
v2's URL scheme is serial-scoped and there's no documented serial-less way to learn it.

## Configuration

| Field | Env var | Default |
|---|---|---|
| `host` | `SUPREME_COOLMASTER_HOST` | *(required)* |
| `protocol` | `SUPREME_COOLMASTER_PROTOCOL` | `auto` (`auto` \| `ascii` \| `rest`) |
| `asciiPort` | `SUPREME_COOLMASTER_ASCII_PORT` | `10102` |
| `restPort` | `SUPREME_COOLMASTER_REST_PORT` | `10103` |
| `pollMs` | `SUPREME_COOLMASTER_POLL_MS` | `10000` (fast tier: HVAC state, faults, temperature) |
| `slowPollMs` | `SUPREME_COOLMASTER_SLOW_POLL_MS` | `300000` (slow tier: line/config info) |
| `discoveryIntervalMs` | `SUPREME_COOLMASTER_DISCOVERY_INTERVAL_MS` | `1800000` (full re-discovery) |
| `timeoutMs` | `SUPREME_COOLMASTER_TIMEOUT_MS` | `5000` |
| `retryCount` | `SUPREME_COOLMASTER_RETRY_COUNT` | `3` |
| `debug` | `SUPREME_COOLMASTER_DEBUG` | `false` |

Configuration is validated at startup (`host` is required; a missing host throws
`CoolMasterConfigError` before any connection is attempted). The Driver Manager UI
generates a matching config page automatically from the manifest in
`services/drivers/src/manifests.ts` (`supreme-coolmaster`, v2.0.0).

## Installation

1. Set `SUPREME_COOLMASTER_HOST` (and optionally the other `SUPREME_COOLMASTER_*`
   variables — see `infra/hub-compose/.env.example`) to the gateway's LAN IP.
2. Boot the gateway (`createHubContext` wires the driver in automatically when
   `config.coolMasterHost` is set — see `services/gateway/src/bootstrap.ts`).
3. On connect, discovery runs automatically: gateway identity, HVAC lines, every indoor
   unit, and (if present) groups/water heaters/ventilation. **No manual unit mapping is
   required or possible** — units simply appear as Supreme devices.

## Discovery

Runs on: initial connect, automatic reconnect, the configured `discoveryIntervalMs`, and
on-demand (`driver.discover()`). Indoor-unit discovery is bulk (one `ls2` request covers
every unit) plus one `query <uid>` per unit **only during discovery, never during routine
polling** — querying hundreds of units individually on every 10-second poll would violate
the "avoid unnecessary API traffic" requirement at real-world VRF fleet scale.

Water heater / ventilation / main controller / group discovery each run independently and
fail *gracefully*: an installation with none of a given type is normal, not a driver error
— one type's "unsupported command" response never blocks indoor-unit discovery (the type
every installation has) or the other optional types.

## Supported HVAC commands

| Command | Confidence | Notes |
|---|---|---|
| `on` / `off` | High | Matches the prior driver's validated behavior |
| `allon` / `alloff` | High | Optional HVAC-line scope |
| `cool`/`heat`/`auto`/`dry`/`fan` | High | The mode word IS the command |
| `temp` | High | Setpoint in °C |
| `ls` / `ls2` | High | Basic / extended listing |
| `stat` | High | Immediate status refresh |
| `query` | High | Per-unit detail (swing/filter/demand/fault/lock/inhibit) |
| `info` / `line` | High | Gateway identity / HVAC line config |
| `fspeed` | Medium | Verb documented; argument spelling best-effort |
| `swing` | Medium | Brand-variant values, passed through verbatim |
| `filt` (reset) | Medium | `reset` argument is inferred, not confirmed |
| `lock` / `inhibit` | Medium | `on`/`off` argument inferred |
| `wh` (water heater) | Low | Named only in the docs — grammar inferred from the protocol's one consistent verb+UID pattern |
| `main` (main controller) | Low | Same |
| `vam` (ventilation) | Low | Same |
| `group` | Low | Power control inferred; **group membership (create/add/remove) is NOT implemented** — no basis to infer that syntax at all |
| `va` (Virtual Address) | **Not implemented** | Named with no behavior detail whatsoever ("Maintain persistent mapping") — nothing to infer a command grammar from |

## Feedback

`onState` publishes Supreme `CapabilityState` events immediately when a value actually
changes (deep-equal change detection, matching every other driver in this codebase).
Commands are **confirmed**, not optimistically guessed: after sending a command's ASCII_IF
line(s), the driver immediately performs a real follow-up read (bulk `ls2` for indoor
units/groups; a targeted re-list for water heater/ventilation/main-controller) and
publishes the actual resulting state — a guessed post-command state could be wrong if the
unit clamped an out-of-range setpoint or ignored an unsupported value.

A unit missing from 3 consecutive polls is marked offline (`coolmaster-cache.ts`) rather
than silently kept at its last-known state forever.

## Error handling & recovery

- Connection loss (gateway reboot, Ethernet drop) → automatic reconnect with exponential
  backoff (`backoffBaseMs` → `backoffMaxMs`, configurable).
- Command timeout / transient network error → retried up to `retryCount` times.
- Malformed response / unsupported command → `CoolMasterProtocolError` /
  `CoolMasterUnsupportedCommandError`, not retried (retrying an inherently-invalid request
  can't help).
- REST unreachable → silent fallback to ASCII_IF for that read; REST retried on the next
  reachability probe.

## Limitations (explicit accounting)

Per the instruction to list any unimplemented documented feature with its reason rather
than silently omit it:

1. **REST v1 (ASCII-over-REST) is not implemented** — its response envelope is undocumented
   in the available reference material. REST v2 + ASCII_IF together cover the full
   requirement.
2. **`va` (Virtual Address) is not implemented** — the docs give no behavior detail to
   infer a command grammar from at all, unlike `wh`/`main`/`vam`/`group` (which at least
   describe a clear real-world action).
3. **Group membership management (create/add/remove) is not implemented** — only group
   *discovery* (reading existing groups) and *power control* (`group <id> on|off`,
   inferred) are. No basis exists to infer the create/delete/update syntax.
4. **Ventilation (VAM) fan speed is approximated.** Supreme's `fan` capability has a fixed
   3-value preset enum (`auto`/`sleep`/`turbo`) that doesn't match VAM's real
   Auto/Low/Med/High vocabulary. The closest preset is used; Supreme's `sensor` capability
   can't losslessly hold the real word either (its `value` is strictly numeric), so the
   approximation is documented here rather than forced into a schema it doesn't fit.
5. **`fspeed`/`swing`/`filt`/`lock`/`inhibit` argument spellings are best-effort
   (Medium confidence)** — the verbs are documented, their exact argument encoding isn't.
   If a real gateway rejects one of these, the fix is isolated to a single builder function
   in `coolmaster-commands.ts`.
6. **Water heater / main controller / ventilation command grammar is inferred (Low
   confidence)** — these types are named in the docs with real-world behavior described
   but no syntax given; implemented via the one consistent verb+UID pattern every other
   documented command uses.
7. **Temperature unit assumption**: a bare numeric token with no `C`/`F` suffix is treated
   as Celsius (Supreme's domain model is Celsius-only). A Fahrenheit-configured gateway
   whose responses never include an explicit suffix would need this cross-checked against
   its `set` output.

## Testing

- `coolmaster-parser.test.ts` (25 tests), `coolmaster-commands.test.ts` (14),
  `coolmaster-mapper.test.ts` (18) — pure-logic unit tests for every parsing/building/
  mapping function.
- `coolmaster-driver.test.ts` (9) — full integration tests against a fake in-process
  ASCII_IF gateway with real greeting/prompt/CR framing (not a mocked transport): connect,
  discovery, bind + initial state seeding, every command category, toggle resolution,
  unbound-device errors, poll-driven feedback, and functional automatic reconnect
  (verified by sending a real command after the simulated drop, not just checking a
  connected flag).

Run: `pnpm --filter @supreme/protocols test`.

## Troubleshooting

- **No units discovered**: confirm `SUPREME_COOLMASTER_HOST` reaches the gateway on port
  10102 (ASCII_IF) — `nc -zv <host> 10102`. Enable `SUPREME_COOLMASTER_DEBUG=1` and check
  logs tagged `[coolmaster:discovery]`.
- **Commands silently fail**: check for `[coolmaster:driver]` error-level logs — an
  `unsupported_command` error means this specific unit/gateway rejected that command;
  a `device_offline` error means the unit stopped responding on its HVAC line.
- **REST never gets used even with `protocol: "auto"`**: check the `REST v2 probe`
  debug log line — a `reachable: false` result means the gateway's port 10103 isn't
  answering; the driver falls back to ASCII_IF for everything in that case, which is
  correct behavior, not a bug.

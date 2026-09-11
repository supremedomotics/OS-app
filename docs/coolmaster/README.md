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
| `coolmaster-discovery.ts` | Full discovery pass: gateway, lines, units, groups, water heaters, ventilation, `props` friendly names |
| `coolmaster-gateway-discovery.ts` | **Gateway** discovery — finds CoolMaster gateways ON THE LAN, before any host is known (separate concern from the file above, which discovers what's *behind* an already-connected gateway) |
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
| `host` | `SUPREME_COOLMASTER_HOST` | *(required unless `autoDiscover: true`)* |
| `autoDiscover` | — | `false` — see **Gateway Auto-Discovery** below |
| `gatewaySerial` | — | *(optional)* disambiguates multiple discovered gateways, and re-finds THIS gateway after a DHCP IP change |
| `protocol` | `SUPREME_COOLMASTER_PROTOCOL` | `auto` (`auto` \| `ascii` \| `rest`) |
| `asciiPort` | `SUPREME_COOLMASTER_ASCII_PORT` | `10102` |
| `restPort` | `SUPREME_COOLMASTER_REST_PORT` | `10103` |
| `pollMs` | `SUPREME_COOLMASTER_POLL_MS` | `10000` (fast tier: HVAC state, faults, temperature) |
| `slowPollMs` | `SUPREME_COOLMASTER_SLOW_POLL_MS` | `300000` (slow tier: line/config info) |
| `discoveryIntervalMs` | `SUPREME_COOLMASTER_DISCOVERY_INTERVAL_MS` | `1800000` (full re-discovery) |
| `timeoutMs` | `SUPREME_COOLMASTER_TIMEOUT_MS` | `5000` |
| `retryCount` | `SUPREME_COOLMASTER_RETRY_COUNT` | `3` |
| `debug` | `SUPREME_COOLMASTER_DEBUG` | `false` |

Configuration is validated at startup (`host` is required UNLESS `autoDiscover` is true, in
which case `connect()` resolves it via a LAN scan instead — see below; a missing host with
`autoDiscover` unset throws `CoolMasterConfigError` before any connection is attempted). The
Driver Manager UI generates a matching config page automatically from the manifest in
`services/drivers/src/manifests.ts` (`supreme-coolmaster`, v2.0.0), plus a dedicated
multi-gateway setup wizard (see **Multiple Gateways** below).

## Installation

1. Either enable **automatic gateway discovery** (default in the setup wizard) or set
   `SUPREME_COOLMASTER_HOST` (and optionally the other `SUPREME_COOLMASTER_*` variables —
   see `infra/hub-compose/.env.example`) to the gateway's LAN IP manually.
2. Boot the gateway (`createHubContext` wires the driver in automatically when configured —
   see `services/gateway/src/bootstrap.ts`).
3. On connect, discovery runs automatically: gateway identity, HVAC lines, every indoor
   unit, friendly names (`props`), and (if present) groups/water heaters/ventilation.
   **No manual unit mapping is required or possible** — units simply appear as Supreme
   devices, named from the gateway's own `props` configuration when set.

## Gateway Auto-Discovery

`coolmaster-gateway-discovery.ts` finds CoolMaster gateways on the LAN so an installer never
has to type an IP address — a genuinely separate concern from indoor-unit discovery above
(which requires an already-connected gateway).

**This is NOT SDDP.** The CoolMaster PRM (`CoolMaster_Core_Reference_Part3_v1.0.txt` §5)
names an `sddp` command, but only as a gateway-side toggle ("Control4 discovery. Functions:
Enable - Disable - Identify - Offline - Alive") — it documents how an installer turns SDDP
on/off *on the gateway*, never what a CoolMaster SDDP reply actually contains on the wire
(no packet format, no port, no field names anywhere in the available reference material).
SDDP itself (Control4's multicast discovery protocol) is publicly documented in the
abstract, but CoolMaster's specific reply payload is not — implementing a client against a
guessed reply shape would be fabricating protocol behavior this driver has never verified,
so **no SDDP client is implemented**, and none of this driver's discovery, logs, or UI ever
describes what it does as SDDP.

Instead, gateway discovery uses **verified ASCII_IF identification**: it opens the same real
ASCII_IF TCP connection and prompt handshake (`CoolMasterAsciiTransport.connect()`) every
normal connection already uses, on each candidate LAN host, then reads `info` to confirm the
gateway actually responds to a real ASCII_IF command. A host that isn't a CoolMaster gateway
either refuses the connection, never produces the real `>` prompt within a bounded timeout, or
produces literally no response text to `info` — all three are rejected, never guessed at.

**Live-confirmed fix**: an earlier revision additionally required `info`'s response to contain
a recognizable serial-number field, on the (documentation-only, never hardware-verified)
assumption that a real gateway always reports one there. A real CoolMasterNet's actual `info`
output reports DIP-switch settings and per-line DC voltage/status instead — **no serial number
anywhere**:
```
DIP P: | X |ON | X | X |
DIP Q: |ON | X |ON | X | (Q2 or Q4 is OFF)
DIP R: | X | X | X | X | (R1 or R3 is OFF) (R2 or R4 is OFF)
DIP S: | X |OFF|OFF| X |
L1 DC- OFF 16V
L2 DC- OFF  0V
OK
```
That check silently rejected every real gateway from discovery. Confirmed against real
hardware and reverted — see `coolmaster-gateway-discovery.test.ts`'s live-confirmed-fix test,
which uses this exact captured output as its fixture. `info`'s content should NOT be assumed
to carry gateway identity; see **Gateway identity** below for what actually does.

Candidate hosts are the full `.1`-`.254` range of every non-internal IPv4 /24 subnet the hub
is directly attached to, probed with bounded concurrency (default 32 at a time) and a
per-host timeout (default 800ms) so one non-responsive host can never stall the whole scan.
Results are deduplicated by serial, so the same physical gateway answering through more than
one path still yields exactly one entry.

This module is a stage-agnostic building block on purpose (`DiscoveredCoolMasterGateway` is
just `{gatewayId, serial, host, asciiPort, firmwareVersion, application}`) — if CoolMaster's
real SDDP reply format is ever obtained and verified, an SDDP probe can be added as a faster
first stage ahead of the ASCII_IF fallback without changing this module's public shape or
anything downstream of it (the driver, the installer route, or the UI panel).

Discovery never sends anything beyond the connection handshake and a single read-only `info`
command — it cannot issue a control command or otherwise change gateway state.

**Gateway identity** is `coolmaster:<serial>` in principle — the serial number, never the IP,
which is only ever current configuration/state and can change on a DHCP lease renewal. In
practice, since `info` (the only bootstrap command run before a host is even known to be a
real gateway) doesn't report one, `serial` today falls back to the probed IP address itself
(`parseGatewayInfo`'s existing, honest "nothing recognizable, use what we have" behavior) —
so gateway identity is **effectively IP-based until a real serial-bearing command is found and
wired in** (`set`, per `CoolMaster_Core_Reference_Part3_v1.0.txt` §1, is the one other
documented command that names "Serial number" among its fields — not yet queried during
discovery, and its own response format is equally unverified against real hardware). Set
`gatewaySerial` in config to pin a specific gateway by whatever value discovery actually
returned for it (today, its IP) — reconnecting after a DHCP change requires re-discovering
with the new IP until real serial support is added.

## Friendly Names (`props`)

Every full discovery pass also runs the bare `props` command and parses it into a
`UID -> name` map (`coolmaster-parser.ts`'s `parsePropsBlock`). A discovered device's
display name (`suggestedName`) is the CoolMaster-configured name when one exists, falling
back to the bare UID (e.g. `L1.101`) when it doesn't — the UID itself is NEVER replaced as
the device's actual identity (`backendId`); the name is display metadata only.

**Cadence**: `props` runs once per FULL discovery pass (initial connect, automatic
reconnect, the periodic `discoveryIntervalMs` timer, and the explicit
`driver.refreshDiscovery()` rescan action) — never on fast polling, and never as part of the
lightweight per-command secondary-device refresh water heater/ventilation/main-controller
commands trigger. A gateway with no `props` support, or a transient failure reading it,
never fails the rest of discovery — indoor units, lines, and every other device type are
unaffected; only the friendly-name map comes back empty for that pass.

**Format confidence — LIVE-TESTED against real hardware, and the guessed format was wrong.**
`props` and `query <uid>` were both tried against a real CoolMasterNet unit with real names
already configured through the vendor's own app:

- Bare `props` returns a genuine, real response — but it's a **pipe-delimited table**, not
  the `<uid> name <name>` line shape this driver guessed from the SET form's own documented
  syntax:
  ```
    UID  |      Name      | Visi |      Modes      |   Fspeeds   | TLim | Cool | Heat |   Elocks  |
  -------+----------------+------+-----------------+-------------+--------------------+-----------+
  OK
  ```
  On this unit the table came back with a header and separator but **zero data rows**, even
  though the units genuinely have names set in the vendor app — the "Visi" (visibility)
  column suggests each property may need to be marked visible before it appears here, but
  this is unconfirmed.
- `props L1.101` (querying one specific unit) returned `Bad Format`.
- `query L1.101` (the SAME argument shape this driver already uses internally for swing/
  filter/demand/fault/lock/inhibit detail) returned the IDENTICAL `Bad Format` error on this
  same unit — meaning that enrichment call has likely never actually worked against this
  hardware either (silently: it's wrapped in try/catch and degrades to ls2-only data, so
  nothing crashes — the advanced controls it would populate simply stay correctly gated off,
  per `indoorUnitCapabilityConfig`'s null-checks, rather than breaking anything).
- REST v2 (port 10103) and a local web config UI (plain HTTP) are both unreachable on this
  unit, ruling out either as an alternative source.

**No further guesses were made against this conclusion** — three different inferred argument
shapes (`props <uid> name <name>`'s LIST form, `props <uid>`, `query <uid>`) all failed to
produce usable data on real hardware, and continuing to try syntax variations against a
live production gateway has a real cost. The parser's existing dual-layout tolerance is left
in place (harmless — it simply never matches this hardware's pipe-table format, degrading to
the honest "no name" empty map, exactly as designed for any unrecognized layout), and
`suggestedName` correctly falls back to the bare UID. **Getting real names from this
protocol requires either the official CoolMaster PRM's exact `props`/per-unit-query syntax
(not available in this repo's reference material) or CoolAutomation support confirming the
correct command** — this is the single highest-priority open item before friendly names can
work on real hardware; everything else in this driver (control, discovery, multi-instance,
gateway auto-discovery) is functioning correctly on this same real unit.

**Discovery-time naming**: `suggestedName` is a discovery-time *suggestion* — what a
not-yet-commissioned device is offered as by default, and what a rescan
(`driver.refreshDiscovery()`) updates for still-uncommissioned devices. It does not reach
into an already-commissioned device's installer-set SupremeOS name and silently overwrite
it. A CoolMaster-side rename never creates a duplicate device and never changes a device's
immutable UID-derived identity.

**SupremeOS → CoolMaster name synchronization** is the OTHER direction — see the dedicated
section below.

## Indoor-Unit Name Synchronization (SupremeOS → CoolMaster)

Whenever an installer renames an indoor-unit device in the SupremeOS UI, that name is
written to the CoolMaster gateway itself, live-confirmed via:
```
props L1.101 name Test
OK
```
The Supreme device's own `name` field is the single source of desired truth — there is no
separate "desired name" field to keep in sync with it; renaming a device in the UI IS
setting the desired CoolMaster name. This is a deliberate simplification: the task's own
model names `supremeName` and `coolMasterName` as conceptually distinct, but architecturally
`device.name` already IS `supremeName`, so introducing a second field would just be two
copies of the same value to keep consistent for no benefit.

### Command encoder (`coolmaster-commands.ts`)

`cmdPropsSetName(uid, name)` builds the command through a dedicated encoder,
`encodePropsName`, which NEVER concatenates untrusted UI text directly into the wire
command. It throws `CoolMasterValidationError` for:
- an empty name (after trimming leading/trailing whitespace — internal spaces like
  "Living Room" are preserved verbatim)
- a name containing CR or LF (would terminate the ASCII_IF command early and let the rest
  of the string be interpreted as a second command — the actual injection this prevents)
- a name containing `|` (reserved by this same gateway's own `props` LIST table format —
  see **Friendly Names** above; a name containing one would corrupt that table)
- a name longer than `PROPS_NAME_MAX_LENGTH` (currently 100) — **live-confirmed fix**: an
  earlier revision set this to 20 as a "conservative guess" at CoolMaster's own field size;
  real usage immediately hit a genuine, ordinary 22-character name ("Sample room for
  L1.101") silently blocked by that invented number before the write ever reached the
  gateway. This is now a pure sanity bound (guards against a pathological input), not a
  claim about hardware capacity — no documented or confirmed real maximum exists, so the
  gateway's own reply (`isPropsSetAck`) is the actual arbiter of whether a name is accepted;
  a real rejection surfaces as an honest sync failure instead of a silent client-side block.

### Response validation (`coolmaster-parser.ts`'s `isPropsSetAck`)

A write is only ever reported as `"synced"` after the gateway's own reply is inspected and
confirmed to contain a bare `OK` line (case-insensitive) — matching the live-confirmed
behavior exactly. `Bad Format`, `Unknown Command`, an empty response, or a thrown
timeout/connection error are ALL treated as failure; a successful wire round-trip alone
(no thrown error) is never enough to claim success.

### Driver API (`CoolMasterProtocolDriver`)

- `uidFor(deviceId)` — the CoolMaster UID a device is bound to, or `null`.
- `getCoolMasterName(deviceId)` — the name CoolMaster's `props` LIST currently reports for
  that device's UID (from the last full discovery pass), or `null`.
- `syncIndoorUnitName(deviceId, name)` — writes the name and returns
  `{ status: "synced" | "failed", error? }`. Reuses the SAME serialized command queue and
  connection every other CoolMaster command goes through (`CoolMasterCommandQueue.
  enqueue` + `CoolMasterConnection.executeAscii`) — no second networking path, no shelling
  out to `telnet`. Rapid renames for the same UID coalesce via the queue's existing
  dedupe-by-key mechanism: a queued-but-not-yet-started write for an older name is
  superseded by a newer one for the same UID and never reaches the wire. (A write already
  "in flight" — shifted off the queue and executing — cannot be cancelled this way, since
  a serialized queue has no way to abort in-progress work; it completes normally and the
  LATEST desired state is guaranteed to be applied by whichever write runs last.)
- `getNameSyncState(deviceId)` — the last-known sync outcome for this running session
  (diagnostics only; the durable record lives in the Supreme device's own metadata).

### Gateway-layer wiring (`installer-context.ts`, `routes/devices.ts`)

`PATCH /v1/devices/:id` — when the request includes a new `name` — calls
`InstallerServices.syncCoolMasterDeviceName(deviceId, name)` **fire-and-forget**, after the
local rename has already been persisted and the HTTP response is about to go out. The local
rename is never blocked on the gateway (§ "Do not block the UI waiting indefinitely for the
gateway") — the CoolMaster write happens in the background, bounded by the driver's own
existing per-command timeout/retry configuration.

`syncCoolMasterDeviceName`:
1. Finds the specific CoolMaster driver INSTANCE that manages this device (§ Multiple
   Gateways below) — a true no-op, not an error, for any device no CoolMaster driver
   manages at all (the overwhelming majority of renames).
2. Calls `driver.syncIndoorUnitName(deviceId, name)`.
3. Persists the outcome onto the device's own `metadata` bag (§ Local DB vs CoolMaster DB
   below) and appends a structured log line.

### Local DB vs CoolMaster DB

The Supreme device's own `metadata` (already a generic `Record<string, unknown>` bag every
driver stashes its own per-device state in — no new DB column, no migration) gains three
fields after every sync attempt:
```
metadata.coolMasterNameSyncStatus: "synced" | "failed"
metadata.coolMasterNameLastSync:   ISO-8601 timestamp
metadata.coolMasterNameSyncError:  string | null
```

### Startup/reconnect reconciliation (§ requirement 8)

After a CoolMaster driver instance reaches the "ready" lifecycle stage (initial connect,
reconnect, or a config-change re-registration — the exact same hook point every other
protocol's lifecycle already reaches), the gateway layer compares each already-bound
indoor unit's CURRENT CoolMaster name (`driver.getCoolMasterName`, from the `props` read
that same connect just did) against the Supreme device's own desired name
(`device.name`) and writes ONLY where they differ:

- **Already matching** → no write at all (never "blindly write every name on every
  connection").
- **CoolMaster reports something different** (a stale name, or an installer renamed it
  directly on the gateway) → SupremeOS's name is authoritative; CoolMaster is corrected to
  match it, never the other way around (§ "Do not overwrite names unexpectedly" — a
  CoolMaster-side alias never silently overwrites the SupremeOS name).
- **CoolMaster reports no name at all** (a factory reset / property-database wipe) →
  restored from the Supreme device's own `name`, exactly the same write path.

This reconciliation runs fire-and-forget and never delays the driver's own "ready"
transition or any other protocol's lifecycle; a failure is logged, never thrown back into
the shared lifecycle pipeline.

### Multiple CoolMaster Gateways

A bare UID like `L1.101` is NEVER used alone to identify a device for name sync — two
different installed gateways can legitimately both report an `L1.101`, and (per §
Multi-instance CoolMaster above) they already resolve to two completely independent
Supreme devices via `coolmaster:<installedId>:L1.101` addressing. `syncCoolMasterDeviceName`
resolves the OWNING driver instance first (enumerating every installed `coolmaster` catalog
entry and asking each one's live driver whether it manages the device), so a rename for
Gateway A's `L1.101` can never be misapplied to Gateway B's `L1.101`.

### Restart persistence

Because the desired name is simply `device.name` (already durably persisted, not a new
field), a SupremeOS restart needs no special handling at all: on the next connect, the
same startup reconciliation pass described above runs again, compares the persisted
`device.name` against whatever CoolMaster currently reports, and writes only if they've
drifted — covering both "SupremeOS restarted, nothing changed" (no write) and "CoolMaster
lost its property database while SupremeOS was down" (restored automatically) with the
exact same code path.

### Limitations

- `PROPS_NAME_MAX_LENGTH` (100) is a defensive sanity bound, not a real hardware limit —
  see the encoder section above for the live-confirmed fix that raised it from an invented
  20-character guess that was silently blocking real names.
- The write path (`props <uid> name <name>`) is live-confirmed; a per-unit READ
  (`props <uid>`) is confirmed NOT to work on the same hardware (`Bad Format`) — see
  **Friendly Names** above. Reconciliation therefore always relies on the bulk `props` LIST
  read (already the only working read path), never a per-unit query.
- Name-sync failures are retried only via the existing per-command retry already built into
  `CoolMasterConnection.executeAscii` (transient errors, bounded by `retryCount`/
  `backoffBaseMs`/`backoffMaxMs`) — there is no separate, persistent "keep retrying a failed
  rename until the gateway comes back" queue. A gateway that's offline when a rename happens
  will pick up the (latest) desired name on its next successful reconnect via the startup
  reconciliation pass instead, which is simpler and reuses an existing, already-tested
  mechanism rather than adding a second retry system.

## Discovery

Runs on: initial connect, automatic reconnect, the configured `discoveryIntervalMs`, and
on-demand (`driver.discover()` triggers it once if nothing has been discovered yet;
`driver.refreshDiscovery()` always forces a fresh full pass). Indoor-unit discovery is bulk
(one `ls2` request covers every unit) plus one `query <uid>` per unit **only during
discovery, never during routine polling** — querying hundreds of units individually on
every 10-second poll would violate the "avoid unnecessary API traffic" requirement at
real-world VRF fleet scale.

Water heater / ventilation / main controller / group / friendly-name (`props`) discovery
each run independently and fail *gracefully*: an installation with none of a given type is
normal, not a driver error — one type's "unsupported command" response never blocks
indoor-unit discovery (the type every installation has) or any other optional type.

## Multiple Gateways

CoolMaster supports installing more than one gateway instance — mirroring the exact
multi-instance architecture already established for Casambi (`native-driver-factory.ts`'s
`withCasambiInstanceAddressing`), reusing the SAME generic install/registry/runtime-protocol
plumbing with zero core changes. The one CoolMaster-specific addition is
`withCoolMasterInstanceAddressing`: since CoolMaster UIDs (`L1.100`) are gateway-LOCAL, not
globally unique, every instance but the first gets its device addresses scoped as
`coolmaster:<installedId>:L1.100` — so Gateway A's `L1.101` and Gateway B's `L1.101` always
become two distinct Supreme devices, never a collision. The first/primary instance is
returned completely unwrapped (bare `L1.100` addressing, unchanged), so a single-gateway
install — still the default, common case, and every already-deployed hub — needs no
migration and behaves exactly as before.

Each installed instance gets its own independent connection, transport, discovery pass,
poller, command queue, state cache, reconnect/backoff state, and log scope — there is no
shared or global mutable state between gateway instances anywhere in this driver (every
piece of state lives on a `CoolMasterProtocolDriver`/`CoolMasterConnection` instance field,
never a module-level variable).

The Driver Manager's "Set up CoolMaster" / "Add gateway" wizard (`CoolMasterSetupWizard` in
`apps/web-homeowner/src/drivers.tsx`) asks how many gateways to configure (1-100) up front,
then renders that many independent config blocks — each with its own choice of automatic
discovery (with a live LAN scan panel, `CoolMasterGatewayDiscoveryPanel`) or manual IP entry.

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
8. **SDDP gateway discovery is not implemented.** The reference material documents `sddp`
   only as a gateway-side enable/disable toggle, never the actual multicast reply payload a
   client would need to parse. Gateway auto-discovery instead uses a verified ASCII_IF
   connect+`info` handshake (see **Gateway Auto-Discovery** above) — this is a deliberate,
   documented choice, not an oversight, and the architecture is built to accept a real SDDP
   prober later without a rewrite if the wire format is ever obtained and verified.
9. **The `props` LIST response line format is inferred, not verified (Low confidence).**
   No real captured `props` output exists anywhere in this repository's documentation or
   test fixtures; only the SET form's syntax is documented. The parser degrades safely for
   an unrecognized layout (absent name, never a fabricated one) but genuinely requires
   validation against a real CoolMasterNet gateway before this format can be trusted.
10. **Gateway identity is effectively IP-based today, not serial-based (live-confirmed).**
    `info` — the only command run before a candidate host is even confirmed to be a real
    gateway — does not report a serial number on real hardware (see **Gateway
    Auto-Discovery** above); discovery's `serial` field falls back to the probed IP. `set`
    is the one other documented command naming "Serial number" among its fields
    (`CoolMaster_Core_Reference_Part3_v1.0.txt` §1) but its response format is equally
    unverified — querying it during discovery to recover a real serial is a real
    improvement opportunity, not yet implemented, pending a real captured `set` response.

## Testing

- `coolmaster-parser.test.ts` (34 tests), `coolmaster-commands.test.ts` (14),
  `coolmaster-mapper.test.ts` (22) — pure-logic unit tests for every parsing/building/
  mapping function, including friendly-name parsing edge cases (punctuation, empty names,
  duplicate name values, malformed lines).
- `coolmaster-discovery.test.ts` (6) — isolated tests for `discoverAll`'s own orchestration
  against a fake `CoolMasterConnection`: a `props` failure never fails the rest of
  discovery, an unnamed unit stays discoverable, duplicate name values are allowed, and
  `includeNames` correctly gates whether `props` is called at all.
- `coolmaster-gateway-discovery.test.ts` (16) — LAN gateway discovery against real
  in-process TCP fixtures: 0/1/N gateways, duplicate-reply collapsing, a non-CoolMaster
  device correctly rejected, a response with no serial-shaped field rejected as
  inconclusive, bounded timeouts (both "no listener" and "accepts TCP but never greets"),
  and bounded concurrency never dropping a reachable gateway.
- `coolmaster-driver.test.ts` (17) — full integration tests against a fake in-process
  ASCII_IF gateway with real greeting/prompt/CR framing (not a mocked transport): connect,
  discovery, bind + initial state seeding, every command category, toggle resolution,
  unbound-device errors, poll-driven feedback, functional automatic reconnect (verified by
  sending a real command after the simulated drop, not just checking a connected flag),
  friendly names (display name from `props`, rediscovery updating the same device),
  `props` frequency (not on fast polls, not on per-command refreshes), and `autoDiscover`
  resolution (single gateway found, `gatewaySerial` mismatch, zero gateways found).
- `services/gateway/src/native-driver-factory.test.ts` — `withCoolMasterInstanceAddressing`
  unit tests (scoping/unscoping, two instances with the identical UID never colliding) plus
  a real-`CoolMasterProtocolDriver` bind proof.
- `services/gateway/src/coolmaster-multi-instance.e2e.test.ts` — install/config/registry
  over real HTTP: independent per-gateway config, `autoDiscover` config independent of a
  manual sibling, uninstall isolation, and label/config survival across a genuine
  `AppContext` restart.

Run: `pnpm --filter @supreme/protocols test` and `pnpm --filter @supreme/gateway test`.

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

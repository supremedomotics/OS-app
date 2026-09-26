# PJLink Class 2 native driver

Real, native `INativeProtocolDriver` for JBMIA PJLink projectors/displays. Implements the
JBMIA "PJLink Specifications" — a strictly request/response ASCII TCP protocol on port
4352 (`PJLINK_DEFAULT_PORT`). One physical projector = one TCP session = one Supreme
device (capability `display`).

Files: `services/protocols/src/pjlink-codec.ts` (pure encode/decode), `pjlink-driver.ts`
(the driver), `pjlink-discovery.ts` (Class 2 UDP search), `pjlink-simulator.ts` (test
fixture), `pjlink-driver.test.ts`. Manifest: `services/drivers/src/manifests.ts`
(`supreme-pjlink`). Gateway wiring: `services/gateway/src/native-driver-factory.ts`
(`pjlink` branch). Capability schema: `packages/domain-model/src/capabilities.ts`
(`DisplayState`, `DisplayErrorStatus`, `DisplayInputRef`/`DisplayInputOption`,
`DisplayLampState`).

## Supported PJLink version / class

Targets PJLink Class 1 and Class 2 (JBMIA spec). A unit's real class is negotiated on
connect via `CLSS?`; an installer override (`ProtocolBinding.config.pjlinkClass`) skips
that probe for a unit whose `CLSS?` reply is itself unreliable.

## Commands implemented

- `POWR` — power on/off/query (4-state: off/warming/on/cooling, spec §4.1).
- `INPT` — query/set current input (source-type + number pair, never a synthesized
  "HDMI 1"-style number).
- `INST` (Class 2) — device-reported list of switchable inputs.
- `AVMT` — video/audio/both mute get/set, full 10/11/20/21/30/31 semantics.
- `ERST` — 6-digit error status (fan/lamp/temperature/cover/filter/other, each 0-3).
- `LAMP` — multi-lamp hours + on/off.
- `FREZ` (Class 2) — freeze/unfreeze.
- `INF1`/`INF2`/`INFO`/`NAME` — manufacturer/product/other-info/name.
- `CLSS` — class query (used for negotiation, above).
- Class 1 MD5 authentication (`PJLINK 1 <seed>` greeting → `MD5(seed+password)` prefix
  on the first command of the session).
- All five error codes (`ERRA`/`ERR1`/`ERR2`/`ERR3`/`ERR4`) decoded as a typed
  `PjlinkProtocolError`, never a thrown string.

## Explicitly NOT implemented this pass

`SNUM` (serial number), `SVER` (software version), `INNM` (per-input name query beyond
what `INST` already returns), `IRES`/`RRES` (resolution), `FILT`/`RLMP`/`RFIL` (filter
usage + replacement model numbers), `SVOL`/`MVOL` (speaker/mic volume), `SECU`
(security). None of these back a Supreme capability field or control today; adding one
is pure encode/decode work in `pjlink-codec.ts` (the class-2 spec table format is
identical to what's implemented) before it needs any driver or capability-schema change.

## Feedback / polling model

PJLink has no unsolicited push notifications (unlike AVR/Denon Telnet's status echoes)
— every reply is the direct answer to a command this driver just sent. The driver
therefore polls each session on a timer (`POLL_INTERVAL_MS`, default 15s, configurable
via `pollIntervalMs`) issuing `POWR?`/`INPT?`/`AVMT?`/`ERST?`/`LAMP?`(+`FREZ?` on Class
2) through the SAME FIFO command queue homeowner commands use, so poll traffic and real
commands are correctly serialized against each other — never a second, racing write
path.

## Multi-projector architecture / failure isolation

One `PjlinkProtocolDriver` instance manages many physical projectors. Each gets its own:
`host:port` TCP link (via the shared `TcpLineTransport`, capped-exponential-backoff
reconnect), FIFO command queue (PJLink is strictly one-command-in-flight-per-session),
auth/class negotiation state, and in-memory state cache. Nothing is shared or global
across devices — a timeout, an `ERRA` auth rejection, or a dropped socket for one
projector never touches another's queue, poller, or reported state. Verified by
`pjlink-driver.test.ts`'s multi-projector isolation test (30 simultaneous simulated
projectors, several deliberately offline/failing, the rest report real independent
state).

## Capability mapping

Maps to the new `display` Supreme capability (`DisplayState`): `power`
(off/warming/on/cooling/unknown — never collapsed to a boolean), `input` (current
source-type+number pair), `availableInputs` (device-reported, empty until `INST?`
answers), `videoMuted`/`audioMuted` (independent), `errorStatus` (6 independent 0-3
severities), `lampHours` (array, multi-lamp), `frozen`, and the info strings
(`manufacturer`/`product`/`productName`/`otherInfo`/`pjlinkClass`). Every field defaults
to `null`/`"unknown"`/`[]` until a real reply populates it — never a fabricated value.

## Discovery

Class 2 UDP search (JBMIA spec addendum): broadcast `%2SRCH\r` on port 4352; each
Class-2-capable, currently-reachable projector answers with a UDP broadcast
`%2ACKN=<ip>\r`. Implemented via `@supreme/lan`'s `UdpTransport` (never a raw socket),
mirroring the `ssdp-remote-socket.ts` adapter pattern. Each discovered device is a
separate candidate (never merged). NOT implemented: the unsolicited `%2LNKUP` "a
projector just came online" broadcast — `discover()` is a one-shot scan, not a
persistent listener. Class 1 has no discovery mechanism at all (verified against the
spec); a Class-1-only unit must be added manually by IP, same as AVR/Telnet units.

## Secrets

The per-projector admin password lives in `ProtocolBinding.config.password` (like AVR's
per-binding config) and, at the manifest level, `configSchema`'s `password` field is
marked `secret: true` — `services/drivers/src/secret-store.ts`'s `withSecretEncryption`
handles encryption at rest transparently. The driver never logs the plaintext password.

## Simulator usage (tests)

`pjlink-simulator.ts`'s `PjlinkSimulator` spins up a real `node:net` server per
simulated projector (own loopback port, own independent power/input/mute/error/lamp
state), supporting response-delay injection, offline/online toggling, and
auth-failure/hard-failure injection. `startPjlinkFarm(n)`/`stopPjlinkFarm(sims)` spin up
`n` independent simulators at once for isolation testing.

## Known limitations

- Filter/security/volume commands are not yet implemented (see above).
- Discovery is one-shot; no persistent `LNKUP` listener.
- `INNM` per-input naming beyond `INST`'s own reply is not separately queried, so
  `DisplayInputOption.label` falls back to a generic "<source> N" label
  (`fallbackInputLabel()`) rather than a device-reported per-input name.
- No web-homeowner/UI work was done for the `display` capability — this is a
  backend/driver task only. The new capability has no UI surface yet; see the
  follow-up note in the implementation report for what a UI pass would need.

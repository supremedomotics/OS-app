# Adding a new AVR / media brand

> Companion to ADR 0015 (Universal AVR Framework). Denon/Marantz (Telnet + HEOS) and
> Yamaha (Extended Control/MusicCast) are the three reference implementations; this is
> the checklist for the next one — Onkyo/Pioneer (ISCP/eISCP), Sony, Arcam, Anthem
> (ARC), NAD, JBL Synthesis, StormAudio, or Trinnov. None of those are implemented
> here; this doc is how you'd do it without re-deriving the pattern from scratch.

## 0. Get the real protocol spec first

Every driver in this fleet is built against a manufacturer's actual published control
protocol, never guessed. Before writing code:

1. Obtain the vendor's IP-control document (most publish one — Onkyo/Pioneer's ISCP,
   Anthem's ARC command list, etc. are public PDFs).
2. Extract the exact wire format: framing (line-based ASCII? JSON-over-HTTP?
   fixed-length binary?), the command/response syntax, and — critically — what the
   protocol **cannot** do. Every driver in this fleet documents its real gaps (Denon
   Telnet has no feature-query command; HEOS has no power command; HEOS/Denon have no
   seek) instead of faking them. Find yours the same way: grep the spec for the
   capability before assuming it exists.
3. If the vendor's control API is genuinely a wrapper around HEOS, MusicCast, or
   another already-implemented protocol (as some AVR lines rebadge a licensed
   streaming module), you may not need a new driver at all — check first.

## 1. Two files: `<brand>-codec.ts` + `<brand>-driver.ts`

Every driver in `services/protocols/src/` splits into:

- **`<brand>-codec.ts`** — pure functions, no I/O. `command → wire bytes`,
  `wire bytes → structured update`, plus a `<brand>CapabilityConfig()` builder. This
  is what you unit-test without a socket.
- **`<brand>-driver.ts`** — the stateful `INativeProtocolDriver` implementation: owns
  the transport (TCP/HTTP/UDP), binding→device bookkeeping, and translates codec
  output into `record()` calls that emit Supreme state.

Look at `avr-codec.ts`/`avr-driver.ts` (Telnet, connection-oriented) and
`yamaha-codec.ts`/`yamaha-driver.ts` (HTTP + UDP push) as the two transport shapes
most new brands will resemble.

## 2. Map your protocol's topology onto bindings

Every driver here answers "what does one `ProtocolBinding` address?" — get this right
first, it drives everything else:

| Topology | Pattern | Reference |
|---|---|---|
| One device = one IP, no zones | `binding.address` = host(:port) | WiiM, Devialet |
| One device, multiple zones sharing one link | `binding.config.zone` selects the zone; multiple Supreme devices share one socket | AVR (`zone: "main"\|"zone2"`), Yamaha (`"main"\|"zone2"\|"zone3"\|"zone4"`) |
| One network, one connection reaches every unit by id | `binding.config.<id>` selects the unit; ALL bindings on that host share ONE link | HEOS (`config.pid`) |

Pick the one that matches your protocol's real topology — don't force a per-device
connection model onto a protocol (like HEOS) that's natively a shared bus.

## 3. Reuse, don't reimplement

- **Reconnect**: `ReconnectScheduler` (`avr-reconnect.ts`) — capped exponential
  backoff, `notifyDisconnected()`/`reset()`/`stop()`. Every connection-oriented driver
  (AVR, HEOS) uses one instance per physical link.
- **Capability config shape**: `AudioCapabilityConfig` (`avr-capabilities.ts`) —
  `inputs`, `soundModes`, `volumeRange`, `toneControl`, `zones`, `transport`,
  `presets`, `bluetooth`. Build one `<brand>CapabilityConfig()` function; set
  `source: "device_reported"` only if you're populating it from an actual wire query
  (like Yamaha's `getFeatures`), otherwise `"installer_declared"` (like Denon's, from
  binding config) — **never claim "device_reported" for data you hardcoded.**
- **Volume scaling**: `percentFromScale`/`scaleFromPercent` (`avr-capabilities.ts`) —
  if your protocol's volume isn't already 0–100 (Yamaha's is 0–194, HEOS's is already
  0–100), use these instead of writing another linear-scale function.
- **Discovery**: `ssdpSearch`/`mdnsBrowse` (`ssdp.ts`/`mdns.ts`) — most AVR/streaming
  brands answer SSDP M-SEARCH; check the spec for the ST (search target) or fall back
  to the standard `MediaRenderer`/`MediaServer` UPnP types filtered by
  `<manufacturer>` in the device-description XML (Yamaha's driver does exactly this).

## 4. Extend the shared schema only through `advanced`

Never add a brand-specific field to `MediaState`/`CapabilityCommand` in
`@supreme/domain-model`. Brand-specific DSP/tone/sound-mode/preset parameters go
through the existing `advanced: record<string, unknown>` field on both, keyed by
whatever your `<brand>CapabilityConfig()` declares (Denon uses `bass`/`treble`/
`soundMode`/`sleepMinutes`; Yamaha uses `bass`/`treble`/`soundProgram`/`sleepMinutes`;
HEOS uses `preset`/`quickSelect`). If your brand needs a genuinely new *capability*
concept the schema doesn't have at all (not just a new parameter name), that's a
domain-model change — and it should be additive (new optional field), exactly like the
`durationSec`/`positionSec`/`shuffle`/`repeat` additions this framework made.

## 5. Test against an in-process fake, not a real device

Every driver test in this fleet spins up an in-process fake server (`node:net` for
Telnet-style, `node:http` for REST-style, an injectable fake socket for
UDP/discovery) and exercises the real driver over it — see `avr-driver.test.ts`,
`heos-driver.test.ts`, `yamaha-driver.test.ts` for the three shapes. Cover, at
minimum: command → wire bytes round-trip, unsolicited status → Supreme state,
multi-device/zone isolation (a command to one device must not leak into another's
state), and reconnect-after-drop (`vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync`,
per `avr-reconnect.test.ts`).

## 6. Wire it in

1. `packages/domain-model/src/drivers.ts` — add your protocol string to
   `ProtocolKind` (additive, one line).
2. `services/protocols/src/index.ts` — export the driver class + codec functions.
3. `services/gateway/src/bootstrap.ts` + `config.ts` + `infra/hub-compose/.env.example`
   — a `SUPREME_<BRAND>_ENABLED` boolean flag, following the AVR/HEOS/Yamaha
   precedent exactly (§ ADR 0015 Consequences: no manifest entry — that file is for
   single-host credential-configured drivers, not "many independent units added by IP
   at commissioning").

## 7. Verify

`pnpm --filter @supreme/protocols exec tsc --noEmit && pnpm --filter @supreme/protocols exec vitest run`,
then rebuild the dependency chain your new driver touches
(`pnpm --filter @supreme/domain-model run build`, then `@supreme/protocols`, then
`@supreme/gateway`) and typecheck/test the gateway — dist/ is gitignored, so a stale
build in a dependent package is the most common false-positive typecheck failure when
you extend a shared schema. See ADR 0015 for the exact rebuild order this session hit.

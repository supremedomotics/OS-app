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
   (+ the matching block in `infra/hub-compose/docker-compose.yml`'s gateway service
   environment) — a `SUPREME_<BRAND>_ENABLED` boolean flag, following the AVR/HEOS/
   Yamaha precedent exactly.
4. **`services/drivers/src/manifests.ts`** — add a manifest with **`configSchema: []`**
   (there's nothing global to configure; each physical unit is still added by IP, and
   each zone/pid by `ProtocolBinding.config`, through Bus Binding). This is required,
   not optional: the Extension Center (`web-homeowner/extensions.tsx`) is populated
   *entirely* from this registry — a driver with no manifest entry is invisible and
   un-installable from the UI, discoverable only by editing `.env` directly. An
   earlier pass on this framework shipped without this step (reasoning that
   manifests.ts was only for single-host credential-configured drivers) and had to be
   corrected once real usage surfaced the gap — see ADR 0015's Consequences.
5. **`services/gateway/src/native-driver-factory.ts`** — add a factory entry that
   always returns a live instance (`<protocol>: () => new <Brand>ProtocolDriver()`),
   since there's no required config to check. `SupremeNativeAdapter.registerDriver`
   replaces any same-protocol instance on register, so this coexists safely with the
   `bootstrap.ts` env-wired path from step 3 — exactly like KNX/MQTT/Modbus/Casambi.

## 7. Verify

`pnpm --filter @supreme/protocols exec tsc --noEmit && pnpm --filter @supreme/protocols exec vitest run`,
then rebuild the dependency chain your new driver touches
(`pnpm --filter @supreme/domain-model run build`, then `@supreme/protocols`, then
`@supreme/gateway`) and typecheck/test the gateway — dist/ is gitignored, so a stale
build in a dependent package is the most common false-positive typecheck failure when
you extend a shared schema. See ADR 0015 for the exact rebuild order this session hit.

## 8. Diagnostics, Room Assignment, and Topology — opt in, no architecture changes needed

ADR 0015's 2026-07-19 addendum added three more seams every new brand automatically
qualifies for, without touching anything outside your own `<brand>-driver.ts`
(verified during the Phase 9 future-driver-readiness audit — Anthem/Arcam/NAD/Sony/
Pioneer/Onkyo/JBL Synthesis/StormAudio/Trinnov were all checked against this list):

- **Diagnostics Console**: implement the optional `getDiagnostics?(deviceId)` method
  using the shared `DriverDiagnosticsTracker` (`driver-diagnostics.ts`) exactly like
  `avr-driver.ts`/`heos-driver.ts`/`yamaha-driver.ts` do — call `.recordSend()`/
  `.recordReceive()` at your driver's real send/receive points, `.recordReconnect()`/
  `.recordError()` where applicable, and return `.snapshot(status, {protocol,
  driverVersion, model, firmware, ip, mac})`. If you skip this entirely, `getDiagnostics`
  is optional on `INativeProtocolDriver` — the Diagnostics Console section on the
  device page simply won't show driver-level fields for your brand, no error, no
  fabricated data. `bestEffortMacForIp()` (`arp-lookup.ts`) is reusable as-is for any
  IP-based brand.
- **Automatic Room Assignment**: if your protocol carries a genuine location signal
  (a persistent, user-set zone/room name — check the spec the same way you checked for
  power/seek support, don't assume), attach it to your `discover()` result as
  `raw.locationHint: { raw: string, source: "explicit_attribute" |
  "persistent_user_zone_name" | "friendly_name_heuristic" }` (see `yamaha-driver.ts`'s
  `discover()` for the exact shape). No protocol has zero signal by default — Onkyo/
  Pioneer's onkyo.com setup app, Arcam's app, and most modern AVR companion apps ask
  the installer to name the unit by room during setup, which is real
  `persistent_user_zone_name` evidence if your research confirms it; if a brand
  genuinely has no such signal (like classic Denon Telnet), simply omit `locationHint`
  — the Room Assignment Engine already handles "no hint" honestly (→ "Unassigned
  Devices"), no driver-side special-casing required.
- **Automatic Zone Generation**: only applicable if your protocol can genuinely
  wire-detect multiple zones on one physical unit (like Yamaha's `getFeatures`) —
  attach `raw.zones: {id: string, label: string}[]` to your `discover()` result and
  `InstallerServices.autoCommissionMedia()` handles the rest. If zone count isn't
  wire-discoverable (like Denon's Zone 2), omit it — extra zones stay a manual
  installer add, exactly like Denon today, and that's the honest answer, not a gap to
  paper over.
- **One real code change required to onboard a 4th brand into `auto-commission-media`**:
  `InstallerServices.autoCommissionMedia()`'s parameter type is currently the literal
  union `"avr" | "heos" | "yamaha"` (`services/gateway/src/installer-context.ts`), and
  the `POST /v1/commissioning/auto-media` route (`routes/installer.ts`) validates
  against the same three literals. Adding a 4th brand to automatic commissioning means
  widening both to include your new protocol string — a one-line change in each file,
  not an architectural one. Your driver works fully (discovery, commands, diagnostics,
  manual commissioning) without this; it only gates the one-click "auto-commission
  this protocol" installer flow.
- **Media Topology Engine**: needs nothing from your driver at all — it's stored in
  `device.metadata.avrTopology` (`packages/domain-model/src/media-topology.ts`) and
  rendered by the AVR console (`features/media/detail.tsx`) for any device with a
  `media` capability, regardless of which driver owns it. Every new brand gets this
  automatically.

**Conclusion of the Phase 9 audit**: the SDK supports all nine listed future brands
(Anthem, Arcam, NAD, Sony, Pioneer, Onkyo, JBL Synthesis, StormAudio, Trinnov) without
any change beyond the one-line `autoCommissionMedia` protocol-union widening above,
which is optional (only needed for the one-click auto-commission flow, not for the
driver to function). No change was made to the core `INativeProtocolDriver` interface,
the Room Assignment Engine, or the Topology Engine this session — all three were
designed generic from the start specifically so this would be true.

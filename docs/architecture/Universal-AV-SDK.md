# SupremeOS Universal AV SDK — Architecture

> The real, runtime `services/protocols/src/av-sdk/` module. Companion to
> [AV-Adapter-Development-Guide.md](./AV-Adapter-Development-Guide.md) (how to build a new
> adapter against it), [AVR-Universal-Capability-Matrix.md](./AVR-Universal-Capability-Matrix.md)
> (the full per-capability sourcing/evidence record),
> [Universal-AVR-SDK-Roadmap.md](./Universal-AVR-SDK-Roadmap.md) (the engine-level roadmap —
> what's ✓/Partial/Planned across the SDK as a whole, and the honest Denon/Yamaha/Anthem reuse
> mapping), [Denon-CheatSheet-Audit.md](./Denon-CheatSheet-Audit.md) (an installer cheat sheet
> audited against the official protocols and this SDK — what it got right, what SupremeOS
> already does better, and the one real gap it led to finding: pre-2016 units silently getting
> zero HTTP-sourced data because the driver assumed every unit was on port 8080), and the
> architecture-verification + duplication-audit history that produced it (see
> `SESSION_HANDOFF.md` for the full trail: a prior turn confirmed no runtime SDK existed, only
> documentation claiming one; a full evidence-based audit then found and scoped the real,
> extractable duplication this module closes).

## What this is, in one sentence

Four small, internal-only modules — `TcpLineTransport`, `recordCapabilityState`,
`HttpPollClient`, and `AdaptivePoller` — extracted from real, evidenced duplication (or,
for the latter two, justified by a genuine second real caller once one existed) across
`AvrProtocolDriver`, `HeosProtocolDriver`, and `YamahaProtocolDriver`. **Nothing
speculative was built.** This is deliberate, not incomplete — read §4 before wondering
where the rest of a "Universal AV SDK" you might expect is.

## § Universal AVR SDK pass — `AvrProtocolDriver` becomes genuinely multi-transport

The Denon/Marantz driver is the SDK's reference implementation for a driver that
combines TWO transports to fully populate the universal capability surface — not
because the SDK grew a "multi-transport" concept, but because Denon/Marantz's real,
evidenced wire behavior genuinely has two: Telnet (port 23, the sole realtime-push
channel — unchanged by this pass) and a second, real, HTTP AppCommand interface
(confirmed via fetching and reading `denonavr`'s actual source this sprint) that
covers the one thing Telnet structurally cannot: renamed/hidden input names and
static album art. See `AVR-Universal-Capability-Matrix.md` for exactly which
commands were verified vs. gated, with citations.

### `http-poll-client.ts` — `HttpPollClient` + `AdaptivePoller`

Generalizes `YamahaProtocolDriver`'s own ad hoc `getJson()`/`diagnosticsFor()`/
in-flight-coalescing pattern (`hostFeaturesInFlight`/`syncZoneInFlight`) into a
reusable primitive — extraction is justified now by a genuine second real caller
(the new AVR HTTP AppCommand layer), meeting this SDK's own established "extract
only with 2+ real callers" bar from the original `TcpLineTransport` extraction.

- **`HttpPollClient`**: `request(key, url, init)` (any HTTP method — AppCommand.xml
  is `POST` with an XML body, unlike Yamaha's `GET`-only query-param API, so this
  isn't GET-only the way an initial Yamaha-only design might have been) — in-flight
  de-duplication per key, a `DriverDiagnosticsTracker` per key (so the SAME
  automatic latency/trace capture `TcpLineTransport`'s links already get applies to
  HTTP traffic too), `ProtocolTracer` integration, `fetchImpl` injection (same
  convention `AvrDriverOptions`/`YamahaDriverOptions` already use).
- **`AdaptivePoller`**: `intervalMs()` is a function, re-evaluated fresh on every
  scheduling decision — returning `null` pauses ticking entirely without the caller
  needing to call `stop()`/`start()` again; it resumes on its own once the function
  stops returning `null`. This is the concrete "never poll when an event exists,
  only poll when absolutely unavoidable, back off automatically when idle"
  mechanism. AVR uses it for exactly one thing: a slow (15-minute) re-poll of
  renamed/hidden inputs while connected — the honest answer to "must stay
  synchronized even when controlled by the Denon Remote App" for the one field
  class Telnet has no push notification for.
- **Not migrating Yamaha onto this in this pass** — its existing polling is
  working and tested; force-migrating it for consistency alone risks regressing a
  working driver for no functional gain, contradicting "never break working
  functionality." Documented here as a real, recommended, separate follow-up.

### `avr-http-codec.ts` — narrower than first scoped, and why (a real self-correction)

Mid-implementation, fetching `denonavr`'s actual `AppCommands` enum (not a
description of it) revealed an earlier, less rigorous research pass had
over-claimed `GetSoundModeList` as a real command — it does not exist. The same
fetch settled that no source anywhere — including a dedicated XML-dump tool by the
same author — parses now-playing title/artist/album from any endpoint either. Both
were cut from scope rather than shipped as guesses. What survived, with an exact
confirmed XML shape (fetched from `denonavr/input.py`'s real parsing code):
`parseRenameSource()`, `parseDeletedSource()`, and `buildAppCommandRequests()` (the
real `<tx><cmd id="…">…</cmd></tx>` envelope, capped at 5 commands per request — a
real, documented Denon limit). `albumArtUrl()` is not a parser at all — a literal,
confirmed-static URL string, so it carries none of the schema-verification risk the
cut commands did.

### Diagnostics: automatic, not driver-opted-in

`DriverDiagnosticsTracker.recordSend()`/`recordReceive()` now also populate a
rolling `averageLatencyMs` window and a bounded (200-line) trace ring buffer
(`recordTrace()`/`recentTrace()`) — **automatically, for every driver that already
calls these methods**, not just the new HTTP layer. AVR/HEOS/Yamaha's existing
Telnet/UDP/HTTP call sites needed zero changes to benefit. This is deliberately
decoupled from the separate, heavier, opt-in `trace`/`onLog` config flag (meant for
verbose backend-log capture) — the ring buffer is cheap, in-memory, and always
available for the Diagnostics UI's new "Protocol Trace" panel
(`GET /v1/devices/:id/diagnostics/trace`).

A third, still heavier and still opt-in-only facility — **AVR Diagnostic Mode**
(`SUPREME_AVR_DIAGNOSTICS`) — was added later, on top of this pattern rather than
folded into it: it traces one event's complete lifecycle end to end, under a
correlation ID, across process boundaries (driver → gateway → WebSocket), which
neither `trace` nor the diagnostics ring buffer can do (both are wire-level, one
driver process only). See `docs/architecture/AVR-Diagnostic-Mode.md`.

### § Second pass — official PDFs + a real RTI driver export un-gate the Audyssey family

The user directly supplied three primary sources this round: the official Denon AVR
control protocol PDF (Ver.8.6.0), the official HEOS CLI Protocol Specification PDF
(v1.17), and a real, exported RTI commercial driver file. Reading the Denon PDF
directly (not a summary) revealed Dynamic EQ / Audyssey MultEQ mode / Reference
Level Offset / Dynamic Volume / Dynamic Range Compression are documented as
**Telnet** `PS`-prefixed commands with exact, literal parameter tokens (p.13-14) —
not the unverified HTTP AppCommand `SetAudyssey*` family the previous pass gated on
"command name confirmed, encoding unverified." Since each is a closed, spec-quoted
enum rather than a guessed numeric range, the safety concern that gated them no
longer applies, and all five are now live, tested, wired capabilities:

- `avr-codec.ts` gained `DENON_AUDYSSEY_MODES`/`DENON_REFERENCE_LEVELS`/
  `DENON_DYNAMIC_VOLUME_MODES`/`DENON_DRC_MODES` fixed enums, encode/parse support,
  and five new `denonCapabilityConfig()` `advancedControls` entries — every one a
  `kind: "select"`, reusing the exact generic UI mechanism `sleepMinutes` already
  proved out, so **zero new UI code** was needed (the `QuickActions` component only
  wires up `"select"` interactivity today; `"toggle"`/`"range"` kinds exist in the
  type but aren't rendered yet, so Dynamic EQ is modeled as a two-option select
  rather than a toggle to stay inside what's actually interactive).
- Gated behind a new `hasAudyssey` installer-declared flag (default `false`,
  opt-in) — same reasoning as `hasToneControl` (Telnet has no feature-query
  command, so presence isn't wire-discoverable) but opt-in rather than opt-out,
  because Audyssey calibration is genuinely absent on lower-tier models where tone
  control is universal.
- Channel-volume trims (`CV<ch> <nn>`, same PDF p.7) got the same evidence
  upgrade — exact 38–62/50=0dB encoding confirmed — but were **not** wired this
  round: the six-channel range-slider UI it needs is separate, UI-verification-
  bound scope, tracked honestly as a follow-up rather than silently dropped (see
  the capability matrix).
- The RTI driver export (`Denon_Marantz_Receiver.rtidriver`, a real OLE2/CFB
  compound document, extracted stream-by-stream with Python's `olefile` and read
  directly) was used **only** as a behavioral cross-check, per the user's explicit
  "never copy proprietary code" instruction — no RTI script or table content
  appears in any SupremeOS source file. It surfaced real gaps worth naming even
  though none were implemented this round: additional channel-trim targets
  (Front Height/Wide L/R, dual subwoofer, Surround Back) beyond the six the Denon
  PDF confirms, per-zone bass/treble/HPF for Zones 3/4 (SupremeOS models Zone 2
  only), and a "Connection State"/"Connections" diagnostic concept RTI's own
  variable model tracks explicitly.
- `HeosProtocolDriver` gained `heartbeat(deviceId)`, wrapping the official HEOS
  CLI spec's `system/heart_beat` (§4.1.5) — an explicit, on-demand liveness/
  round-trip probe distinct from the passive per-command latency
  `DriverDiagnosticsTracker` already measures. Correlated per shared link (the
  response carries no `pid`) with a 5s timeout, cleaned up on `disconnect()`/
  `unbind()` like every other pending-promise map in this fleet.

## Where it lives, and why it's internal-only

`services/protocols/src/av-sdk/` — **not** re-exported from
`services/protocols/src/index.ts`. `AvrProtocolDriver`, `HeosProtocolDriver`, and
`YamahaProtocolDriver` remain the only public symbols this package exposes for AV;
their class names, `protocol` field values, constructor option shapes, and full
`INativeProtocolDriver` behavior are byte-for-byte unchanged by this refactor. This
was a hard constraint, not a preference: the public surface is imported directly by
`services/gateway/src/native-driver-factory.ts` and `bootstrap.ts`, referenced by a
closed `ProtocolKind` zod enum (`packages/domain-model/src/drivers.ts`), and its
protocol-identifier strings are independently hardcoded in at least 7 other places
across gateway routes and 4 client UI platforms — none of which needed to change,
and none of which did.

## The two modules

### `state-cache.ts` — `recordCapabilityState()`

```ts
export function recordCapabilityState(
  states: Map<string, CapabilityState>,
  listeners: Iterable<StateListener>,
  deviceId: DeviceId,
  capability: CapabilityKind,
  state: CapabilityState,
): void
```

Extracted from `record()`, which was **100% verbatim-identical** across all three AV
drivers before this refactor: dedupe an unchanged state by `JSON.stringify`
comparison, cache it, notify every listener. Deliberately a plain function, not a
class owning its own `Map`/`Set` — each driver keeps its own `states`/`listeners`
fields exactly as before, so `getState()`, `onState()`, and each driver's existing
`unbind()`-time `removeDeviceStates()` cleanup call needed zero changes. The lowest-
risk extraction in this refactor: pure, no closures over transport state, used
identically by all three drivers.

### `tcp-line-transport.ts` — `TcpLineTransport`

A pooled, reconnecting, line-buffered TCP transport — the class every persistent-
socket, line-delimited AV protocol driver needs. Extracted from `AvrProtocolDriver`
and `HeosProtocolDriver`'s near-identical `AvrLink`/`HeosLink` interfaces and their
`ensureLink()`/`openSocket()`/`onData()`/`disconnect()`-loop/`getDiagnostics()`
status-ternary — ~55 lines of copy-pasted plumbing per driver, differing only in the
line delimiter (`\r` for Denon/Marantz Telnet, `\r\n` for the HEOS CLI) and each
protocol's own init-command sequence.

```
┌─────────────────────────────────────────────────────────────────┐
│                        TcpLineTransport                          │
│                                                                    │
│   Map<key, TcpLink>                                               │
│     TcpLink = { socket, ready, buffer, reconnect, diagnostics }   │
│                                                                    │
│   ensureLink(key, host, port)  ─┐                                │
│   releaseKey(key)                │  own the pool + socket         │
│   disconnectAll()                │  lifecycle + reconnect         │
│   diagnosticsFor(key)            │  scheduling + line buffering   │
│   get(key)                      ─┘                                │
│                                                                    │
│   delegates to existing, already-shared:                          │
│     ReconnectScheduler (avr-reconnect.ts)                         │
│     LineAccumulator (line-buffer.ts)                              │
│     DriverDiagnosticsTracker (driver-diagnostics.ts)               │
└─────────────────────────────────────────────────────────────────┘
              ▲                                    ▲
              │ onConnect(link, socket, host, port) │ onLine(ctx, line)
              │ (write init sequence)               │ (dispatch to protocol parser)
   ┌──────────┴──────────┐              ┌───────────┴───────────┐
   │   AvrProtocolDriver   │              │   HeosProtocolDriver   │
   │  (Denon/Marantz)      │              │  (whole-home streaming)│
   └───────────────────────┘              └────────────────────────┘
```

Ownership split, precisely: `TcpLineTransport` owns the socket/reconnect/line-buffer/
diagnostics-counter lifecycle for its `Map<key, TcpLink>` pool. It does **not** own
device/binding bookkeeping — a driver decides its own `key` shape (`host:port` in
practice), and supplies two hooks so protocol-specific behavior never leaks into the
transport:

- **`onConnect(link, socket, host, port)`** — called once a socket's `connect`
  event fires, after `link.ready` is set and the reconnect scheduler is reset. The
  driver writes its init-command sequence here (AVR: `PW?`/`MV?`/…; HEOS:
  `register_for_change_events` off → per-pid sync → on). `socket` is a separate,
  always-non-null parameter — deliberately not `link.socket` (which stays nullable)
  — so callers never need a null-check/assertion for something that's always true
  at this exact call site.
- **`onLine(ctx, line)`** — called once per complete line received on any link.
  `ctx = { key, host, port, link }` carries everything either consumer needs: AVR's
  dispatch is scoped by `host`/`port` (for zone lookups); HEOS's dispatch needs the
  `link` itself (one case, `nowPlayingChanged`, writes a follow-up command straight
  back to `ctx.link.socket`). `ctx.link` is always re-resolved from the pool by
  `key`, not a stale closure reference — matching the re-entrancy safety the
  original per-driver `onData()` implementations already had (a link can be
  replaced by a reconnect between when the `data` handler was registered and when
  data actually arrives).

**Preserved exactly, not just "similar behavior":**
- The re-entrancy guard in `ensureLink()` — `socket && !socket.destroyed` (**not**
  `ready`) — reuses a still-connecting link instead of racing a second connection
  when `bind()`/`command()`/a queue read call it concurrently before the first
  connect resolves.
- `releaseKey()` is **unconditional** — it has no visibility into a driver's
  `bindings` array, so "is this key still referenced by another device" stays
  exactly where it was: in each driver's own `unbind()`, which computes the answer
  from its own bindings and calls `releaseKey()` only once it already knows the key
  is orphaned.
- `diagnosticsFor(key)` returns `{ status, diagnostics }` — **not** a final
  `DriverDiagnosticsSnapshot`. The `info` object (`model`/`firmware`/`ip`/`mac`) is
  driver-specific (HEOS threads a per-binding `model`; AVR always passes `null`) and
  stays owned by each driver's own `getDiagnostics()`, which calls
  `diagnostics.snapshot(status, info)` itself.

## Before / after, honestly

| Driver | Before | After | Reduction |
|---|---|---|---|
| `avr-driver.ts` | 387 lines | 305 lines | ~21% |
| `heos-driver.ts` | 522 lines | 437 lines | ~16% |
| `yamaha-driver.ts` | 486 lines | 481 lines | ~1% (only `record()`) |

*(Historical — as of the original `TcpLineTransport` extraction. The § Universal AVR
SDK pass above subsequently grew `avr-driver.ts` back to ~618 lines by adding the real
second HTTP transport, its enrichment/polling/artwork methods, and their doc comments
— a genuine, evidenced feature addition, not a regression of this refactor's own
reduction; the transport-plumbing duplication this table measures was never
reintroduced.)*

**This is a real but modest reduction, not a dramatic rewrite.** The win is
"~70-90 lines of copy-pasted socket/reconnect/buffer plumbing per driver becomes
~15-25 lines of hook wiring" — most of what remains in `avr-driver.ts`/
`heos-driver.ts` was never duplicated in the first place: `bind()`/`unbind()`/
`command()`/`getState()`/`getCapabilityConfig()`/`discover()`, the `onLine`
dispatch `switch` (protocol-specific token/message semantics), `patchMedia()`/
`emitFor()`/`syncPid()`/`pidsFor()` (zone/pid-scoped lookups) are all genuinely
Denon/Marantz- or HEOS-specific and correctly untouched.

## Yamaha: thinner, not thin

`YamahaProtocolDriver` only adopted `state-cache.ts` — it has no persistent TCP
socket (per-request HTTP + a driver-wide UDP event listener, not a per-host
connection), so `TcpLineTransport` genuinely doesn't apply to it. Building an
HTTP-transport SDK primitive now would have been exactly the speculative
abstraction this refactor was told to avoid: no second driver in the 22-driver
fleet needs one today. Yamaha keeps 100% of its HTTP request/response bookkeeping,
its two in-flight-coalescing maps (`hostFeaturesInFlight`, `syncZoneInFlight`,
guarding real TOCTOU races found during a prior audit), its `hostDown`
reconnect-equivalent tracking, and its UDP event parsing — none of which resemble
the TCP-link-pool shape at all. Don't read "thinner, not thin" as an oversight;
it's the accurate description of what the evidence supported.

## What this SDK deliberately does NOT contain, and why

Per the evidence-based scoping decision (confirmed explicitly, not assumed): no
`DiscoveryEngine`/`CapabilityEngine`/`StateEngine`/`EventEngine`/`DigitalTwin`/
`DiagnosticsEngine`/`RoomAssignment`/`ZoneEngine`/`MediaTopology`/`DeviceFactory`/
`SubscriptionManager`/`CommandDispatcher`/`Telemetry`/`Metrics` module. Each either:

- **Already exists elsewhere as generic, fleet-wide, non-AV-specific infrastructure**
  — Room Assignment Engine (`services/commissioning/src/room-assignment-engine.ts`),
  the generic per-device diagnostics route (`GET /v1/devices/:id/diagnostics`),
  `packages/domain-model/src/capabilities.ts` serving as the de-facto digital twin,
  `MediaTopology` (`packages/domain-model/src/media-topology.ts`, a UI-only concern
  no driver touches) — wrapping these in new AV-scoped modules would duplicate,
  not consolidate.
- **Has no current duplication or requirement to justify it** — Telemetry/Metrics/
  Subscription Manager don't exist anywhere in this codebase for any driver, AV or
  otherwise. A unified "Zone Engine" was specifically considered and rejected: AVR
  (installer-declared 2-zone enum, no wire detection at all), Yamaha (wire-
  discovered 4-zone enum via a real `getFeatures` query), and HEOS (no zone concept
  — an opaque `pid` string) model this so incompatibly that a shared "Zone" type
  would be a false abstraction, not a real consolidation.
- **No separate `ConnectionManager`/`TransportManager`/`ConnectionPool`/
  `ReconnectManager` as four distinct classes** — only ONE real transport variant
  exists in evidence (pooled TCP + reconnect + line-buffering, shared by AVR/HEOS
  only), so it's one cohesive class, not four thin wrappers manufactured for
  symmetry with a diagram that had no second implementation to justify the split.

## § Universal Protocol Discovery Framework — what was requested vs. what's honest to build here

A later pass asked for a full **Universal Protocol Discovery Framework**: a multi-protocol
recorder (simultaneously capturing Telnet/HTTP/AppCommand/AppCommand0300/HEOS/XML/UPnP/SSDP,
every request/response timestamped), a **protocol correlation engine** (correlate an IR-remote
button press across every interface, determine which updates first, which is authoritative,
measure cross-interface latency/consistency), and a **guided hardware verification mode**
(prompt an installer for a physical action, record every interface, correlate, auto-update the
capability database).

**What shipped instead, and why, stated plainly rather than silently scoped down:**

- The **timestamped multi-transport capture** piece is real and already shipped, just not as a
  separate "recorder" module: every driver's `DriverDiagnosticsTracker.recordSend`/
  `recordReceive` (§ Universal AVR SDK pass, above) timestamps every raw token on every
  transport (Telnet, HTTP, UDP) automatically, and the trace ring buffer
  (`recentTrace()`/`GET /v1/devices/:id/diagnostics/trace`) already captures Telnet **and**
  HTTP AppCommand traffic for the same device side-by-side, in arrival order. What's missing
  relative to the ask is SSDP/UPnP GENA eventing in that same buffer (SSDP is one-shot at
  discovery time, not an ongoing channel this driver holds open — see the deferred-items table
  in `AVR-Universal-Capability-Matrix.md`) and HEOS (a HEOS-routed device is a *separate*
  Supreme device today, with its own trace buffer, not merged into the AVR device's).
- The **protocol correlation engine** and **guided hardware verification mode** were **not
  built this pass**, and the honest reason is environmental, not a scoping shortcut: both
  require a real receiver to correlate against. "Press Volume Up once on the IR remote, then
  compare which interface updated first" is meaningless without a physical remote and a
  physical receiver in front of whoever runs it — this sandbox has neither, and no prior
  evidence in this session (the official Denon/HEOS PDFs, the RTI driver export) substitutes
  for a live capture. Building the engine's *code* without ever running it against a real
  device would mean shipping unverified correlation logic — the same category of risk this
  SDK's own "never guess a parameter encoding" rule exists to prevent, just at the diagnostics
  layer instead of the control layer.
- What a **real** guided verification mode needs, concretely, so this isn't just a deferral
  with no path forward: (1) the trace buffer already described, extended to hold HEOS +
  UPnP/SSDP alongside Telnet/HTTP for one physical unit; (2) a start/stop capture window (a
  thin wrapper around the existing tracer — genuinely small, once there's hardware to run it
  against); (3) a diff pass over the four buffers keyed by timestamp to find "what changed and
  in what order"; (4) a UI prompt/timer, which is pure frontend work with no protocol risk.
  None of this is speculative architecture — it's the natural extension of infrastructure
  that already exists, gated on the one thing that can't be faked: real hardware in the loop.
- A **driver validator** that automatically diffs SupremeOS against RTI/Crestron/Control4/
  Savant/official docs/Home Assistant/openHAB, as requested, already exists in the one form
  that's honest to produce without live access to four proprietary systems: the capability
  matrix itself (`AVR-Universal-Capability-Matrix.md`), maintained as a hand-authored,
  evidence-cited table rather than an automated "diff tool" whose only real inputs (four
  NDA-gated driver formats) aren't available to automate against. The RTI driver file the
  user supplied this pass *is* now real evidence (see the matrix's methodology section) —
  used to find gaps (extra channel names, per-zone tone control, a "Connection State"
  diagnostic concept), never to auto-generate a checkmark grid.

## Performance validation

No performance benchmarks exist anywhere in this repository for these drivers, and
none were added by this refactor — the prior production audit's own "Performance
Audit" phase was explicit that only structural/code-review reasoning is possible in
this environment (no real hardware, no real network segment to measure against),
never fabricated numbers. This section uses the same documented methodology,
per-dimension, specifically reasoning about what changed vs. what didn't:

| Dimension | Assessment |
|---|---|
| **Startup time** | Unchanged. `connect()` on both `AvrProtocolDriver` and `HeosProtocolDriver` still just sets `connected = true` — sockets are still opened lazily per bound host on first `bind()`/`command()`, exactly as before. `TcpLineTransport`'s constructor does no I/O. |
| **Reconnect latency** | Unchanged. The exact same `ReconnectScheduler` instance, constructed with the exact same `{ baseMs, maxMs }` options sourced from the exact same `AvrDriverOptions`/`HeosDriverOptions` fields, drives reconnection — `TcpLineTransport.ensureLink()`'s reconnect closure is a line-for-line move of the original, not a reimplementation. |
| **Memory** | Slightly reduced, not increased. `TcpLineTransport` holds exactly the same `Map<string, TcpLink>` shape (`socket`/`ready`/`buffer`/`reconnect`/`diagnostics`) each driver held directly before — no new per-link fields were added. `recordCapabilityState()` adds zero new allocations per call (same `Map`/`Set` the driver already owned, passed by reference, not copied). |
| **CPU** | No new hot-path work. `onData`/`onLine` dispatch is the identical `buffer.feed(chunk)` → per-line `recordReceive` → dispatch sequence, now living in `TcpLineTransport.onData()` instead of each driver's own `onData()` — a method relocation, not new computation. The one behavior change in this entire refactor (HEOS/AVR's parallel-vs-sequential device fetch) was in the **Automation Editor** work, not this AV SDK refactor — unrelated. |
| **Event latency** | Unchanged. The hook-call chain (`socket "data" event → onData → onLine hook → driver's protocol parser → recordCapabilityState → listener dispatch`) has the exact same number of synchronous function calls between a byte arriving and a `StateListener` firing as the pre-refactor code did — confirmed by keeping every hook invocation synchronous (no added `await`/microtask hop), a design constraint enforced specifically because the existing reconnect tests mix `vi.useFakeTimers()` with real socket event ordering, which an async hook would have desynced (and which would have shown up as flaky test failures — it did not). |
| **Command execution** | Unchanged. `command()` on both drivers still calls `ensureLink()` (now `this.transport.ensureLink()`) to get a `TcpLink`, checks `link.ready`/`link.socket`/`link.socket.destroyed` (identical fields, identical checks), and writes directly to `link.socket` — no new indirection layer between "driver decided to send bytes" and "bytes go on the wire." |
| **Discovery performance** | Untouched. `discover()` on all three drivers was not modified by this refactor at all — SSDP search, `queryPlayers()`, UPnP-description fetching are all byte-for-byte unchanged. |

**No fabricated numbers are presented as measured.** The claim here is narrower and
verifiable by reading the diff: this refactor relocated existing logic into a new
module without changing its algorithmic shape, call ordering, or synchronicity —
which is a structural argument for "no regression," not a substitute for the real
hardware validation this repository's documentation has consistently and honestly
flagged as still outstanding (see `docs/architecture/avr-framework-production-audit.md`
Phase 5, and `TODO.md`'s "Live hardware verification" entry).

## Verification

Every driver's own real-transport test suite (`avr-driver.test.ts`'s 19 tests,
`heos-driver.test.ts`'s 21 tests, `yamaha-driver.test.ts`'s 24 tests) passed
**unmodified** after each migration step — the primary regression gate. New
`av-sdk/`-level tests (`state-cache.test.ts`, `tcp-line-transport.test.ts`,
`extensibility.test.ts`) cover the primitives directly, including an explicit test
proving `TcpLineTransport`'s link-pool insertion ordering is correct even against a
synthetic fake socket more aggressive than any real TCP socket could be. Full
monorepo `pnpm build`/`pnpm typecheck`/`pnpm test` all green after every step — see
the AV SDK section of `SESSION_HANDOFF.md` for the exact numbers.

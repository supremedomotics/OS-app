# SupremeOS Universal AV SDK — Architecture

> The real, runtime `services/protocols/src/av-sdk/` module. Companion to
> [AV-Adapter-Development-Guide.md](./AV-Adapter-Development-Guide.md) (how to build a new
> adapter against it) and the architecture-verification + duplication-audit history that
> produced it (see `SESSION_HANDOFF.md` for the full trail: a prior turn confirmed no runtime
> SDK existed, only documentation claiming one; a full evidence-based audit then found and
> scoped the real, extractable duplication this module closes).

## What this is, in one sentence

Two small, internal-only modules — `TcpLineTransport` and `recordCapabilityState` —
extracted from `AvrProtocolDriver` and `HeosProtocolDriver`'s genuinely duplicated
transport plumbing, plus `YamahaProtocolDriver`'s independently-duplicated state
recorder. **Nothing more was built.** This is deliberate, not incomplete — read §4
before wondering where the rest of a "Universal AV SDK" you might expect is.

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

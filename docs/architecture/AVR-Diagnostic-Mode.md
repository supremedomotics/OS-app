# AVR Diagnostic Mode

> An installer-enabled, production-safe tracing facility for the Denon/Marantz Telnet driver
> (`services/protocols/src/avr-driver.ts`). Captures the complete lifecycle of every real
> receiver event — TCP receive → parse → capability-state patch → dedupe/dispatch decision →
> gateway publish → WebSocket send — under one correlation ID per event, plus session-wide
> counters and an unknown-command frequency table. Built so a real installation's own receiver
> traffic can be captured and handed back for analysis. Off by default; effectively zero runtime
> overhead when disabled (see "How it stays free when off," below).

## Why this exists

Static code review and a live, instrumented runtime test against a fake AVR (both already
performed against this codebase) can only prove the SupremeOS pipeline itself works correctly —
neither can observe what a specific installer's own physical Denon/Marantz receiver actually
sends. This mode closes that gap: it's a permanent, opt-in facility an installer turns on
against their own hardware to produce one artifact — a single trace log — that captures ground
truth from the real receiver, for analysis without requiring remote hardware access.

## 1. Enabling it

Set the environment variable on the gateway process:

```
SUPREME_AVR_DIAGNOSTICS=true
```

(Adapted from the originally-requested `AVR_DIAGNOSTICS` name to match this codebase's
established `SUPREME_`-prefixed environment variable convention — see `SUPREME_AVR_ENABLED`,
`SUPREME_HEOS_ENABLED`, etc. in `services/gateway/src/config.ts`.)

This is picked up in two places, matching how the AVR driver is already brought up:

- **Env-only boot path** (`services/gateway/src/bootstrap.ts`): if `SUPREME_AVR_ENABLED=true`,
  the driver is constructed with `diagnostics: config.avrDiagnostics`.
- **Extension-Center / manifest-driven path** (`services/gateway/src/installer-context.ts`'s
  `nativeDriverContext()`, used when the "Supreme AVR" extension is installed + enabled from the
  UI): every AVR driver instance built this way also receives the same flag.

Either way, restart (or redeploy) the gateway process with the env var set. There is no
per-device toggle — it applies to every Denon/Marantz receiver this hub controls, because a
single AVR driver instance owns the Telnet link(s) for all of them.

**Turn it off again** by removing the env var (or setting it to `false`) and restarting. Leave it
on only while actively capturing a session — see "Overhead," below, for why.

## 2. Reproducing the issue

With diagnostics enabled, operate the receiver as you normally would — through the SupremeOS
app, the Denon Remote app, or the receiver's own front panel — reproducing whatever real-world
symptom prompted the investigation (e.g. "volume changes on the receiver don't show up in the
UI"). Every command sent and every line the receiver sends back is captured automatically; no
additional action is needed beyond generating real traffic.

## 3. Exporting the trace

**GET `/v1/devices/:id/diagnostics/export`** — returns the owning driver's complete diagnostic
trace log as a downloadable `diagnostic.log` file (`Content-Type: text/plain`,
`Content-Disposition: attachment; filename="diagnostic.log"`). Same permission posture as the
existing `/v1/devices/:id/diagnostics` and `/v1/devices/:id/diagnostics/trace` routes — requires
a valid session token and `device`/`view` permission on the target device.

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" \
  "https://<hub>/v1/devices/<deviceId>/diagnostics/export" \
  -o diagnostic.log
```

`:id` is any Supreme device ID bound to the AVR driver instance you enabled diagnostics on (any
zone of the receiver works — the trace log covers the whole driver instance, not just that one
device). Returns `404 not_found` if diagnostics was never enabled for that driver instance (the
env var was off, or the process hasn't been restarted since it was set).

**This is the one file to upload back for analysis: `diagnostic.log`.** It contains, in order:

1. The complete raw trace — every captured stage line, chronological, each tagged
   `[AVR-000023][StageName]` with its correlation ID.
2. A session summary — exact counters plus the unknown-command frequency table (see below).

## 4. What's captured

### Per-event trace lines

Every real receiver event gets a correlation ID (`AVR-000001`, `AVR-000002`, ...), and every
stage that event passes through logs a line tagged with that same ID:

```
2026-07-25T18:04:11.203Z [AVR-000023][TCP] host=192.168.1.50 port=23 line="MV63"
2026-07-25T18:04:11.204Z [AVR-000023][Parser] update={"kind":"volume","volume":63,"volumeDb":0}
2026-07-25T18:04:11.204Z [AVR-000023][patchMedia] host=192.168.1.50 port=23 zone=main capability=media deviceId=device123 bindingFound=true old={...} new={...}
2026-07-25T18:04:11.204Z [AVR-000023][StateCache] deviceId=device123 capability=media old={...} new={...} changed=true listeners=1 dispatch=true
2026-07-25T18:04:11.206Z [AVR-000023][Gateway] published=true
2026-07-25T18:04:11.208Z [AVR-000023][WebSocket] sent=true subscribedRooms=2
```

Stages, and what each one proves:

| Stage | Proves | Fields |
|---|---|---|
| `TCP` | a line genuinely arrived from the receiver | host, port, raw Telnet line |
| `Parser` | the codec recognized it | parsed update object (or `null` — see "Unknown protocol lines") |
| `patchMedia` / `emitFor` | a Supreme device binding exists for this host/port/zone/capability | host, port, zone, capability, deviceId (or `NONE`), whether a binding was found, old/new state |
| `StateCache` | whether it was dispatched or deduplicated | deviceId, capability, old/new state, `changed`, listener count, dispatch decision |
| `Gateway` | the event reached the bus/publish layer | `published: true` |
| `WebSocket` | a connected client actually received it | `sent: true`, `subscribedRooms` (this client's subscription count) — appears once per subscribed client, so a broadcast to 2 clients produces 2 `[WebSocket]` lines under the same correlation ID; that's real fan-out, not duplicate logging |

`patchMedia`/`StateCache` stages are emitted by the driver itself
(`services/protocols/src/avr-driver.ts`); `Gateway`/`WebSocket` stages are appended by the
gateway process (`services/gateway/src/context.ts`'s `onBackendState()` and
`services/gateway/src/stream.ts`'s WSS fan-out) via `INativeProtocolDriver.recordDiagnosticStage()`
— an optional driver method looked up through the existing `SupremeIntegrationLayer.
getNativeDriver("avr")`, so the gateway never needs AVR-specific knowledge to append to the
trace the driver started. The hand-off is a `traceId` field carried on the normalized
`BackendStateEvent` the driver dispatches — present only when diagnostics is on, `undefined`
(zero behavior change) for every other event from every other driver.

### Unknown protocol lines

A line the receiver genuinely sent but the codec doesn't recognize is never summarized as a bare
"unrecognized line" message — it's captured with everything needed to identify a real codec gap:

```
2026-07-25T18:05:02.001Z [AVR-000031][Unknown] host=192.168.1.50 port=23 hex=5a5a51393900 ascii=ZZQ99 length=5 firstToken=ZZQ99 occurrences=3 note="observed 3 times this session"
```

Fields: raw bytes (hex), ASCII rendering (non-printable bytes shown as `.`), byte length, first
whitespace-delimited token, sender host:port, and how many times this exact line has been seen
this session. The session report (below) lists every distinct unknown pattern, most-frequent
first, with first/last-seen timestamps.

### Session report (at export / at shutdown)

Exact counters — every number is a real count, never estimated:

```
===== AVR Diagnostic Mode — Session Report =====
Started:            2026-07-25T18:00:00.000Z
Report generated:   2026-07-25T18:10:00.000Z
Session duration:   600s

Counters:
  commands received:    142
  commands parsed:       139 (2 distinct unknown patterns)
  unknown commands:      3
  events dispatched:     87
  events dropped:        52  (= bindings missing + cache deduplicated)
    bindings missing:      5
    cache deduplicated:    47
  gateway publishes:     87
  websocket sends:       174

Unknown commands (most frequent first):
  "ZZQ99" observed 2 times — first seen ..., last seen ..., sender=192.168.1.50:23, firstToken=ZZQ99, length=5 bytes, hex=5a5a513939
  ...
=================================================
```

`eventsDropped` is always exactly `bindingsMissing + cacheDeduplicated` — kept as its own counter
(not recomputed at report time) so the three numbers can never silently drift apart. This report
is also logged automatically (through the same `onLog` sink every other driver log line uses)
when the driver disconnects, satisfying "at shutdown produce a summary" even if the export route
is never called.

## 5. How it stays free when off (production-safety)

Every call site in `avr-driver.ts` reads diagnostics through `this.diagnostics?.method(...)`.
When disabled, `this.diagnostics` is `null`, and optional chaining short-circuits **before
evaluating any argument** — this is real, spec-guaranteed JavaScript/TypeScript behavior
(`a?.b(expensive())` never calls `expensive()` when `a` is nullish), not an approximation. The
disabled cost is one property read plus one null check per call site: no string building, no
allocation, no I/O, no behavior change to the protocol, parser, or any control path.

This is a distinct, heavier, opt-in-only facility from the existing `trace`/`ProtocolTracer`
mechanism (`AvrDriverOptions.trace`), which already ships and answers a narrower question ("what
raw bytes went over the wire"). AVR Diagnostic Mode answers "what happened to ONE event as it
moved through the entire pipeline, end to end, including hops outside this driver" — gateway
publish, WebSocket send — which `ProtocolTracer` cannot see. The two can be enabled
independently; diagnostics does not replace or disable `trace`.

**Memory bounds** (both silently enforced, never grow unbounded): the raw trace buffer keeps the
most recent 100,000 lines (oldest evicted first — the session report notes if eviction happened,
though counters and the unknown-command table stay exact for the full session regardless); the
unknown-command frequency table caps at 2,000 distinct patterns (least-frequent evicted first).
Neither bound is expected to be hit in a normal diagnostic session.

## 6. No feature work

This mode adds observability only. It does not add AVR functionality, does not modify protocol
behavior, and does not change parser logic — every field captured is read from data the driver
already computes; nothing about *what* the driver does changes, only what gets logged about it.

## 7. Files

- `services/protocols/src/avr-diagnostics.ts` — `AvrDiagnosticsRecorder`: correlation IDs,
  per-stage capture, unknown-command tracking, counters, session report, log export.
- `services/protocols/src/avr-driver.ts` — instrumentation call sites (`onLine()`,
  `patchMedia()`, `emitFor()`, `record()`, `disconnect()`), plus `recordDiagnosticStage()` /
  `exportDiagnosticsLog()` on `AvrProtocolDriver`.
- `services/integration-layer/src/adapter.ts` — `BackendStateEvent.traceId` (optional).
- `services/integration-layer/src/protocols/driver.ts` — `INativeProtocolDriver.
  recordDiagnosticStage?()` / `exportDiagnosticsLog?()` (both optional).
- `services/integration-layer/src/native-adapter.ts`, `routing-adapter.ts`, `sil.ts` —
  `exportDiagnosticsLog(deviceId)` routed to the owning driver, mirroring `getTrace`/
  `getDiagnostics`'s existing routing.
- `services/gateway/src/context.ts` — appends the `[Gateway]` stage in `onBackendState()`.
- `services/gateway/src/stream.ts` — appends the `[WebSocket]` stage per subscribed client.
- `services/gateway/src/config.ts` — `SUPREME_AVR_DIAGNOSTICS` → `GatewayConfig.avrDiagnostics`.
- `services/gateway/src/native-driver-factory.ts`, `installer-context.ts`, `bootstrap.ts` —
  thread the flag into the AVR driver's construction (both boot paths).
- `services/gateway/src/routes/devices.ts` — `GET /v1/devices/:id/diagnostics/export`.
- Tests: `services/protocols/src/avr-diagnostics.test.ts`, the "AVR Diagnostic Mode wiring"
  `describe` block in `services/protocols/src/avr-driver.test.ts`, `services/gateway/src/
  native-driver-factory.test.ts`, `services/gateway/src/avr-diagnostics-export.e2e.test.ts`.

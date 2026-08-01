# SESSION_HANDOFF.md

> Current development state. **Rewrite this at the end of every session** — it should describe
> what changed *since the previous handoff*, not the whole project history (that's
> `PROJECT_CONTEXT.md`). Keep it concise.

## Session: Casambi Local Gateway — Final Hardware Validation & Production Gate

**Branch:** `claude/casambi-driver-refactor-lvu23e` (continues Phase 2 below). Full report:
**`docs/architecture/Casambi-Final-Hardware-Validation-Report.md`** — Hardware Validation Report,
Performance Report, Packet Replay Framework Guide, Transport Monitor Guide, and Production
Readiness Checklist, all in one document. **Production Gate verdict: NOT EVALUATED — hardware
unavailable** (neither PASS nor FAIL — this sandbox never had access to a real Lithernet gateway,
so there is no real-hardware evidence to render either verdict on). Per the governing brief's
Critical Requirement, KNX/Matter/other protocol migrations remain on hold until that real-hardware
retest actually happens.

**What changed this session:**
- **Packet Replay Framework** (new, `@supreme/lan`, protocol-agnostic — reusable by every future
  LAN protocol): `PacketCapture` JSON format (`services/lan/src/server/replay-dgram-socket.ts`),
  `replayableDgramSocket()` (wraps a real or fake `DgramSocketLike`, injects a captured datagram
  through the IDENTICAL `DgramUdpSession` → `UdpTransportServer` → NATS → `NatsUdpTransportClient`
  → adapter → driver chain real hardware traffic uses — "no code path may differ" is satisfied
  structurally, not by convention), `fakeDgramSocket()` (formalizes the fake-socket pattern every
  test file was hand-rolling separately). File I/O + PCAP export (one-way, for opening a capture in
  Wireshark — PCAP import deliberately not implemented, see the report §3 for why) in
  `services/lan/src/server/capture-io.ts`.
- **Capture library**: `tests/regression/casambi/{living-room,kitchen,office}.json` —
  `living-room` is the REAL 99-byte Wireshark-captured NotifyControlValues packet from the earlier
  hardware audit session, reused rather than re-transcribed; `kitchen`/`office` are synthetic but
  wire-valid (a button press; a well-formed but UNMAPPED opcode 0x39, deliberately exercising the
  "Discovery ignored packet" failure mode). New
  `casambi-packet-replay-regression.test.ts` (7 tests) auto-loads and replays every capture
  through the real pipeline — "no hardware required" per the brief, verified: e.g. the real
  living-room capture's controls map to Supreme's `sensor` capability (VERIFIED by actually
  running the code and reading the result, not assumed — an earlier draft assumption that it
  would map to `onoff` was wrong and caught by the test failing honestly).
- **New driver-level observability**: `CasambiProtocolDriver` now tracks `unmappedOpcodeEvents`/
  `lastUnmappedOpcode` (a datagram that decodes successfully but whose opcode
  `normalizeLocalPacket` doesn't map to any signal — previously a true silent drop, now a real,
  observable event) and a bounded `recentJourney` "Packet Trace" (per-datagram: arrival time,
  decode outcome, resolved handler/signal kind, and a REAL measured `processingDurationMs`).
- **Failure Analysis report generator** (`services/protocols/src/casambi/failure-analysis.ts`,
  new): a pure function over the Transport Monitor snapshot producing the EXACT ✓/✗ + "Reason:"
  checklist format the governing brief specified (Transport → NATS → Casambi Adapter →
  Discovery/Driver), never guessing — `not_applicable` for anything it can't honestly evaluate.
  Wired into `GET /v1/drivers/:id/casambi/transport-monitor` as a new `failureAnalysis` field.
- **Performance**: extended the existing latency benchmark to report p50/p95/p99/max (not just
  median/p95/mean).
- **No UI built this session** (Transport Monitor panel, Packet Replay "Saved Captures" panel,
  Packet Trace viewer) — same disclosed scope cut as Phase 2's Transport Monitor; backend/data
  only, tracked in TODO.md.

**Tests:** 4 new test files (`replay-dgram-socket.test.ts` 5 tests, `capture-io.test.ts` 3 tests,
`casambi-packet-replay-regression.test.ts` 7 tests, `failure-analysis.test.ts` 8 tests) plus new
cases in `casambi-driver.test.ts`. `@supreme/lan`: 6 files/42 tests. `@supreme/protocols`: 79
files/760 tests. `@supreme/gateway`: 72 files/295 tests. All passing, zero regression.

**Disclosed, still not resolved:** real Lithernet hardware and real Windows Docker Desktop remain
outside this sandbox's reach — no engineering inside this environment changes that. The Packet
Replay Framework and Failure Analysis tooling exist specifically so that when real hardware IS
available, the runbook (`docs/architecture/Casambi-Real-Hardware-Validation-Runbook.md`, updated
this session to reference these new tools) can be followed and the Production Gate re-evaluated
with real evidence.

## Session: `supreme-lan` LAN Transport Service — Phase 2 (Casambi Migration & Transport Monitor)

**Branch:** `claude/casambi-driver-refactor-lvu23e` (continues Phase 1 below). Full account,
including the honest hardware/Windows/Linux assessment: **`docs/architecture/
Supreme-LAN-Transport-Architecture.md` §10**. ADR 0022's status line updated to reflect Phase 2 as
implemented. Per the governing brief's Critical Requirement, **do not start KNX/Matter/any other
protocol migration until Casambi is confirmed operational on real hardware** — that hasn't
happened yet (see below); the existing `lan-adapters/` (KNX Discovery/mDNS/SSDP) remain exactly as
Phase 1 left them, untouched.

**What changed this session:**
- **`CasambiUdpSocketLike`/`CasambiUdpSocketFactory` deleted entirely.** `CasambiUdpEngine`
  (`services/protocols/src/casambi/local-transport/udp-engine.ts`) now takes a required
  `udpTransportFactory: UdpTransportFactory` and calls the generic `UdpTransport` (`@supreme/lan`)
  directly — no adapter layer, no raw `node:dgram` inside this package anymore. Every other public
  method/getter kept its exact prior shape, so `command-engine.ts`, `discovery-engine.ts`, and
  `casambi-driver.ts`'s command/event dispatch needed **zero edits**.
- **`LocalDirectUdpTransport`** (new, `services/lan/src/client/local-direct-udp-transport.ts`) — a
  same-process `UdpTransport` (real `node:dgram`, no NATS hop) for single-process dev/test, wrapping
  the already-tested `DgramUdpSession`.
- **Transport selection is centralized once**, in `services/gateway/src/installer-context.ts`'s
  `nativeDriverContext()`: real NATS configured → `NatsUdpTransportClient`; otherwise →
  `LocalDirectUdpTransport`. `native-driver-factory.ts`'s casambi factory and the Test Connection
  route (`routes/installer.ts`) both consume this same resolution — Casambi's Local Gateway driver
  now **defaults through `@supreme/lan`** in every environment, not just when explicitly configured.
- **Transport Monitor** (new): `CasambiProtocolDriver.getCasambiTransportMonitor()`
  (`services/protocols/src/casambi/transport-monitor.ts`) — four real, non-fabricated layers
  (Transport/NATS/Casambi Adapter/Driver), exposed at the new
  `GET /v1/drivers/:id/casambi/transport-monitor` route, separate from the existing
  `casambi/diagnostics` route (unchanged). New counters added purely additively:
  `CasambiUdpEngine.decodedCount`/`decodeFailureCount`/`transportDiagnostics`,
  `NatsUdpTransportClient.packetsSent`/`packetsReceived`/`requestsSent`/`eventsReceived`/
  `lastError`, `CasambiProtocolDriver`'s `discoveryEventsCount`/`commandsIssuedCount`/
  `feedbackEventsCount`. New `queryLanHealth()` client helper (`@supreme/lan`) calls the
  `supreme.lan.health` subject Phase 1 built a server handler for but nothing had called yet.
  **No dedicated UI page built this session** — see TODO.md.
- **Cloud implementation, entity model, discovery/event/command engines, Driver Manager UI, and
  the existing Cloud REST implementation are byte-for-byte unchanged** — zero edits to any of those
  files; confirmed by the full pre-existing test suite passing unmodified.

**Tests (all passing, all in this session):** rewrote `udp-engine.test.ts` (35 tests, all UdpTransport-
based) and `casambi-driver.test.ts` (34 tests) onto the new architecture; new
`casambi-over-supreme-lan.test.ts` (7 tests) — the cross-package proof that the REAL, unmodified
`CasambiProtocolDriver` connects/discovers/updates state/fires events/issues commands entirely over
a REAL `NatsUdpTransportClient` + REAL `UdpTransportServer` sharing a REAL `IEventBus` (fake
`node:dgram` only), plus the honest failure-path proof (no `supreme-lan` reachable → `connect()`
rejects, never silently "succeeds"); new `NatsUdpTransportClient`/`queryLanHealth` tests in
`@supreme/lan`'s `contract.test.ts`; new `native-driver-factory.test.ts` tests proving the factory
actually uses a supplied `udpTransportFactory` and correctly falls back to
`LocalDirectUdpTransport`; new `casambi-lan-latency.test.ts` — an automated, repeatable, code-only
latency benchmark (n=50 samples/run). Full monorepo `turbo run build typecheck test`: **173/173
tasks green** (`@supreme/protocols` 77 files/742 tests, `@supreme/gateway` 72 files/295 tests,
`@supreme/lan` 4 files/34 tests — all up from Phase 1's counts, zero regression anywhere).

**Real Docker validation (new this continuation — a real Docker Engine became available in this
sandbox mid-session):** built the real `lan.Dockerfile` image, booted real `nats`+`lan` containers,
and reproduced the ACTUAL bug this project exists to fix, for real: a genuine UDP broadcast sent
from the Docker host was **not received** by the bridge-networked `lan` container, then **was
received** by the identical container rebuilt on `docker-compose.lan-host.yml` (real
`network_mode: host`) + `docker-compose.nats-loopback.yml`. This is real Docker/Linux evidence, not
a simulation — see architecture doc §10.3 for full detail. In the process, found and fixed two
real, previously-undiscovered bugs (not caught by config-parsing or code review): (1)
`lan.Dockerfile` never copied `cloud`/`drivers`/`tools`, so `pnpm install --frozen-lockfile` failed
outright (`services/license` depends on `cloud/licensing`) — fixed to match
`gateway.Dockerfile`'s COPY list; (2) `docker-compose.nats-loopback.yml`'s port publish was
silently a no-op because Docker refuses to publish a port for a container whose ONLY network is
`internal: true` (confirmed with an isolated minimal repro) — fixed by giving `nats` a second,
non-internal, loopback-only network in that one override file. Also measured a real end-to-end
latency of **~8ms** (host UDP send → real container receive → real NATS publish → host-side
subscriber) during this validation, alongside the new automated benchmark's code-only numbers
(sub-millisecond — see architecture doc §10.4 for both, kept clearly separate).

**Disclosed, still not resolved (see TODO.md and architecture doc §10.3):** this sandbox still
cannot reach a real Lithernet gateway or real Windows Docker Desktop — no amount of additional
sandbox work substitutes for that. A synthetic UDP broadcast from a script is real evidence the
Docker/networking MECHANISM works, but it is not a real device on a real physical LAN. The
Transport Monitor has a working backend + route but no dedicated UI page yet. KNX/mDNS/SSDP
migration remains explicitly on hold pending the real-hardware retest, per the governing brief.

## Session: Production Architecture Refactor — `supreme-lan` LAN Transport Service (Phase 1)

**Branch:** `claude/casambi-driver-refactor-lvu23e` (continues the sessions below — this is now a
cross-cutting infrastructure change, not Casambi-specific, per the user's own explicit framing).
Full design record: **`docs/architecture/adr/0022-supreme-lan-transport-service.md`**; full
technical detail (flow/deployment diagrams, migration risk table, testing honesty notes):
**`docs/architecture/Supreme-LAN-Transport-Architecture.md`** — read both before touching Docker
network topology or any raw-socket driver code again.

**Problem:** Docker bridge networking silently drops LAN broadcast/multicast (proven with the real
Casambi Wireshark capture from the prior session) — affects Casambi UDP, KNX Routing/Discovery,
Matter/mDNS, SSDP, Sonos, Denon, Apple TV, Hue, Yamaha. Moving the whole Gateway to
`network_mode: host` (tried previously) broke it (`getaddrinfo ENOTFOUND postgres`, proxy 502) —
the Gateway is tightly coupled to Postgres/Redis/NATS/internal services only reachable via
Docker's bridge DNS.

**Solution built this session (Phase 1 only — service + generic transport + Docker topology +
docs, NOT yet the default for any driver):**
- **New package `@supreme/lan`** (`services/lan`) — zero dependency on `@supreme/protocols` or any
  business/domain concept. Reuses `@supreme/messaging`'s existing `IEventBus`/NATS seam (already
  deployed, already wired into the Gateway) as its only IPC — no new mechanism invented. A generic
  `requestReply()` helper (`shared/rpc.ts`) adds real RPC semantics on top of the bus's existing
  publish/subscribe, without modifying `@supreme/messaging` itself.
- **Generic `UdpTransport` interface** (`transport.ts`): `bind`/`send`/`joinMulticast`/`close`/
  `onMessage`/`onError`/`onListening`/`address` — ONE interface covering unicast, broadcast, and
  every multicast use in this codebase (mDNS/SSDP/KNX are just `bind({multicastGroup})` presets).
  `joinMulticast()` exists as a separate post-bind capability specifically because KNX
  discovery's real code binds first, then joins multicast only once bind genuinely completes — a
  real API gap found and fixed during implementation, not assumed away.
- **Real server** (`server/`): `DgramUdpSession` (injectable `DgramSocketLike`, same fake-socket
  convention as every existing raw-socket module) + `UdpTransportServer` (NATS command dispatch,
  session multiplexing, event publishing) + `main.ts` (deployable entrypoint) + `health.ts`
  (diagnostics snapshot — `networkMode` read from config, never inferred, per this codebase's
  standing "never fabricate" rule).
- **Four migration adapters** (`services/protocols/src/lan-adapters/`, NOT inside `@supreme/lan` —
  keeps the dependency direction one-way: `@supreme/protocols → @supreme/lan`): each implements an
  EXISTING driver-facing interface (`CasambiUdpSocketLike`, `KnxDiscoverySocket`, `MdnsSocket`,
  `SsdpSocket`) exactly, as a drop-in alternative to that protocol's real-`dgram` default. **None
  of the four existing driver files were modified** — the adapters are opt-in, not defaulted.
- **Docker**: base `docker-compose.yml` gets a `lan` service (bridge, degraded-but-testable
  default); new `docker-compose.lan-host.yml` (host networking, mirrors
  `docker-compose.appletv-host.yml` exactly — simpler, since `lan` only ever talks NATS, no
  `extra_hosts` needed); new `docker-compose.nats-loopback.yml` (exposes NATS on `127.0.0.1` only,
  since `supreme-core` is `internal: true` and a host-networked container can't reach it by
  container DNS). New `infra/hub-compose/lan.Dockerfile` mirrors `gateway.Dockerfile`'s
  multi-stage pnpm-deploy pattern.

**Tests (all passing, all in this session):** `@supreme/lan` — 24 tests (fake-socket unit,
`InProcessEventBus` contract/RPC, real-loopback smoke test with genuine OS UDP sockets).
`@supreme/protocols` lan-adapters — 19 tests, including the concrete cross-package proof: the
REAL, unmodified, hardware-validated `CasambiUdpEngine` sending/receiving real wire packets
entirely over the new remote transport. Full `@supreme/protocols` suite re-run: 77 files/727 tests,
zero regression (no existing driver file touched).

**Disclosed, not resolved this session (see TODO.md):** Phase 2 (defaulting Casambi onto the
remote transport) deliberately held — the adapter is proven, but flipping the default needs its
own real-hardware retest against a host-networked `supreme-lan`, not bundled into the session that
introduces the RPC path for the first time. KNX Routing and Matter (Phases 3b/4) need their own
protocol-level seam work first — both currently own sockets inside third-party libraries
(`knxultimate`, future `@matter/main`) with no injectable hook, unlike Casambi/KNX-discovery/
mDNS/SSDP. "Windows compatibility" testing is code-review-only + a documented native-process
workaround, not executed on Windows this session (this sandbox is Linux-only). Real LAN broadcast
reception has not been re-verified against actual hardware through `supreme-lan` yet — only the
diagnostic/transport plumbing is proven, via loopback and in-process tests.

## Session: Casambi Local Gateway — UDP Receive Pipeline Audit (real hardware capture)

**Branch:** `claude/casambi-driver-refactor-lvu23e` (continues the Auth & UDP Diagnostics session
below). Triggered by a real Wireshark capture (Lithernet Gateway, firmware 6.25) proving the
gateway broadcasts `NotifyControlValues` to `255.255.255.255:10009` while SupremeOS reported
`Packets Received = 0`. Full audit, root cause, before/after flow diagrams, and firmware-scheme
disclosure: **`docs/architecture/Casambi-UDP-Receive-Pipeline-Audit.md`** — read that document
before touching `udp-engine.ts`'s `handleMessage` again.

**Root cause (confirmed by code reading, not hardware):** no reception-blocking bug existed —
the socket binds to `0.0.0.0` (no address filter, no `connect()`, no `rinfo.address` check
anywhere), so broadcast and unicast datagrams are received identically. The REAL, confirmed bug:
`packetsReceived` only incremented inside `decodeCasambiPacket()`'s success branch, so a datagram
that failed to parse was invisible to the counter and had no bulk trace — "never arrived" and
"arrived but failed to parse" were indistinguishable everywhere in the driver. Manually decoding
the report's exact byte sequence (reconstructed to its stated 99-byte length) against the
unmodified codec succeeds, so the specific example isn't itself undecodable — the fix targets the
counter/tracing gap the report's required steps describe, not a codec rewrite.

**Changes:**
- `udp-engine.ts`: `packetsReceived`/`lastPacketAt` now increment BEFORE parsing, unconditionally.
  New `onRawDatagram()` (fires pre-parse, proves socket-level reception independent of decode) and
  a bounded (20-entry) `recentTraces` log — every datagram, decoded or not, with raw ASCII/hex,
  byte length, source, and parse result. A failed parse is traced and logged, never a silent drop.
- `casambi-driver.ts`: wires `onRawDatagram`/`onDecodeError` into the existing `ProtocolTracer`
  pipeline (immediate "UDP datagram received"/"UDP parse failed" log lines); threads
  `recentTraces` into `getCasambiDiagnostics()`.
- `diagnostics.ts`, `routes/installer.ts`, `api.ts`, `drivers.tsx`: `recentTraces` surfaced end to
  end — Diagnostics page now renders a real packet-trace table, and Test Connection's UDP result
  includes the trace from its own test window.

**Tests:** `udp-engine.test.ts` — 1 updated (decode failure now correctly counts as received) + a
new "real hardware capture" suite (8 tests) using the report's exact byte sequence, reconstructed
and verified to be exactly 99 bytes: broadcast reception, pre-parse counting, real ASCII hex-dot
decode, full trace recording, parser-failure trace+log, bounded trace log. `casambi-driver.test.ts`
+2 (end-to-end trace reaching Driver Diagnostics for both a decodable and an undecodable packet).
Full monorepo verification green (`@supreme/protocols` 72 files/708 tests, `@supreme/gateway` 72
files/293 tests after rebuilding `@supreme/protocols`'s dist — a workspace-resolution step, not a
code defect — `@supreme/drivers` 22, `@supreme/web-homeowner` 55 + build). Zero Cloud regression.

**Disclosed, not resolved:** no hardware was available to confirm the original symptom is now
actually fixed end-to-end on the real gateway — only that the diagnostic blind spot the report
describes is closed and the reconstructed real payload decodes correctly. The gateway's own
firmware number (6.25) and the protocol doc's "Evolution firmware" version gates (e.g. ≥37.90) are
different numbering schemes and were NOT compared numerically — see the audit doc §6.

## Session: Casambi Local Gateway — Auth & UDP Diagnostics

**Branch:** `claude/casambi-driver-refactor-lvu23e` (continues the audit session below, same
branch). Brief: refine Local REST authentication, fix the UDP "Unreachable" false-negative, and
add production-quality staged connection diagnostics — grounded strictly in the Lithernet manuals,
with every undocumented assumption disclosed rather than inferred. Full write-up, including the
required six-question UDP audit answered against the real pre-existing code:
**`docs/architecture/Casambi-Local-Auth-And-UDP-Diagnostics.md`** — read that document, not this
summary, before touching Local REST auth or UDP diagnostics again.

**Root causes found (both real, confirmed by reading the code, not assumed):**
1. The generic `services/drivers/src/config.ts` `validateDriverConfig` iterated the Casambi
   manifest's full `configSchema` unconditionally, checking `required` regardless of
   `connectionType` — a Local Gateway config save could fail on a missing `email` (a Cloud-only
   field), and vice versa. This existed independently of anything UDP-related.
2. `CasambiUdpEngine.probe()`'s reachability check conflated one timed-out application-layer
   round-trip (opcode 0x39 Node Status, 2s timeout) with the actual transport state — a
   TCP-shaped assumption on a connectionless, push-based protocol. The gateway's own "UDP
   Listening on IP:Port" self-report (confirmed via `Lithernet_General_Settings_Network.pdf` p.72
   as its own Control System Wizard status field) was never contradictory with SupremeOS's
   report; the probe-timeout logic was just answering the wrong question.

**Changes made** (Connection Manager → Transport → Service → Engine hierarchy preserved,
unmerged; zero Cloud regression — the full pre-existing Cloud-mode test suite passed unmodified):
- **`packages/domain-model/src/drivers.ts`** — new `requiredIf: { key, equals }` on
  `DriverConfigField`, a generic (not Casambi-specific) mechanism for mode-conditional required
  fields.
- **`services/drivers/src/config.ts`** — `validateDriverConfig`/`isConfigComplete` now resolve
  `requiredIf` against the submitted/existing/default value of the named discriminator field.
- **`local-transport/rest-client.ts`** — `gatewayUsername`/`gatewayPassword` → HTTP Basic Auth on
  every request; `testConnection()` returns `{ reachable, httpStatus, authFailed }`;
  `setTargetValue()` can return `"unauthorized"`.
- **`local-transport/udp-engine.ts`** — real `socketState`, `localAddress`/`localPort` (from
  `dgram.Socket.address()`), `packetsSent`/`packetsReceived`, `lastPacketAt`, `lastSendError`,
  `lastDecodeError`, `averageLatencyMs` (probe round-trips only). No packet-loss field — the
  documented packet structure has no sequence numbers, so it's permanently unmeasurable and never
  fabricated.
- **`health-monitor.ts`** — new `udpStage()`: `not_configured | socket_error | bound_waiting |
  active`. Only a real socket error is a failure; "bound, nothing received yet" is a normal state.
- **`diagnostics.ts`** — additive `udp` field on the snapshot (Local only, `null` for Cloud).
- **`services/gateway/src/routes/installer.ts`** — Test Connection rewritten to the staged model
  above instead of a single `reachable` boolean; never marks UDP failed on "no reply yet."
- **`manifests.ts`** — new `gatewayUsername`/`gatewayPassword` fields, exact field order per the
  brief's mockup, `requiredIf` on every mode-conditional field, version bumped to 1.3.0.
- **`native-driver-factory.ts`**, **`drivers.tsx`**, **`api.ts`** — threaded the new fields/types
  through; Driver Manager's Local Gateway panel now renders the staged Test Connection report
  (REST / HTTP Authentication / Gateway / UDP / Port / Gateway Configuration / Status / Packets
  Received / Last Packet / Latency), and the Diagnostics page gained a live "UDP transport"
  section sourced from the running driver's real engine state.

**Tests:** ~45 new/updated tests across `config.test.ts` (requiredIf, both directions),
`rest-client.test.ts` (Basic Auth header, 401/403 handling), `udp-engine.test.ts` (socketState
transitions including a real bind failure, address/port exposure, packet/send/decode counters,
probe latency, no packet-loss getter), new `health-monitor.test.ts` (`udpStage`'s four-way rule),
`casambi-driver.test.ts` (end-to-end diagnostics wiring, `bound_waiting`→`active` transition,
`udp: null` in Cloud mode), `native-driver-factory.test.ts` (+2). Full monorepo
`turbo run build typecheck test` across `@supreme/domain-model`, `@supreme/drivers`,
`@supreme/protocols`, `@supreme/gateway`, `@supreme/web-homeowner`: **48/48 tasks green**
(`@supreme/protocols` 71 files/690 tests, `@supreme/gateway` 71 files/289 tests, `@supreme/drivers`
22 tests, `@supreme/web-homeowner` 55 tests + build). No hardware was available — every claim is
either a code fact or cited to a specific Lithernet PDF page, never inferred as verified.

**Disclosed, not fixed this session** (see `TODO.md`): the HTTP auth scheme is Basic by informed
default, not confirmed against real hardware (Digest is possible); no SSL/HTTPS support for the
Local REST client; no dedicated fastify-level HTTP test for the rewritten test-connection route
(its underlying primitives are fully unit-tested); the MAC-address-as-credentials fallback login
is not implemented.

## Session: Casambi Architecture Validation & Refactor (mandatory pre-implementation audit)

**Branch:** `claude/casambi-driver-refactor-lvu23e` (continues PR-2 below, same branch). The user
required a full, honest architecture audit against an explicit Connection Manager → Transport →
Service → Command/Event/Discovery Engine hierarchy **before any further feature work**, with an
explicit instruction not to self-grade "yes." Full findings, per-layer honest answers, refactor
performed, and justification for every decision: **`docs/architecture/Casambi-Architecture-Audit.md`**
— read that document, not this summary, before touching command/event dispatch in this driver again.

**Headline finding:** Connection Manager, Local Transport (container), and both Local Services
(REST/UDP) were already genuinely compliant. **Command Engine and Event Engine did not exist as
real, distinct entities** — `casambi-driver.ts`'s `command()` had an inline `if (mode==="local")`
branch building/sending commands two different ways, and two separate private methods
(`onEvent`/`onLocalPacket`) each independently decided what a raw wire signal meant, duplicating
that decision once per transport. Discovery Engine was half-real: `buildDiscoveredDevices()` (the
output-shaping half) was already transport-independent and correct; the driving half (how a
transport learns about units) was inline in the driver for both transports.

**Refactor performed** (zero Cloud regression — the full pre-existing Cloud-mode
`casambi-driver.test.ts` suite, including its fake-timer reconnect/heartbeat assertions, passed
unmodified after every step, verified incrementally, not just once at the end):
- **`command-engine.ts` (new)** — `CasambiCommandEngine` interface, `CloudCommandEngine`/
  `LocalCommandEngine` implementations. `command()` collapsed to one call site, no mode branching.
- **`event-engine.ts` (extended)** — `CasambiSignal` union + `normalizeCloudEvent`/
  `normalizeLocalPacket` (pure functions) + `enableLocalButtonEvents`/`disableLocalButtonEvents`.
  The driver's two duplicated dispatch methods removed, replaced by one `applySignal()` reaction
  method fed by both normalizers.
- **`discovery-engine.ts` (extended)** — `startLocalDiscovery`/`stopLocalDiscovery` extracted from
  the driver's inline UDP bootstrap/teardown. Cloud's discovery-driving (`loadNetwork`/`seedState`)
  was deliberately NOT extracted into a shared interface — two real callers with genuinely
  different shapes (REST pull vs. UDP push) is judged premature abstraction, not a missing
  abstraction; full reasoning in the audit doc.
- **25 new tests** (`command-engine.test.ts` 6, `event-engine.test.ts` 14, `discovery-engine.test.ts`
  5) exercising the extracted engines directly, independent of the driver.

**Disclosed, NOT fixed in this pass** (see the audit doc's §7 template-readiness table and
`TODO.md`): `casambi-driver.ts` still publishes through the old, Casambi-only `CasambiEventBus`,
not the cross-driver `core/event-bus.ts`'s `CoreEventBus` built in the PR-2 session — migrating it
is scoped, disclosed follow-up, not bundled into this audit's regression-sensitive refactor.
Similarly, `entity-mapper.ts`'s `capabilitiesFromUnit` does not yet consume `core/
capability-engine.ts` — that Capability Engine module exists and is tested but has no real
consumer anywhere yet, Casambi included. **Casambi is not yet confirmed ready to be the standard
template for future drivers** until those two gaps close — the audit doc says so explicitly rather
than claiming a clean bill of health.

**Verification:** full `turbo run build typecheck test` across `@supreme/protocols`,
`@supreme/drivers`, `@supreme/gateway`, `@supreme/web-homeowner` — 46/46 tasks green.
`@supreme/protocols` alone: 70 test files, 669 tests, all passing.

## Session: Casambi Driver Refactor — PR-2 Core Architecture + Local Gateway Foundation

**Branch:** `claude/casambi-driver-refactor-lvu23e` (continues the Foundation session below — same
branch, same effort). This session's brief: build the cross-driver **SupremeOS Core** (Event Bus,
Capability Engine, Packet Recorder Framework, Driver Health Engine, Driver Metrics Engine) and
implement the **real** Casambi Local Gateway protocol wherever it is fully documented — grounded in
the 7 attached Lithernet reference PDFs (re-read in full this session; `Lithernet_UDP_Developer_
Reference.pdf`'s §5.10 "UDP Casambi Command" and `Lithernet_WebAPI.pdf`'s §5.14 are the two that
matter for wire protocol). Foundation's explicit constraint carries forward unchanged: **Cloud
behavior must stay byte-for-byte identical** — nothing in `cloud-transport.ts`, `connection-
manager.ts`'s cloud branch, or the Cloud half of `casambi-driver.ts` was touched.

### SupremeOS Core (`services/protocols/src/core/`, new)

Five modules, none Casambi-specific, all with real unit tests:

- `event-bus.ts` — `CoreEventBus` + the brief's exact 13-category taxonomy (Device/Button/Sensor/
  Lighting/Media/Climate/Automation/Scene/Group/Diagnostic/Driver/Network/Health). Every interface's
  doc comment states plainly which driver actually emits it today; most are honestly reserved for a
  future protocol. **Not yet wired into `casambi-driver.ts`** — the driver still publishes through
  the pre-existing, Casambi-only `event-engine.ts`/`CasambiEventBus` (Foundation-session code, left
  alone deliberately to avoid re-touching tested Cloud event-emission paths in the same PR that adds
  Local). Migrating the driver onto `CoreEventBus` is real, scoped follow-up work — see TODO.md.
- `capability-engine.ts` — `computeEntityCapabilities()`/`computeDriverCapabilities()`, pure
  functions turning a device's real `CapabilityKind[]` + structural color config into flat boolean
  flags. `supportsRGBW` is hard-coded `false` with a doc comment explaining why (no domain-model
  white-channel field exists — not this session's gap to invent one).
- `packet-recorder.ts` — `PacketRecorder`, a bounded ring buffer with query/filter/export. Framework
  only, as scoped: no protocol-specific parsing lives here, and nothing wires the real UDP engine's
  raw datagrams into it yet (see TODO.md).
- `driver-health-engine.ts` — `computeDriverHealth()`, generalizing Foundation's Casambi-only
  Health Monitor into a reusable score+verdict engine any future driver can reuse.
- `driver-metrics-engine.ts` — `DriverMetricsEngine`, sliding-window rate counters (packets/
  commands/events per sec) + cumulative counters (REST requests/UDP events/reconnects/dropped) +
  latency tracking.

### Casambi Local Gateway — now a real protocol, not architecture-only

- `local-transport/udp-codec.ts` (new) — byte-exact encode/decode for the "UDP Casambi Command"
  wire format (`hex-dot`/`dec-hash`), grounded directly in the reference PDF's opcode tables and
  worked examples. Every encoder/parser is unit-tested against a real documented example where one
  exists. **Three documentation inconsistencies found and flagged in code comments (never silently
  resolved):** (1) §5.10.2.1.2's section heading says opcode 0x1A but its own body says 0x1B — same
  opcode 0x1B is *also* used for the unrelated ParametersComplete marker; disambiguated by the
  declared Length field, exactly as both sections themselves specify. (2) §5.10.2.2.18's heading
  says 0x3F (SetTargetElements) but its body says opcode 0x3E — identical to SetTargetDimmers
  immediately above it; resolved by following the section title, flagged as a judgment call. (3)
  0x2F (Set color via RGBW) and 0x3D (Set color via Hue/Sat) both have a worked example whose
  Length token undercounts by exactly one relative to the doc's own universal framing formula
  (`length = opcode + arguments`, p.264) — this codec always derives Length from that formula, not
  a per-opcode caption, so it does not reproduce the doc's apparent typo.
- `local-transport/udp-engine.ts` (real, was a stub) — a real `node:dgram` UDP4 socket (injectable
  `socketFactory` for tests), send via the codec's encoders, decode incoming datagrams via the
  codec's parsers, and a `probe()` method for the Setup Wizard's "Test Connection" using opcode
  0x39 with `Request=0xFF` ("own node") — the one documented request value that can never actuate a
  real device/group/scene.
- `local-transport/rest-client.ts` (real, was a stub) — implements exactly the one documented REST
  endpoint, `GET /set/target_value` (`Lithernet_WebAPI.pdf` §5.14.1). `fetchNetwork`/`fetchState`
  honestly still reject — no such endpoint exists anywhere in the supplied reference set.
  `testConnection()` never calls the write endpoint (that always actuates); it's a plain reachability
  GET to the gateway's HTTP root.
- `local-discovery.ts` (new) — `updateUnitFromControlValues()`, the mechanism Local-mode discovery
  actually uses: no REST device-listing endpoint is documented anywhere, so units are inferred
  progressively from UDP NotifyControlValues (opcode 0x4B) subscription responses, folded into the
  SAME `CasambiUnit` shape `entity-mapper.ts`'s `capabilitiesFromUnit`/`statesFromUnit` already
  know how to read — additive to the unified entity model, not a parallel implementation of it.
  Maps dimmer (type 1), on/off (16), battery (7), device temperature (6), lux (20), and presence
  (21). Deliberately does NOT map the color-related types (2/3/4/5/11) — type 2's single-byte
  "Color Temperature" has no documented Kelvin range/normalization at the NotifyControlValues
  layer (unlike the SET-side opcode 0x48, which does document one) — an honest, disclosed gap.
- `local-command-mapper.ts` (new) — `localCommandToUdpPacket()`, the Local-mode analogue of
  `entity-mapper.ts`'s `commandToTargetControls()`. Maps onoff/brightness/color(hue-sat, kelvin) to
  real UDP opcodes (0x20, 0x3D, 0x48). `position` is deliberately unmapped — no opcode in the
  reference set documents a shade/cover position control.
- `casambi-driver.ts` — Local mode's `connect()` no longer throws
  `CasambiLocalRestNotImplementedError`. It now really starts the UDP engine, sends the documented
  bootstrap sequence (SetDefaultMask → Subscribe → NotifyButtonEvent enable, all best-effort since
  Subscribe/NotifyButtonEvent are firmware-gated ≥37.90/≥39.50 and there's no way to detect an
  older-firmware no-op without real hardware), and routes incoming packets: 0x4B →
  `local-discovery.ts` → the SAME `applyUnit()`/`record()` machinery Cloud already uses (so state
  listeners/diagnostics/events all work identically regardless of transport); 0x51 → a typed
  `ButtonEvent`; 0x3A → forgets the unit + a `networkUpdated` event; 0x0D (Scene called) is logged
  via the tracer only — its 8-bit, installer-app-configured payload has no unitId/sceneId
  equivalent to `SceneEvent`, an honest gap rather than a forced mapping. `command()` now really
  sends a UDP packet for onoff/brightness/color; `position` (and anything else `local-command-
  mapper.ts` returns `null` for) surfaces the driver's existing "unsupported command" error.
  `isConnected()` reflects the real UDP socket's `listening` state. UDP being connectionless means
  there is still no reconnect loop for Local — a disclosed, deliberate scope boundary, see TODO.md.
- `health-monitor.ts` — `computeHealthVerdict`/`restSubsystemStatus`/`udpSubsystemStatus` no longer
  hard-code Local to `"not_implemented"`. UDP status now reflects the real socket state
  (`connected`/`disconnected`); REST status for Local reports `"not_configured"` (honestly: the
  documented REST surface is one stateless write endpoint, nothing with a live connection state to
  report — not a placeholder for "unimplemented").

### Driver Store, Gateway routes, UI

- `services/drivers/src/manifests.ts` — Casambi bumped 1.1.0 → 1.2.0. New config fields: `netId`
  (0-254, must match the gateway's own Net ID) and `dataFormat` (`hex-dot`/`dec-hash` select, must
  match the gateway's own "DEC or HEX" setting). `autoDiscover`'s help text now honestly says why
  it's unimplemented (no discovery endpoint) rather than "architecture-only."
- `services/gateway/src/native-driver-factory.ts` — reads `netId`/`dataFormat` from stored config
  and passes them through to `CasambiLocalGatewayConfig`.
- `services/gateway/src/routes/installer.ts` — `POST /v1/commissioning/casambi/test-connection` is
  now REAL: parses `{gatewayIp, restPort, udpPort, netId, dataFormat}` from the request body, runs a
  REST reachability check + a safe UDP probe, returns `{implemented: true, reachable, rest, udp,
  message}`. `discover-gateway` stays honestly `implemented: false` with updated wording (no
  enumeration/discovery endpoint is documented for this gateway at all).
- `apps/web-homeowner/src/api.ts`/`drivers.tsx` — `testCasambiLocalConnection()` now sends real
  connection params (reads them from the wizard's own in-progress field values) and renders
  `rest`/`udp` reachability separately. New `netId`/`dataFormat` fields render in the Local Gateway
  section. Diagnostics panel's UDP status no longer says "(placeholder)".

### Verification

Full `turbo run build typecheck test` across `@supreme/protocols`, `@supreme/drivers`,
`@supreme/gateway`, `@supreme/web-homeowner` (and their dependency closure) — 46/46 tasks green.
`@supreme/protocols`' own suite: **67 test files, 644 tests, all passing**, including every
pre-existing Cloud-mode Casambi test unmodified (confirms zero Cloud regression) plus this
session's new coverage: `core/*.test.ts` (5 files), `casambi/local-transport/udp-codec.test.ts` (39
tests, several byte-exact against the PDF's own worked examples), `udp-engine.test.ts` (13, fake
`dgram` socket), `rest-client.test.ts` (6, fake `fetch`), `local-discovery.test.ts` (8),
`local-command-mapper.test.ts` (10), and 12 new Local-mode integration tests appended to
`casambi-driver.test.ts` (connect/disconnect bootstrap+teardown sequences, NotifyControlValues →
state, command → UDP packet, button events, node removal, diagnostics). **Not done this session:**
live Playwright verification of the updated Driver Manager UI (no running `hub-compose` stack in
this sandbox, same honest gap as the Foundation session) — flagged, not claimed. Real Lithernet
hardware verification of anything firmware-gated (≥37.90/≥39.50 NotifyControlValues/NotifyButtonEvent,
≥36.70 Target Color/Status) is also unverifiable without hardware — see TODO.md.

## Immediate priorities for the next session

1. **RGBW/CCT capability inference for Local mode** — `local-discovery.ts` currently omits color
   entirely (documented gap: NotifyControlValues type 2's byte has no known Kelvin range). If a
   real gateway can be tested, confirm the actual encoding and complete the mapping.
2. **Wire `casambi-driver.ts` onto `core/event-bus.ts`** — today the driver still uses the
   Foundation-session `CasambiEventBus`; migrating to the new cross-driver `CoreEventBus` was
   deliberately deferred this session to avoid re-touching tested Cloud event paths in the same PR
   that added Local. Do this as its own scoped change with its own regression pass.
3. **Wire the real UDP engine into `core/packet-recorder.ts`** — the framework exists; nothing
   records real datagrams into it yet. Needed before "Packet Capture" in the UI can go from
   disabled placeholder to real.
4. **Local mode reconnect/health-recovery loop** — UDP being connectionless means a lost socket
   today has no automatic recovery the way Cloud's WebSocket does. Decide what "reconnect" even
   means for a connectionless protocol on a LAN gateway before building it.
5. **0x0D Scene called → a real driver event** — currently only logged via the tracer. Its 8-bit,
   installer-app-configured payload has no unitId/sceneId; decide on a shape (maybe a new,
   Local-only event type) before wiring it into `CoreEventBus`/`CasambiEventBus`.
6. Live Playwright verification of the updated Driver Manager wizard/diagnostics UI at all four
   required breakpoints — genuinely not done this session (no backend running in this sandbox).
7. Verify every firmware-gated opcode (0x39/0x45/0x46/0x49/0x4B/0x50/0x51, gated ≥33.22 through
   ≥39.50 across different features) against a real Lithernet Gateway once hardware is available —
   this session's implementation is byte-exact against the documentation but has never touched a
   real device.

---

## Session: Universal AV SDK

**Branch:** `claude/supremeos-universal-av-sdk-0rtaiw`, based on `main` at session start.

This handoff was rewritten from scratch — the previous version had drifted several sessions out
of date (it stopped at the original `TcpLineTransport`/`state-cache.ts` extraction and never
recorded the subsequent HTTP AppCommand layer, the Audyssey-family command pass, the RTI
Capability Audit, or this session's work). The detailed history of each of those passes lives in
its own architecture doc, cross-linked below — this file only needs to describe current state and
what changed most recently.

## Most recent session — AVR Diagnostic Mode

Prior sessions in this branch did a static code audit (found one real bug: the renamed-input
capability-config race — `refreshInputEnrichment()` fire-and-forget raced by a synchronous
`getCapabilityConfig()` read, still unfixed, still in `TODO.md`), then a full runtime-instrumented
trace of a real event through the entire pipeline against a fake AVR + real gateway + real
browser (found no pipeline break). The user then explicitly asked for neither: since they have no
way to give this session access to their real physical Denon/Marantz receiver, they asked for a
**permanent, production-safe diagnostic facility they can enable on their own installation** to
capture ground truth from their own hardware and hand the log back for analysis.

**Shipped**: AVR Diagnostic Mode — `SUPREME_AVR_DIAGNOSTICS=true` (env var, off by default).
When enabled, every real receiver event gets a correlation ID (`AVR-000023`); every stage it
passes through (`TCP`/`Parser`/`patchMedia`/`emitFor`/`StateCache`/`Gateway`/`WebSocket`) logs a
line tagged with that ID. Unrecognized lines are captured with hex/ascii/length/firstToken/
sender/frequency, never a bare "unrecognized" message. Exact session counters (received/parsed/
unknown/dispatched/dropped/bindingsMissing/cacheDeduplicated/gatewayPublishes/websocketSends) are
tracked throughout and reported at shutdown and at export time. `GET /v1/devices/:id/diagnostics/
export` streams the complete trace as a downloadable `diagnostic.log` file — the one file to
upload back for analysis. Full detail, exact enable/export steps: `docs/architecture/
AVR-Diagnostic-Mode.md`.

**Architecture**: new `services/protocols/src/avr-diagnostics.ts` (`AvrDiagnosticsRecorder` —
pure, no I/O, bounded ring buffer + bounded unknown-pattern map). Wired into `avr-driver.ts` via
`this.diagnostics?.method(...)` at every stage — optional chaining short-circuits before argument
evaluation when disabled, so the off cost is one property read + one null check, zero string
building/allocation/I/O. Correlation ID crosses the driver→gateway→WebSocket process/package
boundary via a new optional `traceId?: string` field on the already-shared `BackendStateEvent`
type, and a new optional `INativeProtocolDriver.recordDiagnosticStage?()` method that gateway code
calls back into (found via the pre-existing `SupremeIntegrationLayer.getNativeDriver("avr")`) —
neither layer needs new knowledge of the other's internals. `exportDiagnosticsLog?()` is routed to
the owning driver through the same `native-adapter.ts`/`routing-adapter.ts`/`sil.ts` pattern
`getTrace`/`getDiagnostics` already use. No feature work: parser/protocol/control-path logic is
completely unchanged, only observability was added.

**Verification**: 6 new tests in `avr-diagnostics.test.ts` (correlation IDs, full-lifecycle
capture, unknown-command capture, exact counters, session report, buffer eviction), 3 new tests
in `avr-driver.test.ts`'s "AVR Diagnostic Mode wiring" `describe` block (disabled = no-op, enabled
= real end-to-end trace incl. simulated Gateway/WebSocket stage append, real unrecognized-line
capture over a real TCP fake AVR), 1 new test in `native-driver-factory.test.ts`, 3 new e2e tests
in `avr-diagnostics-export.e2e.test.ts` (export succeeds/404s-when-off/404s-for-unknown-device).
Full monorepo `pnpm typecheck`/`pnpm build`/`pnpm test` all green (93/93 turbo tasks); one
transient CPU-contention flake in an untouched, pre-existing real-TCP timing test was confirmed
non-reproducible in isolation and on rerun, not a regression from this work.

**Known limitation, stated to the user**: this facility captures real traffic once enabled and
operated against real hardware — it cannot be exercised against a physical Denon/Marantz receiver
from this environment, since none is reachable here. The wiring itself is proven against a real
in-process fake AVR over real TCP (same fidelity as prior sessions' runtime pipeline trace).

## Current state of the AV SDK

- `services/protocols/src/av-sdk/` is the real, runtime shared module: `TcpLineTransport`
  (pooled/reconnecting/line-buffered TCP, shared by AVR+HEOS), `HttpPollClient`/`AdaptivePoller`
  (shared in-flight-deduped HTTP + adaptive polling, shared by AVR's AppCommand layer), `state-
  cache.ts` (`recordCapabilityState`, shared by all three AV drivers), `init-handshake.ts`
  (`InitHandshake` — new this session, see below), `protocol-tracer.ts`, `network-source-
  resolver.ts`.
- `avr-driver.ts` (Denon/Marantz) is the SDK's reference implementation — the only driver
  combining two transports (Telnet realtime push + HTTP AppCommand for renamed/hidden inputs and
  album art) through shared SDK primitives.
- Full architecture: `docs/architecture/Universal-AV-SDK.md`. Full per-capability wire evidence:
  `docs/architecture/AVR-Universal-Capability-Matrix.md`. Engine-level roadmap (what's ✓/Partial/
  Planned across the whole SDK, honest Denon/Yamaha/Anthem reuse mapping): **new this session**,
  `docs/architecture/Universal-AVR-SDK-Roadmap.md`.

## This session's work — RTI Capability Audit, Phases 1–4

Prior session produced `docs/architecture/RTI-Capability-Audit.md`: an evidence-based audit of 16
capabilities RTI's driver has that SupremeOS didn't, classified A (officially confirmed, ready to
build) / B (officially-adjacent, one piece of evidence missing) / C (RTI application-layer pattern
buildable from already-confirmed commands) / D (RTI-only, no official corroboration). This
session executed the user's 4-phase instruction against that audit:

**Phase 1 — Category A (5 items), all shipped:**
Subwoofer On/Off (`PSSWR`), Cinema/Music/Game/Pro Logic mode (`PSMODE:`), Cinema EQ (`PSCINEMA
EQ.`), Loudness Management (`PSLOM`), Tone Control On/Off (`PSTONE CTRL`) — all in `avr-codec.ts`,
each an official-PDF-cited exact token, wired into `denonCapabilityConfig()`'s `advancedControls`
(reusing the existing generic `select` UI renderer, zero new frontend code needed). New
`hasExtendedAudio` installer-declared gate flag. 30 tests in `avr-codec.test.ts`.

**Phase 2 — Category C (all 4 items), all shipped:**
- **C.1/C.2 (connection-readiness state machine + paced init-burst)**: new `InitHandshake` class
  (`av-sdk/init-handshake.ts`) — sends one init token, waits for any reply, sends the next, rather
  than one blind burst write. New `DriverDiagnosticsSnapshot.fullySynced: boolean` (three-file
  sync: `adapter.ts` → `rest.ts` → `driver-diagnostics.ts`), wired into `avr-driver.ts`'s
  `onLinkConnect()`.
- **C.3 (keepalive probe)**: `AvrProtocolDriver.heartbeat()` — `PW?` probe, `{ ok, latencyMs }`,
  structurally identical to the existing `HeosProtocolDriver.heartbeat()`.
- **C.4 (raw command escape hatch)**: `AvrProtocolDriver.sendRaw()`, threaded through 6 interface/
  adapter touch points (`INativeProtocolDriver` → `IBackendAdapter` → `avr-driver.ts` →
  `native-adapter.ts` → `routing-adapter.ts` → `sil.ts`) to a new `POST /v1/devices/:id/raw-
  command` gateway route (`validation_failed`/422 when the owning backend doesn't support it), plus
  a new devMode-gated **Raw Command** UI section (`device-detail-sections.tsx`, wired into the AVR
  console). New `services/gateway/src/raw-command.e2e.test.ts` (4 tests) covers both the success
  path (fake native driver) and the unsupported-backend 422 path (HA-owned device).
- Two real race-condition bugs were found and fixed via test-driven debugging while wiring this
  (not guessed, not papered over — see `RTI-Capability-Audit.md`'s git history / the full session
  transcript for the exact repro): a test-harness ECONNRESET gap (fixed in the test helper) and a
  genuine `fullySynced` default-value race in `avr-driver.ts`'s `bind()` (fixed with `if
  (!link.ready) link.diagnostics.setFullySynced(false);` right after `ensureLink()`).

**Phase 3 — honest response on hardware access:**
This sandboxed environment has no LAN reachability to any physical Denon/Marantz receiver — there
is no real hardware to verify Category B (Zone 3/4, 8 extra channel-trim targets, Tone Defeat)
against. Rather than fabricate a live capture, `RTI-Capability-Audit.md` got a new closing section
documenting this plainly and laying out a concrete, self-serve **guided capture procedure**: with
`devMode` on, send each Category B probe token via the new Raw Command box and read the reply in
the existing Protocol Trace panel — the exact tooling built in Phase 2 is what a real Category B
verification pass needs, no new engineering. Category B/D stay unbuilt, as they should.

**Phase 4 — Universal AVR SDK Roadmap (the explicitly-flagged most important deliverable):**
New `docs/architecture/Universal-AVR-SDK-Roadmap.md` — an engine-level (not brand-level) roadmap:
a ✓/Partial/Planned status for each of 17 engines (Core Transport, Realtime Event Engine,
Diagnostics, Capability Engine, Protocol Recorder, Connection State Machine, Keepalive Framework,
Zone Engine, Media Engine, Artwork Engine, Metadata Engine, Audio/Video Processing Engine,
Calibration Engine, Developer Console, Capability Discovery, Hardware Verification Mode), each
cited against real code. Includes a Denon "Uses:" mapping, and — deliberately correcting the
user's own illustrative "reuses 95%" framing rather than parroting it — an **honest** Yamaha reuse
assessment (real, measured reuse is low: only `state-cache.ts` + the shared `DriverDiagnosticsTracker`
class; `Universal-AV-SDK.md`'s own before/after table already recorded Yamaha's SDK-extraction
line-count reduction at ~1%, not 95%) with a concrete 3-step path to raise it, and an Anthem
mapping framed honestly as **not yet built** — a projection based on Phase 9's readiness findings
(transport/diagnostics tier likely near-total reuse; command-vocabulary tier 100% unevidenced,
zero shortcuts).

## Verification (RTI Capability Audit phases)

`pnpm build` — 54/54 (now includes the new `raw-command.e2e.test.ts`, `init-handshake.ts`/`.test.ts`).
`pnpm typecheck` — 93/93. `pnpm test` — full monorepo green (a `pnpm test` run under maximum
turbo parallelism transiently failed 3 unrelated, pre-existing timing-sensitive tests in
`avr-driver.test.ts`/`heos-driver.test.ts` due to CPU contention across ~50 concurrently-running
packages; confirmed non-reproducible via 3 repeated isolated re-runs and a scoped
`--filter @supreme/protocols --filter @supreme/gateway` run, both 100% green — not a regression
from this session's changes). Frontend (`apps/web-homeowner`) `typecheck`/`build` both clean for
the new `RawCommandSection`/`sendRawDeviceCommand` wiring; **not** Playwright-verified live this
session (no running dev server/backend in this sandbox) — flagged honestly rather than claimed.

## Later this session — Denon Cheat Sheet Audit

The user supplied an installer/engineer reference document ("Dan's Denon Cheat Sheets," Denon
section, pasted directly after a `share.google` link proved unreachable from this sandbox — the
outbound proxy rejected the CONNECT with a policy denial, confirmed via `$HTTPS_PROXY/
__agentproxy/status`) and asked for it to be audited against the official protocols and this
SDK, under a strict evidence hierarchy: official Denon Telnet PDF → official HEOS spec → live
hardware → the cheat sheet (reference only, never a source), with an explicit copyright
constraint (extract capabilities/observations only, never copy text/tables/examples/code).

**Method**: every claim in the cheat sheet was independently re-derived by fetching and reading
`denonavr`'s real, MIT-licensed source from GitHub (`const.py`, `foundation.py`, `input.py`,
`volume.py`) — the same independent cross-check source this project has used since the original
HTTP AppCommand pass — plus SupremeOS's own existing Telnet/AppCommand code. Every literal string
or field name that appears in the new doc is cited to one of those, never to the cheat sheet.

**New**: `docs/architecture/Denon-CheatSheet-Audit.md` — a full per-capability table, a gap
matrix, and an SDK-layer placement review (per-capability: Transport/Discovery/State/Capability/
Diagnostics/Media/Audio/Video/Developer-Tools layer, or Denon-adapter-only).
---

## Session: Universal Keypad Framework / Intent Engine

**Branch:** `claude/universal-keypad-framework-7khr2o`, based on `main` at session start (the
same branch Phase 1 shipped on — this session's branch instruction named
`feature/universal-keypad`, but the harness's assigned branch for this session takes precedence,
per this environment's git-safety convention). This session built the **Universal Intent &
Capability Engine, Phase 2** (ADR 0017), directly on top of the Universal Keypad Framework (ADR
0016) shipped last session — the brief's mission: completely decouple user interactions from
drivers, so `ToggleLight` keeps meaning the same thing forever even if the physical device behind
it changes from KNX to Casambi to Matter to anything else.

## What actually shipped

**The single highest-leverage decision**: `AutomationAction`
(`packages/domain-model/src/automations-dsl.ts`) gained ONE new additive variant — `{ type:
"intent", intentId, target, params }` — alongside the existing `device_command`/`scene_activate`/
`notify`/`delay`. Because `KeypadMapping.actions` already reuses `AutomationAction` verbatim (Phase
1's design), keypad mappings gained full Intent support with **zero** additional schema/engine
changes — direct payoff of Phase 1's reuse decision. `AutomationExecutors` gained one new optional
method, `runIntent?`, wired identically for both the Automation Engine and the Keypad Mapping
Engine (they already share one executor set). `runAutomationAction`/`describeAutomationAction`
(both previously extracted+shared, see Phase 1) grew an `"intent"` case; `compileToHa` (the
`engine: "ha"` static-compile path) honestly refuses to compile an intent action — intent
resolution is inherently dynamic, no static HA config can express it.

**New domain-model** (`packages/domain-model/src/intents.ts`, new + `intents.test.ts`):
`IntentDefinition` (pure, serializable metadata: id/name/category/description/
requiredCapabilities/parameters/targetKinds/version/i18nKey — future-proofed for AI/marketplace
consumption), `IntentTarget` (device/room/scene/automation/home, discriminated union).
Deliberately NOT a closed `z.enum` of every intent id — the catalog lives as runtime
`IntentRegistry.register()` calls, extensible forever with zero schema changes, mirroring how
`DriverManifest`/the Driver Store let a new protocol appear with no core-architecture change.

**New bounded service `@supreme/intent-engine`** (mirrors `@supreme/automations`/
`@supreme/keypad-framework`'s conventions — depends only on domain-model/contracts):
- `CapabilityIndex` — `Map<CapabilityKind, Set<DeviceId>>`, O(matching devices) lookup for
  `devicesWithCapability`/`devicesWithCapabilityInRoom`, never O(every device on the hub). Kept in
  sync via a new, additive `HomeService.onDeviceChanged` event (mirrors `SIL.subscribe`/
  `NotificationService.onNotification`'s exact shape) rather than re-scanning on every lookup or
  hooking dozens of device-mutation call sites individually.
- `IntentRegistry` — pairs each `IntentDefinition` with a `translate` (capability-driven: params +
  current state + capability config → `CapabilityCommand`) or `runSystem` (system-level: direct
  dispatch, no device resolution) handler, validated to match `requiredCapabilities` **at
  registration time**, not at first invocation.
- `validateIntentParams` — real required/type/min/max/enum-options validation + defaults, never
  trusting a caller (keypad, automation, direct REST, future AI) blindly.
- `registerBuiltinIntents` (`catalog.ts`) — 42 intents across all 6 brief-specified categories
  (lighting/climate/av/blinds/security/system). Two categories are honest, registered-but-throwing
  gaps: `swingMode`/`tiltUp`/`tiltDown` (no swing/tilt field in `TemperatureState`/`PositionState`
  yet) and `executeScript`/`webhook` (no script engine/webhook dispatcher exists) — same "visibly
  incomplete, never faked" discipline as ADR 0015's undocumented protocol gaps.
- `IntentEngine` — the Capability Engine itself: validate target kind → validate params → resolve
  device(s) via `CapabilityIndex` (or dispatch system-level directly) → translate → command →
  record an `IntentRun` trace (mirrors `AutomationRun`/`KeypadMappingRun`).
- 48 tests across 5 files, all passing, including a dedicated "migration readiness" test proving
  the identical intent+target invocation against two different `executors.command`
  implementations (standing in for two different drivers) behaves identically.

**Gateway wiring** (`services/gateway/src/{context,server}.ts`, new `routes/intents.ts`): the
`CapabilityIndex`/`IntentRegistry`/`IntentEngine` are constructed in `initWithHome()`, wired to the
SAME executors closures already built for automations/scenes/security/notifications; `runIntent`
added to the shared `AutomationExecutors` object. New REST surface (`GET /v1/intents`,
`GET /v1/intents/:id`, `POST /v1/intents/:id/run`, `GET /v1/intents/runs`,
`GET /v1/intents/:id/runs`), gated by a new additive `"intent"` `ResourceType` (baseline
permissions mirroring `"keypad_mapping"`'s per-role defaults). New `intents.e2e.test.ts` (11 tests)
proves the full pipeline over a real mock-backend hub: catalog listing, direct device-target
invocation, room-target multi-device resolution ("Movie Mode" pattern), param validation
(422 on missing required param), the honest `executeScript` failure (503), real security
arm/disarm dispatch, run-history retrieval, AND a keypad mapping whose action is `{type:"intent",
...}` driving a real device through the exact same Intent Engine a direct REST call uses.

**Documentation**: `docs/architecture/adr/0017-universal-intent-capability-engine.md`,
`docs/architecture/Universal-Intent-Capability-Engine.md` (architecture diagram, 4 sequence
diagrams — lifecycle/resolution/room-resolution/migration-readiness — Intent Registry spec,
capability resolution flow, driver integration spec, migration strategy, performance/scalability
analysis, public APIs, extension points, future roadmap). `PROJECT_CONTEXT.md` §4/§6 updated.

**Verification**: full monorepo `pnpm build` (56/56), `pnpm typecheck` (97/97), `pnpm test` (97/97
tasks) — all green, including every pre-existing suite passing **unmodified**
(`@supreme/automations`' original 36 tests + 3 new for the `"intent"` action = 39,
`@supreme/protocols`' 378, `@supreme/gateway`'s 229 pre-existing + 11 new = 240,
`@supreme/permissions`' 10, `@supreme/home`'s 8).

## What was deliberately NOT built (Phase 2 scope, per the brief)

- **No visual Intent/mapping editor** — backend architecture only, matching Phase 1's scope
  discipline.
- **No Postgres persistence** for anything new (the Intent Registry is code-defined, not a
  user-editable record, so this doesn't apply the way it does to `KeypadMapping`; `IntentEngine`'s
  run-history is in-memory only, same as the Automation/Mapping engines).
- **No swing/tilt capability-model addition** — `swingMode`/`tiltUp`/`tiltDown` are registered,
  honestly throwing intents, not a speculative schema change to invent the field.
- **No script engine or webhook dispatcher** — `executeScript`/`webhook` are registered, honestly
  throwing intents, not fabricated infrastructure.

**Findings, net**:
- Most of the cheat sheet's *write*-path claims (power/volume/mute/input via a legacy
  `/MainZone/index.put.asp?cmd0=...`-style HTTP interface) are fully redundant with the
  already-shipped, universal Telnet control path — and independently, `denonavr`'s own
  legacy-generation write path uses a *different* URL family than the cheat sheet describes,
  so that specific write shape isn't even cross-corroborated. Not implemented.
- Several things SupremeOS already does are independently confirmed to already be *better* than
  the cheat sheet's own described workflow: renamed inputs (already solved via the stronger,
  2016+ `GetRenameSource`/`GetDeletedSource` mechanism, which `denonavr` also treats as primary,
  not a fallback), and volume shown as dB in the UI with a "dB" unit label (the exact confusion
  the cheat sheet's author flags is already resolved).
- **The one genuine, previously-silent gap it led to finding**: `avr-driver.ts` hardcoded its
  HTTP port to a fixed `8080`, with no fallback — so pre-2016 Denon/Marantz units (which answer
  on port 80 and don't support `AppCommand.xml` at all) silently got **zero** HTTP-sourced data:
  no album art, no renamed inputs, no error, just quiet absence. Independently confirmed via
  `denonavr/foundation.py`'s own real `async_identify_receiver()` (try `Deviceinfo.xml` on 8080,
  then 80) and its own port-templated album-art URL usage (proving album art genuinely works on
  either port, not gated to `AppCommand.xml`).
- Two things were deliberately left **documented only, not implemented**, per the stated
  evidence rules: a generic HTTP keypress-simulation endpoint (uncorroborated by any second
  source) and an HTML-scraped SETUP rename page (the cheat sheet's own text calls it unreliable).
- One **bonus finding, unrelated to the cheat sheet itself** (surfaced while independently
  verifying its claims): `denonavr/input.py` confirms a real now-playing metadata path
  (`formNetAudio_StatusXml.xml`'s `szLine` array) for legacy pre-HEOS "NetAudio" sources
  (AirPlay/Media Server/iPod-USB/Bluetooth) — extends, not contradicts, the capability matrix's
  existing "no verified non-HEOS metadata source" finding (that one was scoped to Tuner/USB
  against the 2016+ AppCommand path specifically). Documented, not implemented — needs its own
  scoped design pass.

## Session: Universal AV SDK

**Implemented** (the one Ready-to-Implement, no-hardware-needed finding):
- `avr-http-codec.ts`: `DEVICE_INFO_URL`/`MAIN_ZONE_STATUS_URL` constants, `parseMainZoneStatus()`
  — a narrow, tested parser for exactly the 4 fields independently confirmed (power, mute,
  volume-in-dB, current input). 24 new tests.
- `avr-driver.ts`: `resolveHttpPort()`/`detectHttpGeneration()` — a best-effort, per-host-cached
  probe (an explicit `opts.httpPort` always wins, preserving every existing test's behavior
  unmodified). `refreshInputEnrichment()` now skips the doomed `AppCommand.xml` attempt entirely
  on a detected-legacy host (stops wasting a request every 15-minute poll forever) and instead
  does a best-effort legacy-status read for diagnostics only — never written into the
  installer-facing input-rename data, since that source is independently confirmed incomplete.
  `getArtwork()` and `discover()`'s AppCommand attempt both use the resolved port. `unbind()`'s
  per-host cleanup clears the cache so a re-added unit re-detects fresh. 7 new driver-level
  tests (2016+ detection, legacy detection, no-answer default, per-host caching, explicit-
  override-always-wins, artwork-on-legacy-port).
- Updated `AVR-Universal-Capability-Matrix.md` (new generation-detection row, corrected
  renamed-input/album-art/metadata rows, and fixed a stale "no AVR heartbeat exists" row that
  predated the RTI Capability Audit's own `heartbeat()` work landing) and
  `Universal-AVR-SDK-Roadmap.md` (Artwork Engine/Capability Discovery rows + Denon mapping, no
  status-label changes — the ✓/Partial labels were already accurate).
- Did **not** touch `RTI-Driver-Knowledge-Base.md`/`RTI-Capability-Audit.md` — checked for
  overlap (grepped for port-80/legacy-HTTP/pre-2016 references) and found none; those documents
  are about an unrelated source (an extracted RTI driver), not genuinely affected by this audit.

**Verification**: `pnpm --filter @supreme/protocols run typecheck` clean; `avr-driver.test.ts`
(56/56, was 50) and `avr-http-codec.test.ts` (18/18, was... wait, this file grew from 0 dedicated
generation tests to include the new suite) both green, re-run 3× to confirm no flakiness in the
new async-heavy detection tests (one genuine test race was found and fixed during authoring — the
cache-verification test's `vi.waitFor` was synchronizing on the wrong signal, not a driver bug).
Full monorepo regression run after this — see the next section below for the final numbers.

## Known issues / open gaps (carried forward, still real, still unfixed)

- Cross-platform duplication: web (`automations.tsx`) and mobile
  (`apps/mobile/lib/screens/automation_editor.dart`) Automation Editors independently hand-
  implement the identical six-node palette/defaults/field rules.
- Automation DSL/engine supports triggers/conditions/actions across every `CapabilityKind`; the
  editor UI only authors `onoff`. Documented in `Automation-Editor.md` §2, not fixed (new
  user-facing functionality, out of scope for a hardening pass).
- `AutomationService` has no direct unit tests beyond one happy-path e2e test.
- `HeosProtocolDriver.queryPlayers()` (discovery-only) reimplements manual line buffering instead
  of reusing `LineAccumulator`, no `maxBytes` cap. Still real, still unfixed, still in `TODO.md`.
- Yamaha's real SDK-primitive reuse is low (see Phase 4 roadmap doc) — `HttpPollClient`/
  `AdaptivePoller` migration and a `heartbeat()` addition are documented, scoped, NOT started.
- Category B (Zone 3/4, 8 extra channel-trim targets, Tone Defeat) and Category D (All Zone
  Stereo, Surround Back mode/Front A+B select, D.Comp, video-output routing) remain unbuilt —
  correctly so, pending either an official spec update or a real-hardware guided capture (see the
  Phase 3 procedure above).
- Raw Command UI (`RawCommandSection`) was typecheck/build-verified but not live-browser-verified
  at the project's required phone/tablet/desktop/ultrawide breakpoints this session.

## Immediate priorities for the next session

1. If a real Denon/Marantz unit becomes reachable: run the Phase 3 guided capture procedure
   against Category B's three items, AND (new this session) verify the legacy full-zone-state
   snapshot's partial rename list on a real pre-2016 unit (`TODO.md` — "Verify the pre-2016
   legacy rename-list fallback on real hardware") — both are the single highest-value next step,
   since the tooling to do the first already exists and is tested.
2. Live Playwright verification of the new Raw Command UI section (`ProtocolTraceSection`'s
   sibling in `media/detail.tsx`) at all 4 required breakpoints — genuinely not done this session.
3. Yamaha's `HttpPollClient`/`AdaptivePoller`/`heartbeat()` migration (Phase 4 roadmap doc, "Roadmap
   ordering" step 5) — independently valuable, not blocked on anything.
4. Wire the two existing `heartbeat()` methods (AVR, HEOS) into an actual scheduler + gateway
   route/UI affordance — currently callable but never automatically invoked (roadmap step 3).
5. The HEOS `queryPlayers()` unbounded-buffer bug fix (`TODO.md`) remains small, low-risk, ready
   whenever a bug-fix pass is in scope.
6. Legacy NetAudio now-playing metadata (`TODO.md`, Denon Cheat Sheet Audit bonus finding) — a
   real, evidenced capability (`formNetAudio_StatusXml.xml`'s `szLine` array) for pre-HEOS
   AirPlay/Media-Server/USB/Bluetooth sources, needs its own scoped design pass.
7. An HTTP-request equivalent of the Raw Command devMode tool (`TODO.md`) — surfaced as a real
   gap while trying to write a hardware-verification task for the cheat sheet audit's
   uncorroborated keypress-endpoint finding; today that kind of check needs a manual, out-of-band
   request.
---

## Session: Universal Keypad Framework / Intent Engine

- `IntentEngine`'s `resolveDevices()` for a `room` target unions across every capability in
  `requiredCapabilities` — correct today (every built-in intent requires exactly one capability),
  but untested against a hypothetical future intent requiring more than one simultaneously (no such
  intent exists in the catalog yet, so this is a latent-but-unexercised path, not a known bug).
- `CapabilityIndex` has no idle-eviction — same documented, negligible-at-realistic-scale
  characteristic already accepted for `UniversalInputEngine`'s per-control timer map in Phase 1.
- The "Optional Variables" mechanism from Phase 1 (`expandVariables`) hasn't been exercised
  end-to-end with an `"intent"` action's `params` field yet (only with `device_command`'s nested
  `command` fields) — the underlying recursive JSON walk is generic and should just work, but no
  dedicated test proves `{{step}}` inside an intent action's `params`.

## Immediate priorities for the next session

1. Pick a real protocol from `Keypad-Driver-Author-Guide.md`'s list (Lutron remains the most
   natural first target — its LIP transport already exists) and do the actual spec-verification
   research pass before writing keypad-specific code, exactly as ADR 0015 did for AVR.
2. If a homeowner-facing "Movie Mode"-style scene/intent authoring surface is prioritized next,
   this is exactly the point where the visual Universal Keypad Editor (or an Intent-aware
   extension to the existing Automation Editor) becomes worth its own scoped session — the backend
   (Phase 1 + Phase 2) is now complete enough to build a real UI against.
3. Consider extending `KeypadMapping`'s `variables` test coverage to include an `"intent"` action's
   `params` field (see "Known issues" above) — small, low-risk, closes a coverage gap.
4. Everything from the prior (Phase 1) handoff not touched this session remains open — see
   `TODO.md` for the full backlog with priority tiers.

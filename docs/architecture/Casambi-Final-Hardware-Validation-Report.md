# Casambi Local Gateway — Final Hardware Validation & Production Gate

> Companion documents: `docs/architecture/Supreme-LAN-Transport-Architecture.md` (the full
> `@supreme/lan` architecture, Phases 1-2), `docs/architecture/adr/0022-supreme-lan-transport-service.md`
> (the decision record), `docs/architecture/Casambi-Real-Hardware-Validation-Runbook.md` (the
> step-by-step procedure for running the ONE thing this document cannot do: validate against a
> real Lithernet gateway on a real physical LAN).
>
> This single document covers, as clearly labeled sections: the Hardware Validation Report, the
> Performance Report, the Packet Replay Framework Guide, the Transport Monitor Guide, and the
> Production Readiness Checklist — kept together because they describe one connected system, not
> five independent ones.

## 1. Hardware Validation Report

**This sandboxed AI session has no access to a real Lithernet gateway, a real physical LAN, or a
real Windows machine, at any point in this project.** That has not changed since every prior
session's disclosure on this point, and no amount of additional engineering inside this sandbox
changes it. This report states plainly what was and wasn't validated, stage by stage, using the
brief's own pipeline diagram:

```
Lithernet Gateway → UDP Broadcast → @supreme/lan → NATS → Casambi Transport → Casambi Driver
    → Discovery Engine → Entities → UI
```

| Stage | Validated how | Evidence |
|---|---|---|
| Lithernet Gateway → UDP Broadcast | **Not validated with a real device.** A synthetic UDP broadcast, sent from a script on the same Docker host, WAS used to reproduce the general Docker bridge-vs-host broadcast delivery mechanism (see the architecture doc §10.3) — that proves the mechanism, not the device. | `Supreme-LAN-Transport-Architecture.md` §10.3 |
| @supreme/lan (real UDP socket, real Docker container) | **Validated for real**, this session and the prior one: a real Docker image was built and booted, received a real UDP broadcast in host-networking mode, and reported it through the real wire protocol. Bridge mode was also proven to drop the identical broadcast — reproducing the ORIGINAL bug this whole project exists to fix. | `Supreme-LAN-Transport-Architecture.md` §10.3 |
| NATS | **Validated for real** in the same Docker run (real `nats:2.10-alpine` container, real request/reply over the wire) and by 760 automated tests exercising the real `NatsUdpTransportClient`/`UdpTransportServer` wire protocol. | `contract.test.ts`, `casambi-over-supreme-lan.test.ts` |
| Casambi Transport / Casambi Driver | **Validated for real** at the code level: the REAL, unmodified `CasambiProtocolDriver` running its full connect/discover/feedback/command lifecycle over the real NATS wire protocol, plus — new this session — the real captured Wireshark payload (`living-room.json`) replayed through that exact same real chain via the new Packet Replay Framework (§3 below). **Not validated**: whether a REAL gateway's REAL broadcast timing/framing/firmware quirks behave identically to the one captured sample. | `casambi-packet-replay-regression.test.ts` (7 tests, all passing, replaying real + synthetic captures) |
| Discovery Engine / Entities | **Validated for real** against the captured payload: the real 99-byte NotifyControlValues capture discovers unit 30, correctly classifies its capability as `sensor` (verified by actually running the code, not assumed), and a bound device sees the resulting real state. **Not validated**: discovery behavior for capability types (dimmable/color luminaires) this session had no real capture of. | `casambi-packet-replay-regression.test.ts` |
| UI | **Not validated at all this session** — no browser/UI testing was performed; this session's scope was backend/transport/pipeline only, consistent with the brief's "do not refactor unrelated components." | — |

**Conclusion for this section:** every stage this sandbox CAN exercise (the entire chain from a
real UDP socket through to entity state, using either live Docker containers or the real captured
payload) has been exercised and passes. The one stage that cannot be exercised without physical
access — a real Lithernet gateway's real broadcast — remains unverified. This is not a
"probably fine" hand-wave; it is a literal, structural gap in what this environment can do, stated
as plainly as possible so nobody downstream mistakes "everything we could test, passed" for
"tested against real hardware."

## 2. Performance Report

Two kinds of numbers, kept clearly separate because they measure different things and neither
should be read as the other:

### 2.1 Real Docker measurement (one-off, manual, not automated — needs a live Docker daemon)

From the real host-networking validation (architecture doc §10.3): a real UDP packet sent from
the Docker host to the real host-networked `lan` container's real bound socket was observed on
its NATS-published `session.rx` event **~8ms** later. This is the most realistic number this
sandbox can produce — real OS UDP delivery, real `DgramUdpSession`/`UdpTransportServer` code, real
NATS publish/subscribe round trip.

### 2.2 Automated, repeatable, code-only benchmark (runs on every `vitest run`, n=50 samples)

`services/protocols/src/casambi/casambi-lan-latency.test.ts` — the SAME real classes
(`CasambiProtocolDriver`, `NatsUdpTransportClient`, `UdpTransportServer`) over an
`InProcessEventBus` (isolates the code's own overhead from Docker/OS/network variance):

| Path | Median | p95 | p99 | Max | Mean |
|---|---|---|---|---|---|
| UDP-receive → decode → driver `applySignal` → `onState` fired | 0.022ms | 0.354ms | 1.656ms | 1.656ms | 0.088ms |
| `command()` → adapter → transport → fake gateway socket | 0.028ms | 0.147ms | 0.592ms | 0.592ms | 0.055ms |

(Figures are from one representative run in this sandbox; re-run `vitest run
casambi-lan-latency.test.ts` for current numbers — they are logged to stdout on every run, not
hardcoded anywhere.)

**What these numbers say and don't say:** the code path this migration introduced adds negligible
overhead (sub-millisecond) relative to any real network hop. The real ~8ms figure is dominated by
real inter-process NATS/OS scheduling, not this migration's own code. **Neither number measures
real Casambi UDP broadcast latency over a real physical LAN** — only real hardware can produce
that, and this report does not claim to have measured it.

## 3. Packet Replay Framework Guide

### What it is

A permanent, protocol-agnostic mechanism (lives in `@supreme/lan`, reusable by every future LAN
protocol — KNX, Matter, mDNS, SSDP, Sonos, Denon, Apple TV, Hue — not Casambi-specific) for saving
a captured UDP datagram (or sequence of them) and replaying it through the **exact same real code
path** a real device's traffic would take. "No code path may differ" is satisfied structurally:
`DgramUdpSession` registers exactly one `"message"` listener, same as always; replay calls that
SAME listener directly. Everything from there upward — `UdpTransportServer`, NATS,
`NatsUdpTransportClient`, the Casambi adapter, the driver, discovery, entities — runs completely
unmodified and unaware whether a datagram came from a real socket event or a replay call.

### Capture format

One canonical, human-readable JSON format (`PacketCapture` — `services/lan/src/server/
replay-dgram-socket.ts`):

```json
{
  "name": "living-room",
  "savedAt": "2026-08-01T00:00:00.000Z",
  "description": "...",
  "packets": [
    { "rawHex": "...", "sourceAddress": "192.168.0.45", "sourcePort": 10009, "relativeTimeMs": 0 }
  ]
}
```

Raw hex is canonical; ASCII is always derived from it (`capturedDatagramAscii()`), never stored
redundantly. `relativeTimeMs` lets a multi-packet capture replay with realistic pacing (a real
commissioning burst, say), not all at once.

**PCAP:** export-only (`exportPcap()`, `services/lan/src/server/capture-io.ts`) — wraps a
capture's payloads in a synthetic Ethernet+IPv4+UDP frame with a correctly-computed IPv4 checksum,
so a saved capture opens directly in Wireshark. PCAP **import** is deliberately NOT implemented —
parsing arbitrary third-party `.pcap`/`.pcapng` files correctly (link-layer types, snaplen, byte
order) is a large, open-ended format-compatibility surface that doesn't change whether the actual
goal (replaying a payload through the real pipeline) is achieved; the JSON format serves that
completely.

### API

```ts
import { replayableDgramSocket, fakeDgramSocket, makeCapture, saveCaptureJson, loadCaptureJson, exportPcap } from "@supreme/lan/server";

// Build a capture from raw bytes (e.g. off a real Wireshark session):
const capture = makeCapture("living-room", [{ raw: buf, rinfo: { address, port }, atMs: 0 }]);
await saveCaptureJson(capture, "tests/regression/casambi/living-room.json");

// Replay it against a REAL running supreme-lan (or a hermetic fake for tests):
const socket = replayableDgramSocket();       // real node:dgram — live devtool use
// const socket = replayableDgramSocket(fakeDgramSocket); // pure in-memory — CI/tests
const server = new UdpTransportServer(bus, () => socket);
await server.start();
const handle = socket.replay(capture, { loop: false, speedMultiplier: 1 });
// handle.stop() to cancel a loop/in-flight timed replay early
// socket.injectDatagram(capture.packets[0]) for a one-shot "step"
```

### Saved Captures library — status

The "Saved Captures / Living Room / Kitchen / Office" UI mockup in the governing brief describes a
developer-mode panel; **the UI panel itself was not built this session** (same disclosed scope cut
as the Transport Monitor's own UI — see TODO.md). What DOES exist and is real: the capture
LIBRARY, at `tests/regression/casambi/` — `living-room.json` (the real, Wireshark-captured
99-byte NotifyControlValues packet reused from the earlier hardware audit session), `kitchen.json`
(a synthetic but wire-valid button press), `office.json` (a synthetic but wire-valid, well-formed,
UNMAPPED opcode — exercises the "Discovery ignored packet" failure mode on purpose).

### Regression testing

`services/protocols/src/casambi/casambi-packet-replay-regression.test.ts` loads every `.json` file
in that directory automatically (no test-code change needed to add a new capture) and replays each
through the real `CasambiProtocolDriver` + real `NatsUdpTransportClient` + real
`UdpTransportServer` chain, asserting real, verified outcomes for each — "no hardware required,"
exactly as the brief asked. 7 tests, all passing.

## 4. Transport Monitor Guide

`GET /v1/drivers/:id/casambi/transport-monitor`, backed by `CasambiProtocolDriver.
getCasambiTransportMonitor()`. Response shape (new fields this session in **bold**):

```jsonc
{
  "connectionType": "local",
  "transport": { "backend": "nats", "listening": true, "localAddress": "...", "localPort": 10009,
                 "packetsSent": 0, "packetsReceived": 1, "lastError": null },
  "adapter": { "packetsReceived": 1, "decoded": 1, "decodeFailures": 0, "lastPacketAt": "...",
               "lastDecodeError": null, "recentTraces": [ /* engine-level, last 20 */ ] },
  "driver": {
    "entities": 1, "discoveryEvents": 1, "commandsIssued": 0, "feedbackEvents": 1,
    "unmappedOpcodeEvents": 0, "lastUnmappedOpcode": null,
    "recentJourney": [ /* driver-level, last 20 — SEE BELOW */ ]
  },
  "lan": { /* service-wide supreme-lan health, only when backend === "nats" */ },
  "lanQueryError": null,
  "failureAnalysis": { /* SEE BELOW */ }
}
```

**`driver.recentJourney`** (new — "Packet Trace" per the brief): one entry per datagram the
DRIVER processed, bounded to the last 20, each with `at`, `sourceAddress`/`sourcePort`,
`rawAscii`, `decoded`, `decodeError`, `opcode`, `handlerInvoked` (the resolved `CasambiSignal.kind`,
or `null`), `outcome` (`"mapped"` / `"unmapped_opcode"` / `"decode_failed"`), and a REAL, measured
`processingDurationMs` (wall-clock time from raw reception to the driver finishing its handling of
that datagram — this codebase's receive path is fully synchronous JS, so this is a genuine
measurement, not a simulation). This is the "one click reveals the entire processing path" data
the brief asked for — no UI built for it this session (same disclosed scope cut as above), but the
data is real and complete.

**`failureAnalysis`** (new — see §5 of the architecture doc's Phase 2 section and the dedicated
`failure-analysis.ts` module): a stage-by-stage checklist (Transport → NATS → Casambi Adapter →
Discovery/Driver), each stage `pass`/`fail`/`not_applicable`, with a concrete, data-backed
`reason` on the first failure — never a guess, never fabricated. Call
`formatFailureAnalysisReport()` for the literal ✓/✗ text rendering.

**UI:** not built this session (backend + route only), consistent with the "do not modify the
Driver Manager UI" constraint carried over from Phase 2 and the same honest scope-cut already
disclosed for the base Transport Monitor.

## 5. Production Readiness Checklist

- [x] Casambi driver migrated completely onto `@supreme/lan` (no raw socket ownership) — Phase 2.
- [x] Transport selection centralized, defaults through `@supreme/lan` everywhere — Phase 2.
- [x] Layered Transport Monitor (Transport/NATS/Adapter/Driver) with real counters — Phase 2 + this session's Packet Trace/Failure Analysis additions.
- [x] Bridge-vs-host broadcast bug reproduced AND fixed on real Docker/Linux — this session.
- [x] Packet Replay Framework: capture format, replay engine, PCAP export, regression test library — this session.
- [x] Failure Analysis report generator: stage-by-stage, data-backed, matches the brief's exact format — this session.
- [x] Automated regression suite replays real + synthetic captures with zero hardware — this session.
- [x] Automated, repeatable performance benchmark (code-only) — this session.
- [x] Full monorepo `turbo run build typecheck test` green throughout every change.
- [ ] **Real Lithernet gateway validated on a real physical LAN.** NOT DONE. See
      `Casambi-Real-Hardware-Validation-Runbook.md`.
- [ ] Real Windows Docker Desktop validated. NOT DONE — this sandbox is Linux-only.
- [ ] Transport Monitor / Packet Replay UI pages. NOT DONE — backend/data only, tracked in TODO.md.
- [ ] Driver Verification checklist (on/off, brightness, color, scenes, sensors, battery,
      temperature, presence, button events, feedback) run against a REAL device. NOT DONE — the
      capture library only covers what this session could construct/replay
      (NotifyControlValues + button press + an unmapped opcode); it does not exercise every
      capability type a real installation will encounter (e.g. dimmable/color luminaires, scenes).

## Production Gate

**Verdict: NOT EVALUATED — hardware unavailable.**

Not PASS: the brief's own success criterion is explicit — "A real Lithernet Gateway automatically
discovers devices, creates entities, maps them to rooms, receives live feedback, executes commands
bidirectionally, and every stage of the pipeline is observable through the Transport Monitor."
That has not happened; nothing in this sandbox can make it happen.

Not FAIL either: FAIL means the pipeline was run against real hardware and broke at an identified
stage. It was never run against real hardware at all — there is no broken stage to name, no root
cause to give, because there is no real-hardware evidence to analyze.

What this report DOES establish, with real evidence rather than assumption: every stage of the
pipeline that can be exercised without physical Lithernet hardware — a real Docker Engine, a real
NATS server, the real `CasambiProtocolDriver`, and a real captured hardware payload replayed
through the real code — works correctly, including the specific bridge-vs-host broadcast bug this
whole project was built to fix, reproduced and confirmed fixed for real. The Packet Replay
Framework and Failure Analysis tooling built this session exist specifically so that when real
hardware IS available, the runbook in `Casambi-Real-Hardware-Validation-Runbook.md` can be
followed and this Production Gate can be re-evaluated with actual evidence — PASS or FAIL, decided
by what the Transport Monitor and Failure Analysis report actually show, not by anyone's
assumption in either direction.

**Recommendation:** do not merge this branch's Casambi migration into `main` as "the reference
architecture for migrating KNX, Matter, Sonos, Denon, Apple TV, Hue" on the strength of this report
alone. Run the runbook against real hardware first. If it passes, this becomes exactly the
reference implementation the brief describes. If it doesn't, the Failure Analysis report and
Packet Replay Framework built this session are the tools that will pinpoint exactly why, without
guessing — capture the failing traffic, save it as a new regression capture, and it becomes a
permanent, hardware-free test the moment it's fixed.

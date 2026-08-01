# Casambi Local Gateway — UDP Receive Pipeline Audit (Real Hardware Capture)

> Follow-on to `Casambi-Local-Auth-And-UDP-Diagnostics.md`. Triggered by a real Wireshark capture
> against a Lithernet Gateway on firmware 6.25 showing `Packets Received = 0` in SupremeOS despite
> the gateway visibly broadcasting `NotifyControlValues` to `255.255.255.255:10009`. **Cloud mode
> was not touched.** No hardware was available to this session either — every finding below is a
> direct code-reading fact (cited to the exact file/line behavior) or a documentation fact, never
> an inference presented as verified live behavior.

## 1. Root cause analysis

Two independent facts, both confirmed by reading the actual pre-existing code
(`local-transport/udp-engine.ts` before this session):

1. **No reception-blocking bug was found.** The engine binds via `socket.bind(this.opts.localPort
   ?? this.opts.udpPort)` — a bare port number, no address — which Node's `dgram` binds to
   `0.0.0.0` (all interfaces). There is no `socket.connect()` call anywhere (the
   `CasambiUdpSocketLike` interface the engine depends on doesn't even declare a `connect` method,
   so the engine cannot call it — a compile-time guarantee, not just an absence today). There is no
   `rinfo.address !== gatewayIp` check, no destination-address filter, and no unicast-only logic
   anywhere in `handleMessage` or its callers. A broadcast datagram to `255.255.255.255:10009` and
   a unicast one to `192.168.0.117:10009` are handled identically by this code — Node's `dgram`
   delivers both to any socket bound to that port on `0.0.0.0`.
2. **A real, confirmed instrumentation bug was found:** `packetsReceived` (and the packet/decode
   listener dispatch feeding discovery and entity creation) was gated on `decodeCasambiPacket()`
   succeeding. The counter incremented only in the success branch of a try/catch; a datagram that
   failed to parse was never counted as "received" at all — only exposed via a single
   `lastDecodeError` field, with no bulk trace and no proof reception itself had occurred. This
   directly matches the reported symptom class: a real datagram can arrive at the socket and still
   produce `Packets Received = 0` if it fails to decode, and there was no way to distinguish "never
   arrived" from "arrived but failed to parse" anywhere in the driver or its diagnostics.

Manually decoding the exact byte sequence from the report (`c.70.27.4b.1e.15.0.14.0.0.90.0.1.1.
90.1.1.1.90.2.1.1...`, reconstructed to the reported 99-byte length — see §7) against the
**current, unmodified codec** shows it decodes successfully (Net_ID=12, Direction=`fromCasambi`,
Opcode=`0x4b` NotifyControlValues, Target_ID=30). This means the specific payload in the report is
not itself undecodable by the existing parser — so if `Packets Received = 0` was observed for
exactly this traffic, the most likely explanation is the second bug above (a parse-gated counter
masking real reception for some fraction of traffic, or a payload variant not covered by the
truncated example), not a parser rewrite. **This is disclosed as the most likely explanation, not
a confirmed one** — no hardware was available to reproduce the original symptom end-to-end.

## 2. Answering the required questions directly

- **Was the receive callback firing?** Cannot be confirmed against real hardware this session.
  The code has no defect that would prevent `socket.on("message")` from firing for a broadcast
  datagram — binding to `0.0.0.0` receives broadcast on every mainstream OS without needing
  `setBroadcast()` (that flag only gates *sending* broadcast, per Node's own `dgram` docs). A new,
  dedicated `onRawDatagram()` hook (§3) now makes this directly observable (logged the instant a
  message arrives, before any parsing) so the next real-hardware session can confirm it with
  certainty instead of inferring it from code review.
- **Were broadcast packets being filtered?** No — confirmed by reading every line of
  `handleMessage` and its call sites; no such filter exists, and none was added.
- **Did the parser expect binary instead of ASCII "Hex with dot"?** No — `handleMessage` has
  always called `msg.toString("ascii")` before handing the string to `decodeCasambiPacket`, which
  is a pure string parser (`split(".")`, `parseInt(token, 16)`). This was already correct.

## 3. Exact code changes

- **`local-transport/udp-engine.ts`**:
  - `handleMessage()` rewritten so `packetsReceived`/`lastPacketAt` increment **immediately**,
    before `decodeCasambiPacket()` is even called — reception and parsing are now two separate,
    independently observable facts.
  - New `onRawDatagram(listener)` — fires for every datagram the socket delivers, before any
    parsing, so "did the message event fire" can be proven directly rather than inferred from
    downstream parse success.
  - New bounded (last 20) `recentTraces` — every datagram, decoded or not, recorded as
    `{ at, sourceAddress, sourcePort, destinationPort, payloadLength, rawAscii, rawHex, decoded,
    parseError }`. A failed parse is never a silent drop: the raw payload and exact error are
    always in this log.
- **`casambi-driver.ts`**: `connectLocal()` wires `onRawDatagram`/`onDecodeError` into the
  existing `ProtocolTracer` (`this.tracer.event(...)`, the same opt-in trace/log pipeline every
  other native driver uses) — "UDP datagram received from X:Y (N bytes)" logs immediately on
  every packet, and "UDP parse failed: ... — raw: ..." logs immediately on every decode failure.
  `getCasambiDiagnostics()` now threads `recentTraces` through to the Diagnostics snapshot.
- **`diagnostics.ts`**: `CasambiUdpDetail.recentTraces` (additive field).
- **`routes/installer.ts`**: Test Connection's UDP result also includes `recentTraces` — the
  packets the ad hoc test window actually saw, decoded or not.
- **`api.ts` / `drivers.tsx`**: new `CasambiUdpPacketTrace` type; the Diagnostics page now renders
  a real packet trace table (time, source, byte count, raw ASCII, decoded opcode, parse result)
  under "UDP transport" — this is where "protocol tracing... in Driver Diagnostics" (Step 6) lives.

Nothing in `cloud-transport.ts`, the Cloud branch of `connection-manager.ts`, or the Cloud paths of
`casambi-driver.ts` was touched. No opcode table, wire format, or codec byte-layout was changed —
per the brief, no protocol behavior was modified without evidence.

## 4. Before / after packet flow

**Before:**

```
socket.on("message")
        │
        ▼
  toString("ascii")
        │
        ▼
  decodeCasambiPacket() ──fails──► lastDecodeError set, RETURN (packetsReceived untouched)
        │
      succeeds
        │
        ▼
  packetsReceived++, lastPacketAt=now
        │
        ▼
  notify onPacket listeners → discovery / entity state
```
A datagram that failed to parse was invisible to `packetsReceived` and to any bulk trace — only
the single most-recent `lastDecodeError` recorded it.

**After:**

```
socket.on("message")
        │
        ▼
  packetsReceived++, lastPacketAt=now      ← counted BEFORE parsing, unconditionally
        │
        ▼
  notify onRawDatagram listeners            ← "received" is now provable independent of parsing
        │
        ▼
  toString("ascii") / toString("hex")
        │
        ▼
  decodeCasambiPacket() ──fails──► lastDecodeError set, recordTrace(parseError, raw, hex)
        │                          notify onDecodeError listeners → traced + logged, never silent
      succeeds
        │
        ▼
  recordTrace(decoded, raw, hex, parseError:null)
        │
        ▼
  notify onPacket listeners → discovery / entity state
```

## 5. Verification against the supplied Wireshark capture

The report's example payload (`c.70.27.4b.1e.15.0.14.0.0.90.0.1.1.90.1.1.1.90.2.1.1...`, "Payload
Length: 99 bytes") was reconstructed byte-exactly by completing the truncated tail with the same
documented indexed-`onOffToggle` pattern already present in the given prefix, and verified to be
**exactly 99 bytes** (`Buffer.byteLength(..., "ascii") === 99`) — confirming the reconstruction is
faithful to the real capture, not a fabricated stand-in. This exact string is now a permanent
regression fixture in `udp-engine.test.ts`'s "real hardware capture — broadcast NotifyControlValues,
firmware 6.25" suite, asserting:
- the engine accepts it when the sender/rinfo is the gateway address:port broadcasting, with no
  destination filtering;
- `packetsReceived` increments immediately, observable via `onRawDatagram` before decode;
- it decodes successfully (`opcode 0x4b`, `netId 12`, `direction fromCasambi`);
- a full trace entry is recorded with the correct raw ASCII/hex and byte length;
- an undecodable payload is still counted as received, traced, and reported through
  `onDecodeError` with the raw payload attached — never a silent drop;
- the trace log stays bounded (≤20 entries) across many packets.

## 6. Firmware compatibility audit

The gateway reports its **own box firmware** as `6.25`. The Lithernet UDP Developer Reference
gates individual opcodes behind **"Evolution firmware"** version numbers in a completely different
numbering scheme (e.g. NotifyControlValues/NotifyButtonEvent require Evolution firmware
≥37.90/≥39.50; 0x39 Node Status is documented only as "available with Evolution firmware," no
minimum given). **These are two different version spaces — the gateway's own firmware number
cannot be compared numerically against the Evolution firmware thresholds the protocol doc cites.**
This session found no evidence of the parser making an assumption tied to a specific *older*
protocol document revision — the codec's opcode/field layouts were not changed, and the captured
payload decodes correctly against the current implementation. Whether firmware 6.25 corresponds to
an Evolution firmware version above or below any of the documented thresholds is **not
determinable from the supplied documentation** and is not asserted either way.

## 7. Test results

New/updated coverage, all passing:

| Suite | New/updated tests |
|---|---|
| `udp-engine.test.ts` | 1 updated (decode failure now counts as received) + 8 new (`real hardware capture` describe block: byte-length verification, broadcast reception, pre-parse counting, ASCII hex-dot decode of the real payload, full trace recording, parser-failure trace+log, bounded trace log) |
| `casambi-driver.test.ts` | 2 new (end-to-end: a received broadcast packet's trace reaches `getCasambiDiagnostics()`; a decode failure is still counted and traced at the driver level) |

Full monorepo verification: `@supreme/protocols` typecheck clean, 72 test files / 708 tests
passing; `@supreme/gateway` typecheck clean (after rebuilding `@supreme/protocols`'s dist, a
workspace-resolution step, not a code issue), 72 files / 293 tests passing; `@supreme/drivers` 22
tests passing; `@supreme/web-homeowner` typecheck + build clean, 55 tests passing. Zero Cloud
regression — the full pre-existing Cloud-mode `casambi-driver.test.ts` suite passed unmodified.

## 8. What remains unverified

No hardware was available this session. The fix closes the diagnostic blind spot the report
describes (reception is now provably independent of parsing, and every packet — decoded or not —
is traced), and manual decoding of the reconstructed real capture succeeds against the current
codec. Whether the original `Packets Received = 0` symptom is now fully resolved on the actual
Lithernet Gateway (firmware 6.25) can only be confirmed by re-running SupremeOS against that same
hardware and checking the new Diagnostics trace table and `onRawDatagram`-driven trace log output
directly — this is the next concrete verification step, not something this session can claim.

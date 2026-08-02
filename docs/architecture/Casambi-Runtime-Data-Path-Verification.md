# Runtime Data Path Verification — Casambi UDP Receive Path

> Companion to `Casambi-LAN-Receive-Path-Investigation.md` (which established the Docker-bridge
> root cause) and `Casambi-ENETUNREACH-Investigation.md` (the send path, resolved). This document
> covers the tooling built to prove — with runtime evidence, not assumption — exactly which layer
> a receive-path failure is in, on a real deployment this investigation cannot reach directly.
>
> **No protocol logic was modified.** The UDP codec, Discovery Engine, Entity Mapper, and Event
> Engine are unchanged. This is instrumentation and evidence collection, built on top of the
> existing architecture.

## Why this exists

The prior investigation proved, with a reproducible Docker experiment, that bridge networking
silently drops broadcast/multicast before it reaches a container. That explains a *class* of
failure. It does not, by itself, tell an installer running a real deployment whether their specific
`Packets Received = 0` is that same cause, a different deployment misconfiguration, a gateway that
genuinely isn't transmitting, or a bug somewhere between the socket and the driver. This session
built the tooling to answer that question from runtime evidence collected on the user's own
installation, since this sandbox has no path to their real Lithernet Gateway.

## What was built

### 1. The independent UDP probe (`services/lan/src/server/udp-probe.ts`)

The single most decisive piece of new evidence. `UdpProbe` binds its own `SO_REUSEADDR` socket on
the same port as the Casambi driver and does exactly one thing: count and log every datagram the
kernel hands it. No decoder, no NATS republish, no protocol awareness. It converts one
unanswerable question into two answerable ones:

- Probe receives nothing while a host capture shows traffic → the loss is **below SupremeOS**
  (kernel, namespace, interface, firewall). No application change can fix it.
- Probe receives datagrams while the driver still reports zero → the loss is **inside SupremeOS**,
  between the socket and the driver, and the pipeline stages below localize it further.

Opt-in via `SUPREME_LAN_PROBE_PORT` (binding a real port unconditionally by default would claim it
on every deployment, including ones that don't need this diagnostic). When disabled, every
consumer reports `probe: null` with the reason — never a fabricated "probe ran and saw nothing."

Documented, deliberate limitation: broadcast/multicast is delivered to *both* the driver's socket
and the probe (both hold `SO_REUSEADDR`), but a *unicast* datagram to that port is delivered to
only one of them by the kernel. The probe's own snapshot states this caveat explicitly rather than
leaving it to be rediscovered.

### 2. Network and socket forensics (`services/lan/src/server/network-forensics.ts`)

Reads real kernel state — never inferred, never defaulted:

- **`/proc/net/route`** → the real routing table and whether a default route exists at all (the
  decisive `ENETUNREACH` fact).
- **`/proc/net/udp`** → every open UDP socket in the namespace, including the kernel's own **drop
  counter** — proof that a datagram reached a socket and was *then* lost to receive-buffer
  overflow, which is a completely different diagnosis from "nothing ever arrived."
- **`/proc/self/ns/net`** → the network namespace identity, the one fact that actually settles "is
  this process really sharing the host's network?"
- **`getRecvBufferSize()`** on the live socket, corroborated against the matching `/proc/net/udp`
  row.

On a non-Linux platform (`/proc` doesn't exist), every one of these fields reports `null` with
`procAvailable: false` and a stated reason — never a fabricated empty table. The parsers
(`parseProcNetRoute`, `parseProcNetUdp`, `parseKernelHexAddress`) were validated against real
content read from this session's own Linux sandbox — including hand-verifying a genuinely bound
socket's kernel row matched Node's own `address()`/`getRecvBufferSize()` — not written against an
imagined format.

What Node's `dgram` API cannot provide is reported as a *request*, not a *confirmation*:
`SO_BROADCAST`/`SO_REUSEADDR` have no getter, so `SocketForensics.requestedBroadcast` etc. are
named to make clear they reflect what was asked for at bind time, not a verified kernel state.

### 3. The eleven-stage receive pipeline (`services/protocols/src/casambi/receive-pipeline.ts`)

A pure function over already-collected evidence (the existing Transport Monitor snapshot plus the
new LAN forensics) — it takes no measurement itself, so it can neither create nor destroy a fact.

```
OS Network Stack → supreme-lan UDP Socket → Datagram Received → Raw Packet Recorder →
NATS Publish → Gateway Subscriber → Casambi UDP Engine → Protocol Decoder →
Discovery Engine → Entity Mapper → Room Assignment
```

Every stage reports `entered` / `exited` / `failures` / `firstAt` / `lastAt` / `latencyMs`
independently — no aggregation. The core stage model (`core/pipeline-stages.ts`) was extended with
`StageMetrics`, where every field is `number | null` and any `null` **requires** a stated reason
(`unmeasured`), enforced by `stageMetrics()`'s own default. Two examples of what that discipline
actually rules out:

- The OS Network Stack's `entered` count is `null` — the kernel cannot report datagrams that never
  reached it, full stop. Reporting `0` there would be a request masquerading as a measurement.
- Room Assignment carries **no counter at all**. Room assignment is a human commissioning step
  (`approvePendingDevice` in the Gateway's installer routes), not something the driver does —
  confirmed by reading that code path before writing this stage, not assumed. Inventing a number
  here would be fabricating a capability the driver doesn't have.

### 4. Root cause classification and certification (`services/protocols/src/casambi/receive-certification.ts`)

Automatic classification into exactly the nine categories specified, in bottom-up order (kernel
drops checked before any application counter, because diagnosing at the wrong layer is the exact
failure this tooling exists to prevent):

```
gateway_not_transmitting | packets_blocked_before_socket | packets_received_by_socket |
packets_lost_before_nats | packets_lost_before_decoder | packets_rejected_by_decoder |
packets_ignored_by_discovery | entities_not_created | unknown
```

**`unknown` is a first-class, tested outcome, not a fallback that never fires.** The exact reported
state — driver socket at zero, no host capture supplied — resolves to `unknown` with the two
candidate causes named explicitly and the one piece of evidence (`tcpdump`/Wireshark over the same
window) that would resolve it. Supplying that count is the only way to distinguish "the gateway
isn't transmitting" from "the packets never reach this network namespace," since both produce
byte-identical counters from inside the process.

The certification report has seven sections (Socket, Network, Packet Reception, NATS, Decoder,
Discovery, Entity Creation). A section whose prerequisite never fired (e.g. Decoder, when zero
packets arrived) is `NOT EVALUATED` — and a report `certified: true` requires every section to be
both evaluated *and* passing. An un-run check never counts as a pass.

### 5. Gateway route and UI

`GET /v1/drivers/:id/casambi/receive-pipeline?wiresharkPackets=N` — separate from the existing
`/transport-monitor` route because this one asks `supreme-lan` for deep forensics (reads `/proc`,
walks every session), so it's requested when actively diagnosing, not on every poll. The Gateway is
the one boundary that narrows the wire-typed (`unknown`) forensics payload into the shape the
classifier needs — `@supreme/lan`'s wire protocol stays free of `@supreme/protocols` internals, the
same separation the deployment/transport work established.

The Runtime Pipeline Dashboard (`CasambiReceivePipelineDashboard` in `drivers.tsx`) renders all
eleven stages independently with their real counters, an optional host-capture packet count input,
the root cause verdict, the Wireshark comparison, and the certification checklist. A `null` metric
renders as "not measured" (with its reason on hover), never as `0` — the UI-level enforcement of
the same rule the data model enforces. Diagnostics-only: no new control, no protocol change, not
rendered in Cloud mode.

## Verification

- `@supreme/lan`: 93/93 tests (22 new: `udp-probe.test.ts` proves real-socket reception AND honest
  zero-reporting against a real OS socket, not just a fake one; `network-forensics.test.ts`
  validates parsers against real captured `/proc` content).
- `@supreme/protocols`: 279/279 tests in the Casambi/core suites (32 new, covering every branch of
  the root-cause classifier including both `unknown` cases and every resolved cause).
- The deployment-isolation guard (`deployment-isolation.test.ts`) still passes against all new
  modules — no Docker vocabulary leaked into the probe or forensics code.
- Full monorepo: 115/115 build+typecheck tasks, 99/99 test tasks.
- The evidence-collection script (`infra/hub-compose/collect-certification-evidence.sh`) now also
  fetches this report and feeds it the real `tcpdump` packet count it already captures.

## What this does not do

This tooling cannot run against the user's real Lithernet Gateway from this sandbox — there is no
LAN path here, per the standing constraint. It is built entirely for local execution: the user
enables the probe, runs the collection script or opens the dashboard on their own installation, and
the resulting `receive-pipeline.json` (or a description of what the dashboard showed) is the
evidence a future session would analyze. Nothing here claims the receive path is fixed; it exists
to make the next real diagnosis conclusive instead of another round of "increase logging and
guess."

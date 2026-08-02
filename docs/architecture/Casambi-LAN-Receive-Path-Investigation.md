# LAN Receive Path Investigation — Casambi UDP RX & KNX/IP Discovery

> Companion to `Casambi-ENETUNREACH-Investigation.md` (the *send* path, resolved) and ADR 0022.
> This document covers the **receive** path, for both Casambi and KNX/IP.
>
> **Both symptoms share ONE root cause: Docker bridge networking does not deliver LAN
> broadcast OR multicast into containers.** Verified experimentally on a real Docker Engine, in
> both directions. Neither is a protocol defect. No protocol logic was modified.

## Headline findings

1. **Casambi RX** — bridge networking accepts the bind and delivers zero broadcast. Same class of
   failure as the resolved `ENETUNREACH`, but on the receive side, and it needs a different fix
   (egress was enough to *send*; **reception requires host networking**).
2. **KNX/IP discovery is NOT a regression caused by `@supreme/lan`.** KNX discovery never migrated
   to it — it still uses raw `node:dgram` inside the Gateway container. Proven below by code
   evidence. It fails for the same Docker-bridge reason, independently.
3. **The most damaging finding: a successful multicast join is not evidence of reception.**
   `addMembership()` returns cleanly on bridge networking and then nothing ever arrives. Every
   diagnostic that checked "did we join?" was reporting a **false PASS** on a permanently deaf
   socket. This is why KNX discovery returned an empty list with no error, forever.

## PART 1 — Casambi receive path

### Stage-by-stage, against the reported state (`Sent = 6, Received = 0, Last Error = None`)

| Stage | Status | Evidence |
|---|---|---|
| Lithernet Gateway → UDP broadcast | **PASS** (your Wireshark) | Gateway broadcasts to `255.255.255.255:10009` |
| Operating system (host NIC) | **PASS** | Host-side Wireshark sees the frames |
| `@supreme/lan` UDP socket — created/bound | **PASS** | `Packets Sent = 6` proves the socket exists, is bound, and can transmit |
| `@supreme/lan` — **datagram delivered** | **FAIL** | `Packets Received = 0`, `Last Error = None`. Reproduced below |
| Raw datagram → NATS | **NOT REACHED** | Nothing received to publish |
| Gateway → Casambi adapter → decoder | **NOT REACHED** | — |
| Discovery Engine → Entity Mapper → Rooms | **NOT REACHED** | — |

`Last Error = None` is correct and important: nothing *errored*. The kernel simply never delivered
a packet. That is the signature of the bridge dropping it, not of a bug in the receive code.

### Reproduction (real Docker Engine, this session)

Identical image, identical code, identical sender; only the container's network mode changed:

| Network mode | Broadcast to `255.255.255.255` | Multicast to `224.0.23.12` |
|---|---|---|
| **bridge** | **NOT RECEIVED** | join OK → **NOT RECEIVED** |
| **host** | **RECEIVED** | join OK → **RECEIVED (3/3)** |

### Wireshark comparison — answered

> *Does Wireshark see packets `@supreme/lan` never receives, or does it receive them and lose them later?*

**Wireshark sees them; `@supreme/lan` never receives them.** The loss is below the application
entirely — in the Docker bridge, before the container's socket. Nothing in the Casambi receive
code (`DgramUdpSession` → `UdpTransportServer` → NATS → adapter → decoder) is reached, so no
amount of protocol-level change could fix it. This is also why the counter reads exactly `0` rather
than "received but failed to decode" — the prior UDP Receive Pipeline Audit already made those two
states permanently distinguishable.

## PART 2 — KNX/IP discovery regression

### It did not migrate to `@supreme/lan` — code evidence

```
$ grep -rn "createKnxDiscoveryRemoteSocketFactory" --include=*.ts services/ apps/
services/protocols/src/lan-adapters/knx-discovery-remote-socket.ts:19:  (its own definition)
services/protocols/dist/... (compiled output of the same)
```

The adapter is **defined and never called**. `knxSearch()` falls back to its built-in
`defaultSocket()` (raw `node:dgram`), and the one production call site passes no options at all:

```ts
// services/gateway/src/installer-context.ts:817
async discoverKnxInterfaces(): Promise<KnxGateway[]> {
  return knxSearch();          // no createSocket → raw dgram; no interfaceAddress → 0.0.0.0
}
```

That was deliberate: Phase 1 built the adapters but explicitly left them unwired pending the
Casambi reference migration. So:

**`@supreme/lan` cannot have caused this regression — KNX discovery has never routed through it.**
KNX discovery runs raw sockets inside the *Gateway* container, which is attached to
`supreme-edge` + `supreme-core` and was never modified by any `@supreme/lan` work
(`git log -- infra/hub-compose/docker-compose.yml` shows the Gateway's networks untouched).

### Why it fails anyway — and why it looked fine

Live run of the real `knxSearch()` in a bridge-networked container:

```
gateways found: 0
raw diagnostics: {"socketBound":true,"joinedMulticast":true,"joinError":null,
                  "datagramsReceived":0,"searchResponsesParsed":0,"gatewaysFound":0}
```

Everything "succeeded". The socket bound. The IGMP membership was **accepted**. No error was
raised. And zero datagrams arrived — because the bridge never forwards multicast in from the
physical LAN. An installer saw an empty gateway list and nothing else.

### Old vs new architecture — the honest comparison

| | Old (pre-`@supreme/lan`) | Today |
|---|---|---|
| KNX discovery socket | raw `node:dgram` in the Gateway container | **unchanged** — still raw `node:dgram` in the Gateway container |
| Casambi UDP socket | raw `node:dgram` in the Gateway container | `@supreme/lan` (`supreme-lan` container) |
| Multicast RX on Docker bridge | broken | broken (identical) |
| Failure visibility | silent: empty list, no error | **named**: stage-by-stage PASS/FAIL/WAITING with the cause |

The architecture change moved *where* the Casambi socket lives; it did not change the Docker
networking constraint, which pre-dates it and applies equally to both protocols. What changed for
the better is that the failure is now diagnosable instead of silent.

## Required changes

### Docker (the actual fix — both protocols)

Reception of broadcast/multicast requires host networking. For Casambi that means running
`supreme-lan` with the documented overlay:

```bash
docker compose -f docker-compose.yml \
  -f docker-compose.nats-loopback.yml \
  -f docker-compose.lan-host.yml up -d
```

**For KNX/IP discovery this is not yet sufficient**, because KNX discovery does not run inside
`supreme-lan` — it runs in the Gateway, which stays bridge-attached by design (ADR 0022: the
Gateway cannot move to host networking without losing Postgres/Redis/NATS DNS). The correct
long-term fix is to wire the already-built `knx-discovery-remote-socket.ts` adapter so KNX
discovery runs through `@supreme/lan` like Casambi does. That is **recommended, not done here** —
per the standing rule that KNX migration waits until Casambi is confirmed on real hardware.

### Windows-specific

Docker Desktop for Windows/macOS does not implement `network_mode: host` for Linux containers, so
the overlay above is a no-op there. Run `supreme-lan` as a native Windows process against the
loopback-exposed NATS instead. **Not verified here** — this sandbox is Linux-only; the new routing
diagnosis reports the real platform at runtime rather than assuming it.

### Code changes made (diagnostics only — no protocol logic touched)

- `DgramUdpSession` — tracks `joinedMulticastAt` and exposes `joinedMulticastButNeverReceived`,
  the honest signal a bare "joined OK" cannot give. Surfaced on `LanSessionDiagnostics`.
- `core/pipeline-stages.ts` (new, protocol-agnostic) — `PASS` / `FAIL` / `WAITING` vocabulary.
  `WAITING` is the state the old diagnostics could not express and the reason a deaf socket
  rendered as a green tick. A reception stage is never `PASS` because a setup call didn't throw;
  it must be backed by a received-packet counter.
- `casambi/pipeline-status.ts` — Socket → Listening → Receiving → Publishing → Decoding →
  Discovery → Entities.
- `knx/knx-discovery-pipeline.ts` — Socket → Joined Multicast → Received Search Response →
  Gateway Parsed → Gateway Created.
- `knx-discovery.ts` — an **optional** `onDiagnostics` observer. Omitting it is byte-for-byte the
  prior code path; discovery behavior is unchanged.

### Deliberately NOT tracked

A per-datagram broadcast/multicast/unicast split. `dgram`'s `rinfo` reports the **sender**, not the
destination, and Node does not surface `IP_PKTINFO` — so a "Broadcast RX vs Multicast RX" counter
would be a guess presented as a measurement. What is observable (joined? received anything?) is
reported instead.

## PART 3 — Is `@supreme/lan` the right permanent foundation?

**Yes, with one caveat worth stating plainly.**

| Protocol | Supported by the current `UdpTransport` without protocol-specific hacks? |
|---|---|
| Casambi | Yes — migrated, unicast send + broadcast RX |
| KNX/IP discovery | Yes — adapter built (`joinMulticast()` exists precisely for its two-phase bind-then-join); needs wiring |
| mDNS / SSDP | Yes — adapters built; both are `bind({multicastGroup})` presets |
| Matter / Apple TV / Denon | Partly — anything using a third-party library that owns its own sockets (`knxultimate`, `@matter/main`) needs a socket seam in that library first. Not a `@supreme/lan` limitation |

The caveat: `@supreme/lan` correctly centralizes *where* sockets live, but it cannot grant network
capabilities the container doesn't have. Its value is that the host-networking requirement now has
to be solved **once**, for one small service, instead of per protocol — which is exactly what ADR
0022 set out to do. Nothing in this investigation argues for changing that design; the two failures
found were a deployment gap and a diagnostics gap, both now closed or clearly named.

**Recommendation (not done here):** wire the KNX discovery adapter through `@supreme/lan` so it
inherits the same host-networking fix rather than needing its own. That is the single highest-value
next step, and it is exactly the migration ADR 0022 already anticipated.

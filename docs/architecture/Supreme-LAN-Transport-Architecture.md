# SupremeOS LAN Transport Architecture (`supreme-lan`)

> Decision record: `docs/architecture/adr/0022-supreme-lan-transport-service.md`. This document is
> the detailed technical reference — protocol flows, deployment topology, the generic transport
> design, and the full migration plan. Read the ADR first for the "why," this doc for the "how."

## 1. Why Docker bridge networking fails for LAN broadcast

Docker's default `bridge` network puts a container behind NAT on a private subnet
(`172.x.x.x`/`10.x.x.x` typically). A LAN broadcast packet (destination `255.255.255.255`, or a
subnet broadcast like `192.168.0.255`) or a multicast packet (destination `224.0.0.0/4`) is
addressed to something that simply doesn't exist inside the bridge's private subnet — the host's
NAT/iptables rules that make bridge networking work for ordinary outbound/inbound TCP/UDP
connections have no rule that forwards a broadcast/multicast datagram from the physical LAN
interface into the bridge. The packet is real, it arrives at the host's physical NIC (confirmed
with Wireshark), and it is simply never delivered past that point to a bridge-attached container's
socket.

This is not a Casambi bug, a Node.js bug, or a `dgram` bug — every protocol in this codebase that
relies on LAN broadcast (KNX/IP Discovery's `SEARCH_REQUEST`) or multicast (KNX Routing, mDNS,
SSDP) hits the identical wall the moment it runs inside a bridge-attached container.

## 2. Why moving the Gateway to host networking broke it

`network_mode: host` makes a container share the host's network namespace directly — no bridge,
no NAT, real LAN visibility. This was tried for the whole Gateway service and broke it immediately:

```
Gateway failed:  getaddrinfo ENOTFOUND postgres
Proxy failed:    502 Bad Gateway
```

Docker Compose's bridge networks (`supreme-core`, `supreme-edge`) provide container-name DNS
resolution (`postgres`, `redis`, `nats`, `homeassistant`, …) as an emergent property of being
attached to those networks. A container in `network_mode: host` is **not** attached to any Compose
network — it has no access to that DNS at all, and no route to the bridge's private subnet either.
The Gateway's entire dependency graph (Postgres, Redis, NATS, `commissioning`, `ai`, `appletv`,
headless `homeassistant`) becomes unreachable simultaneously. This is why the Gateway's
architecture is preserved unchanged in this refactor — the fix cannot touch it.

## 3. Why `supreme-lan` solves both problems

`supreme-lan` is a new, minimal service with exactly one job: own raw LAN sockets. It has **no**
dependency on Postgres, Redis, or any internal HTTP API — its only dependency is
`@supreme/messaging`, the NATS event-bus seam the Gateway already uses. Because its dependency
graph is trivially small, it can safely run with real LAN network access (host networking on
Linux) without inheriting the Gateway's DNS problem: it never needed bridge-network DNS to begin
with. The Gateway stays on bridge, keeps every one of its existing dependencies, and reaches
`supreme-lan` the same way it reaches every other cross-process concern today — a NATS subject.

## 4. Protocol flow

**Send** (a driver wants to transmit, e.g. a Casambi UDP command):

```
Protocol driver (Gateway process)
        │  calls UdpTransport.send(bytes, port, address)
        ▼
Migration adapter (services/protocols/src/lan-adapters/*)
        │  NatsUdpTransportClient.send() — a NATS request/reply
        ▼
IEventBus (NatsEventBus in production, InProcessEventBus in tests)
        │  subject: supreme.lan.udp.send
        ▼
supreme-lan: UdpTransportServer
        │  looks up the DgramUdpSession by sessionId
        ▼
DgramUdpSession → real node:dgram socket
        │
        ▼
Physical LAN
```

**Receive** (the LAN delivers a datagram — e.g. Casambi's gateway broadcasting a notification):

```
Physical LAN (e.g. Casambi Lithernet gateway broadcasting to 255.255.255.255:10009)
        │
        ▼
supreme-lan's real node:dgram socket ("message" event fires)
        │  DgramUdpSession counts it, notifies its onMessage listeners
        ▼
UdpTransportServer
        │  publishes supreme.lan.session.<sessionId>.rx (bytes as base64)
        ▼
IEventBus
        │
        ▼
NatsUdpTransportClient (Gateway process)
        │  decodes base64 back to bytes, notifies onMessage listeners
        ▼
Casambi (Phase 2, migrated): CasambiUdpEngine consumes UdpTransport DIRECTLY — no adapter layer.
KNX Discovery / mDNS / SSDP (unmigrated as of §10): a migration adapter implements each
protocol's existing driver-facing interface (KnxDiscoverySocket / MdnsSocket / SsdpSocket) on
top of the same UdpTransport.
        │
        ▼
Protocol driver's own wire codec (unchanged — e.g. Casambi's udp-codec.ts)
        │
        ▼
Entity/capability state update → Supreme Integration Layer → UI
```

The receive path never changes above the transport boundary — a driver's own decode/dispatch
logic (Casambi's `decodeCasambiPacket`, KNX's `parseSearchResponse`, mDNS's `decodeMessage`,
SSDP's `parseSsdpResponse`) runs exactly as it always has, on bytes that arrived via a different
transport underneath it.

## 5. The generic transport interface

```ts
export interface UdpBindOptions {
  localPort?: number; localAddress?: string; reuseAddr?: boolean;
  broadcast?: boolean; multicastGroup?: string; multicastInterface?: string;
}
export interface UdpTransport {
  bind(opts?: UdpBindOptions): Promise<void>;
  send(data: Buffer, port: number, address: string): Promise<void>;
  joinMulticast(group: string, iface?: string): Promise<void>;
  close(): Promise<void>;
  onMessage(cb: (msg: Buffer, rinfo: { address: string; port: number }) => void): () => void;
  onError(cb: (err: Error) => void): () => void;
  onListening(cb: () => void): () => void;
  address(): { address: string; port: number } | null;
}
```

One interface for every UDP-shaped need in this codebase:
- **Casambi UDP** (`gatewayIp:udpPort`, unicast + the gateway's own broadcast) — plain `bind()` +
  `send()`.
- **mDNS** (`224.0.0.251:5353`) / **SSDP** (`239.255.255.250:1900`) — plain `bind()` + `send()` to
  the multicast address; no membership join needed because both existing implementations rely on
  responders **unicasting** their reply back (mDNS's query sets the DNS "QU" bit; SSDP M-SEARCH
  responses are unicast per the UPnP spec) — this adapter preserves that exactly, it doesn't add a
  join neither driver ever needed.
- **KNX Discovery** (`224.0.23.12:3671`) — a genuinely two-phase case: `knxSearch()`'s existing
  code calls `bind(cb, address)` first, and only once that callback fires (bind genuinely
  complete) does it call `setMulticast(interfaceAddress)` to join the group. This is exactly why
  `joinMulticast()` is a **separate** capability from `bind({multicastGroup})`'s upfront join —
  real `dgram.Socket.addMembership()` itself works the same way, callable any time after bind, not
  only at bind time.
- **KNX Routing / Matter** — NOT covered by Phase 1 (see §8). Both currently own their sockets
  inside a third-party library (`knxultimate`, future `@matter/main`) with no injectable seam.

## 6. Migration adapters

**Casambi (Phase 2, completed — see §10) no longer uses a migration adapter at all.** Phase 1's
`casambi-remote-socket.ts` implemented a Casambi-specific `CasambiUdpSocketLike` interface as a
bridge; Phase 2 deleted `CasambiUdpSocketLike` entirely and rewrote `CasambiUdpEngine` to consume
the generic `UdpTransport` directly — one less layer, and proof that a driver CAN be written
against `UdpTransport` from the start rather than needing an adapter shim. KNX Discovery/mDNS/SSDP
are still Phase 1's migration-adapter shape (below), unmigrated as of this document — see §8.

Each adapter in `services/protocols/src/lan-adapters/` implements an **existing** interface
exactly, so it's a drop-in alternative to that protocol's existing real-`dgram` default:

| Adapter | Implements | Existing default (unchanged) |
|---|---|---|
| `knx-discovery-remote-socket.ts` | `KnxDiscoverySocket` | `knx-discovery.ts`'s `defaultSocket()` |
| `mdns-remote-socket.ts` | `MdnsSocket` | `mdns.ts`'s `defaultSocket()` |
| `ssdp-remote-socket.ts` | `SsdpSocket` | `ssdp.ts`'s `defaultSocket()` |

None of these change any existing driver's default behavior — they're passed only where a caller
explicitly supplies the new factory via each protocol's existing `socketFactory`/`createSocket`
option. `knx-discovery.ts`, `mdns.ts`, `ssdp.ts` remain unmodified and unmigrated — per the
Critical Requirement governing Phase 2 (§10), nothing here is touched until Casambi is proven
fully operational on real hardware.

## 7. Deployment topology

**Default (bridge, degraded — every platform, including Windows/Mac Docker Desktop and CI):**

```
docker compose -f docker-compose.yml up -d
```
```
┌─────────────── supreme-core (bridge, internal) ───────────────┐
│  postgres   redis   nats   mqtt   commissioning   ai   ha      │
│                        ▲                                       │
│                        │ NATS pub/sub                          │
│                     ┌──┴───┐                                   │
│                     │ lan  │  (bridge-attached — NO real LAN   │
│                     └──────┘   broadcast/multicast reception)  │
└──────────────────────────────────────────────────────────────┘
         ▲
         │ NATS pub/sub (same subjects, same bus)
   ┌─────┴─────┐
   │  gateway  │  (supreme-edge + supreme-core, unchanged)
   └───────────┘
```

**Production (Linux, real LAN access):**

```
docker compose -f docker-compose.yml \
  -f docker-compose.nats-loopback.yml \
  -f docker-compose.lan-host.yml up -d
```
```
Host network namespace ─────────────────────────────────────────
   ┌──────┐        real LAN broadcast/multicast
   │ lan  │◄───────────────────────────────────── Casambi / KNX /
   └──┬───┘                                        mDNS / SSDP / …
      │ nats://127.0.0.1:4222 (loopback-only, never LAN-exposed)
──────┼──────────────────────────────────────────────────────────
┌─────┴──────── supreme-core (bridge, internal) ─────────────────┐
│  postgres   redis   nats   mqtt   commissioning   ai   ha       │
└─────────────────────────────────────────────────────────────────┘
         ▲
   ┌─────┴─────┐
   │  gateway  │  (unchanged — bridge, Postgres/Redis/NATS-attached)
   └───────────┘
```

**Windows/macOS Docker Desktop local dev (host networking is a no-op there):**

```
docker compose -f docker-compose.yml -f docker-compose.nats-loopback.yml up -d nats ...
node services/lan/dist/server/main.js    # plain native process, NOT in Docker
```
`SUPREME_LAN_NATS_URL=nats://127.0.0.1:4222` (the same loopback exposure). Workable because
`@supreme/lan`'s only runtime dependency is `@supreme/messaging` (+ optional `nats`) and
`node:dgram` — no Postgres/Redis/native bindings. This is a **disclosed workaround**, exactly like
`services/appletv-py/README.md` already discloses for the identical AppleTV case — not a Docker
feature, and it only gives real LAN access if the Windows/macOS host's own firewall and NIC allow
it (outside this document's control).

## 8. Migration phasing and per-protocol risk

| Phase | Protocol | Effort | Risk |
|---|---|---|---|
| 1 | `supreme-lan` itself: generic transport, wire protocol, Docker topology | Done | Purely additive — zero existing behavior changed |
| 2 | Casambi UDP | **Done** (see §10) — `CasambiUdpEngine` rewritten onto `UdpTransport` directly, `CasambiUdpSocketLike` deleted, Casambi now DEFAULTS through `@supreme/lan` (`NatsUdpTransportClient` when NATS is configured, `LocalDirectUdpTransport` otherwise) | Migration itself fully tested (loopback + cross-package proof, §9/§10); **real-hardware LAN broadcast reception on the new path is NOT yet re-verified** — this sandbox cannot originate that test (§10) |
| 3a | KNX Discovery | Small — adapter already built (`knx-discovery-remote-socket.ts`) | Low — discovery is a one-shot, timeout-bounded operation; a regression is easy to detect (empty results) |
| 3b | KNX Routing | **Large** — `knxultimate` (the third-party library `knx-driver.ts`/`knx-ultimate-provider.ts` wrap) owns its own sockets internally with no injectable seam today. Needs its own protocol-level investigation (does the library expose a custom-socket hook? does it need forking/patching?) before any transport swap is possible | Not started; genuinely harder than a factory swap |
| 4 | Matter (mDNS-based commissioning) | **Large** — no real `@matter/main` controller is wired in yet (`matter-driver.ts`'s `defaultMatterController()` throws); when it is, it will own its own sockets internally, the same class of problem as KNX Routing | Not started |
| 5 | mDNS/SSDP consumers (Sonos, Denon, Apple TV, Hue, Shelly, AirPlay, WiiM…) | Small per consumer — adapters already built (`mdns-remote-socket.ts`, `ssdp-remote-socket.ts`); each consumer just needs its own `createSocket` wired to the new factory when its driver opts in | Low |

## 9. Testing (honestly scoped)

Three tiers, all passing in this Linux sandbox as of this session:

1. **Fake-socket unit tests** — `services/lan/src/server/dgram-udp-session.test.ts` (bind/send/
   close/multicast-join against a fake `DgramSocketLike`, mirroring the `CasambiUdpSocketLike`
   fake-socket convention already established in this codebase).
2. **Contract/integration tests** — `services/lan/src/contract.test.ts` wires the real
   `UdpTransportServer` and `NatsUdpTransportClient` to one shared `InProcessEventBus`, proving the
   real request/reply + event wire protocol end-to-end with zero network. Plus (Phase 2)
   `services/protocols/src/casambi/casambi-over-supreme-lan.test.ts` — the concrete cross-package
   proof: the REAL, unmodified `CasambiProtocolDriver` (not a lower-level engine test) running its
   full connect/discover/feedback/command lifecycle entirely over `NatsUdpTransportClient` +
   `UdpTransportServer` + a fake `node:dgram` socket standing in for the physical Lithernet
   gateway. This superseded and replaced Phase 1's `lan-adapters/casambi-remote-socket.test.ts`,
   which tested an adapter interface Phase 2 deleted.
3. **Real-loopback smoke test** — `services/lan/src/loopback.smoke.test.ts` uses the REAL
   `node:dgram`-backed server (not a fake) on `127.0.0.1`, proving actual OS sockets move bytes
   through the full pipeline.

**What this does NOT prove, stated plainly:** "Windows compatibility" and "Linux compatibility" as
literally requested cannot both be *executed* in one sandboxed session. Linux is verified by
actually running the above tests here. Windows is verified only by code review (no OS-specific
APIs are used anywhere in `@supreme/lan` — `node:dgram`, `node:crypto`'s `randomUUID`, and
`node:os` are all cross-platform) plus the documented native-process workaround in §7. Genuine LAN
broadcast reception — the actual bug this service exists to fix — has not been re-verified against
real hardware in this session either; that requires a Linux host running the `lan-host` overlay
against a real Casambi/KNX device, which this sandboxed environment cannot originate.

## 10. Phase 2 — Casambi migration (completed) and the Transport Monitor

Phase 2 completed the ONE thing Phase 1 deliberately deferred: making `@supreme/lan` the real,
default transport for a real driver, using Casambi as the reference implementation per the
Phase 2 brief's Critical Requirement ("do not proceed to KNX, Matter, or any other protocol until
the Casambi driver is fully operational on the new `@supreme/lan` transport ... Use Casambi as the
reference implementation that validates the architecture before migrating the remaining
LAN-based drivers").

### 11.1 What changed

- `CasambiUdpSocketLike` / `CasambiUdpSocketFactory` — **deleted**. `CasambiUdpEngine`
  (`services/protocols/src/casambi/local-transport/udp-engine.ts`) no longer owns a raw socket or
  defines any protocol-specific socket interface; it takes a required `udpTransportFactory:
  UdpTransportFactory` and calls `UdpTransport.bind()/send()/close()` directly. Every other public
  method/getter kept its exact prior name and shape, so `command-engine.ts`, `discovery-engine.ts`,
  and `casambi-driver.ts` needed **zero changes** to their command/event dispatch logic — only the
  UDP engine's internals changed, satisfying the "do not modify Discovery/Event/Command engine"
  constraint by construction rather than by care.
- `LocalDirectUdpTransport` (`services/lan/src/client/local-direct-udp-transport.ts`, new) — a
  same-process `UdpTransport` wrapping the existing tested `DgramUdpSession`, for single-process
  dev/test stacks where no separate `supreme-lan` deployment exists (no NATS hop).
- **Transport resolution is centralized, once**, in
  `services/gateway/src/installer-context.ts`'s `nativeDriverContext()`: real NATS configured
  (`config.natsUrl` set) → `NatsUdpTransportClient` reaching a real `supreme-lan` service;
  otherwise → `LocalDirectUdpTransport`. `services/gateway/src/native-driver-factory.ts`'s casambi
  factory consumes this via `ctx.udpTransportFactory`, falling back to `LocalDirectUdpTransport`
  only when no context is supplied at all (e.g. a test constructing the factory directly). This is
  the ONE decision point for every future LAN-dependent driver, not a per-protocol choice.
- The Test Connection route (`services/gateway/src/routes/installer.ts`,
  `/v1/commissioning/casambi/test-connection`) resolves its diagnostic `CasambiUdpEngine` through
  the identical resolution logic, so a "Test Connection" result reflects the same network vantage
  point the real persistent driver would actually use in production.
- **Cloud implementation, entity model, discovery engine, event engine, command engine, Driver
  Manager UI, and the existing Cloud REST implementation are byte-for-byte unchanged** — confirmed
  by zero edits to any of those files and the full pre-existing test suite passing unmodified.

### 11.2 The Transport Monitor

A new, additive, developer-grade diagnostics view — separate from the long-standing
`/v1/drivers/:id/casambi/diagnostics` (installer-facing, unchanged) — at
`/v1/drivers/:id/casambi/transport-monitor` (`services/gateway/src/routes/installer.ts`), backed by
`CasambiProtocolDriver.getCasambiTransportMonitor()`
(`services/protocols/src/casambi/transport-monitor.ts`). Four layers, matching the brief's example
shape, each sourced from a real counter — nothing estimated or backfilled:

| Section | Fields | Source |
|---|---|---|
| **Transport** | backend (`local-direct`/`nats`/`unknown`), listening, local address/port, packets sent/received, last error | `CasambiUdpEngine.transportDiagnostics` — read off whichever concrete `UdpTransport` is actually bound, via `instanceof`, never assumed from config |
| **NATS** (Gateway route only, when backend is `nats`) | the running `supreme-lan` service's own interfaces, configured network mode, session diagnostics | `queryLanHealth()` (new client helper, `services/lan/src/client/query-lan-health.ts`) — calls the `supreme.lan.health` subject Phase 1 already built a server handler for but nothing had called from the Gateway side yet |
| **Casambi Adapter** | packets received, decoded, decode failures, last packet, last decode error, recent trace | `CasambiUdpEngine.decodedCount`/`decodeFailureCount` (new counters) + the pre-existing `recentTraces` |
| **Driver** | entities, discovery events, commands issued, feedback events | New lifetime counters on `CasambiProtocolDriver` (`discoveryEventsCount`/`commandsIssuedCount`/`feedbackEventsCount`), incremented at the same points that already drive `getState()`/`onDriverEvent()` |

**What is deliberately absent, and why:** Broadcast-vs-unicast receive counts (nothing in this
codebase filters or distinguishes by destination address — that was the actual root cause fixed
in the prior UDP Receive Pipeline Audit session, so tracking it separately would imply a
distinction that doesn't exist). A NATS "dropped" counter (neither `IEventBus` implementation has
a queue that can silently drop a message today — reporting `0` would look like a measurement,
not an honest "not applicable"). Cross-layer counts (transport vs. adapter vs. driver) are
reported independently and are expected to agree — a real production issue would show up as a
**disagreement** between layers, which is the entire diagnostic point of separating them.

The Transport Monitor endpoint is implemented, typechecked, and unit/integration-tested (below).
**A dedicated UI page for it was not built this phase** — the endpoint is deliberately new/separate
so a future UI page (not the existing Driver Manager, per the "do not modify" constraint) can
consume it; see `TODO.md` for this as an explicit follow-up rather than a silently dropped
requirement.

### 11.3 Real hardware validation — stated honestly

**This sandboxed environment cannot connect to real Lithernet hardware, a real Windows Docker
Desktop host, or a real Linux Docker host.** Everything claimed as "tested" in this phase is one
of: a fake-transport unit test, a fake-`dgram`-socket integration test, or a REAL loopback
`node:dgram` test on `127.0.0.1` inside this sandbox — never a real LAN, never real broadcast
traffic from real Casambi hardware. Specifically NOT verified this phase, and not claimed to be:

- Whether the migrated Casambi driver actually receives the real broadcast NotifyControlValues
  traffic from the real Lithernet gateway (192.168.0.45) captured in the earlier Wireshark
  session, when running through a real `supreme-lan` service on real Linux host networking.
- Any behavior on real Windows Docker Desktop.
- Any behavior on a real multi-container Linux Docker Compose deployment (`docker compose up`
  with the `lan-host`/`nats-loopback` overlays) — the overlay files were validated with `docker
  compose config` (parses correctly) in Phase 1, not with real running containers.

What WAS actually run and passed in this sandbox, and is meaningful evidence the migration is
architecturally sound: `services/protocols/src/casambi/casambi-over-supreme-lan.test.ts` proves
the REAL, unmodified `CasambiProtocolDriver` connects, discovers a unit, updates capability state,
fires a button event, and issues a command — all the way through a REAL `NatsUdpTransportClient`
+ REAL `UdpTransportServer` sharing a REAL `IEventBus`, with only the innermost `node:dgram`
socket faked (the same disclosed testing tier this codebase uses everywhere it cannot originate
real network hardware). It also proves the failure path: if no `supreme-lan` service answers on
the bus, `connect()` rejects honestly within the configured timeout rather than silently
"succeeding" — the exact case the Phase 2 brief's Failure Handling clause was written for.

**The next real-world step, not done here:** run this exact build against the real Lithernet
gateway on a real Linux Docker host with the `lan-host` overlay active, and confirm
`GET /v1/drivers/:id/casambi/transport-monitor` shows a nonzero `adapter.packetsReceived` from
real broadcast traffic. Until that's done, the honest status is "migration is architecturally
complete and internally proven; hardware re-validation is outstanding," not "hardware-verified."

### 11.4 Performance — measured, in-sandbox loopback numbers only

No dedicated latency-measurement test was added, so this phase reports only what the existing
test suite's own timings show, clearly labeled as sandbox/loopback figures rather than production
network measurements: the `casambi-over-supreme-lan.test.ts` suite (7 tests, exercising
connect/discover/feedback/button/command/error paths through the real client+server+bus chain)
completes in well under 100ms total, with no individual step requiring an explicit wait beyond a
single 10ms tick for one asynchronous bus hop. This says the in-process NATS-shaped RPC overhead
is negligible relative to real network latency, but it is **not** a measurement of real UDP
broadcast latency, real NATS latency, or real cross-container latency — those all require the
real-hardware/real-deployment step in §10.3.

### 11.5 Production readiness — honest assessment

**Architecturally complete and internally consistent:** the migration removes Casambi's direct
socket ownership entirely, centralizes transport selection in one place, preserves every
byte-for-byte-unchanged constraint the brief required, and is covered by unit tests (engine-level),
integration tests (driver-over-real-client-and-server), and a wiring-level test (gateway factory
resolution) — 76 test files / 740 tests in `@supreme/protocols` and 72 files / 295 tests in
`@supreme/gateway`, all passing, with the new Casambi-specific additions covering the transport
diagnostics, decoded/decode-failure counters, driver-level counters, NATS client counters, and
the full over-the-wire proof.

**Not yet production-validated:** real Lithernet hardware, real Windows Docker Desktop, and real
multi-container Linux deployment, per §10.3. Recommendation: do not consider Casambi's `@supreme
/lan` migration "done" for a real installation until that hardware retest passes — this matches
the Phase 2 brief's own Critical Requirement to prove Casambi before touching KNX/Matter.

## 11. Future extensibility

- **macvlan**: not implemented in Phase 1 (see ADR §Decision for why), but the natural evolution
  for a future Kubernetes deployment — `supreme-lan` as a DaemonSet using a macvlan/Multus CNI
  attachment gives it a real LAN-segment IP without the `hostNetwork: true` posture Kubernetes
  clusters generally discourage for security/multi-tenancy reasons. Would need static IP or DHCP
  reservation planning per deployment site — a real operational cost host networking doesn't have,
  which is why it's deferred rather than built speculatively now.
- **TCP transport**: `UdpTransport` is UDP-only in Phase 1; a `TcpTransport` interface following
  the identical design (generic, business-logic-free, same NATS wire-protocol pattern) is a
  natural, small addition whenever a LAN protocol needing raw TCP (rather than an HTTP client,
  which doesn't have this problem — HTTP works fine over bridge networking) shows up.
- **New protocols**: any future LAN-broadcast/multicast-dependent protocol gets `supreme-lan`
  "for free" the moment its driver is written against `UdpTransport` instead of `node:dgram`
  directly — no new transport-layer work required, only a driver-side adapter matching the
  pattern in §6.

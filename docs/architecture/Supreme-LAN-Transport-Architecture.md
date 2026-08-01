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
Migration adapter → the exact existing driver-facing interface
  (CasambiUdpSocketLike / KnxDiscoverySocket / MdnsSocket / SsdpSocket)
        │
        ▼
Protocol driver's own wire codec (unchanged — e.g. Casambi's udp-codec.ts)
        │
        ▼
Entity/capability state update → Supreme Integration Layer → UI
```

The receive path never changes above the migration adapter boundary — a driver's own
decode/dispatch logic (Casambi's `decodeCasambiPacket`, KNX's `parseSearchResponse`, mDNS's
`decodeMessage`, SSDP's `parseSsdpResponse`) runs exactly as it always has, on bytes that arrived
via a different transport underneath it.

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

Each adapter in `services/protocols/src/lan-adapters/` implements an **existing** interface
exactly, so it's a drop-in alternative to that protocol's existing real-`dgram` default:

| Adapter | Implements | Existing default (unchanged) |
|---|---|---|
| `casambi-remote-socket.ts` | `CasambiUdpSocketLike` | `CasambiUdpEngine`'s `dgram.createSocket()` |
| `knx-discovery-remote-socket.ts` | `KnxDiscoverySocket` | `knx-discovery.ts`'s `defaultSocket()` |
| `mdns-remote-socket.ts` | `MdnsSocket` | `mdns.ts`'s `defaultSocket()` |
| `ssdp-remote-socket.ts` | `SsdpSocket` | `ssdp.ts`'s `defaultSocket()` |

None of these change any existing driver's default behavior — they're passed only where a caller
explicitly supplies the new factory via each protocol's existing `socketFactory`/`createSocket`
option. `casambi-driver.ts`, `local-gateway-transport.ts`, `knx-discovery.ts`, `mdns.ts`, `ssdp.ts`
are unmodified in this phase.

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
| 1 (this session) | `supreme-lan` itself: generic transport, wire protocol, Docker topology | Done | Purely additive — zero existing behavior changed |
| 2 | Casambi UDP | Small — adapter already built (`casambi-remote-socket.ts`), proven against the real `CasambiUdpEngine` in `casambi-remote-socket.test.ts` | Low, but deliberately **not defaulted yet** — Casambi's engine was hardware-validated across two recent sessions; flipping its default transport needs its own real-hardware retest, not bundled into the session that introduces the RPC path for the first time |
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
   real request/reply + event wire protocol end-to-end with zero network. Plus
   `services/protocols/src/lan-adapters/casambi-remote-socket.test.ts` — the concrete
   cross-package proof: the REAL, unmodified `CasambiUdpEngine` running entirely over this
   transport, sending and receiving real Casambi wire packets.
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

## 10. Future extensibility

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

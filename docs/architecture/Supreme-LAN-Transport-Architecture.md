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
| 2 | Casambi UDP | **Done** (see §10) — `CasambiUdpEngine` rewritten onto `UdpTransport` directly, `CasambiUdpSocketLike` deleted, Casambi now DEFAULTS through `@supreme/lan` (`NatsUdpTransportClient` when NATS is configured, `LocalDirectUdpTransport` otherwise) | Migration fully tested (loopback + cross-package proof + real-Docker bridge-vs-host broadcast reproduction, §9/§10); **only real physical Lithernet hardware remains unverified** — this sandbox has no such device (§10.3) |
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
actually running the above tests here, and — as of Phase 2 (§10.3) — by actually booting the real
`lan`/`nats` containers on a real Docker Engine and reproducing the bridge-vs-host broadcast
behavior for real, not just parsing the Compose files. Windows is still verified only by code
review (no OS-specific APIs are used anywhere in `@supreme/lan` — `node:dgram`, `node:crypto`'s
`randomUUID`, and `node:os` are all cross-platform) plus the documented native-process workaround
in §7 — this sandbox is Linux-only and cannot originate a real Windows Docker Desktop run. Genuine
LAN broadcast reception from a REAL Casambi/KNX device — the actual bug this service exists to
fix — still has not been re-verified against real hardware; that requires a Linux host running the
`lan-host` overlay against the real device itself, which no synthetic broadcast from a script can
substitute for (see §10.3 for exactly what was and wasn't reproduced).

## 10. Phase 2 — Casambi migration (completed) and the Transport Monitor

Phase 2 completed the ONE thing Phase 1 deliberately deferred: making `@supreme/lan` the real,
default transport for a real driver, using Casambi as the reference implementation per the
Phase 2 brief's Critical Requirement ("do not proceed to KNX, Matter, or any other protocol until
the Casambi driver is fully operational on the new `@supreme/lan` transport ... Use Casambi as the
reference implementation that validates the architecture before migrating the remaining
LAN-based drivers").

### 10.1 What changed

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

### 10.2 The Transport Monitor

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

### 10.3 Real hardware validation — stated honestly

**This sandboxed environment still cannot connect to a real Lithernet gateway or a real Windows
Docker Desktop host — that has not changed.** What DID change this session: a real Docker Engine
became available in this sandbox, so the Docker/Linux/Compose side of validation moved from
"config parses" (Phase 1) to **real containers actually booted, and the exact bridge-vs-host
broadcast behavior this whole project exists to fix was reproduced for real** — not simulated,
not code-reviewed, actually observed. Both directions:

- **Bug reproduced (bridge mode):** built the real `lan.Dockerfile` image, booted real `nats` +
  `lan` containers with `lan` on its default bridge network, bound a real UDP socket inside the
  container via the real wire protocol (`supreme.lan.udp.bind` over real NATS), then sent a real
  UDP broadcast (`255.255.255.255` and the subnet broadcast) from a process on the Docker host —
  **not received**. This is the exact `Packets Received = 0` failure mode the whole `supreme-lan`
  service exists to fix, reproduced against this session's own build, not assumed from the
  original Casambi-specific incident.
- **Fix confirmed (host mode):** rebuilt the same containers with `lan` on `docker-compose.
  lan-host.yml` (real `network_mode: host`) and NATS reachable via `docker-compose.
  nats-loopback.yml`'s loopback-only publish — the identical broadcast, from the identical host
  process, to the identical bound port, **was received**, correctly reported through the real
  wire protocol (`supreme.lan.session.<id>.rx`) and the real health snapshot
  (`packetsReceived: 1`).
- **A real, previously-undiscovered bug was found and fixed in the process** (not by inspection —
  by actually running it): `lan.Dockerfile` only `COPY`'d `packages`/`services`, but
  `pnpm-workspace.yaml` also declares `cloud/*`/`drivers/*`/`tools/*` as workspace members, so
  `pnpm install --frozen-lockfile` failed outright (`services/license` depends on
  `@supreme/licensing`, which lives in `cloud/licensing`, never copied into the build context).
  Fixed by copying `cloud`/`drivers`/`tools` too, matching `gateway.Dockerfile`'s existing pattern.
  A second, separate bug: `docker-compose.nats-loopback.yml`'s `ports:` publish was silently a
  no-op, because Docker does not create the port-forwarding rule for a container whose ONLY
  network is `internal: true` (confirmed with an isolated minimal reproduction outside this repo,
  not just this service) — `supreme-core` is `internal: true` by design. Fixed by giving `nats` a
  second, non-internal, loopback-only network (`lan-loopback`) in that one override file — every
  other service on `supreme-core` keeps its exact existing isolation.

**What this still does NOT prove, stated plainly:** a synthetic UDP broadcast sent from a script
on the same Docker host is not a real Casambi Lithernet gateway on a real physical LAN segment —
it doesn't exercise a real NIC, real switch, real ARP, or a real ~six-message Lithernet UDP
Command protocol payload. Real Windows Docker Desktop was not (and cannot be) touched from this
Linux sandbox. The recommended next real-world step is unchanged: run this exact build against
the real Lithernet gateway on a real Linux host with the `lan-host` overlay, and confirm
`GET /v1/drivers/:id/casambi/transport-monitor` shows a nonzero `adapter.packetsReceived` from
that real device. What DID change is that the Docker/networking MECHANISM this depends on is no
longer merely asserted by design — it was independently reproduced and fixed in this session, on
a real Docker Engine, which is meaningfully stronger evidence than Phase 1 had.

A step-by-step runbook for that real-hardware retest — prerequisites, exact commands, what
success/failure at each stage means, and how to isolate exactly where a real failure occurs
without guessing — is written out in full at `docs/architecture/
Casambi-Real-Hardware-Validation-Runbook.md`.

### 10.4 Performance — real Docker measurement plus a repeatable automated benchmark

Two distinct numbers, deliberately kept separate because they measure different things:

- **Real, one-off, real-Docker measurement (not automated — needs a live Docker daemon):** in the
  §10.3 host-mode validation, a real UDP packet sent from the Docker host process to the real
  host-networked `lan` container's real bound socket was observed on its NATS-published
  `session.rx` event **~8ms** after the `dgram.send()` call returned. This includes real OS UDP
  delivery, the real `DgramUdpSession`/`UdpTransportServer` code path, and a real NATS publish/
  subscribe round trip over the loopback-published connection — the closest this session could get
  to a genuine cross-process, cross-container latency number without physical LAN hardware.
- **Automated, repeatable, code-only benchmark** (`services/protocols/src/casambi/
  casambi-lan-latency.test.ts`, runs in CI on every `vitest run`, n=50 samples each): the SAME real
  classes (`CasambiProtocolDriver`, `NatsUdpTransportClient`, `UdpTransportServer`) wired over an
  `InProcessEventBus` (no real NATS, no real network — isolates the CODE's own overhead from
  Docker/OS/network scheduling variance). Measured this session: UDP-receive → decode → driver
  `applySignal` → `onState` fired — median **0.022ms**, p95 **0.354ms**; `command()` dispatch →
  adapter → transport → fake gateway socket — median **0.035ms**, p95 **0.127ms**. These numbers
  say the code path itself adds negligible overhead; the real ~8ms figure above is dominated by
  real inter-process NATS/OS latency, not this migration's own code.

Neither number is a measurement of real Casambi UDP broadcast latency over a real physical LAN —
that still requires the real-hardware step in §10.3.

### 10.5 Production readiness — honest assessment

**Architecturally complete, internally consistent, AND now independently validated on real Docker
infrastructure (new this session):** the migration removes Casambi's direct socket ownership
entirely, centralizes transport selection in one place, preserves every byte-for-byte-unchanged
constraint the brief required, and is covered by unit tests (engine-level), integration tests
(driver-over-real-client-and-server), a wiring-level test (gateway factory resolution), an
automated latency benchmark, AND a real Docker Engine run that reproduced the original bug in
bridge mode and confirmed the fix in host mode — 77 test files / 742 tests in `@supreme/protocols`
and 72 files / 295 tests in `@supreme/gateway`, all passing.

**Still not production-validated:** a real Lithernet gateway on a real physical LAN, and real
Windows Docker Desktop. Recommendation unchanged: do not consider Casambi's `@supreme/lan`
migration "done" for a real installation until the real-hardware retest in §10.3 passes — this
matches the Phase 2 brief's own Critical Requirement to prove Casambi before touching KNX/Matter.
The gap between "done" and "not yet" narrowed significantly this session (from "never actually ran
a container" to "reproduced and fixed the exact bug on a real Docker Engine"), but real Lithernet
hardware is the one thing no amount of additional sandbox work can substitute for.

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

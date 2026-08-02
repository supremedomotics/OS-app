# ADR 0022 — `supreme-lan`: a dedicated, business-logic-free LAN transport service

- Status: **Accepted** (Phase 1 implemented. Phase 2 — Casambi, the reference migration — also
  implemented and is now the DEFAULT transport for the Casambi Local Gateway driver; see
  `docs/architecture/Supreme-LAN-Transport-Architecture.md` §10 for the full account, including
  what remains hardware-unverified. Phases 3-5 — KNX/Matter/remaining LAN drivers — are deliberate,
  separate follow-ups, explicitly gated on a real-hardware retest of Phase 2, not part of this
  decision's scope yet)
- Date: 2026-08-01 (amended 2026-08-02 — see the Amendment section at the end)
- Context: Production Architecture Refactor — Docker bridge networking silently drops LAN
  broadcast/multicast traffic, proven with real hardware.

## Context

Real hardware testing proved Docker bridge networking drops LAN broadcast/multicast traffic
before it reaches a container: a Lithernet Casambi gateway broadcasts UDP notifications to
`255.255.255.255:10009`; Wireshark on the host sees them; the Gateway container's bound socket
never does (see `docs/architecture/Casambi-UDP-Receive-Pipeline-Audit.md`). This is not
Casambi-specific — the same failure mode blocks KNX Routing (multicast `224.0.23.12:3671`) and
Discovery, Matter/mDNS (`224.0.0.251:5353`), SSDP (`239.255.255.250:1900`), and every future
LAN-broadcast/multicast-dependent protocol (Sonos, Denon, Apple TV, Hue, Yamaha).

A previous attempt moved the whole Gateway service to `network_mode: host` to fix this — it broke
the Gateway instead (`getaddrinfo ENOTFOUND postgres`, the edge proxy returning 502) because the
Gateway is tightly coupled to Postgres, Redis, NATS, and internal services (`commissioning`, `ai`,
`appletv`, `homeassistant`) that are only reachable via Docker's bridge-network DNS. Moving the
Gateway to host networking severs that DNS resolution entirely. **The Gateway cannot move to host
networking.**

This repo already has a smaller-scale precedent for the exact same class of problem:
`infra/hub-compose/docker-compose.appletv-host.yml` puts only the Apple TV pyatv sidecar on host
networking for reliable mDNS discovery, documented as Linux-only (a Docker Desktop for macOS/
Windows limitation — the VM boundary between the host's real network adapter and the container
runtime makes host networking a no-op there). This ADR generalizes that pattern into a permanent,
protocol-agnostic architecture rather than repeating it once per protocol.

## Decision

Extract all raw LAN socket access into a new, standalone service — `supreme-lan` (npm package
`@supreme/lan`, workspace `services/lan`) — with these hard constraints:

- **No business logic.** It never parses a protocol frame, never knows what a `CapabilityKind` or
  `DeviceId` is. It moves `Buffer`s between the LAN and the process that asked for them, nothing
  else.
- **No persistence, no Postgres, no Redis, no authentication.** Its only dependency is
  `@supreme/messaging` (this repo's existing NATS event-bus seam) plus `node:dgram`.
- **The Gateway stays exactly where it is** — bridge-attached, Postgres/Redis/NATS-connected,
  unmodified in this phase. It talks to `supreme-lan` only over the SAME NATS instance it already
  connects to (`SUPREME_NATS_URL`), never a new IPC mechanism.
- **Protocol drivers stop opening raw sockets.** They consume a single generic `UdpTransport`
  interface (bind/send/close/onMessage/onError/onListening/address, plus a `joinMulticast()`
  capability for post-bind multicast joins) instead. mDNS and SSDP are not separate transports —
  they are `bind({multicastGroup, localPort})` presets on the same interface. Wire-codec logic
  (DNS-SD parsing, SSDP HTTP-framing, Casambi's `.`-hex codec, KNXnet/IP frame encode/decode) is
  unchanged and stays exactly where it already lived, in `services/protocols`.
- **Migration is non-breaking and incremental.** Two shapes, chosen per protocol: (1) a thin
  adapter per existing driver-facing socket interface (`services/protocols/src/lan-adapters/`,
  used for KNX Discovery/mDNS/SSDP, still unmigrated as of Phase 2) implementing that EXACT
  interface by delegating to a `UdpTransport`; (2) Casambi (Phase 2, migrated) skips the adapter
  entirely — `CasambiUdpEngine` was rewritten to consume `UdpTransport` directly, since its
  socket interface had no other real consumer to stay backward-compatible with. Either way, the
  driver's OWN wire codec and every non-transport method/getter keep their exact prior shape.
- **Docker: `supreme-lan` may run with host networking; the Gateway never does.** The base compose
  stack runs `lan` bridge-attached (a deliberately degraded default — testable everywhere, no real
  LAN broadcast). A separate override, `docker-compose.lan-host.yml`, switches only `lan` to
  `network_mode: host` on Linux, mirroring `docker-compose.appletv-host.yml` exactly. Because
  `supreme-core` is `internal: true`, a second override (`docker-compose.nats-loopback.yml`)
  exposes NATS on `127.0.0.1` only so a host-networked `lan` can still reach it.
- **macvlan is documented as a future option, not implemented now.** It offers no advantage over
  host networking on Linux (the only platform host networking works on today) and needs
  per-site static IP/ARP planning; it's the natural fit for a *future* Kubernetes deployment via
  Multus CNI, where `hostNetwork: true` is discouraged.

Full technical detail — flow diagrams, deployment diagrams, the wire protocol, the per-protocol
migration risk table, and the Windows Docker Desktop disclosure — lives in
`docs/architecture/Supreme-LAN-Transport-Architecture.md`.

## Consequences

- Every current and future LAN-broadcast/multicast-dependent protocol gets a real fix through ONE
  shared service, not a bespoke workaround repeated per protocol.
- The Gateway's architecture, Docker service isolation, and Postgres/Redis/NATS coupling are
  fully preserved — this is additive infrastructure, not a rewrite of anything that already works.
- Real LAN access for `supreme-lan` is Linux-only for now (Docker host networking is a no-op on
  Docker Desktop for macOS/Windows) — an honestly disclosed limitation, not a design flaw this ADR
  hides. Local Windows development can still exercise every non-broadcast-dependent code path, and
  can exercise the real socket/RPC pipeline via loopback (see the architecture doc's testing
  tiers); genuine LAN broadcast verification needs a Linux host or a native (non-Docker) process.
- KNX's tunneling/routing driver and Matter's future controller both own their sockets inside
  third-party libraries (`knxultimate`, `@matter/main`) with no injectable seam today — Phase 1's
  generic transport cannot absorb them for free. Migrating those is real, separate protocol-level
  work (Phases 3-4), not solved by this decision.
- `@supreme/lan`'s wire protocol (base64-encoded datagram bytes over NATS request/reply built on
  `@supreme/messaging`'s existing pub/sub) adds one network hop's worth of latency to every LAN
  send/receive when `supreme-lan` genuinely runs remotely — acceptable for the protocols this
  serves (all sub-second, human-interaction-paced control/discovery traffic, none of them
  latency-sensitive media/audio streams).
- **Phase 2 (Casambi) is architecturally complete and covered by real loopback/in-process tests
  (unit, integration, and a full driver-over-real-client-and-server cross-package proof), but has
  NOT been re-verified against real Lithernet hardware, real Windows Docker Desktop, or a real
  multi-container Linux deployment** — this sandboxed environment cannot originate any of those.
  Treat Casambi's `@supreme/lan` migration as "internally proven, hardware-pending" until that
  retest happens; see the architecture doc §10.3 for the exact, disclosed scope of what was and
  wasn't verified.

## Amendment (2026-08-02) — Production Architecture Direction: deployment/transport separation

### Context

The original decision above was written while Docker was the only deployment SupremeOS had. That
framing leaked: the transport layer had come to carry Docker's own vocabulary in load-bearing
places — `networkMode: "bridge" | "host" | "macvlan"` in the NATS **wire protocol**, in the health
snapshot, in the `UdpTransportServer` constructor, and as the branch condition in the failure
diagnosis. Compose filenames were hardcoded into remediation strings.

The confirmed product direction is that SupremeOS ships as a **dedicated OS image** (Home Assistant
OS-style) on x86/ARM hardware, where `supreme-lan` runs as a native systemd service with direct
access to the physical NICs. **Docker is a development and CI environment only.** Under the old
shape, removing Docker would have meant editing the transport and its wire protocol — a protocol
change forced by a deployment change, which is exactly backwards. None of the Docker networking
limitations documented in this ADR exist on the production target at all.

### Decision

**`@supreme/lan` owns every physical LAN socket in SupremeOS, and knows nothing about how it is
deployed.** Two concrete rules, both now structurally enforced rather than aspirational:

- **One deployment module.** `services/lan/src/server/deployment.ts` is the ONLY module in
  `@supreme/lan` permitted to name a container runtime, a compose file, or a systemd unit. It
  exposes a `LanDeployment` table (`native-linux`, `docker-host`, `docker-bridge`, `macvlan`,
  `vm-bridged`, `unknown`) carrying `label`, `developmentOnly`, `noLanAccessRemedy`, and
  `unreliableLanAccessOn` — all deployment-specific text as *data*.
- **The transport reasons only about `LanAccess`** (`"direct" | "isolated" | "unknown"`) — a
  property of the network namespace, meaningful for a native service, a VM, and a container
  alike. This replaced `"bridge" | "host" | "macvlan"` in the wire protocol, the health snapshot,
  the server constructor, and `routing-diagnosis.ts`. Adding a future deployment (hardware
  appliance, VM template, k8s DaemonSet) is one entry in that table — no transport change, and no
  protocol-driver change.

Deployment is **configured, never auto-detected** (`SUPREME_LAN_DEPLOYMENT`, with the legacy
`SUPREME_LAN_NETWORK_MODE` still honored for backward compatibility). A process cannot reliably
determine from inside its own network namespace whether it shares the host's, so detection would
produce confidently wrong diagnostics — `unknown` is reported honestly instead.

`infra/systemd/supreme-lan.service` is the production deployment unit. It runs the **same**
`dist/server/main.js` as the container, with `SUPREME_LAN_DEPLOYMENT=native-linux`. Note what it
deliberately does not harden: `PrivateNetwork`/`NetworkNamespacePath` must never be set there, as
that would recreate on the production image precisely the isolation that breaks
broadcast/multicast under Docker bridge.

### Consequences

- **Removing Docker is now a deployment change, not a protocol rewrite** — the stated goal. The
  same transport code ships unchanged to the SupremeOS image.
- **The rule is enforced by a test, not by convention.** `services/lan/src/deployment-isolation.
  test.ts` scans every shipped `@supreme/lan` module for container-runtime vocabulary in
  executable code (doc comments exempt — explaining *why* a limitation exists carries no runtime
  coupling; `*.test.ts` exempt — a test must be able to construct a `DEPLOYMENTS["docker-bridge"]`
  fixture and assert its remediation text, which is consuming the isolated module, not leaking).
  The guard was verified to actually fail on an injected leak, not merely to pass.
- **Docker's platform caveats became data.** "Docker Desktop does not implement host networking
  for Linux containers" now lives in `deployment.ts` as `unreliableLanAccessOn` keyed by
  `process.platform`; `routing-diagnosis.ts` appends the note verbatim without knowing which
  runtimes are affected. Correcting the earlier code, this now covers `darwin` as well as
  `win32` — Docker Desktop runs Linux containers in a VM on both.
- **Backward compatibility is preserved in full.** Existing compose files and any already-deployed
  unit setting `SUPREME_LAN_NETWORK_MODE` keep behaving identically; no protocol driver was
  touched by this amendment.
- The transport can now switch between Docker, native Linux, and a future hardware-specific
  deployment without modifying any protocol driver — which is what makes Phases 3-5 (KNX, Matter,
  remaining LAN drivers) independent of the deployment question entirely.

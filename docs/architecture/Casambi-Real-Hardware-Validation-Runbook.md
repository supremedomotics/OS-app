# Casambi Real Hardware Validation Runbook

> Companion to `docs/architecture/Supreme-LAN-Transport-Architecture.md` §10.3 and ADR 0022.
> This is the ONE remaining step before the Casambi Local Gateway driver's `@supreme/lan`
> migration can be called production-verified rather than "internally proven." Nothing in this
> document has been run by the AI session that wrote it — this sandbox has no real Lithernet
> gateway, no real physical LAN, and no real Windows machine. It is written FOR the person who has
> those things.

## What has already been proven, and what hasn't

Already proven, for real, on real Docker/Linux (this session): the `@supreme/lan` service boots,
connects to NATS, correctly binds/sends/receives real UDP datagrams, and — critically — a real UDP
broadcast sent from the Docker host is **dropped** when `lan` runs on its default bridge network
and **received** when `lan` runs with `docker-compose.lan-host.yml` (real `network_mode: host`).
That is real evidence the Docker/networking *mechanism* this whole architecture depends on works
as designed.

NOT proven: that a **real Casambi Lithernet gateway**, broadcasting its real UDP Command protocol
traffic on a **real physical LAN**, is received and correctly decoded by this build. A script
sending a synthetic broadcast from the same Docker host is not the same as a real device on a real
switch with real ARP and real firmware behavior. This runbook closes that specific, remaining gap.

## Prerequisites

- A Linux host (bare metal or VM with a real bridged/macvlan-capable NIC — NOT a nested container
  sandbox) with Docker Engine + Docker Compose v2, on the same physical LAN segment as the
  Lithernet gateway.
- The Lithernet gateway's IP, REST port, UDP port, Net ID, and Data Format (from its own web UI —
  see `Lithernet_General_Settings_Network.pdf`).
- This repo, checked out on that host, on the branch/commit containing this Phase 2 work.
- A `.env` file at the repo root (copy `.env.example`, fill in real values — never commit it).

## Step 1 — Bring up the production topology

```bash
cd infra/hub-compose
docker compose -f docker-compose.yml \
  -f docker-compose.nats-loopback.yml \
  -f docker-compose.lan-host.yml \
  up -d --build
docker compose -f docker-compose.yml -f docker-compose.nats-loopback.yml -f docker-compose.lan-host.yml ps
```

Confirm:
- `lan` container is `Up`. `docker inspect <lan-container> --format '{{.HostConfig.NetworkMode}}'`
  must print `host`.
- `docker logs <lan-container>` shows `networkMode=host` and a NATS URL it connected to
  successfully (no repeated connection-refused errors).
- `docker port <nats-container>` shows `4222/tcp -> 127.0.0.1:4222` (loopback-only — if this is
  empty, the `nats-loopback.yml` override isn't being applied; re-check the `-f` flags above).

## Step 2 — Configure the Casambi Local Gateway driver

Through the normal installer/commissioning UI (or the API directly), set the Casambi driver's
`connectionType` to `local` with the real gateway's IP/ports/Net ID/Data Format. This is the SAME
configuration flow that existed before this migration — nothing about the installer UX changed.

## Step 3 — Watch the Transport Monitor

```bash
curl -s http://<gateway-host>/v1/drivers/<installed-driver-id>/casambi/transport-monitor | jq .
```

(Swap in your real auth header / gateway base URL as this deployment requires.) Before any real
traffic arrives, expect:

```json
{
  "connectionType": "local",
  "transport": { "backend": "nats", "listening": true, "packetsSent": 0, "packetsReceived": 0, "lastError": null },
  "adapter": { "packetsReceived": 0, "decoded": 0, "decodeFailures": 0 },
  "driver": { "entities": 0, "discoveryEvents": 0, "commandsIssued": 0, "feedbackEvents": 0 },
  "lan": { "networkMode": "host", "natsConnected": true, "sessions": [...] }
}
```

`transport.backend` must read `"nats"` — if it reads `"local-direct"`, the Gateway isn't
configured with `SUPREME_NATS_URL`, meaning it's using the same-process fallback and never talking
to the `lan` container at all; fix the Gateway's env before continuing.

## Step 4 — Trigger real traffic and confirm reception

Do something on the real Casambi network that causes a `NotifyControlValues` broadcast (toggle a
light physically, or via the Casambi app) — the gateway broadcasts on state change and periodic
heartbeats. Re-poll the Transport Monitor:

- `transport.packetsReceived` and `adapter.packetsReceived` should both increment together. If
  `transport.packetsReceived` increments but `adapter.packetsReceived` does not, the failure is
  between the transport and the Casambi engine — check `adapter.decodeFailures` and the
  `casambi/diagnostics` route's `recentTraces` for the raw payload.
- If NEITHER increments, the failure is upstream of this codebase entirely — confirm with
  `tcpdump -i <iface> udp port <udp-port>` on the Linux host itself that the broadcast is arriving
  at the host's real NIC in the first place. If `tcpdump` sees it and the Transport Monitor
  doesn't, that is the single most useful piece of evidence to bring back to a follow-up session —
  it means the receive path inside `@supreme/lan` itself is the problem, not the network.
- If `tcpdump` does NOT see it, the problem is external to this codebase (firewall, switch
  IGMP/broadcast filtering, wrong interface, VLAN mismatch) — not something a code change can fix.

This is the exact staged approach the governing brief's Failure Handling clause asked for: prove
exactly which stage stops, never guess.

## Step 5 — Confirm discovery, feedback, and commands

- **Discovery:** `driver.discoveryEvents`/`driver.entities` in the Transport Monitor should
  increase as real units broadcast their first packet. Confirm the resulting devices/entities
  appear in the normal Discovery Queue / Driver Manager UI (unchanged this phase).
- **Feedback:** toggle a real light/device physically or via the Casambi app; confirm the
  corresponding SupremeOS entity's on/off, brightness, etc. updates in the UI, and
  `driver.feedbackEvents` increments.
- **Commands:** issue an on/off/brightness command from the SupremeOS UI; confirm the real light
  responds, and `driver.commandsIssued` increments.

## Step 6 — Report back

Whatever the outcome — full success, partial (e.g. discovery works but commands don't), or
complete failure — the Transport Monitor's full JSON output at each stage, plus a `tcpdump`
capture if reception fails, is exactly what a follow-up session needs to diagnose further without
guessing. Please capture and share that rather than a summary like "it didn't work."

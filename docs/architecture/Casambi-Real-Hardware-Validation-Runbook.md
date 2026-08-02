# Casambi Real Hardware Validation Runbook

> Companion to `docs/architecture/Supreme-LAN-Transport-Architecture.md` §10.3, ADR 0022, and
> `docs/architecture/Casambi-Final-Hardware-Validation-Report.md` (the Production Gate's official
> "NOT EVALUATED — hardware unavailable" verdict, and the Packet Replay Framework / Failure
> Analysis / Transport Monitor guides this runbook now uses). This is the ONE remaining step
> before the Casambi Local Gateway driver's `@supreme/lan` migration can be called
> production-verified rather than "internally proven." Nothing in this document has been run by
> the AI session that wrote it — this sandbox has no real Lithernet gateway, no real physical LAN,
> and no real Windows machine, and no network path to reach any of those things even if they
> existed. It is written FOR the person who has those things.
>
> **Confirmed workflow:** you run this runbook (and/or the collection script in Step 6) on your
> own SupremeOS installation, against your real Lithernet Gateway. Nothing here attempts to reach
> your LAN remotely, and nothing should — the collection script explicitly never talks to anything
> outside your own network. You then share the resulting JSON/logs/pcap bundle back for analysis
> and certification write-up.

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
heartbeats. Re-poll the Transport Monitor, and read its new `failureAnalysis` field FIRST — it
already runs this exact staged diagnosis for you (`services/protocols/src/casambi/
failure-analysis.ts`): a ✓/✗ checklist across Transport → NATS → Casambi Adapter →
Discovery/Driver, with a concrete, data-backed reason on the first stage that fails. Use it before
manually cross-referencing counters:

- If `failureAnalysis.firstFailingStage` is `"Transport (UDP)"` and the reason mentions zero
  packets received: confirm with `tcpdump -i <iface> udp port <udp-port>` on the Linux host itself
  that the broadcast is arriving at the host's real NIC in the first place. If `tcpdump` sees it
  and the Transport Monitor doesn't, that's the single most useful evidence to bring back to a
  follow-up session — the receive path inside `@supreme/lan` itself is the problem, not the
  network. If `tcpdump` does NOT see it either, the problem is external to this codebase (firewall,
  switch IGMP/broadcast filtering, wrong interface, VLAN mismatch) — not something a code change
  can fix.
- If it's `"Casambi Adapter"`: the reason includes the exact decode error and raw payload — check
  `driver.recentJourney` (the per-packet "Packet Trace") for the full sequence of what arrived and
  when.
- If it's `"Discovery / Driver"` with an "opcode 0xXX not mapped" reason: this is a REAL,
  documented Casambi opcode `event-engine.ts`'s `normalizeLocalPacket` doesn't yet map to a
  driver signal — that's a concrete, fixable gap, not a network problem.

**Capture it for next time:** whatever raw payload the `recentTraces`/`recentJourney` show,
save it as a new Packet Replay capture (`docs/architecture/
Casambi-Final-Hardware-Validation-Report.md` §3) under `tests/regression/casambi/` — from then on,
this exact real-world scenario is a permanent, hardware-free regression test, and a follow-up
session can reproduce and fix it without needing your hardware again.

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

## Step 5a — If Step 4 shows zero packets received: Runtime Data Path Verification

If `transport.packetsReceived` stays at zero while a host-side capture confirms the gateway is
broadcasting, the fault is below the Casambi driver, and the driver's own counters cannot localize
it further. This is exactly what the Runtime Pipeline Dashboard (in the driver's Diagnostics panel)
and the independent UDP probe exist to resolve.

1. **Enable the independent probe.** Before bringing the stack up, set on the `lan` service (e.g.
   in `infra/hub-compose/docker-compose.yml` or an env file):
   ```
   SUPREME_LAN_PROBE_PORT=10009
   ```
   This starts a second, completely independent listener inside `supreme-lan` — no decoder, no
   NATS republish, no Casambi — bound to the same port. Its only job is to prove whether the OS
   delivers datagrams to this process at all, independent of anything the driver does with them.
2. **Open the Runtime Pipeline Dashboard** in the Casambi driver's Diagnostics panel and click "Run
   verification." It shows all eleven stages (OS Network Stack → supreme-lan UDP Socket → Datagram
   Received → Raw Packet Recorder → NATS Publish → Gateway Subscriber → Casambi UDP Engine →
   Protocol Decoder → Discovery Engine → Entity Mapper → Room Assignment) independently, each with
   its own entered/exited/failures/timestamps — never one aggregated number.
3. **If you also ran `tcpdump`/Wireshark**, enter the packet count it captured into the "Host
   capture packet count" field before running verification. This is the one number SupremeOS
   cannot observe about itself, and it is what resolves the one case where two opposite causes
   ("the gateway isn't transmitting" vs. "the packets never reach this network namespace") would
   otherwise look identical from inside the process.
4. **Read the Root Cause verdict.** It is one of exactly nine categories (never a guess — an
   inconclusive case reports `unknown` with exactly what additional evidence would resolve it,
   most commonly "take a host-side capture over the same window").
5. **Check the Certification section.** A stage that was never exercised (e.g. the Decoder, when
   nothing reached it) is reported `NOT EVALUATED`, never as a silent pass — certification requires
   every one of the seven sections to be both evaluated and passing.

The evidence-collection script in Step 6 below automatically calls this same endpoint
(`GET /v1/drivers/:id/casambi/receive-pipeline`) and feeds it the real packet count from its own
`tcpdump` capture, so running the script already captures everything above — this section explains
what you're looking at in the resulting `receive-pipeline.json` and the live dashboard.

## Step 6 — Collect evidence and report back

Rather than doing Steps 3-5's `curl`/`tcpdump` manually, run the collection script from the repo
root — it automates exactly those steps into one timestamped bundle:

```bash
cd infra/hub-compose
./collect-certification-evidence.sh \
  --gateway-url https://<your-gateway-host> \
  --driver-id <installed-casambi-driver-id> \
  --auth-token "$SUPREME_AUTH_TOKEN" \
  --interface <real-LAN-NIC-name>   # optional — omit to skip the tcpdump capture
```

It collects, into `./casambi-certification-<timestamp>/` (and a matching `.tar.gz`): `docker
compose ps` output, `lan`/`gateway`/`nats` container logs, a Transport Monitor snapshot taken
immediately, a real `tcpdump` capture running while you're prompted to trigger activity on the
gateway (if `--interface` was given), and a second Transport Monitor snapshot taken after.
Anything it couldn't collect is recorded honestly in `notes.txt` inside the bundle — never
silently skipped.

**Whatever the outcome** — full success, partial (e.g. discovery works but commands don't), or
complete failure — share the whole bundle back, not a summary like "it didn't work." The
`failureAnalysis` field in the "after" snapshot already names the exact failing stage with
Reason/Evidence/Suggested Fix if something's wrong (see `docs/architecture/
Casambi-Final-Hardware-Validation-Report.md` §5 for the guide), so a follow-up session can act on
it directly rather than re-deriving it from raw logs.

**Turn it into a permanent regression test:** whatever raw payload the bundle's Transport Monitor
snapshot or a `driver.recentJourney`/`recentTraces` entry shows, save it as a new capture under
`tests/regression/casambi/` (see that directory's own `README.md` for the exact categories —
`living-room/`, `kitchen/`, `office/`, `button-events/`, `sensor-events/`, `dimming/`, `scenes/`
— and the Live Capture API for recording it directly from a real session instead of hand-typing
hex). From then on, this exact real-world scenario is a permanent, hardware-free regression test
in CI, and a fix for it stays fixed.

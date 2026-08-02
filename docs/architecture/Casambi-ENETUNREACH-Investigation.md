# Casambi Local Gateway — `ENETUNREACH` Investigation & Root Cause

> Reported symptom:
> ```
> Packets Sent: 0
> Packets Received: 0
> Last Error: supreme-lan: send failed — send ENETUNREACH 192.168.0.45:10009
> ```
>
> **Verdict: DEPLOYMENT defect (Docker networking). Not a Casambi protocol defect, not a gateway
> defect, not a Windows-specific limitation.** Reproduced experimentally on a real Docker Engine
> and fixed; the fix is verified by the same experiment. No Casambi protocol code (UDP codec,
> Discovery Engine, Entity Mapper, Event Engine) was touched.

## 1. Where the error actually comes from — traced through real code

The string is assembled in `services/lan/src/client/nats-udp-transport-client.ts` from a failure
the **server** reported back:

```
CasambiUdpEngine.send()
  → NatsUdpTransportClient.send()            (Gateway process)
  → NATS request/reply "supreme.lan.udp.send"
  → UdpTransportServer.handleSend()          (supreme-lan process)
  → DgramUdpSession.send()
  → node:dgram socket.send(...)  →  OS returns ENETUNREACH
```

Two facts follow directly, without inference:

- **The error is real and OS-level.** `DgramUdpSession.send()` only rejects from `dgram`'s own
  send callback (`services/lan/src/server/dgram-udp-session.ts`). `ENETUNREACH` is the kernel
  saying *"no route to that network"* — the datagram never reached the wire.
- **It happened inside the `supreme-lan` process's own network namespace**, not the Gateway's.
  Whatever routing is wrong, it is wrong for the `lan` container specifically.

`Packets Sent: 0` corroborates this exactly: `DgramUdpSession` increments `_packetsSent` only
*after* a successful send, so a rejected send correctly leaves the counter at zero.

## 2. Root cause — reproduced, not assumed

`infra/hub-compose/docker-compose.yml` attached the `lan` service to **`supreme-core` only**, and
`supreme-core` is declared:

```yaml
supreme-core:
  driver: bridge
  internal: true # no outbound/inbound to host — pure internal plane
```

A Docker network with `internal: true` deliberately gets **no default route and no NAT**. A
container whose *only* network is internal therefore cannot reach any off-subnet address — the
kernel rejects the send with `ENETUNREACH` before a packet leaves the process. `192.168.0.45` is
off-subnet from the container's `172.x` bridge address, so the failure is deterministic, not
intermittent.

**Experiment run on a real Docker Engine** (identical image, identical code, identical target;
the *only* variable changed was the network's `internal` flag):

| Network | Result |
|---|---|
| `internal: true` (mirrors `supreme-core`) | `SEND FAILED: send ENETUNREACH 192.168.0.45:10009` |
| normal bridge | `SEND OK (no OS-level error)` |

The failing output is byte-identical to the reported symptom. That is the root cause, isolated to
a single variable.

## 3. Deployment vs. ADR 0022 — the mismatch

| ADR 0022 says | What was actually deployed | Match? |
|---|---|---|
| `supreme-lan` owns raw LAN sockets and must have **real LAN access**; the Gateway stays bridge-attached | `lan` was attached only to an `internal: true` network — no LAN access of any kind, not even unicast egress | **No** |
| Base compose is a "deliberately degraded" bridge mode: testable everywhere, **no broadcast reception** | Reality was strictly worse: no broadcast reception **and** no ability to transmit anything at all | **No** |
| Production (Linux) layers `docker-compose.lan-host.yml` + `docker-compose.nats-loopback.yml` for `network_mode: host` | Unchanged and still correct — that overlay was never the problem | Yes |

The documented *intent* was always right. The base compose simply didn't implement it: the
degraded default was described as "can send, just can't receive broadcast," but was in fact
"cannot use the network at all." That gap is what produced `ENETUNREACH`.

## 4. The fix — and its verification

`lan` now joins a second, **non-internal** network that only it uses:

```yaml
lan:
  networks:
    - supreme-core        # unchanged: NATS, internal plane
    - supreme-lan-egress  # NEW: gives this one service a default route

networks:
  supreme-lan-egress:
    driver: bridge        # deliberately NOT internal — that is the entire point
```

Every other service keeps its exact prior `supreme-core` isolation; nothing else changed.

**Verified by booting the real stack** (real `lan.Dockerfile` image, real `nats` container, real
wire protocol over real NATS):

- Container now has two interfaces and, critically, **a default route** (`eth1` → `172.19.0.1`)
  where previously there was none.
- The identical send that produced the reported error now returns:
  ```json
  { "ok": true }
  ```
  …from a real `supreme.lan.udp.send` request to `192.168.0.45:10009` through the real
  `UdpTransportServer`.

### What this fix does and does not achieve — stated precisely

- **Fixed:** `supreme-lan` can now transmit UDP to LAN devices and receive unicast replies. The
  `ENETUNREACH` class of failure is gone in the default deployment.
- **Still requires host networking:** receiving LAN **broadcast/multicast** (the Casambi gateway's
  `NotifyControlValues` broadcasts to `255.255.255.255:10009`). Docker bridge does not deliver
  broadcast into containers — that is the original, unchanged reason `supreme-lan` exists. For a
  real installation, still deploy with:
  ```bash
  docker compose -f docker-compose.yml \
    -f docker-compose.nats-loopback.yml \
    -f docker-compose.lan-host.yml up -d
  ```

## 5. Windows Docker Desktop — assessed, not assumed

The reported error does **not** require a Windows explanation: it is fully accounted for by the
`internal: true` misconfiguration, which is platform-independent and was reproduced on Linux.

Separately, and still true (unchanged from prior sessions): Docker Desktop for Windows/macOS does
not implement `network_mode: host` for Linux containers, so the host-networking overlay is a no-op
there. If you are on Windows, run `supreme-lan` as a native process against the loopback-exposed
NATS instead. The new routing diagnosis surfaces this explicitly when it detects
`platform=win32` together with a configured `host` mode — it does not guess the platform.

**Not verified here:** which platform your installation actually runs on. This sandbox is
Linux-only. The diagnostics below now report the real platform at runtime so no one has to guess.

## 6. Improved diagnostics

`services/lan/src/server/routing-diagnosis.ts` (new) turns a bare errno into a layered verdict,
computed **inside `supreme-lan`'s own network namespace** — the only place that can honestly
answer "is there even a route?":

| Field | Source |
|---|---|
| `verdict` | `ok` / `no_route` / `host_unreachable` / `permission_denied` / `unknown_error`, from the real errno |
| `interfaces` | Real `os.networkInterfaces()` IPv4 list, with CIDRs |
| `outboundInterface` | The interface whose subnet actually contains the destination — real CIDR mask arithmetic, `null` when none does (itself the key `ENETUNREACH` finding) |
| `platform` | Real `os.platform()` |
| `configuredNetworkMode` | `SUPREME_LAN_NETWORK_MODE` — explicitly configured, never self-detected (a host-networked container is not reliably distinguishable from the inside) |
| `explanation` / `suggestedFix` | Plain language + a concrete next action, never "check the logs" |

It is attached to the failed-send wire response (`LanSendResponse.diagnosis`), surfaced on
`NatsUdpTransportClient.lastSendDiagnosis`, and mirrored by a snapshot-level classifier in
`services/protocols/src/casambi/failure-analysis.ts` so the Transport Monitor names the failing
layer:

- `ENETUNREACH` → **deployment/routing** failure (checked *before* the "zero packets received"
  branch, so a rejected send is never misreported as a broadcast-reception problem)
- `EHOSTUNREACH` → **gateway/addressing** issue (route exists; device didn't answer)
- `EACCES`/`EPERM` → **permission / missing SO_BROADCAST**
- anything else → honestly `unknown_error`, with no invented cause

## 7. Device discovery — unchanged and still automatic

No Casambi protocol code was modified. Device discovery works exactly as before: once UDP traffic
flows, `local-discovery.ts`'s `updateUnitFromControlValues` builds real units from incoming
`NotifyControlValues` (opcode `0x4B`) notifications, and entities appear with no manual creation.
It is *progressive* (a unit appears as its first notification arrives, since the Local protocol
has no device-listing endpoint to enumerate from) — that is a documented protocol property, not a
limitation of this implementation.

The UI now states the two discovery mechanisms separately, because conflating them was the actual
UX defect:

- **Automatic Gateway Discovery — Not available.** No discovery API is defined anywhere in the
  Lithernet documentation (no REST enumeration endpoint, no SSDP/mDNS profile). The IP is entered
  manually. Implementing a speculative scan would be fabricating a protocol the vendor never
  defined.
- **Automatic Device Discovery — Enabled.** Devices are discovered automatically from incoming UDP
  notifications; no manual device creation is required.

The Diagnostics page additionally shows live discovery state, and when no packets have arrived yet
says *"Waiting for first UDP notification — device discovery will begin automatically after the
first Casambi event is received,"* explicitly framing that as a normal pre-traffic state rather
than an unsupported feature.

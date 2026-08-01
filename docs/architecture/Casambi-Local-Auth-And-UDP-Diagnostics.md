# Casambi Local Gateway — Auth & UDP Diagnostics Refinement

> Follow-on to `Casambi-Local-Gateway-Protocol.md` and `Casambi-Architecture-Audit.md`. Scope: Local
> REST authentication, honest UDP diagnostics, and mode-aware config validation. **Cloud mode was
> not touched — every Cloud test in `casambi-driver.test.ts` passed unmodified.** No hardware was
> available for this session; every claim below is either a code fact (verified by reading the
> actual implementation) or a documentation fact (cited to a specific Lithernet PDF page), never an
> inference presented as verified behavior.

## 1. Why UDP was previously reported "Unreachable"

The bug report: the Lithernet Gateway's own web UI shows `UDP Listening on IP: 192.168.0.45 / Port:
10009`, which the installer reasonably reads as "the gateway is operational" — yet SupremeOS's Test
Connection reported `UDP: Unreachable`. Answering the six audit questions the brief posed, against
the actual pre-existing code (`local-transport/udp-engine.ts` before this session, `routes/
installer.ts`'s `/v1/commissioning/casambi/test-connection` before this session):

1. **What did "UDP Reachable" mean?** `CasambiUdpEngine.probe()` sent one UDP datagram (opcode
   0x39 Node Status, `Request=0xFF` "own node") and resolved `true` only if a 0x39/0x3A reply
   arrived within a timeout (2s in the route), `false` otherwise — including on a plain timeout.
2. **Was Test Connection expecting an application-layer response?** Yes. The entire reachability
   signal was gated on one specific request/reply exchange completing — a request/response
   expectation layered on top of a protocol that doesn't guarantee any reply to anything.
3. **Which documented packet was sent?** Opcode `0x39` ("Node Status"), the one request value
   documented as safe (queries the gateway itself, never a real device/group/scene) —
   `Lithernet_UDP_Developer_Reference.pdf` §5.10, p.300 for the opcode table, p.314+ for
   Subscribe/Notify semantics.
4. **Does the documentation guarantee a reply?** No — and there is a concrete, disclosed reason it
   might not: 0x39 Node Status is documented only as "available with Evolution firmware," with no
   Classic-firmware fallback described. A Classic-firmware gateway can be fully operational and
   correctly configured and still never answer this specific probe. NotifyControlValues/
   NotifyButtonEvent similarly require Evolution firmware ≥37.90/≥39.50 respectively — real,
   version-gated behavior, not a hypothetical.
5. **Was the implementation treating UDP like a connection-oriented protocol?** Yes. Collapsing
   "no reply to one specific probe within 2 seconds" into `udp: false` / "Unreachable" is exactly
   the TCP-shaped assumption the brief called out: it conflates one application-layer round-trip's
   outcome with the actual, verifiable state of the transport (is the socket even created? bound?
   did the send itself succeed?).
6. **What was the socket actually doing?** The engine bound a real `dgram` socket correctly (this
   part was always genuine — `socket.bind()`, `"listening"` event, `send()` to `gatewayIp:udpPort`).
   The route already tore this real, working socket down and reported it as failed because ONE
   probe reply hadn't arrived in ONE two-second window.

**The gateway's own "UDP Listening on IP:Port" string** (`Lithernet_General_Settings_Network.pdf`
p.72, §4.3.1.6, Control System Wizard screenshot) is the gateway's own one-sided self-report that
its own socket is bound — it says nothing about whether any particular external client (SupremeOS)
has sent it anything, received anything from it, or is even pointed at the right Net ID/port. The
two messages were never contradictory: the gateway telling the truth about its own socket, and
SupremeOS's old probe-timeout logic wrongly treating "no reply yet" as failure, are two different
(and both accurate, in their own scope) statements.

## 2. Architectural changes

The Connection Manager → Transport → Service → Command/Event/Discovery Engine hierarchy from the
prior audit is preserved unmerged. Changes are additive, layer-respecting:

- **UDP Service** (`local-transport/udp-engine.ts`): now exposes real, non-fabricated instrumentation
  — `socketState` (`"closed" | "bound" | "error"`, derived only from real bind/error events, never
  from "no reply"), `localAddress`/`localPort` (from `dgram.Socket.address()`), `packetsSent`/
  `packetsReceived`, `lastPacketAt`, `lastSendError`, `lastDecodeError`, `averageLatencyMs` (probe
  round-trips only). No `packetLoss` getter exists — see §6.
- **REST Service** (`local-transport/rest-client.ts`): Basic Auth support (`gatewayUsername`/
  `gatewayPassword`), `testConnection()` returns a structured `{ reachable, httpStatus, authFailed }`
  instead of a boolean, `setTargetValue()` can now return `"unauthorized"`.
- **Health Monitor** (`health-monitor.ts`): new `udpStage()` — a pure function producing
  `"not_configured" | "socket_error" | "bound_waiting" | "active"`. `"socket_error"` requires a real
  socket error; `"bound_waiting"` (bound, zero packets yet) is a normal, healthy state, never
  reported as a failure.
- **Diagnostics** (`diagnostics.ts`): `CasambiDiagnosticsSnapshot.udp` (new, additive field, `null`
  for Cloud) surfaces the above staged detail continuously, not just during Test Connection.
- **Local Transport** (`local-gateway-transport.ts`) and **Connection Manager**
  (`connection-manager.ts`, unchanged): thread `gatewayUsername`/`gatewayPassword` through
  unchanged otherwise.
- **Config validation** (`services/drivers/src/config.ts`): new `requiredIf` concept on
  `DriverConfigField` (domain-model), consumed by `validateDriverConfig`/`isConfigComplete`. This
  is a generic, driver-agnostic mechanism — not a Casambi special case — so any future driver with
  mutually exclusive modes gets the same correct behavior for free.

No file in `cloud-transport.ts`, the Cloud branch of `connection-manager.ts`, or the Cloud paths of
`casambi-driver.ts` was modified.

## 3. Authentication changes (Part 1)

**Root cause confirmed:** `Lithernet_General_Settings_Network.pdf` p.64 (§4.2.2 "Web server"):
*"Username and password... Only one user account can be set up. This account has full access to
all system functions."* The same section's screenshot shows a native browser credential dialog
(not a custom HTML form) guarding `/reset_full_flash` (p.109) — i.e. direct HTTP endpoints require
this login "if you are not already logged in," exactly as the brief stated.

**What was implemented:**
- New, independent config fields `gatewayUsername`/`gatewayPassword` (manifest + domain model +
  factory + UI) — never aliased to or sharing storage with Cloud's `apiKey`/`email`/`password`.
- `CasambiLocalRestClient` now sends `Authorization: Basic base64(username:password)` on every
  request (`testConnection()` and `setTargetValue()`), built fresh per request from the configured
  Gateway Username/Password. Omitted entirely (no header at all) when no credentials are
  configured, so a gateway with no login enabled still gets a clean, unmodified request.
- `testConnection()`'s new `authFailed` field distinguishes "gateway rejected these credentials"
  (401/403) from "gateway is unreachable" (network-level failure) — previously indistinguishable.
- **Validation now branches strictly on `connectionType`** via the new `requiredIf` schema field:
  Cloud's `apiKey`/`email`/`password` are `requiredIf: { key: "connectionType", equals: "cloud" }`;
  Local's `gatewayIp`/`restPort`/`gatewayUsername`/`gatewayPassword`/`udpPort` are `requiredIf:
  { key: "connectionType", equals: "local" }`. This closes a **real, confirmed bug**: the previous
  generic `validateDriverConfig` iterated the full schema unconditionally, so a `required: true`
  Cloud field (e.g. `email`) would block saving a valid Local Gateway config, and vice versa — the
  bug existed independently of anything about UDP, and was caught by reading `services/drivers/
  src/config.ts` directly rather than assumed.

**Disclosed, not verified:** the manuals show the native-browser-prompt *behavior* of the gateway's
login but never name the wire scheme explicitly. HTTP Basic Authentication is the standard
mechanism that produces exactly that prompt and was chosen as the informed default — this is a
disclosed design decision, not a literally-quoted protocol fact. If the gateway actually expects
HTTP Digest instead, the current implementation would need a follow-up change (real hardware
verification would resolve this either way — not available in this session). The documented
MAC-address-as-credentials fallback login (p.109: username/password = the device's own MAC, e.g.
`4C:75:25:5C:E1:E7`) is not implemented — SupremeOS never guesses a gateway's MAC address.

## 4. Updated diagnostics (Part 2)

**Test Connection** (`POST /v1/commissioning/casambi/test-connection`) now returns staged, honest
results instead of a single `reachable` boolean:

```json
{
  "implemented": true,
  "rest": { "reachable": true, "httpStatus": 200, "authFailed": false },
  "udp": {
    "socketCreated": true,
    "socketBound": true,
    "packetSent": true,
    "localAddress": "192.168.1.42",
    "localPort": 5100,
    "remoteAddress": "192.168.1.90",
    "remotePort": 5100,
    "notificationReceived": false,
    "packetsReceived": 0,
    "averageLatencyMs": null,
    "lastError": null
  },
  "message": "REST reachable. UDP socket bound and listening — waiting for the gateway's first notification. This is normal for a connectionless protocol and does not by itself mean the gateway is unreachable."
}
```

UDP is only ever reported as failed when `socketBound` or `packetSent` is `false` — both require a
real OS-level error (bind failure, send failure), never a mere absence of a reply. The Driver
Manager's "Lithernet Gateway" panel renders this as the staged report the brief specified: REST /
HTTP Authentication / Gateway / UDP / Port / Gateway Configuration / Status / Packets Received /
Last Packet / Latency.

**Ongoing Diagnostics page** (`GET /v1/drivers/:id/casambi/diagnostics`) gained an additive `udp`
field (Local mode only, `null` for Cloud) with the same real instrumentation, live from the running
driver's actual `CasambiUdpEngine`: `stage`, `socketState`, `localAddress`/`localPort`,
`remoteAddress`/`remotePort`, `packetsSent`/`packetsReceived`, `lastPacketAt`, `averageLatencyMs`,
`lastSendError`, `lastDecodeError`. This is the field set the brief's "before/after first
notification" mockups describe, sourced from the driver that's actually running rather than a
one-shot ad hoc test instance.

**"Gateway Configuration ✓ Verified"** is disclosed as a *local* check, not a remote one: it means
the entered IP/ports/Net ID/Data Format are well-formed and the outbound test packet was accepted
by the OS network stack — not a gateway-confirmed acknowledgement, which no Lithernet document
describes as existing.

## 5. Test results

All new/changed behavior has direct unit test coverage; the full existing suite (Cloud included)
was re-run, unmodified, and passes:

| Package | Files | Tests | Result |
|---|---|---|---|
| `@supreme/domain-model` | — | — | builds clean (schema addition only) |
| `@supreme/drivers` | 2 | 22 | ✅ all passing (13 new/updated `requiredIf` cases) |
| `@supreme/protocols` | 71 | 690 | ✅ all passing (Casambi: 10 files, 153 tests, including 30+ new for UDP staging + REST auth) |
| `@supreme/gateway` | 71 | 289 | ✅ all passing (`native-driver-factory.test.ts` +2 new) |
| `@supreme/web-homeowner` | 4 | 55 | ✅ all passing (build + typecheck also verified) |

`npx turbo run typecheck build test` across all five packages: **48/48 tasks green.**

New coverage added this session: mode-aware `requiredIf` validation (both branches, both
directions, discriminator-from-existing-config, discriminator-default-fallback); REST Basic Auth
header construction, omission when no credentials, 401/403 handling on both `testConnection()` and
`setTargetValue()`; UDP `socketState` transitions (closed → bound → closed, and the error path on a
real bind failure); real local address/port exposure; packet/send/decode counters and error
capture; probe-derived `averageLatencyMs`; `udpStage()`'s four-way honesty rule; end-to-end driver
diagnostics wiring (`bound_waiting` → `active` transition on a real incoming packet); Cloud-mode
`udp: null` (no fabricated detail for a transport that doesn't exist).

**Not added this session (disclosed gap):** an HTTP-level e2e test for the rewritten
`/v1/commissioning/casambi/test-connection` route itself. The route is thin orchestration over
already-covered primitives (`rest.testConnection()`, `udp.probe()`, the engine's counters), but a
dedicated fastify-level integration test for the route's response shape does not exist yet.

## 6. Remaining documented limitations

- **HTTP auth scheme is a disclosed assumption (Basic), not a confirmed one** — see §3.
- **MAC-address-as-credentials fallback login is not implemented.**
- **SSL/HTTPS to the gateway's own web server is not implemented** — the REST client is
  HTTP-only; `restPort` defaults to 80 with a help-text note that the gateway may use 443 if the
  installer has enabled SSL on it, but SupremeOS does not speak HTTPS to the gateway itself yet.
- **Packet loss is permanently unmeasurable and intentionally never reported** — the documented
  Casambi UDP packet structure (`{length, opcode, args}`) carries no sequence numbers, so there is
  no honest way to distinguish "nothing sent yet" from "something was dropped." No field, getter,
  or UI row claims a loss percentage.
- **`averageLatencyMs` measures probe round-trips only**, never the (unmeasurable, unsolicited)
  notification stream's latency — labeled precisely as "probe round-trip" wherever shown.
- **Firmware gating remains real and undiscoverable in advance:** 0x39 Node Status, Subscribe, and
  NotifyButtonEvent are documented as Evolution-firmware features (≥37.90/≥39.50 for the latter
  two; no minimum version given for 0x39). A Classic-firmware gateway may never reply to the probe
  or emit button events at all — this now correctly surfaces as `bound_waiting` (a real, honest
  "waiting" state) rather than a false "Unreachable," but SupremeOS still cannot detect firmware
  version itself to explain *why* to the installer, since no such query is documented.
- **No hardware verification was performed in this session.** Every behavior above was verified
  either by reading the actual shipped code or by citing a specific Lithernet PDF page; nothing
  here should be read as "tested against a real gateway."

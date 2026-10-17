# KNX IP Secure — Secure Tunnelling Architecture Proposal

2026-10-17 · **Proposal only. No code was changed for this document.** Inputs: the actual files `native/tunnel-client.ts` (601 lines),
`native/knxnetip-frame.ts`, `native/transport.ts`, `native/secure/{ip-session,secure-connection,stream}.ts`, `native/tcp-socket.ts`, and
`knx-secure-blocker-matrix.md` (B1–B9). Evidence classes N/T/I/U are defined there. Everything that depends on a **T** or **U** statement
is marked **BLOCKED** and is *not* to be implemented from this document.

## 1. What exists and what it guarantees

```
 KnxTunnelClient (UDP only)               SecureSessionConnection (verified: vectors + simulator + loopback TCP)
   socketFactory: KnxDatagramSocket         streamFactory: KnxStreamSocket (node:net, tcp-socket.ts)
   NAT_HPAI (UDP route-back) everywhere     KnxStreamDeframer (header-driven, 8 KiB cap)
   ACK/retry/heartbeat = UDP rules          SecureSessionClient: handshake → authenticated → sendInner / onInner
                                            (plain frames never processed; D1 server auth mandatory; D5/D6)
```

`SecureSessionConnection.sendInner(frame)` / `onInner(fn)` is the verified pipe: it wraps/unwraps whole KNXnet/IP frames (IPS §2.2.1.3,
§2.4.1) and enforces session/TCP lifetime coupling (IPS §2.4.2). Nothing above it exists. `KnxTunnelClient` cannot be placed on it unchanged
(§2). The production registration, `knxultimate`, flags, `policy.ts` (`assertPolicySatisfiable` still rejects any secure policy) are untouched.

## 2. Gap analysis: what must change, per concern

| Concern | Current behaviour (file) | Required for secure tunnelling | Evidence for the requirement | Status |
|---|---|---|---|---|
| **Transport** | `tunnel-client.ts` constructs a `KnxDatagramSocket` via `SocketFactory`, filters datagrams by source IPv4 (`foreignDatagrams`), and owns its socket lifetime | Replace the socket with a *link*: send(frame) / onFrame(frame) / close, delivering **whole, already-unwrapped** inner frames. Source filtering and socket ownership move into the UDP link; the secure link is `SecureSessionConnection` (+ `onClosed` ⇒ tunnel closed, IPS §2.4.2). The tunnel must never open a socket itself in secure mode | N: IPS §2.4.1 (all connection traffic wrapped), §2.4.2 | Design clear; **refactor allowed** but see §4 (not done) |
| **Addressing (HPAI)** | `NAT_HPAI` = UDP route-back (01h) in CONNECT/CONNECTIONSTATE/DISCONNECT; `decodeHpai` throws on any non-UDP HPAI; response endpoint (`target`) logic is UDP route-back | TCP route-back HPAI (02h 0.0.0.0:0) in CONNECT_REQUEST (control + data), CONNECTIONSTATE, DISCONNECT; decoding that accepts TCP HPAI; **no `target` rewriting** (the peer is the session) | HPAI in SESSION_REQUEST: N. HPAI for tunnel frames over TCP: **T only** (TSSK 2.5.21: UDP HPAI over TCP is silently ignored) | **BLOCKED B3** |
| **ACK handling** | One outstanding frame; ACK wait; ACK error status ⇒ repeat/terminate; every received TUNNELLING_REQUEST is ACKed; sequence rules `rx == expected / expected−1 / else` | Stream mode: **send no TUNNELLING_ACK**; **ignore received TUNNELLING_ACK**; do not evaluate the receive sequence counter; sender may use 0. Same for TUNNELLING_FEATURE_* (no ACK on TCP) | **N:** TUN §2.6.2, §3.1 | Rule is N. Unblocked **in the simulator**, but meaningless without the link/HPAI shell |
| **Retries** | `maxSendAttempts=2`, 1 s ack timeout, then DISCONNECT + `ack_timeout` | No ACK ⇒ nothing to retry and no ack timeout. A send "succeeds" when the frame is handed to the verified pipe (`sendInner` throws/closes on failure). Delivery to the bus is still observable only through `L_Data.con` (existing `confirmation` promise) | N (consequence of no ACK) | Semantics change to the public `SendReceipt` (see §3) |
| **Heartbeat / liveness** | CONNECTIONSTATE every 60 s, 10 s response, 3 tries ⇒ `heartbeat_lost` | Two independent liveness layers: (a) *secure session* — SESSION_STATUS(KEEPALIVE) before the 60 s session timeout (N, already implemented and scheduled automatically in `ip-session` — 30 s interval, re-armed after each send; the tunnel adds nothing here), (b) *KNX connection* — whatever Core v2 prescribes on TCP | (a) N IPS §2.2.3.5.2. (b) **T only**: server closes TCP after `TimeoutKnxConnection` 120 s idle (2.5.13) but what resets it is unknown | (a) buildable; (b) **BLOCKED B4** |
| **Teardown** | `disconnect()` sends DISCONNECT_REQUEST, waits 5 s for the response, closes the UDP socket; `terminate()` after ack failure | Order to be confirmed: DISCONNECT_REQUEST (+response) inside the wrapper → SESSION_STATUS(CLOSE) → TCP FIN. Any session end must fail pending sends with a typed `closed`/`session_*` error and never leave a tunnel slot open on the server | N for session↔TCP coupling (IPS §2.4.2). Whether DISCONNECT is required/confirmed on TCP: **U** | **BLOCKED B5** |
| **Errors / status** | `describeStatus` UDP-era table; `E_CONNECTION_ID` handling | A new close reason family `secure_*` mapping `SessionClosedEvent.reason` (already typed) to `TunnelErrorCode`; status text for CONNECT_RESPONSE errors (E_AUTHORISATION_ERROR, E_NO_TUNNELLING_ADDRESS, …) | numeric values **U** (Overview) | **BLOCKED B1/B5** |
| **Connection request body** | Basic 4-octet CRI (layer) | Extended CRI to request a specific tunnelling address for the user (TUN §5.4.3.2); needed when the interface has several tunnels bound to users | N: TUN §5.4.3.2–3, IPS §2.3.1.8 | Not started (gap G5); readable, **not secure-specific** |
| **Policy / flags** | `assertPolicySatisfiable` refuses secure policies; secure flag off | Stays refusing until the final wiring step; separate secure sub-flag from `SUPREME_KNX_NATIVE` | D | unchanged |
| **Security properties to preserve** | n/a | No plaintext fallback (no code path writes outside the wrapper); one ECDH pair per session; server auth mandatory (D1); reflection/fault guards (D5/D6); credentials never logged | review F1–F9 | must hold by construction |

## 3. Proposed structure (to be built only after the gates in §4)

1. **`TunnelLink` seam (protocol-neutral).**
   `interface TunnelLink { send(frame: Buffer): void; onFrame(fn): off; onClosed(fn): off; close(kind: "graceful"|"abort"): void; readonly kind: "datagram" | "secure-stream" }`.
   * `DatagramTunnelLink` = today's socket + source filter + `target` route-back logic, moved verbatim (behaviour-preserving; the existing
     `tunnel-client.test.ts` is the characterisation suite and must stay green unchanged).
   * `SecureStreamTunnelLink` = thin adapter over `SecureSessionConnection` (`sendInner`/`onInner`/`whenClosed`), plus a connection-level
     liveness hook for B4 (session KEEPALIVE is already automatic inside `SecureSessionClient`).
2. **`TunnelRules` strategy** (the only place TCP-specific wire behaviour lives):
   `datagram` rules (current code) vs `stream` rules. Each stream-rule field is declared as `{ value, source: "N:<clause>" } | { status: "UNVERIFIED:<blocker id>" }`.
   Construction of a stream-mode client **against a real transport** throws while any field is `UNVERIFIED`; the simulator may opt in with an
   explicit `allowUnverified: "simulator-only"` marker. This makes the blocker list executable: a blocker cannot be bypassed by forgetting it.
3. **Public API.** `connect()/sendGroup()/onTelegram()/disconnect()/diagnostics()` unchanged. `SendReceipt` gains an explicit
   `transportAck: "ack" | "none"`; in stream mode `ackedAt`/`ackLatencyMs` are `null`-typed variants (a discriminated union, so callers cannot read a
   fabricated latency). Diagnostics add `link: "datagram" | "secure-stream"` and the session counters already exposed by `SecureSessionConnection.diagnostics()`.
4. **Frame codec generalisation (B3).** `Hpai` already carries `protocol`; `decodeHpai` must accept 02h only when the *link kind* is
   stream, and 01h only for datagram, so a mixed HPAI is a typed error rather than a silent accept. Encoding uses a `routeBackHpai(linkKind)` helper.
5. **Ownership/teardown.** The link owns the transport; the tunnel client owns timers for sends/confirmations/heartbeat; one `shutdown()` path
   (already single-exit in `tunnel-client.ts`) closes the link last. Every pending send/confirmation settles on link close (existing `failPending`).

## 4. Gates and staging (nothing past T0 is started)

| Stage | Content | Gate | Allowed in this milestone? |
|---|---|---|---|
| T0 | This proposal + blocker matrix | – | **done** |
| T1 | `TunnelLink` extraction, UDP behaviour unchanged (characterisation tests only; no secure code) | none technically | **DONE 2026-10-17** (`tunnel-link.ts`, commit `d1cff88`; see §7) |
| T2 | Stream rules limited to the **N** subset (no ACK, ignore ACK, ignore rx seq, send seq 0/counter) in the simulator | T1 | no |
| T3 | TCP HPAI codec, CONNECTIONSTATE/DISCONNECT over TCP, status table, teardown order | **Core v2 + Overview** (B1,B3,B4,B5) | blocked |
| T4 | Secure gateway simulator extended with tunnelling (CONNECT → TUNNELLING_REQUEST/L_Data.con → DISCONNECT), then loopback TCP | T2, T3 | blocked |
| T5 | Driver adapter behind a **separate** secure sub-flag; `policy.ts` accepts secure only here | T4 + keyring (KR-*) + serial-number rule (B9) | blocked |
| T6 | Hardware interop (§6 of this document) | T5 + bench | blocked |

Required new tests when T2+ is built (mutation-checked in the style of the existing suites): no ACK ever written in stream mode (assert on the
wire); a received ACK changes no state; rx sequence not evaluated (send 42,42,42; deliver all); TCP-HPAI mismatch ⇒ typed error; secure close
mid-send settles every promise exactly once; session close ⇒ tunnel closed ⇒ no further writes; KEEPALIVE keeps the session alive while a tunnel is idle (manual clock);
100 connect/teardown cycles leak no timer/socket; a rejected UNVERIFIED rule set cannot reach a real stream factory.

## 5. Risks that remain even after the spec gaps close

* The simulated gateway is self-authored: it can only confirm internal consistency (the same author wrote both peers).
* Tunnel-slot exhaustion on real interfaces (commonly few slots): a leaked connection starves the installation until the server's timeout.
  Teardown correctness (B5) is therefore a field-safety issue, not cosmetic.
* Secrets: passwords/DAC/FDSK arrive only through `Secret`; the keyring (KR-*) is not yet parsable.
* Counter exhaustion and renewal: a new session needs a new instance; the supervisor must apply back-off to avoid hammering a device that
  counts failed authentications (B6/B7).

## 6. Hardware-validation requirements (cannot be replaced by anything in this repo)

1. A KNX IP Secure interface/router with known Device Authentication Code (or FDSK from the label) and known tunnelling-user password; a second, **non-secure** interface for the classic regression.
2. An ETS project/keyring generated by a licensed ETS (format document absent) and a closed lab network.
3. Packet capture on the lab segment (secrets scrubbed; captures never committed) to confirm: TCP route-back HPAI acceptance, absence of
   ACKs in both directions, KEEPALIVE/CONNECTIONSTATE cadence, behaviour on pre-authentication close (B7), wrong password, non-zero `reflected`
   counter (must stay 0), tunnel-slot release on teardown.
4. Cases to run: valid session; wrong password; wrong DAC; session timeout; unplug/replug; power-cycle the interface (new key ⇒ new session);
   two clients competing for slots; 24 h soak; interface firmware variants.
5. A rollback runbook (secure flag off ⇒ legacy `knxultimate` path, no data migration).
6. Written KNX answers for B6, B7, B9 and the AN183 applicability statement.

## 7. T1 as built (2026-10-17)

* `native/tunnel-link.ts`: `TunnelLink` { `kind: "datagram"`, `open(handlers)`, `send(frame)`, `routeBack(announced?)`, `close()` } and `UdpTunnelLink`,
  which holds exactly what used to live in `tunnel-client.ts`: the socket, the source-address filter, the gateway endpoint used for the first
  CONNECT_REQUEST, and the route-back rule (announced data endpoint used only if concrete and on the gateway's own address, otherwise the address/port
  the CONNECT_RESPONSE came from). The doc's earlier sketch (`onFrame`/`onClosed`, `close(kind)`) was reduced to what the existing behaviour needs;
  `onClosed`/graceful-abort are not needed until a stream link exists (YAGNI).
* `KnxTunnelClient` takes `socketFactory` (unchanged, now optional) **or** `link`; with `socketFactory` it builds a `UdpTunnelLink`. Everything else
  — encoding, `NAT_HPAI`, ACK/retry, heartbeat, sequence handling, teardown, diagnostics — is unchanged. `kind` admits only `"datagram"`, so a stream link
  cannot be injected by type; stream rules (T2) are not implemented and `SecureSessionConnection` is not connected.
* Evidence of preservation: golden wire traces (time, destination, bytes) recorded **before** the change (`3dc6c31`) and unchanged after; the pre-existing
  37 tunnel-client tests and 27 udp/tcp tests unmodified; five mutations of the link/client each failed named tests (route-back address check, foreign
  filter, ignored target, missing close, foreign counting after close).
* Not covered by any of this: real gateways. The classic UDP behaviour has never been run against hardware in this repository.

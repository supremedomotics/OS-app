# Native Tunnelling Client — Audit Against the Verified KNXnet/IP Specifications

Audited: `services/protocols/src/knx/native/{tunnel-client,knxnetip-frame,cemi}.ts` (as of commit `1b73a13`+, before any change in this
session). Against: **Tunnelling v01.07.01 AS** (integrates Core v2 / Tunnelling v2; read in full) and **KNX IP Secure v01.01.02 AS**
(read in full). Reported *before* modifying protocol code, per instruction. Production (`KnxProtocolDriver` / `knxultimate`) is not
involved and unchanged. Verdicts: ✅ matches the text · ❌ gap vs the text · ❓ cannot be audited (governing document absent).

## A. Requirements verified against the text

| # | Requirement (Tunnelling v01.07.01 unless noted) | Native client | Verdict |
|---|---|---|---|
| T1 | §5.4.1 service types 0420h TUNNELLING_REQUEST, 0421h TUNNELLING_ACK (v1); 0422h–0425h FEATURE_GET/RESPONSE/SET/INFO (v2) | 0420h/0421h implemented; 0422h–0425h unknown → counted `malformed.unknown_service` | ✅ v1 / ❌ v2 services absent |
| T2 | §5.4.2 TUNNEL_CONNECTION = 04h; §5.4.3 Table 10 layers 02h link, 04h raw, 80h busmonitor | same constants | ✅ |
| T3 | §5.4.3.1 Basic CRI = 4 octets (04h,04h,layer,reserved); §5.4.3.2 Extended CRI = 6 octets adding the requested IA | Basic CRI only | ✅ basic / ❌ **no Extended CRI** (cannot request a tunnelling address; needed for secure tunnels with per-user addresses, IP Secure §2.3.1.8) |
| T4 | §5.4.4 CRD = 4 octets carrying the assigned IA | decoded; `assignedAddress` exposed | ✅ |
| T5 | §5.4.5/§5.4.7 connection header 4 octets; ACK = header with status | enforced `=4` | ✅ — but **see erratum E1** |
| T6 | §2.6.1 (UDP) request not ACKed within **1 s** → repeat **once** with same sequence | `ackTimeoutMs=1000`, `maxSendAttempts=2`, same seq | ✅ |
| T7 | §2.6.1: if still no ACK, **or the ACK status signals any error**, "repeat once and then **terminate the connection by sending a DISCONNECT_REQUEST** to the other device's control endpoint" | after the 2nd timeout: `shutdown("ack_timeout")` closes the local socket **without sending DISCONNECT_REQUEST**; an ACK with an error status other than 0x26/0x27 closes immediately **without repeating and without DISCONNECT_REQUEST**; 0x26/0x27 only fails that one frame and keeps the tunnel | ❌ **G1**: a server is left holding a half-dead channel until its own heartbeat timeout; ❌ **G2**: error-ACK handling deviates (no repeat; selectively tolerated) |
| T8 | §2.6.1 inbound (server **and** client): expected seq → ACK + process; seq = expected−1 → ACK + discard; otherwise no reply, discard | exactly that (`rxSeq`, duplicate re-ACK, out-of-order ignored) | ✅ |
| T9 | §2.6.2 inside TCP: sequence counter **not evaluated**, **no TUNNELLING_ACK sent**, received ACKs ignored | no TCP transport at all | ❌ **G3** (prerequisite for any secure tunnel) |
| T10 | §2.2.2 server fills IA when L_Data.req source = 0000h; otherwise frame sent unchanged | client sends its assigned IA as source | ✅ (permitted) |
| T11 | §2.2.2/§2.5 group telegrams are forwarded to the client; point-to-point only for the tunnel's own IA | client delivers whatever arrives | ✅ |
| T12 | §3 TUNNELLING_FEATURE services; "Interface Feature Info Service Enable" default **Disable** per connection (§3.6.9) | not implemented; default means no INFO frames arrive unsolicited | ❌ **G4** (optional/mandatory status depends on Volume 6 [09] — ❓) |
| T13 | §4.3 handling of E_NO_MORE_UNIQUE_CONNECTIONS (25h) by the client | reported as `connect_rejected` with status 0x25; the ETS-style remediation procedure is a management-client duty, not runtime | ✅ value / n/a procedure |
| T14 | §5.4.3.3.2 server refuses Raw mode when Security Mode is enabled with E_CONNECTION_OPTION | client only requests link layer | ✅ n/a |
| T15 | E_NO_MORE_UNIQUE_CONNECTIONS = **25h**, E_TUNNELLING_LAYER = **29h** (Tunnelling Tables 11, §2.2.2) | 0x25, 0x29 | ✅ |

## B. Requirements that live in documents NOT in the bundle (❓ — cannot be audited)

| Our implementation detail | Where it came from | Status |
|---|---|---|
| CONNECT_REQUEST / CONNECT_RESPONSE structure, CONNECTIONSTATE (heartbeat) and DISCONNECT structures | written from the public KNXnet/IP Core structure as understood earlier | ❓ **Core v2 (3/8/2) absent** |
| Timeouts: connect response 10 s, heartbeat 60 s / response 10 s / 3 attempts, disconnect 5 s | same | ❓ Core absent. *Partial corroboration only:* IP Secure §2.2.3.6.1/§2.2.3.8.1 give 10 s for secure-session responses (a different procedure). |
| Status/error values 0x01, 0x02, 0x04, 0x21–0x24, 0x26, 0x27 | same | ❓ **KNXnet/IP Overview (3/8/1) absent**; 0x25 and 0x29 are now verified. `E_CONNECTION_IN_USE`, `E_AUTHORISATION_ERROR`, `E_NO_TUNNELLING_ADDRESS`, `E_CONNECTION_ID` numeric values are **not in the bundle** (the test spec names them but this audit does not infer values). |
| HPAI structure, host-protocol code UDP=01h | public structure | UDP ✅ not contradicted; **TCP = 02h ✅ confirmed** by IP Secure Annex A.1 ("02h for TCP over IPv4") |
| Discovery (SEARCH / extended search) | `knx-discovery.ts`, not part of `native/` | ❓ Core v2 absent |

## C. Spec errata / ambiguities to resolve on hardware

| ID | Finding |
|---|---|
| E1 | Tunnelling §6.1 Figure 15 prints the connection-header structure length as `06h`; Figures 8 and 16 and both frame lengths imply `04h`. The native decoder rejects anything but `4`. **Capture a real TUNNELLING_REQUEST from a v2 interface to settle it** before relaxing or keeping the strict check. |
| E2 | Tunnelling §2.6.1 requires a client to terminate with DISCONNECT_REQUEST "to the other device's control endpoint"; the native client addresses everything to the CONNECT_RESPONSE source (route-back). Equivalent only if control and data endpoints coincide — unverified on multi-port gateways. |

## D. Gaps summary and plan

| Gap | Severity for production | Plan |
|---|---|---|
| G1 no DISCONNECT_REQUEST after ack failure | medium (resource hold on gateway; tunnels are scarce — 1–4 slots) | **fix in this session**, spec-verified (§2.6.1), tests added |
| G2 error-ACK handling | medium | **fix in this session** (repeat once, then terminate with DISCONNECT_REQUEST for any error status) |
| G3 no TCP | **blocking for IP Secure** | implement stream transport + deframer; TCP-mode tunnelling rules (no ACK, seq ignored) |
| G4 no feature services | low | not started; needs Volume 6 profile to know if required |
| G5 no Extended CRI | medium (secure tunnels with user-bound addresses) | encode/decode support when secure tunnelling is wired; server-side semantics are in the text |
| G6 Core/Overview-derived constants unverified | medium | blocked until Core v2 / Overview are supplied |

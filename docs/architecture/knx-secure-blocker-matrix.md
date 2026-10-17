# KNX IP Secure — Specification Blocker Matrix (secure tunnelling)

2026-10-17 · branch `claude/great-keller-fmenbn` · base `d5b78bf` · **documentation only; no wire behaviour was added or changed.**
Nothing here is hardware evidence. No KNX IP Secure device, no ETS, no conformance tool was available.

Companion documents: `knx-ip-secure-security-review.md` (findings, traceability), `knx-secure-tunnelling-architecture.md` (proposal that
consumes this matrix), `knx-secure-spec-acquisition.md` (what to obtain/ask).

## 0. Evidence classes and rules used here

| Class | Meaning | May drive an implementation? |
|---|---|---|
| **N** | Stated by a supplied normative text actually read (IPS v01.01.02, TUN v01.07.01, AL v02.01.01). | Yes |
| **T** | Described only by the conformance test spec TSSK v1.1 (2018). Server-side ("BDUT") behaviour, written against **older drafts** (Core v2 KSG696-08.01 2017.04, AN184 v01 DP 2016.11, Overview v01.04.02). A test is not a specification. | **No.** A lead to be confirmed in the normative text |
| **I** | A SupremeOS implementation decision (stricter or additional; no spec text). | Only as an explicitly labelled decision |
| **U** | No supplied document states it. | **No** — blocked |

Rule for this milestone: a row's wire behaviour is implemented only when its governing statement is **N**. T-only and U rows stay unimplemented.
Where this matrix says "current code", it was checked by reading the file named.

## 1. Blocker matrix

Columns: **Known** (N/T) · **Unknown** · **Current code** · **Risk of guessing** · **Needed to close**.

### B1 — KNXnet/IP Core v2 and Overview (root blocker)

| | |
|---|---|
| Known | **N:** IPS and TUN cite Core v2 (3/8/2) and Overview (3/8/1) as normative and absent from the bundle. TUN is stated to *integrate* AN184 "KNXnet/IP Core v2" (2020.12.22) and AN185 "Tunnelling v2" (2021.01.05) — so only **TCP-tunnelling rules that TUN itself restates** (TUN §2.6.2, §3.1) are N. **T:** TSSK cites, for the topics below, `KSG696-08.01 Core v2` §2.2.3.2.3 (TCP receive/idle), §2.2.3.2.3.1 (frame synchronisation, receive timeouts), §2.2.3.2.4.1 (sequence counter), §2.2.3.2.5 (HPAI), §2.2.3.2.7/8 (connections per TCP connection / session), §2.2.3.4 (ACK); and `03_08_01 Overview v01.04.02 AS` §5.8 (timeout constants). |
| Unknown | Everything in B3–B5 and B8 below; numeric service-family/DIB codes beyond what IPS prints; all status-code values. |
| Current code | `knxnetip-frame.ts` carries a status table (`StatusCode`/`describeStatus`, commented "Core spec §7.8", e.g. CONNECTION_ID = 0x21); **no supplied document states any of these values**, so they are unverified. |
| Risk | Wrong HPAI/timeouts ⇒ connect timeouts or a gateway silently ignoring requests (see B3). Wrong status values ⇒ mislabelled errors. |
| Needed | Exact titles in `knx-secure-spec-acquisition.md` §A. |

### B2 — AN183 (System Broadcast) applicability

| | |
|---|---|
| Known | **N:** IPS profile table lists "KNX IP System Broadcast" (mandatory for some device classes; IPS §2.5.1.1 profile table, row 6). AL v02.01.01 change table: "AN183 integration **started** 2020.10.26" (completeness unverified). **T:** TSSK §2.4 (IP System Broadcast tests, e.g. 2.4.1–2.4.13) are written "in accordance with AN 183" and concern **server/router** behaviour on the system-setup multicast. |
| Unknown | Whether AN183 imposes **any** obligation on a *tunnelling client* (e.g. a system-broadcast flag in tunnelled cEMI, or a SCF bit semantics). Whether the integration in AL is complete. |
| Current code | None. The native stack does not originate or interpret system-broadcast frames; the Data Secure SCF "system broadcast" bit is not implemented (DS rows are blocked). |
| Risk | Low for group-address control (the only thing the driver does). Real if a tunnelled frame is ever sent with the system-broadcast address type. |
| Needed | Standalone AN183 (current revision) and a written statement of client applicability. **Assumption until then: not applicable to group-value tunnelling; do not emit system-broadcast.** |

### B3 — TCP HPAI / addressing rules

| | |
|---|---|
| Known | **N:** SESSION_REQUEST must carry a *TCP route-back* HPAI (protocol 02h, 0.0.0.0, port 0); other HPAIs or UDP delivery ⇒ the request is rejected (IPS §2.2.3.6.2–4). IPS §2.4.1 / TSSK `GlPro_EstablishTunnellingConnection` use "two route-back HPAIs" in the CONNECT_REQUEST. **T (TSSK 2.5.21/2.5.22):** over TCP, a CONNECT_REQUEST with TCP route-back is accepted; TCP with non-zero port and/or non-zero address, or with a *UDP* HPAI of any kind, is **silently ignored — no error response**; over UDP the TCP route-back is not allowed. |
| Unknown | The normative statement of the above (Core v2 §2.2.3.2.5); which HPAI the server puts in CONNECT_RESPONSE's data endpoint and in DISCONNECT/CONNECTIONSTATE over TCP; whether a client must ignore/validate it. |
| Current code | **Cannot be reused as is.** `NAT_HPAI` is hard-wired to protocol 01h (UDP); `decodeHpai()` throws `unsupported_protocol` for any non-UDP HPAI, so a CONNECT_RESPONSE/DISCONNECT/CONNECTIONSTATE carrying a TCP HPAI would be dropped as malformed; `encodeConnectionStateRequest`/`encodeDisconnectRequest` embed the UDP HPAI. A UDP-HPAI CONNECT over TCP would (per T) be *silently ignored*, appearing only as a 10 s `connect_timeout`. |
| Risk | Silent non-response; or accepting a response whose HPAI we cannot validate. |
| Needed | Core v2 §2.2.3.2.5 + the HPAI structure table; confirmation that TCP route-back is also the response form. |

### B4 — TCP heartbeat / liveness behaviour

| | |
|---|---|
| Known | **N:** secure *session* liveness: server drops a session unused for 60 s; client may send SESSION_STATUS(KEEPALIVE), which is unconfirmed (IPS §2.2.3.5.2, §2.4.1) — implemented. TUN §2.6.2: no ACK/sequence on TCP. **T:** constants `TimeoutKnxConnection` 120 s (idle KNX connection; cites Overview §5.8), `TimeoutKnxConnectionStateResponse` 10 s, `TimeoutIdleTcpConnection` 10 s (a TCP connection with no KNX connection and no secure session, restarted by *any* received octet — TSSK 2.5.17/2.5.18); a server that has an idle KNX connection inside TCP closes the **whole** TCP connection immediately after `TimeoutKnxConnection` (2.5.13); same for an inner secure-session timeout (2.5.14); an incomplete frame is closed by the receive timeout (2.5.7). |
| Unknown | Whether CONNECTIONSTATE_REQUEST remains the keep-alive for a KNX connection inside TCP; **which frames reset `TimeoutKnxConnection`** on TCP (any traffic, or only CONNECTIONSTATE?); client-side receive/idle timeouts; behaviour on a missing CONNECTIONSTATE_RESPONSE (retry count, 3 tries is the UDP rule). |
| Current code | Tunnel client: UDP rules — heartbeat every 60 s, 10 s response timeout, 3 tries ⇒ `heartbeat_lost`; ACK wait 1 s, one retry, then DISCONNECT. Secure connection: no client-side idle watchdog and no receive timeout for partial frames (review F5). |
| Risk | Under-beating ⇒ server closes the TCP connection (possibly mid-command); over-beating is harmless. Inventing a TCP-specific timer set would be unverified protocol. |
| Needed | Core v2 §2.2.3.2.3 / CONNECTIONSTATE procedure for TCP; Overview §5.8 current constants. |

### B5 — E_CONNECTION_ID and disconnect semantics

| | |
|---|---|
| Known | **N:** DISCONNECT_REQUEST and CONNECTIONSTATE_REQUEST return `E_CONNECTION_ID` if the connection id is used outside the associated secure session (plain or other session) (IPS §2.4.1). **N:** session/TCP lifetime coupling — closing the TCP connection ends the session and its KNX connections (IPS §2.4.2); ending SESSION_STATUS values are unconfirmed (IPS §2.2.3.9.2). **T (2.2.34, 2.5.28):** a KNX connection is implicitly closed with its secure session / TCP connection. |
| Unknown | The **numeric value** of `E_CONNECTION_ID` (Overview). Whether on TCP an orderly teardown is DISCONNECT_REQUEST→DISCONNECT_RESPONSE inside the wrapper *and then* STATUS_CLOSE, or either alone; whether the server confirms; whether a client may skip DISCONNECT_REQUEST when closing the session. |
| Current code | `StatusCode.CONNECTION_ID = 0x21` exists (value unverified here); tunnel `disconnect()` is UDP (DISCONNECT_REQUEST + 5 s wait). Secure teardown: STATUS_CLOSE then TCP FIN (N for the close semantics). |
| Risk | A mis-identified status code could be treated as success/failure incorrectly; an incomplete teardown could leave a server tunnel slot occupied until its 120 s timeout (T) — **tunnel slots are scarce** (often 4). |
| Needed | Overview status table; Core v2 DISCONNECT clauses for TCP. |

### B6 — Password encoding

> **Status 2026-10-17 (still BLOCKED for non-ASCII; guard implemented, class I).** `ip-keys.ts` now refuses non-ASCII password text
> (`unsupported_password_encoding`) and, by default, the empty password, *before any key derivation or connection*; no normalisation or
> re-encoding is applied (NFC and NFD forms are both refused). Raw-byte `Secret`s are checked too, so the guard cannot be bypassed. One constant
> (`PASSWORD_ASCII_ONLY`) removes it once KNX confirms the encoding. The empty password stays derivable (`allowEmpty`) because the spec's own
> worked example defines its fixed hash (N). **ASCII acceptance is not an interoperability claim.** Tests: `ip-keys.test.ts` "password input guard".

| | |
|---|---|
| Known | **N:** user password hash = PBKDF2-HMAC-SHA-256(password, salt `user-password.1.secure.ip.knx.org`, 65 536, 128 bit) (IPS §2.3.1.4.1/§2.3.1.4.3); the empty-password hash is fixed; vector (Annex A.3.1) uses ASCII text. **Searched IPS and TSSK for `UTF`, `ASCII`, `character`, `encod` — no statement of the character encoding of the password input.** |
| Unknown | Encoding/normalisation of the password string for non-ASCII input (UTF-8? Latin-1? NFC?); maximum length; how ETS stores it in the keyring (keyring format also absent). |
| Current code | `passwordSecret(text)` encodes **UTF-8** (decision I). For pure ASCII, UTF-8 = ASCII = Latin-1, so the ambiguity affects non-ASCII passwords only. |
| Risk | A non-ASCII password yields a different key ⇒ authentication fails (counted by the server as a failed attempt; **one authenticate per ECDH session, retry needs a new handshake**), which may hit a lock-out/attempt limit if a device has one. |
| Needed | Written KNX confirmation; keyring format (may carry the hash directly). **Recommendation (not applied — behaviour change, needs owner decision):** until confirmed, reject non-ASCII password input with a clear installer-facing message rather than silently authenticating with a guessed encoding. |

### B7 — Pre-authentication close behaviour

> **Status 2026-10-17 — RESOLVED from normative text (N), no wire change.** IPS v01.01.02 §2.2.3.5.2.5 (transition table), column UNAUTHENTICATED:
> **E03** ("valid SECURE_WRAPPER containing SESSION_STATUS with STATUS_CLOSE") → IDLE with **A3** (close contained connections, send SESSION_STATUS
> STATUS_CLOSE, deallocate). So a wrapped STATUS_CLOSE before authentication is a defined, accepted event — the current client behaviour is
> correct. In the same column **E04** (KEEPALIVE) and **E05** (any other frame) → IDLE with **A6** (STATUS_UNAUTHENTICATED), so a client must
> **not** send KEEPALIVE before authentication success (it does not: the keep-alive timer starts only once authenticated). "Valid" requires a
> verifiable MAC, i.e. the session key must already exist: before the SESSION_RESPONSE no wrapper can be built, so the client writes nothing
> and only closes TCP (§2.4.2). The simulator now follows the table (it previously answered UNAUTHENTICATED to an early CLOSE). §2.4.2 words it
> for an "established" session; the table is the more specific clause. Tests: `ip-session.test.ts` "B7 / B8 evidence". Residual question
> (optional): none required.

| | |
|---|---|
| Known | **N:** any frame needing an authenticated session before authentication ⇒ server sends STATUS_UNAUTHENTICATED and disconnects (IPS §2.4.1). 10 s authenticate timeout ⇒ STATUS_TIMEOUT + close; failed authenticate ⇒ STATUS_AUTHENTICATION_FAILED + close (IPS §2.2.3.5.2). Closing the TCP connection always ends the session (IPS §2.4.2). |
| Unknown | Whether a SESSION_STATUS(CLOSE) sent by the client *before* authentication is accepted, ignored or answered UNAUTHENTICATED; whether it is permissible for a client to send any SESSION_STATUS inside a wrapper before success. |
| Current code | Client in `awaiting_status` sends STATUS_CLOSE then FIN (review F6). Harmless in every outcome I can derive (server answers UNAUTHENTICATED/ignores, then TCP closes) but **not verified**. |
| Risk | Low. A wrapper sent pre-authentication could count as an attempt on a device with attempt limiting (U). |
| Needed | KNX confirmation. **Candidate decision (not applied):** before authentication a local close should only close TCP (no frame), which is always legal per IPS §2.4.2. |

### B8 — Frame-size and partial-frame limits

> **Status 2026-10-17 — PARTLY RESOLVED.** IPS §2.2.1.3.2 note: the CCM payload **P = the encapsulated KNXnet/IP frame** is limited by B0 to 65 279
> octets "but as [j] in Ctrj is only one octet, this practically limits the length of the payload to 255×16 = 4 080 octets" (N). The MAC (16)
> and the 22 octets of header + session id + security info are *not* part of P. Arithmetic: outer SECURE_WRAPPER ≤ 6 + 16 + 4 080 + 16 = **4 118**;
> encapsulated frame ≤ 4 080; MAC-only session frames are 24/56/8/36 fixed. This bounds **only the SECURE_WRAPPER** (and its nested frame); it is
> silent about plain frames and about the stream. Implemented: encoding refuses P > 4 080 (and < 6); the client discards a received wrapper > 4 118
> as malformed before any MAC work (`WRAPPER_MAX_SIZE`); boundary tests at 4 080/4 081, an independent AES-CTR check of the last keystream block
> ([j] = FFh), and a >4 118 test. **The stream deframer cap stays 8 192 (class I)** — it is not tightened to 4 118 because it also sees non-wrapper
> frames whose limit is Core v2 (U). Still BLOCKED: partial-frame receive timeout, client obligations for oversize plain frames.

| | |
|---|---|
| Known | **N:** common header (06h, 10h, service, 2-octet total length) frames every message. **N (derived):** the CCM payload limit makes a SECURE_WRAPPER at most 6 + 16 + 4080 + 16 = **4118** octets (IPS §2.2.1.3.2 note: `[j]` is one octet ⇒ 255 blocks). **T:** server must skip a secure frame announcing length FFFFh without desynchronising (2.5.8), unknown service types do not close TCP (2.5.9), total length < 6 / wrong header size / wrong version close TCP (2.5.4–2.5.6), a 508-octet frame is handled (2.5.11), a partial frame is closed on receive timeout (2.5.7) while valid octets reset the idle timer (2.5.18). Half-closed ⇒ closed (2.5.10). |
| Unknown | The client-side obligations: maximum frame, receive timeout for a partial frame, whether an unknown service type must be skipped by a client, and what a client does on an oversize frame. |
| Current code | `stream.ts`: wrong header size/version, length < 6 or > 8192 ⇒ `KnxStreamError` ⇒ session closed (`protocol_violation`) — decision **I**; **no** receive timeout for a partial frame (a stalled partial frame is bounded only by the handshake timeouts, and afterwards by nothing — F5). Unknown *inner* service types inside a wrapper are counted, not fatal. Plain frames and unexpected secure service types outside the handshake are counted (`plainFrame`/`unexpected`), not fatal. |
| Observations | (1) 8192 ≥ 4118, so no legitimate wrapper is rejected [Likely]; the cap could be tightened to 4118 for outer secure frames — **not done**, pending Core v2. (2) T 2.5.8 shows a conformant *server* skips rather than closes on a huge frame; our client's stricter close is a safe-side decision (a client has no obligation to consume 64 KiB of junk). (3) The idle-watchdog gap (F5) is real: a post-auth server that stops sending mid-frame is not detected until the 60 s server-side session timeout fires on **its** side. |
| Needed | Core v2 §2.2.3.2.3.1 (receive timeout, header validation list). |

### B9 — Client KNX serial number (found while reviewing D5)

> **Status 2026-10-17 — BLOCKED; production session creation stays impossible.** Trace of the serial field (all from IPS v01.01.02 unless marked):
> (1) *Encoding:* wrapper security information = SeqInf(6) ‖ SerialNr(6) ‖ Tag(2); SerialNr is "the KNX serial number of the device sending the frame"
> (§2.2.1.3.1, N). (2) *Nonce:* B0 = SeqInf‖SerialNr‖Tag‖Q and Ctr0 = SeqInf‖SerialNr‖Tag‖FFh‖00h (§2.2.1.3.2, N) — the serial is part of the CCM
> nonce *and* is MAC-protected. (3) *Session establishment:* SESSION_REQUEST (46 octets) and SESSION_RESPONSE (56) carry **no serial**; each side's
> serial first appears in its first wrapper, so there is no negotiation or exchange to rely on (N, from the fixed frame layouts). (4) *Uniqueness:* each
> peer has an independent unicast counter starting at 0 (§2.2.3.3, N) and the session key is fresh per session (§2.2.3.1.1, N); the text states the
> purpose of the serial in the nonce only for *multicast* ("different … even on different devices in the same millisecond"). For *unicast*, two
> directions sharing one key have equal (SeqInf, Tag=0000h) pairs, so nonce uniqueness between the directions rests on the two serials differing —
> **an inference [Likely], not a stated requirement (U)**. (5) *Identity:* nothing read says a server validates the client's serial or binds a session to
> it; the client is identified by the session (user id + password hash), not by serial. (6) *Source for a software client:* **not defined (U)**.
> Therefore: `serialNumber` remains a mandatory option with no default; `assertConfigured` refuses a missing, mis-sized or all-zero value; the D5 guard
> (drop wrappers bearing our own serial) is class **I** and is **not** a resolution of B9 — it detects a collision, it does not make a fabricated serial
> legitimate. No production wiring exists, and `assertPolicySatisfiable` still refuses `ip_secure_required`, so no production session can be created.
> No direction-specific nonce was introduced: the nonce layout is normative wire format (N) and the text does not permit altering it.

| | |
|---|---|
| Known | **N:** the wrapper's serial field is "the KNX serial number of the device sending the frame" and is part of the nonce, added so that nonces differ between devices (IPS §2.2.1.3.1, §2.2.1.3.2). **T:** TSSK lists "uniqueness of serial number for each device" as not testable with a single device (KSG616-18.03 §2.5.1.3.1). |
| Unknown | What serial number a **software** client without an assigned KNX serial number must use (ETS uses its own); whether servers validate the client's wrapper serial (nothing read says so). |
| Current code | `serialNumber` is a mandatory option with no default (6 non-zero octets). The production wiring that would supply it does not exist yet. |
| Risk | A fabricated serial that equals a real device's serial would break the nonce-uniqueness premise (and trip D5 against that device). |
| Needed | KNX Association statement on serial allocation for software clients. **Until then SupremeOS must not invent one** — it needs an installer/owner-supplied or Association-issued value. |

## 2. Gate summary — what may and may not be built

| Item | Allowed now | Blocked until |
|---|---|---|
| Stream-mode tunnelling rules from TUN §2.6.2/§3.1 (no ACK, ignore received ACKs, ignore sequence on receive) | design + tests against the simulator **only**, behind the not-enabled secure flag | – (N), but see architecture doc: the *transport shell* around it is blocked |
| TCP HPAI encode/decode (B3) | no | Core v2 |
| CONNECTIONSTATE / DISCONNECT over TCP (B4/B5) | no | Core v2 + Overview |
| Status-code table for secure paths (B5) | no | Overview |
| AN183 behaviour (B2) | no (assumed N/A) | AN183 + statement |
| Password encoding change (B6) | no | owner decision / KNX answer |
| Receive timeout / frame cap change (B8) | no | Core v2 |
| Serial number allocation (B9) | no | KNX answer |

## 3. D5 reflection guard — review against the specification and available test cases

**Classification: remains an implementation decision (I). Not spec text. Not conformance-tested.**

| Question | Evidence | Finding |
|---|---|---|
| Does the spec forbid or address reflection of a sender's own frame? | IPS §2.2.3.3 / §2.2.1.3.3 read in full: unicast receiver drops sequence ≤ last received and MAC failures; no sentence about frames carrying the receiver's own serial. | **Not addressed (N-silent).** |
| Is the premise of D5 (sender serials differ) in the spec? | **N:** serial = "device sending the frame", added to Ctr to make nonces differ between devices (IPS §2.2.1.3.2 note). The spec's multicast TIMER_NOTIFY procedure itself recognises "repeats the own serial number" (IPS §2.2.2.3.2.8, timer-sync start) — as a *multicast* mechanism. | The premise is supported by the spec's intent [Likely]; applying it to unicast is our extension. |
| Does any TSSK case exercise it? | Searched TSSK for `reflect`, `own serial`: none. Cases that touch serials (2.2.x error tables) send a serial that does not match the one used for the MAC — i.e. MAC failure, which we also handle — and ask the BDUT to ignore them. No case reflects a frame to its sender, and "uniqueness of serial number" is declared untestable with one device. | **No available test case confirms or contradicts D5.** |
| Can D5 cause a false rejection against a real gateway? | Only if the gateway's serial equals the client's configured serial (requires a duplicated serial = violation of device uniqueness, or a badly chosen fabricated client serial → B9). | Practically no, **provided** B9 is solved without fabricating a serial. |
| What attack does it stop? | A network attacker (or buggy middlebox) reflecting the client's own authenticated frames back: same key, same nonce layout, sequence above the server's last ⇒ MAC verifies, frame accepted as server data. With equal serials in both directions the same (key, nonce) could also be used for two messages by CCM. | Real for our model (reproduced by the F1 regression), but still a consequence of our own two-direction key sharing described in the spec. |
| Alternative without relying on the serial? | Direction-specific nonce domain would be a *wire change* (not allowed). A client-side check "inbound sequence must be exactly the next expected" is **not** spec behaviour (spec: monotonic only). | None that stays spec-conformant. D5 stays. |

Test status: 3 regression tests (F1/D5 ×2, F2/D5) — the two F1 tests were mutation-verified to fail when the check is removed (previous
session) and were re-run green this session. **Required before D5 can be promoted:** (1) written KNX confirmation that servers never send
wrappers with a serial equal to the client's configured serial and (2) interoperability capture against a real gateway showing no `reflected`
counter increments in normal operation.

## 4. Vector preservation and mutation evidence (this session)

* Licensed vectors live **outside Git** (`vectors.local.json` in a mode-0700 scratchpad directory next to the extracted spec text); `git ls-files` contains no `.pdf`, `.knxkeys` or vector file; `knx-licensed/` is git-ignored (verified with `git check-ignore`).
* With `KNX_SECURE_VECTORS` unset the 22 vector tests are **skipped, not passed**.
* Mutation: a copy of the local JSON with four expected values altered (`a2_mac`, `a2_session_key`, `a3_auth_mac`, `a3_wrap_key`; last hex digit flipped) made **5 tests fail** across `ccm.vectors`, `ip-frames.vectors`, `ip-keys.vectors`; the mutated copy was deleted. Expected values are never computed by repository code.

## 6. Stream-mode tunnelling in the simulator (2026-10-17) — what is verified, what stays blocked

Scope and conditions of TUN v01.07.01 §2.6.2 (read in full; three sentences): *"For connections inside a TCP connection, the sequence counter shall not be
evaluated by the receiver. The sender may set the sequence counter to zero. For TCP communication, no TUNNELLING_ACK shall be sent. Received TUNNELLING_ACK
Frames shall be ignored."* §3.1 applies the same to TUNNELLING_FEATURE_* (no ACK on TCP). The clause is conditioned on "a connection inside a TCP connection"; it
says nothing about secure sessions specifically, nor about HPAI, liveness, disconnect or timeouts.

| Rule (code: `tunnel-rules.ts`, `STREAM_RULES`) | Class | Source |
|---|---|---|
| Do not send TUNNELLING_ACK | **N** | TUN §2.6.2 |
| Ignore received TUNNELLING_ACK (any status, any channel; counted as `ignoredAcks`) | **N** | TUN §2.6.2 |
| Do not evaluate the receive sequence counter (no duplicate/out-of-order suppression) | **N** | TUN §2.6.2 |
| Send sequence 0 | **N-permitted** ("may"); zero chosen because it is the simplest permitted value (I) | TUN §2.6.2 |
| A send is complete when the secure session accepted the frame (no ACK wait, no repeat, no ACK timeout); receipt `transportAck: "none"` | **I** — consequence of "no ACK", not stated | – |
| HPAI/addressing of CONNECT/CONNECTIONSTATE/DISCONNECT inside TCP | **U — B3** | Core v2 |
| KNX-level heartbeat / liveness on TCP | **U — B4** | Core v2 |
| DISCONNECT_REQUEST requirement/response, slot cleanup | **U — B5** | Core v2, Overview |
| Numeric status/connection codes | **U — B1** | Overview |
| Partial-frame receive timeout | **U — B8** | Core v2 |

Simulator placeholders for the blocked rows (all marked in the registry and exercised only over an in-memory transport): UDP-form HPAIs in CONNECT_REQUEST
(ignored by the simulated server); **no** KNX heartbeat (the secure session's KEEPALIVE, IPS §2.2.3.5.2, N, is the only liveness); **no** DISCONNECT_REQUEST on local
disconnect — ending the secure session closes contained connections implicitly (IPS §2.4.2, N) — and a received DISCONNECT_REQUEST closes the tunnel **without** a
response. **Fail closed:** `KnxTunnelClient` refuses a stream link at construction unless every rule is verified or the link's transport is simulated; "simulated" is
derived from a symbol set only by `VirtualStreamNetwork.createStreamFactory` (a real `createTcpStreamFactory` and even an unmarked in-memory wrapper are refused). With
five rules still unverified (B1, B3, B4, B5, B8) no real transport can ever run a stream tunnel.

Ambiguities recorded (none resolved by guessing): (A1) §2.6.2 does not say how a sender knows a TCP send "succeeded"; (A2) "may set the sequence counter to zero" does not say whether a
sender may *also* count — a receiver must accept either, so zero is safe; (A3) whether "ignored" ACKs should be logged is unspecified — they are counted, not acted on.

## 7. Update 2026-10-17 — archive re-inspection, partial evidence, decision reassessment

**B1 (status codes) — narrowed.** Verified from Tunnelling v01.07.01: `E_NO_ERROR` 00h and `E_TUNNELLING_LAYER` 29h (Table 11), `E_NO_MORE_UNIQUE_CONNECTIONS` 25h (N). Names without values in the supplied text: E_CONNECTION_ID, E_CONNECTION_TYPE,
E_CONNECTION_OPTION, E_NO_MORE_CONNECTIONS, E_DATA_CONNECTION, E_KNX_CONNECTION → still **U**. No behaviour depends on a numeric code in stream mode (registry rule `statusCodes` stays blocked until the rest are verified).
**B2 (AN183) — partial, still BLOCKED for a conclusion.** Evidence (N-scope): Network Layer v02.01.01 §2.4.2.4.5.7.5 defines IP System Broadcast handling for the *KNXnet/IP Router* (PID_IP_SBC_CONTROL) and "tunnel" does not occur in NL/TL/AL, so no supplied text
imposes it on a group-telegram tunnelling client [Likely not applicable]. The standalone AN183 and the integration (marked "started" only) are absent, so applicability is **not verified**; AN183 constants appear in TSSK 2.4 (router tests).
**B3, B4, B5, B8 — unchanged:** Core v2 / Overview not in the archive (see acquisition plan §D).

**Reassessment of the stream-mode decisions** (each re-read against TUN §2.6.2, TSSK 2.5.19/2.5.20/2.7.6 and the code):

| Decision | Class | Evidence | Effect on real-transport readiness |
|---|---|---|---|
| Receiver does not evaluate the tunnel sequence counter | **N** | TUN §2.6.2; **T** TSSK 2.5.19 (accepts constant 42), Core v2 2017 draft §2.2.3.2.4.1 | none — verified |
| Send no TUNNELLING_ACK | **N** | TUN §2.6.2, §3.1; **T** TSSK 2.5.20, 2.7.6 | none — verified |
| Ignore received TUNNELLING_ACK (and never treat it as an error / close) | **N** (ignore) + **T** (TSSK 2.5.20 fails a BDUT that closes on an ACK) | as above | none — verified |
| Send sequence 0 | **N-permitted** ("may"); **T** (BDUT may send any values) | TUN §2.6.2 | none — permitted choice |
| Count ignored ACKs (`ignoredAcks`) | **I** | – | none (no wire effect) |
| A stream send "completes" when the secure session accepted the frame; receipt `transportAck: "none"` | **I** | consequence of "no ACK"; the text defines no completion event | none on the wire, but **callers must treat it as "handed to the session", never "delivered"**; delivery truth is `confirmation` (L_Data.con), and `not_confirmed` means UNKNOWN |
| No tunnel-layer duplicate suppression | **N-mandated** for the sequence-based mechanism (not evaluated); suppression of *replays* is the secure session's job (N IPS §2.2.1.3.3/§2.2.3.3) | see security review §10 | none — but see replay gaps below |
| Placeholders for HPAI, heartbeat, disconnect, status codes, partial frames | **U** (B3/B4/B5/B1/B8) | – | **real transport stays blocked** |

None of the wire-visible stream decisions is unsupported; the real-transport block comes solely from the five unverified rows. A passing simulator suite proves none of the above (self-authored server).

**Replay/duplicate gap register (details: security review §10, architecture §9):** G-R1 held-back tail frames are accepted (no freshness in unicast wrappers; receive path unbounded on the client until B4); G-R2 application retries are new authenticated messages
(at-least-once, only the caller can judge idempotence); G-R3 delivery outcome after a session loss is UNKNOWN. G-R4/G-R5 (key-pair reuse seam; TCP left open when `start()` refuses) were fixed (class I).

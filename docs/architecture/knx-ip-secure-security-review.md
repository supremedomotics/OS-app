# KNX IP Secure client — Security Review Gate (before real TCP integration)

Reviewer: independent re-read of the code in `services/protocols/src/knx/native/{secure,simulator,tcp-socket.ts}` against
`03_08_09 KNX IP Secure v01.01.02 AS` (IPS, 2021) and `03_08_04 Tunnelling v01.07.01 AS` (TUN, 2021), cross-checked with the TSSK
v1.1 AS test descriptions. Branch `claude/great-keller-fmenbn`. Review base `fcec19a`; fixes in `93777b3`.
**Nothing here is hardware interoperability evidence. No KNX IP Secure device was available. Not production-ready.**

Classification used throughout: **N** = stated by the supplied normative text · **I** = our implementation decision (stricter or
additional; not spec text) · **H** = test-harness/simulator behaviour · **U/BLOCKED** = no supplied document states it.

## 1. Provenance and evidence

| Check | Result |
|---|---|
| Working tree | clean after commit `93777b3`; no untracked licensed material |
| Licensed PDFs / extracted text / vectors in Git | **none**: `git ls-files` has no `.pdf`/`.knxkeys`; `.gitignore` covers `knx-licensed/`, `The KNX Standard*/`, `KNX_Secure_Claude_Bundle*`, `*.knxkeys` (verified with `git check-ignore`) |
| Vector leakage scan | all 35 vector values ≥ 12 octets (`vectors.local.json`) searched (case-insensitive, fixed string) in the working tree **and in every commit of every ref**: 0 hits |
| Vectors are genuine source material | every one of the 53 hex values in the local JSON was located in the extracted spec text: 50 as one contiguous hex string, 3 (`a2_response_frame`, `a3_wrap_cipher`, `a5_cipher`) only as annotated, column-split dumps — each 8-octet chunk of those three was found in the text. Expected values are never computed by repository code: the tests read them from the JSON |
| Vector tests really execute | with `KNX_SECURE_VECTORS` set they run; mutating the MAC values of three vectors made 4 tests fail (then discarded); without the variable the 22 vector tests are **skipped, never passed** |
| Independent crypto checks | CCM is cross-checked against Node `aes-128-cbc/ctr`. That shows the construction equals standard AES primitives; it is **not** KNX conformance — only the spec's own worked examples (V) touch the KNX-specific layouts |
| Executed conformance | **none** (TSSK is only a description; no EITT templates). Hardware: **none** |

## 2. Security findings (ordered by severity)

| # | Sev | Finding | Status |
|---|---|---|---|
| F1 | **Medium** | **Reflection / nonce-domain collision.** Both directions of a session share one key and one nonce layout (`SeqInf‖Serial‖Tag`). A frame the client sent, replayed back to it, carries a valid MAC and a sequence above the server's last — it was delivered to the application as server data (reproduced by regression test). Equal serials in the two peers would additionally reuse a CCM nonce. The text (IPS §2.2.1.3.2/§2.2.3.3) does not address this. | **Fixed (I, D5):** wrappers carrying our own serial are dropped and counted (`reflected`); an all-zero own serial is refused. Tests `F1/D5 ×2`, `F2/D5`; the two F1 tests fail when the check is removed (mutation-verified) |
| F2 | Low | All-zero own serial accepted (cannot be an assigned KNX serial) | Fixed with F1 |
| F3 | Medium (robustness) | `receive()` caught only frame-format errors; any other exception would have propagated into the socket `data` callback → process-level failure instead of fail-closed | **Fixed (I, D6):** any unexpected fault closes the session (`protocol_violation`). Test `F3/D6` |
| F4 | Info | The simulated TCP stream discarded in-flight bytes on graceful close, which hid real behaviour | Fixed earlier in the simulator only (H) |
| F5 | Info / U | No bound on a **partially received frame** and no client-side liveness check on an authenticated session (KEEPALIVE is unconfirmed by design, IPS §2.2.3.5.2). Receive/idle rules for TCP live in Core v2, which is absent | **BLOCKED-SPEC.** Mitigation present: 8 KiB frame cap, connect timeout, write-queue bound; tunnelling heartbeats (when integrated) would give liveness |
| F6 | Info | `STATUS_CLOSE` is also sent when a client closes while still `awaiting_status` | **Resolved (N)**: IPS §2.2.3.5.2.5 E03 in UNAUTHENTICATED → A3 (server answers STATUS_CLOSE and deallocates). KEEPALIVE/other frames pre-auth would draw UNAUTHENTICATED; the client sends none |
| F7 | Info | Key bytes handled by Node's `createCipheriv`/KeyObject and JS strings (passwords via `passwordSecret(text)`) cannot be wiped by us; `Secret.wipe()` is best-effort for our own buffers | Documented limitation (threat model §8) |
| F8 | Info / U | Character encoding of user passwords is not specified in the text read | **Mitigated (I):** non-ASCII passwords are now refused before derivation (temporary guard `PASSWORD_ASCII_ONLY`); still **BLOCKED pending KNX clarification** for non-ASCII |
| F9 | Info | Session renewal: none is automatic. Counter exhaustion closes the session (`sequence_exhausted`) instead of wrapping; a new session needs a new instance (new ECDH pair). 2^48 frames is unreachable in practice (IPS §2.2.3.3: ~9 years at 10^6 fps) | By design (N + D2) |
| – | – | No logging calls exist in `secure/`; `Secret` redacts in `toString`/JSON/inspect; `diagnostics()` exposes counters and states only (never keys, hashes, DAC, plaintext) | Verified by grep + existing redaction tests |

No finding allows a plaintext fallback: there is no code path that sends or accepts an unwrapped frame inside a session (D3).

## 3. Behaviour → specification traceability (implemented behaviours)

| Behaviour (code) | Class | Spec revision & clause | Conformance reference (TSSK v1.1, **not executed**) |
|---|---|---|---|
| SESSION_REQUEST 46 octets, TCP route-back HPAI `08 02 00…`, fresh X25519 pair per session | N | IPS v01.01.02 §2.2.3.1.1, §2.2.3.6 | 2.2.1–2.2.4, 2.2.25, 2.2.28, 2.2.35 |
| Session key = first 16 octets of SHA-256(shared secret); reject zero/low-order peer value | N (+I for rejection) | §2.2.3.1.2 | 2.2.x setup cases |
| SESSION_RESPONSE 56 octets; MAC over header‖id‖(X⊕Y) with Device Authentication Code | N | §2.2.3.7, Annex A.2 (V) | 2.2.2 |
| **Mandatory** server authentication (client may skip per text) | I (stricter, D1) | §2.2.3.7.5 calls it optional | – |
| Session id ≠ 0, Y ≠ X, Y ≠ 0 | I (mirrors the TSSK tool's client procedure `GlPro_SecureSessionSetup`) | §2.2.3.7.2 (id 0 = multicast) | 2.2.35 |
| PBKDF2-HMAC-SHA256 / 65 536 / 128 bit, fixed salts | N | §2.3.1.3.1, §2.3.1.4.1, Annex A.1/A.3 (V) | 2.3.x (device side) |
| SESSION_AUTHENTICATE 24 octets, user id 01h–7Fh, MAC with password hash; exactly one per ECDH session | N | §2.2.3.8 (incl. §2.2.3.8.3), Annex A.3 (V) | 2.2.4, 2.2.13, 2.2.15, 2.2.16, 2.2.20–23 |
| SECURE_WRAPPER ≥ 44 octets; AAD = header‖session id; B0/Ctr0 layout; tag ignored/0000h for unicast | N | §2.2.1.3.1–§2.2.1.3.3, Annex A.3/A.4 (V) | 2.2.x |
| MAC verified before delivery; failed MAC → discard, no state change | N + I | §2.2.1.3.3, §2.4.1 | 2.2.24 |
| Receive: discard sequence ≤ last accepted (before MAC allowed); counter advances only after MAC | N (check order) + I (advance rule) | §2.2.1.3.3, §2.2.3.3 | 2.2.24 |
| Send counter 48-bit, starts at 0, +1 per frame, never wraps | N | §2.2.3.3 | 2.2.24 |
| Wrong/other session id discarded | N | §2.2.1.3.3, §2.4.1 | 2.2.x |
| Plain frames ignored inside the session; no nesting | N | §2.4.1, §2.2.3.5.1 | 2.2.36 (server side) |
| Timeouts: response 10 s, authentication 10 s; keep-alive well before 60 s idle | N (10 s/60 s), I (30 s interval) | §2.2.3.5.2.1.1, §2.4.1 | 2.2.5, 2.2.18–19 |
| Terminal statuses end session; TCP closed with the session | N | §2.2.3.9.2, §2.4.2 | 2.2.x |
| **Reflection / own-serial drop (D5)** | **I** | not in text | none |
| **Fault → fail closed (D6)** | **I** | not in text | none |
| TCP deframing by common header, 8 KiB cap | N (header) + I (cap) | common KNXnet/IP header; Core v2 rules **U** | 2.5.2, 2.5.3 |
| Unicast sessions only over TCP (no UDP path exists) | N | §2.2.3.3 | 2.2.25 |

## 4. Real TCP transport (added after the review; no blocker found for a byte-stream socket)

`tcp-socket.ts` is a pure byte pipe to one configured endpoint (no KNX knowledge, **no destination allow/deny policy**). Decisions
(I): connect timeout 10 s, 1 MiB write-queue bound, linger bound after `end()`, TCP_NODELAY, handler faults contained. Tested on real
loopback sockets (`tcp-socket.test.ts`, 24 tests): round trip, 1-octet fragmentation, coalescing, peer FIN, reset, local destroy,
orderly close + linger, refused, connect timeout, queue bound, handler exception, endpoint validation; and the secure session over a real
socket against the *simulated gateway model* (handshake, wrong-DAC server, silent server timeout, reset, malformed header, oversize length,
no connection opened on invalid config, single-use, 40 cycles with no leaked server session/socket). Mutation checks (removing the queue
bound and the linger timer) failed 4 tests.
Simulator isolation: the simulator directory imports no network/DNS/TLS/HTTP/process module (static test) and the virtual network refuses
a real listening address (runtime test). The production factory is a different file with no such restriction.

## 5. Tunnelling inside the secure session — requirement mapping; **integration deliberately NOT done**

| Requirement | Source | Class |
|---|---|---|
| All traffic of connections created inside a session is wrapped; other sessions' / plain frames ignored; DISCONNECT/CONNECTIONSTATE outside the session → E_CONNECTION_ID | IPS §2.4.1 | N |
| CONNECT_REQUEST/RESPONSE are exchanged as payload of SECURE_WRAPPER | IPS §2.4.1 | N |
| On TCP: sequence counter not evaluated by the receiver (sender may send 0); **no** TUNNELLING_ACK sent; received ACKs ignored | TUN §2.6.2 (AN184/AN185 integrated into v01.07.01, per its change table) | N |
| Same rules for TUNNELLING_FEATURE_* over TCP (no ACK) | TUN §3.1 | N |
| HPAI host-protocol code and content in CONNECT_REQUEST / DISCONNECT / CONNECTIONSTATE over TCP (route-back variant) | Core v2 (3/8/2) | **BLOCKED — absent** |
| Whether the CONNECTIONSTATE heartbeat and its timeouts apply on TCP; DISCONNECT semantics on TCP; connection-level idle rules | Core v2 | **BLOCKED — absent** |
| Numeric E_CONNECTION_ID and other status codes | Overview (3/8/1) | **BLOCKED — absent** |
| Extended CRI, Interface Features (gaps G4/G5) | TUN §3, §5.4.3.2 (read) | N, not yet implemented |
| AN183 (System Broadcast) | referenced only by the IPS profile table row "KNX IP System Broadcast" and by TSSK 2.4; standalone text absent; Application Layer notes integration "started" | **BLOCKED — completeness unverifiable** |

Why not integrate now: the existing tunnel client encodes UDP "NAT" HPAIs (protocol code 01h) and runs a UDP-style ACK/retransmit and
heartbeat state machine. Making it carry frames inside the session requires choosing HPAI codes and heartbeat/disconnect behaviour that
only Core v2 defines. Guessing them would be an unverified protocol invention. What *is* ready and verified: the session pipe
(`SecureSessionConnection.sendInner/onInner`) and the TUN §2.6.2 rules above, to be applied as a "stream mode" once Core v2 is available.

## 6. Documents still needed

KNXnet/IP Core v2 (3/8/2) · KNXnet/IP Overview (3/8/1, status codes) · standalone AN183 and confirmation of its scope · Resources
(3/5/1) · Volume 6 Profiles · ETS keyring format · standalone AN158 · EITT templates · written KNX Association confirmation of the
password encoding (F8) and of the pre-authentication STATUS_CLOSE behaviour (F6).

## 7. Remaining blockers for real-hardware testing

A KNX IP Secure interface with known Device Authentication Code / user password (or its FDSK), a closed lab network, the unlocked
key store, Core v2 + Overview to complete the tunnelling over TCP, a packet capture setup (secrets scrubbed, never committed), and a
rollback runbook. Until then every statement above is a simulator/vector statement.

## 8. Addendum — blocker review (2026-10-17, base `d5b78bf`; no code changed)

Full detail: `knx-secure-blocker-matrix.md` (B1–B9, D5 review) and `knx-secure-tunnelling-architecture.md`.

New findings from reading the *existing* tunnelling client and the specification/test text against §5:

| # | Sev | Finding | Status |
|---|---|---|---|
| F10 | Info (blocks integration) | `decodeHpai()` throws on any non-UDP HPAI and `NAT_HPAI` is UDP route-back (01h); a TCP-carried CONNECT_RESPONSE/DISCONNECT/CONNECTIONSTATE would be rejected as malformed, and per TSSK 2.5.21 a server **silently ignores** a UDP-HPAI CONNECT over TCP (a 10 s connect timeout, not an error) | BLOCKED-SPEC (B3); documented, not changed |
| F11 | Info | `StatusCode` values (e.g. CONNECTION_ID = 0x21) cite "Core spec §7.8"; **no supplied document states them** | Unverified (B1/B5); questions drafted |
| F12 | Info | Deframer closes on length > 8192; derived bound for a SECURE_WRAPPER is 4118 octets (CCM payload ≤ 255 blocks, IPS §2.2.1.3.2 note) so no valid wrapper is rejected; TSSK 2.5.8 shows servers *skip* oversize frames — our stricter close is client-side decision I | I; unchanged (B8) |
| F13 | Info | No client-side partial-frame receive timeout (T 2.5.7/2.5.18 describe it for servers); stalled partial frame after authentication is undetected by the client | = F5, BLOCKED-SPEC (B4/B8) |
| F14 | Info / U | The client must put a KNX serial number into every wrapper (nonce input). A software client has none assigned; fabricating one would undermine nonce uniqueness and D5 | BLOCKED (B9); option stays mandatory with no default |
| F5/F6/F8 | – | Re-examined: still unresolved; candidate decisions recorded in B6/B7/B8 but **not applied** | open |

**D5** was re-reviewed against IPS §2.2.1.3.1–§2.2.3.3 and the TSSK cases: the specification is silent on unicast reflection, its nonce design presupposes
distinct sender serials, and no TSSK case exercises reflection. It remains classified **I (implementation decision), not spec text, not conformance-tested**;
conditions for promoting it are in blocker matrix §3.

## 8. Addendum 2026-10-17 (milestone: B6–B9, T1)

* F6 resolved from normative text (N); F8 mitigated by a guard (I); B8: the 4 118 / 4 080 bound is N-derived for the SECURE_WRAPPER only and is now enforced
  on receive (discard as malformed) with boundary tests; the 8 192 stream cap remains a decision (I).
* B9 unchanged: the serial's source for a software client is undefined (U). D5 is a collision/reflection **detector**, not a resolution; production session
  creation remains impossible (no wiring; `assertPolicySatisfiable` refuses secure policies).
* New code path: `tunnel-link.ts` (classic UDP only; characterised and mutation-checked). No new security-relevant wire behaviour was added anywhere.
* Unresolved security findings: F5 (partial-frame/liveness, blocked on Core), F7 (key bytes inside Node crypto not wipeable), F8 (non-ASCII passwords), B9.

## 9. Addendum 2026-10-17 (T2: stream-mode tunnelling, simulator only)

New security-relevant surface: a tunnel client that (a) sends no ACKs, (b) ignores ACKs, (c) does not evaluate receive sequence numbers. Consequences reviewed: duplicate/replayed *tunnel* frames are
no longer suppressed at the tunnel layer — replay protection rests entirely on the secure session (unicast sequence ≤ stored ⇒ discard, MAC before state advance, fresh key per session; IPS §2.2.3.3),
which the tests exercise unchanged. A server (or anything holding the session key) can therefore make the client deliver the same telegram repeatedly; that is within the trust of an authenticated
session and is inherent in §2.6.2. The stream tunnel cannot start unless the secure session authenticated the server (D1) and cannot be constructed on a real transport (rules B1/B3/B4/B5/B8 unverified).
No new wire format, no nonce or serial change (B9 unchanged), no credential handling change. Unresolved: F5, F7, F8, B9, plus the open stream blockers above.

## 10. Replay-safety review of stream-mode tunnelling (2026-10-17)

**Principle.** Authentication (MAC) proves who produced a frame; replay prevention proves it is not an *old* frame. A captured wrapper is fully authentic. Three independent mechanisms exist and each was checked in code and by test
(`secure/stream-replay.test.ts`, 14 tests; `ip-session.test.ts`): (1) per-direction 48-bit sequence number, discard ≤ last accepted, check before MAC (allowed) but advance only after MAC (IPS §2.2.1.3.3, §2.2.3.3 — N; the "advance after MAC" part is decision I);
(2) a fresh ECDH key pair per session, so a wrapper from another session fails the MAC even with an identical session id (§2.2.3.1.1 — N); (3) SESSION_RESPONSE is bound to this handshake's X (MAC over X⊕Y) so an old response is rejected (§2.2.3.7 — N). The tunnel-layer sequence number contributes **nothing** (TUN §2.6.2: not evaluated).

| Case | Outcome | Mechanism / evidence | Class |
|---|---|---|---|
| Duplicate network delivery of one wrapper (either direction) | processed once; duplicates counted `replay` | (1); tests A1, A2 | N |
| Captured authentic wrapper re-injected later in the same session | not processed again | (1); test B1 | N |
| Reordering (older wrapper after a newer one) | older dropped, telegram **lost**, never replayed | (1); test B2 | N |
| Held-back **tail** frame released later | **accepted** whenever released while the session lives and nothing newer arrived | no freshness field in unicast wrappers; test B3 `KNOWN LIMITATION` | **gap G-R1** |
| Same, client→server | bounded by the server's 60 s session timeout (released frames hit a dead session) | §2.2.3.5.2 A5; test B4 (server model) | N (model) |
| Same, server→client | **unbounded** on the client (no inbound liveness/watchdog; F5/B4) | test B3 | gap G-R1 / B4 |
| Application retry (new wrapper, same payload) | accepted and executed again; distinct increasing sequence numbers | not a replay; tests C1, C3 | **gap G-R2 (by design)** |
| Tunnel retransmission by the stack | never happens in stream mode (no ACK ⇒ nothing to repeat); verified over 5 minutes | TUN §2.6.2; test C2 | N + I |
| Reconnect / new session: old wrapper (other id) | rejected (`wrongSession`) | tests D1 | N |
| …old wrapper, same session id | rejected by MAC (fresh key) | test D2 (counter advanced so only the key can reject) | N |
| Client command wrapper from session A into session B (server model) | not executed | test D3 | N (model) |
| Old SESSION_RESPONSE into a new handshake | `server_authentication_failed` | test D4 | N |
| Client key pair reused across sessions (generator seam, stuck RNG) | **refused** (new) | §2.2.3.1.1 "shall"; test D5 | N rule, I enforcement |
| Outcome of an in-flight command when the session dies | UNKNOWN (`confirmation: not_confirmed`) | tests in `stream-tunnel.test.ts` | gap G-R3 |

**Side-effect commands (switching, blinds, locks, HVAC).** The session layer guarantees that *the same authenticated wrapper* is acted on at most once and never across sessions. It does **not** give exactly-once for *intent*: if an application re-sends after an unknown outcome,
the device may receive two distinct authentic commands. For absolute, idempotent commands (switch on/off, set level, setpoint) that is harmless; for relative/toggle/step, scene triggers, locks, alarms and HVAC mode changes it is not.

**Duplicate-handling strategy (design; no wire change, no tunnel-layer dedupe):**
S1 the stream tunnel never retransmits (enforced + tested); S2 callers receive honest delivery state (`transportAck: "none"` + `confirmation`, `not_confirmed` = unknown);
S3 the planned per-capability replay policy (parity matrix stage 7) must **never auto-resend** non-idempotent classes and locks/security after an unknown outcome, and may resend an idempotent absolute command once only after a status read-back shows the target state was not reached;
S4 no content-based inbound de-duplication (it would swallow legitimate repeated bus telegrams and is not in the specification); S5 receive-path freshness (a client watchdog) waits for the Core v2 liveness rules (B4) — a locally invented timeout would be a guess;
S6 time-critical security commands should not be sent over a session whose liveness is unverified (policy for the future adapter).

**Findings fixed this session:** R4 (Low) key-pair generator seam could defeat cross-session replay protection → process-wide reuse guard (I); R5 (Low) `SecureSessionConnection.connect()` left the TCP connection open when `start()` refused → released, regression test.
**Open:** G-R1 (freshness), G-R2/G-R3 (policy, adapter-level), F5, F7, F8, B9, and the five blocked stream rules. Confirmation matching in the tunnel client is by (destination, service) FIFO; a duplicated *authentic* L_Data.con from the server could settle a later pending send early — it requires the authenticated server and is not suppressible without tunnel sequence numbers (low).

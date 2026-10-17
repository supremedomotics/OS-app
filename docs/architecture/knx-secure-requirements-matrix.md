# KNX Secure — Specification & Requirements Traceability Matrix

**Revision 3 — 2026-10-17.** Supersedes revisions 1–2. Basis: the licensed documents in the supplied bundle, **opened and read in this
session** (see `knx-secure-document-inventory.md` for exact titles, revisions, hashes, discrepancies, and what is still missing).
Nothing here is claimed as *implemented* or *conformant* unless the Status column says so and names its evidence.

## 0. Conventions

**Evidence classes** (Source column)
* **C** — confirmed from an authorized normative document actually read; document, revision and clause given. Informative annexes are marked *(inf.)*.
* **T** — described only in a conformance-test document (TSSK/TSSJ). A test is **not** a specification; T rows never become "implemented" on their own.
* **U** — unresolved: the governing document is not in the bundle.
* **D** — SupremeOS implementation decision (not a KNX requirement).

**Status vocabulary**: *not started* · *spec only* (read & mapped, no code) · *codec* (pure encode/decode) · *unit-verified* (passes the spec's own worked example **and** independent property tests) · *simulator* · *loopback-UDP/TCP* · *HW* (real hardware).
**Nothing is HW-validated.** There is no KNX hardware, no secure device and no ETS in this environment.

**Document short names**: **IPS** = *03_08_09 KNX IP Secure v01.01.02 AS*; **TUN** = *03_08_04 Tunnelling v01.07.01 AS*; **AL** = *03_03_07 Application Layer v02.01.01 AS*;
**TSSK** = *Test Suite Supplement K, KNX IP Secure Tests v1.1 AS*; **TSSJ** = *Test Suite Supplement J, KNX Data Security Tests v1.11 AS*.

## 1. KNX IP Secure (transport layer) — normative source IPS

| ID | Requirement (paraphrased) | Source | Impl status | Tests / evidence | Conformance cases (TSSK) | HW | Uncertainty / blocker |
|---|---|---|---|---|---|---|---|
| IPS-01 | Secure frames use the standard 6-octet KNXnet/IP header, protocol version 10h, service-type high octet 09h; family range 0950h–09FFh; defined types 0950 SECURE_WRAPPER, 0951 SESSION_REQUEST, 0952 SESSION_RESPONSE, 0953 SESSION_AUTHENTICATE, 0954 SESSION_STATUS, 0955 TIMER_NOTIFY | C: IPS §2.2.1.2.1, §2.2.1.3.1, §2.2.2.4.2, §2.2.3.6–9, §2.6.1.1 | see §6 | see §6 | 2.1.5, 2.2.1, 2.2.6 (cite §2.2.1.3.1) | — | — |
| IPS-02 | SECURE_WRAPPER body: session id (2) · sequence information (6) · KNX serial number (6) · message tag (2) · encapsulated KNXnet/IP frame (incl. its header) · MAC (16). Minimum frame 44 octets. Not nestable | C: IPS §2.2.1.3.1, §2.2.1.3.3, §2.2.1.2.2.2, §2.2.3.5.1 | see §6 | see §6 | 2.1.5, 2.2.27, 2.1.40 | — | — |
| IPS-03 | Wrapper CCM: A = wrapper header ‖ session id (a = 8); P = encapsulated frame; B0 = SeqInf‖SerialNr‖Tag‖Q(2 octets); Ctrᵢ = SeqInf‖SerialNr‖Tag‖FFh‖[i]; MAC = full 128-bit CBC-MAC, encrypted with S0; generic CCM steps per AL Annex A.3 | C: IPS §2.2.1.3.2 + C(inf.): AL Annex A.2–A.3; worked examples IPS Annex A.3.3, A.4.2, A.5.2 (inf.) | see §6 | see §6 | 2.1.1, 2.2.1 | — | informative-annex vectors only; no certified vector set |
| IPS-04 | Reception: drop frames < 44 octets; drop unknown/disconnected session id; unicast: drop if sequence ≤ last received (may check before MAC); drop on MAC mismatch; multicast: MAC checked **before** the timer value is evaluated | C: IPS §2.2.1.3.3 | see §6 | see §6 | 2.2.6, 2.2.37 | — | — |
| IPS-05 | Session key = first 16 octets of SHA-256(shared secret), shared secret = Curve25519(myPrivate, peerPublic) (little-endian); **new key pair for every session**, from a cryptographically safe source; never reused | C: IPS §2.2.3.1.1–2; example IPS Annex A.2.4 (inf.) | see §6 | see §6 | 2.2.35 (different key after power cycle) | — | — |
| IPS-06 | SESSION_REQUEST: 46 octets = header · HPAI control endpoint (**TCP route-back: protocol 02h, 0.0.0.0:0**) · client public value X (32). Valid only over TCP; client waits ≤ 10 s | C: IPS §2.2.3.6.1–4; example Annex A.1 (inf.) | see §6 | see §6 | 2.2.2, 2.2.25, 2.2.28 | — | — |
| IPS-07 | SESSION_RESPONSE: 56 octets = header · session id (2, **non-zero for unicast**) · server public value Y (32) · MAC (16). MAC via CCM keyed with the Device Authentication Code, A = header‖session id‖(X⊕Y) (a = 40), P empty, B0 = 0…0‖Q(0000h), Ctr0 = 0…0‖FFh‖00h. Client "optionally" validates | C: IPS §2.2.3.7.1–5; example Annex A.2.2–A.2.3 (inf.) | see §6 | see §6 | 2.2.2 (+ `GlPro_SecureSessionSetup`) | — | **D: SupremeOS validates the MAC and the extra checks the test tool performs (Y ≠ 0, Y ≠ X, id ≠ 0, header/length) and fails closed** — stricter than "optional" |
| IPS-08 | Device Authentication Code = PBKDF2(HMAC-SHA-256, secret, salt `"device-authentication-code.1.secure.ip.knx.org"`, 65 536 iterations, 128-bit). Ex-factory value = FDSK | C: IPS §2.3.1.3.1, §2.3.1.3.3, §2.2.3.4; example Annex A.2.2 ("trustme") (inf.) | see §6 | see §6 | — | — | the **keyring supplies** the real secret/FDSK — KR rows blocked |
| IPS-09 | SESSION_AUTHENTICATE: 24 octets = header · reserved 00h · user id · MAC. Only inside a SECURE_WRAPPER. User id 01h management, 02h–7Fh user; others reserved. MAC via CCM keyed with the **password hash**; A = header‖00h‖userId‖(X⊕Y) (a = 40), P empty. **One authenticate per ECDH session** — retry requires a new handshake | C: IPS §2.2.3.8.1–5, §2.2.3.8.3; example Annex A.3 (inf.) | see §6 | see §6 | 2.2.2, 2.2.4, 2.2.14, 2.2.15, 2.2.17, 2.2.22, 2.2.23, 2.2.29 | — | — |
| IPS-10 | Password hash = PBKDF2(HMAC-SHA-256, password, salt `"user-password.1.secure.ip.knx.org"`, 65 536, 128-bit). Empty password hash is fixed (E9C304B9…) | C: IPS §2.3.1.4.1, §2.3.1.4.3; example Annex A.3.1 ("secret") (inf.) | see §6 | see §6 | — | — | passwords come from keyring/user (KR blocked) |
| IPS-11 | SESSION_STATUS: 8 octets, inside a wrapper; status 00 AUTHENTICATION_SUCCESS, 01 AUTHENTICATION_FAILED, 02 UNAUTHENTICATED, 03 TIMEOUT, 04 KEEPALIVE (client), 05 CLOSE; ending statuses unconfirmed (TCP may be closed immediately); wait ≤ 10 s | C: IPS §2.2.3.9.1–2, §2.4.1; example Annex A.4 (inf.) | see §6 | see §6 | 2.2.7, 2.2.8, 2.2.18–2.2.21 | — | — |
| IPS-12 | Session state machine (server view): auth timeout 10 s, idle session timeout 60 s; client may send KEEPALIVE; any non-authenticate frame before success → UNAUTHENTICATED; failed authenticate → FAILED + close | C: IPS §2.2.3.5.2.1–6, §2.4.1 | see §6 (client view) | see §6 | 2.2.5, 2.2.13, 2.2.16, 2.2.18–2.2.23, 2.2.37, 2.2.38 | — | — |
| IPS-13 | Unicast sequence: 48-bit counter per direction, **starts at 0** per connection, +1 per frame sent; receiver stores the last received and discards ≤; no requirement of +1 steps; no wrap-around design (9-year bound noted) | C: IPS §2.2.3.3; §2.2.1.3.1 | see §6 | see §6 | 2.2.24 (70224) | — | — |
| IPS-14 | Secure unicast sessions **must use TCP and must not use UDP**; a session lives in one TCP connection; closing the TCP connection closes the session and its KNX connections | C: IPS §2.2.3.3, §2.2.3.6.4, §2.4.2 | **not started** (no TCP transport — gap G3) | — | 2.2.3, 2.2.9, 2.2.25 | — | — |
| IPS-15 | Inside an authenticated session all connection traffic (CONNECT_REQUEST, TUNNELLING_REQUEST, CONNECTIONSTATE, DISCONNECT…) is wrapped; plain frames for those connections are ignored; Disconnect/ConnectionState outside the session → E_CONNECTION_ID | C: IPS §2.4.1 | **not started** | — | 2.2.30–2.2.34, 2.2.36 | — | numeric value of E_CONNECTION_ID **U** (Overview absent) |
| IPS-16 | Unwrapped CONNECT_REQUEST accepted only if the family is non-secure; tunnelling access: management user always, other users via PID_TUNNELLING_USERS; tunnelling addresses linked to users | C: IPS §2.2.1.4.2, §2.3.1.8; TUN §5.4.3.3 | server-side; client must request an allowed address (Extended CRI, TUN §5.4.3.2) | — | 2.7.14, 2.7.19, 2.7.23–2.7.28 | — | G5 |
| IPS-17 | Discovery: secure-capable servers list service family 09h version 01h and a *Secured Service Families* DIB (type 06h) **only** in extended search responses | C: IPS §2.6.2.1–2 | **not started** (needs Core v2 SearchRequestExtended) | — | 2.6.15–2.6.17 | — | **U**: Core v2 absent |
| IPS-18 | Multicast secure routing: session id 0000h; seq-info = 48-bit ms timer `mc_timer`; Secure Backbone Key (128-bit, per multicast address); latency tolerance default 2000 ms, sync fraction default 200 ms | C: IPS §2.2.2.1–2.2.2.3, §2.3.1.2, §2.3.1.6–7 | codec only (§6); runtime **not started** | — | 2.1.x | — | routing not in scope of current driver |
| IPS-19 | TIMER_NOTIFY: 0955h, fixed 36 octets; A = header (6), P empty, B0 = timer‖serial‖tag‖0000, Ctr0 = …FFh 00h; state machine events E01–E11, actions A0–A9 | C: IPS §2.2.2.3.2, §2.2.2.4; example Annex A.6 (inf.) | codec only (§6); state machine **not started** | — | 2.1.6–2.1.39 | — | — |
| IPS-20 | `mc_timer` must never decrease, must be persisted across power loss; authentic timer acquisition procedure; persistence interval rules | C: IPS §2.2.2.2.2, §2.2.2.3.2.8, §2.2.4.2 | **not started** | — | 2.1.8 | — | — |
| IPS-21 | CSPRNG required; fresh seed per power cycle | C: IPS §2.2.4.1 | D: use `node:crypto` CSPRNG | test: see §6 | — | — | — |
| IPS-22 | TCP stream handling for KNXnet/IP (fragmented / merged frames, malformed headers closing the connection, idle timeouts) | **U**: Core v2 (3/8/2) absent; T: TSSK 2.5.1–2.5.18 | **not started** | — | 2.5.x | — | **blocker for verified TCP behaviour**; header-driven deframing is derivable from the common header |
| IPS-23 | Tunnelling inside TCP: sequence counter not evaluated; **no** TUNNELLING_ACK sent; received ACKs ignored | C: TUN §2.6.2 | **not started** | — | 2.5.19, 2.5.20, 2.7.6 | — | — |
| IPS-24 | Secure tunnelling is the same tunnelling procedure carried in the session (CONNECT_REQUEST with two route-back HPAIs and a basic/extended CRI) | C: IPS §2.4.1; T: TSSK `GlPro_EstablishTunnellingConnection` | **not started** | — | 2.7.x | — | HPAI-over-TCP details are Core v2 (**U**) |

## 2. Standard tunnelling (verified against TUN) — see `knx-native-tunnelling-audit.md`

| ID | Requirement | Source | Native status | Evidence | HW |
|---|---|---|---|---|---|
| TUN-01 | Service types 0420h/0421h; 4-octet connection header; CRD with assigned IA; layers 02/04/80; type 04h | C: TUN §5.4 | codec, simulator | `knxnetip-frame.test.ts`, `tunnel-client.test.ts` | — |
| TUN-02 | UDP: 1 s ack timeout, repeat once, same sequence | C: TUN §2.6.1 | simulator | `tunnel-client.test.ts` | — |
| TUN-03 | After failure to be ACKed (timeout or error status): repeat once, **then terminate with DISCONNECT_REQUEST** | C: TUN §2.6.1 | **gap G1/G2 → fixed this session (see §6)** | — | — |
| TUN-04 | Inbound sequence rules (expected / expected−1 / otherwise) | C: TUN §2.6.1 | simulator | `tunnel-client.test.ts` | — |
| TUN-05 | Extended CRI (6 octets with requested IA) | C: TUN §5.4.3.2 | **not started (G5)** | — | — |
| TUN-06 | TUNNELLING_FEATURE_GET/RESPONSE/SET/INFO (0422h–0425h) and Interface Features | C: TUN §3 | **not started (G4)** | — | — |
| TUN-07 | TCP-mode tunnelling rules | C: TUN §2.6.2 | **not started (G3)** | — | — |
| TUN-08 | Connection-header length: Fig. 8/16 = 04h; Fig. 15 prints 06h | C but self-contradictory | strict 04h kept; **erratum E1** | — | needs real capture |

## 3. KNX Data Secure (application layer) — normative source AL §5 and Annexes A, C (integrates AN158)

| ID | Requirement (paraphrased) | Source | Impl status | Tests / evidence | Conformance cases (TSSJ) | HW | Uncertainty / blocker |
|---|---|---|---|---|---|---|---|
| DS-01 | Secured APDU: APCI "Secure" = 3F1h; Security Control Field (1 octet: tool-access bit, SAI, system-broadcast bit, S-AL service: 000 data, 010 sync req, 011 sync res); SAI 000 = CCM auth only, 001 = CCM auth + confidentiality; other values reserved | C: AL §5.1.3.1, §5.2.1.2 (Fig. 105–107, Table 6–7) | **not started** (blocked, see policy below) | — | 3.1.4–3.1.8 | — | scope decision: Data Secure stays BLOCKED pending resources doc |
| DS-02 | Secure Data = SeqNr (6) ‖ [plain APDU or ciphertext] ‖ MAC (**4 octets** = MSB32(Yn)) | C: AL §5.1.3.4–5, Annex A.3 | **not started** | — | — | — | — |
| DS-03 | CCM for S-AL: B0 = SeqNr‖SA‖DA‖00h‖AT‖TPCI/APCISec‖00h‖q (q 1 octet); AT = A000EEEEb (A = address type); Ctrⱼ = SeqNr‖SA‖DA‖00 00 00 00 01‖[j]; auth-only: A = SCF‖000000b‖plain APDU, P empty; A+C: A = SCF, P = 000000b‖plain APDU | C: AL §5.1.3.2–5; Annex A (inf.); worked examples Annex C.1.1–C.1.4 (inf.) | **primitive shared with IPS-03 (§6); S-AL itself not started** | primitive verified against C.1.x (§6) | — | — | — |
| DS-04 | Receive order: verify SCF (reserved/unsupported → drop, **not logged**) → verify SeqNr → decrypt → verify MAC; **after** success check the 000000b field; on any failure the plain APDU is **not** passed up even in auth-only mode ("no exceptions to a failed security check") | C: AL §5.1.3.4.2, §5.1.3.5.2, §5.2.1.4, §5.5.2 | **not started** | — | 3.1.x, 3.2.x | — | — |
| DS-05 | Sequence numbers: 48-bit; one sending counter for **all** secure communication; incremented on every S-A_Data handed to TL **even if transmission fails**; never wraps (stops at FFFFFFFFFFFFh); receiver keeps "Last Valid SeqNr" **per sender IA**; > accept, = ignore silently, < ignore + failure log; persist at power-down; initial value 1–255, **not 0**; re-init after master reset | C: AL §5.3.1 | **not started** | — | 3.1.9, 3.1.10 … | — | persistence + initial value for a *non-device* participant is **U** (no resource doc) |
| DS-06 | S-A_Sync: request (SeqNr_local, serial number, challenge, MAC) / response (challenge⊕random, SeqNr_remote, SeqNr_local) encrypted A+C; 6 s timeout; responder rate-limit 1 s; sequence reconciliation rules | C: AL §5.3.2; Annex C.1.3–C.1.4 (inf.) | **not started** | — | 3.3.x, 3.4.x | — | needed if SupremeOS must learn peers' counters (**U**: keyring may supply them) |
| DS-07 | Group communication: look up GA in the Group Key Table; tool-access flag on a group telegram = attack (counted, dropped); verify before forwarding; GA not in table → ignore; non-S-A_Data telegrams forwarded unchanged; sending with par_auth/par_conf requires the GA in the table, else negative confirm | C: AL §5.5.3 | **not started** | — | 3.2.x | — | **Group Key Table / Group Object flags live in Resources [04] — absent (U)** |
| DS-08 | Security failure registration (cryptographic errors; optional SeqNr-error counter) | C: AL §5.4 | **not started** | — | — | — | for SupremeOS: diagnostics only |
| DS-09 | Fail-safe for unrecognised APDUs on groups | D (consistent with C: AL §5.5.2.1) | **done**: non-plain group APCIs withheld & counted (`undecodedGroupTelegrams`) | `security.test.ts` (APCI 3F1h case — which is the **real** secure APCI) | — | — | counter cannot distinguish secured from other unknown APDUs |
| DS-10 | Access Policies (AN193), Master Reset (AN194), Coupler proxy (AN192), PB-mode config (AN169, Draft) | C: scope read | **N/A for a tunnel client** (server/device side) | — | 3.6, 3.7, 3.8 | — | revisit only if SupremeOS emulates a secure *device* |
| DS-11 | Key sources: Group Key Table, P2P Key Table, Tool Key, FDSK, Security IA table, PID_SEQUENCE_NUMBER_SENDING, Group Object security flags | **U**: Chapter 3/5/1 Resources (cited by AL [04]) absent | — | — | 2.x | — | **BLOCKER** |

**Policy (D):** All Data Secure runtime items stay **BLOCKED** until Resources [04] and the keyring format are supplied, even though the S-AL
codec rules (DS-01…DS-06) are fully readable: shipping a verifier without the key/sequence-state model would invite a false sense of
coverage. The shared CCM primitive is delivered because IP Secure requires it (IPS-03) and Data Secure's own worked examples then
serve as additional verification of that primitive.

## 4. Keyring, credentials, commissioning

| ID | Requirement | Source | Status | Blocker |
|---|---|---|---|---|
| KR-01 | `.knxkeys` file structure, integrity/signature, encryption | **U** — searched all 12 documents: **no occurrence of "keyring", "knxkeys", "knxproj"** | **BLOCKED** | document absent |
| KR-02 | Mapping of keyring contents to IPS credentials (device authentication code / FDSK, user password hashes, backbone key) and DS credentials (group keys, tool key, per-device sequence info) | **U** (roles themselves are C: IPS §2.3.1, AL §5.1.3.2/5.5.3, but the *file → role* mapping is absent) | **BLOCKED** | document absent |
| KR-03 | ETS commissioning side effects needed for SupremeOS to be accepted (tunnelling address ↔ user, peers' Security IA tables, sequence-number registration) | partially C: IPS §2.3.1.8, TUN §5.4.3.3; remainder **U** | **BLOCKED** (partial) | Resources [04], Mgmt/Config procedures [05] absent |
| KR-04 | Format-independent validation/activation infrastructure | D | **done** (`import-activation.ts`, prior session) | — |

## 5. Spec-independent controls delivered earlier (unchanged; see previous revision for evidence)
S-01…S-15: secret redaction, encrypted key store (unlock-mode bound, generation/lock), transactional import, fail-closed policy & flags,
simulator isolation. These implement **decisions (D)**, not KNX requirements.

## 6. Implementation status of the IP Secure work (authoritative: `knx-secure-security-test-report.md`)

Evidence legend: **V** = reproduces the spec's own worked example (needs the local licensed vectors; skipped otherwise) · **I** = independent
property/cross-check test · **S** = simulator test (our own simulated gateway — a self-authored peer) · **HW** = real hardware (none).

| Req | Status | Evidence |
|---|---|---|
| CCM primitive (IPS-03, DS-03) | implemented, `secure/ccm.ts` | V (IPS A.2–A.6, AL C.1.1–C.1.4) + I (Node CBC/CTR cross-check, tamper) |
| Key derivation, ECDH, session key (IPS-04…) | implemented, `secure/ip-keys.ts` | V + I |
| Frame codecs 0950–0955 | implemented, `secure/ip-frames.ts` | V (all spec binary examples) + I |
| B6 ASCII-only password guard (temporary, I); B7 resolved (N, §2.2.3.5.2.5 E03); B8 wrapper ≤ 4 118 enforced (N-derived) | implemented | V-independent + S (13 tests, mutation-verified) |
| Classic tunnel client over `TunnelLink` (UDP only) | implemented, behaviour-preserving | golden wire traces + route-back tests (11) |
| Review fixes D5 (reflection/serial) and D6 (fail closed on faults) | implemented, not spec text | S (4 regression tests, mutation-verified) |
| Session establishment, server auth, timeouts, sequence rules, close (IPS-05…13) | implemented client, `secure/ip-session.ts` | S only (35 tests); decisions D1–D4 |
| TCP stream deframing (IPS-14/22 partial) | `secure/stream.ts` header-driven deframer | S; Core v2 stream rules remain **U** |
| Real TCP socket (`node:net`), `tcp-socket.ts` | implemented as a byte pipe; Core v2 TCP rules **U** | loopback-TCP (24 tests, real kernel sockets, simulated gateway on the far end) — not a real gateway |
| Tunnelling inside the session (IPS-15/23/24) | **BLOCKED-SPEC** (HPAI/heartbeat/disconnect over TCP are Core v2; see `knx-ip-secure-security-review.md` §5) | — |
| Discovery (IPS-17), multicast routing runtime/timer machine (IPS-18…20) | **not started** (codec only for 0955) | — |
| Data Secure S-AL (DS-01…08), keyring (KR-*) | **BLOCKED-SPEC** — nothing implemented | — |

No row has HW evidence. Passing self-authored simulator tests is not interoperability with any real KNX IP Secure device.

## 6a. Blocker cross-reference (2026-10-17)
IPS-14/15/22/23/24 and the rows they depend on are tracked precisely in `knx-secure-blocker-matrix.md` (B1 Core v2/Overview · B2 AN183 · B3 TCP HPAI ·
B4 heartbeat/liveness · B5 E_CONNECTION_ID/disconnect · B6 password encoding · B7 pre-auth close · B8 frame limits · B9 client serial). IPS-23 (no ACK,
ignore ACK, no sequence evaluation on TCP) stays **N**; IPS-24 and IPS-22 stay **BLOCKED**. The proposed structure for IPS-24 is
`knx-secure-tunnelling-architecture.md`. New row:

| ID | Requirement | Source | Status | Blocker |
|---|---|---|---|---|
| IPS-25 | Client's KNX serial number in SECURE_WRAPPER security information (sender's serial; nonce input) | C: IPS §2.2.1.3.1/§2.2.1.3.2 | option mandatory, no default; allocation rule **U** | B9 |
| D5 | Own-serial reflection drop | **I** (not in text) | implemented, simulator-tested, not conformance-tested | review conditions in blocker matrix §3 |

## 7. Still-missing documents (ordered by what they unblock)

| Priority | Document | Unblocks |
|---|---|---|
| 1 | Chapter 3/8/2 **KNXnet/IP Core (v2)** | TCP behaviour, connection/heartbeat/disconnect, HPAI/CRI over TCP, Search Request Extended — IPS-14/17/22/24 |
| 1 | Chapter 3/8/1 **KNXnet/IP Overview** | all status/error code values — E_CONNECTION_ID & friends |
| 1 | **ETS keyring file format description** | KR-01…KR-03 |
| 2 | Chapter 3/5/1 **Resources** (Security Interface Object, key tables, FDSK, security flags) | DS-05/07/11 |
| 2 | Volume 6 **Profiles** | which features a tunnelling client must support (TUN-06) |
| 3 | Chapter 3/5/2 Management & 3/5/3 Configuration Procedures | secure sync procedures, commissioning |
| 3 | Chapter 3/8/3 Device Management v2 | secure device-management connections |
| 3 | standalone AN158 v07 AS (2019.08.20) | to confirm the Application Layer integration is complete |
| 4 | EITT test templates / any official conformance vectors | executing conformance rather than describing it |

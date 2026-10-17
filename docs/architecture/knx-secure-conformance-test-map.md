# KNX Secure — Conformance-Test Coverage Map (TSSK = IP Secure, TSSJ = Data Secure)

**Nothing in this document is an executed conformance result.** The bundle contains the test *descriptions* only — no EITT test
templates, no executable vectors, no test tool. "Coverage" below means: which published test cases correspond to which requirement,
and which would exercise which SupremeOS component *if* an equivalent harness were run. Test titles/IDs/clauses are cited as
identifiers; test text is not reproduced (licence). Full TSSK index: `knx-secure-tssk-test-index.csv` (202 rows).

## 0. Who the tests certify (this decides their value to SupremeOS)

* **TSSK** defines **"Server = BDUT"** (Bus Device Under Test) and **"Client = the test tool"**. Every case certifies a KNXnet/IP
  *server or router*. SupremeOS acts as a **client** (tunnelling client; later possibly a routing participant). The tests therefore do
  **not** certify SupremeOS. Their value: (a) an independent description of how a conforming server reacts to each client behaviour —
  the basis for our simulator's server model and for *negative* client tests; (b) the test tool's own client procedures
  (`GlPro_SecureSessionSetup`, `GlPro_EstablishTunnellingConnection`) cross-check our reading of the spec (they agree — see §3).
* **TSSJ** certifies **KNX Data Security devices** ("S-mode"/E-mode devices with a Security Interface Object, key tables and
  property resources). SupremeOS is not such a device unless it deliberately emulates one. Group-communication cases (3.2) are the
  most relevant to a Data-Secure group member; the property/resource chapters (3.8, 4–6) are device-side.

## 1. TSSK v1.1 AS (2018-03-07) — 202 test cases

Count verified two ways: parsed `Test ID` blocks (203 incl. one duplicated 2.7.22 artefact) vs TOC arithmetic (42+39+11+32+31+20+27 = 202;
overview headings 2.1.43, 2.2.40 and the removed 2.7.7 are not tests).

| Area | Cases | Subject | Cited source revisions (as printed in TSSK) | Applies to SupremeOS client? | Spec clauses in current text |
|---|---|---|---|---|---|
| 2.1 Multicast | 42 | secure routing, mc_timer sync state machine, TIMER_NOTIFY | AN159 v05 DV | only if SupremeOS joins a secure routing group (not planned) | IP Secure §2.2.1.3, §2.2.2.x, Annex B |
| 2.2 Unicast | 39 | secure session setup/auth/keepalive/timeout/sequence/close | AN159 v05 DV; KSG616-xx | **yes — defines server reactions our client must handle** | §2.2.3.x, §2.4 |
| 2.3 Resources | 11 | PID_BACKBONE_KEY … PID_TUNNELLING_USERS | AN159 v05; KSG616-20.03 | no (device-side properties); informative for commissioning | §2.3.1.x (**numbering shifted +1 vs TSSK**) |
| 2.4 IP System Broadcast | 32 | routing system broadcast, domain address write | KSG668-15.01 (AN183) | no | AN183 (integration only "started" in AL) |
| 2.5 Core v2 TCP | 31 | TCP framing (fragment/merge), idle timeouts, HPAI rules, ACK-less tunnelling | KSG696-08.01; AN184 v02 DV | **yes — TCP behaviour our client needs**, but **Core v2 spec is absent** | Core v2 (3/8/2) ❓; Tunnelling §2.6.2 ✅ |
| 2.6 Core v2 Discovery | 20 | SearchRequestExtended, DIBs incl. Secured Service Families | KSG696-08.01; AN184 v02 | partly (discovering whether an interface requires security) | IP Secure §2.6.2; Core v2 ❓ |
| 2.7 Tunnelling v2 | 27 | feature services, connect errors, extended CRI, tunnelling users | KSG643-20.01/21.02 (AN185) | **yes** | Tunnelling v01.07.01 ✅ |

### 1.1 Cases that most directly constrain the **client** (use as simulator scenarios; none executed)

| TSSK | Case (title) | Requirement exercised (current clause) | Native status |
|---|---|---|---|
| 2.2.2 (70202) | Secure session setup, management user | IP Secure §2.2.3.6–2.2.3.9, §2.4.1 | not implemented |
| 2.2.4 | Secure session setup, user level | §2.2.3.8.2 user ids 02h–7Fh | not implemented |
| 2.2.5, 2.2.18, 2.2.19 | traffic/keepalive keeps alive; session timeout | §2.2.3.5.2 (60 s) | not implemented |
| 2.2.13, 2.2.15, 2.2.16, 2.2.20–23, 2.2.29 | missing/invalid/duplicate authentication, timeouts | §2.2.3.5.2.5 transition table, §2.4.1 | not implemented |
| 2.2.24 (70224) | Sequence Number tests (48-bit, equal/lower ignored, highest-ever) | §2.2.3.3 | not implemented |
| 2.2.25, 2.2.28 | SESSION_REQUEST via UDP / non-route-back HPAI ignored | §2.2.3.6.4 | n/a for client (it must never send these) |
| 2.2.36 | Disconnect/ConnectionState return E_CONNECTION_ID outside session | §2.4.1 | not implemented |
| 2.2.35 | different server public key after power cycle | §2.2.3.1.1 | client should check Y differs (see test-tool check) |
| 2.5.2, 2.5.3 | fragmented / merged TCP frames | Core v2 ❓ | **needed**: stream deframer |
| 2.5.19, 2.5.20 | TCP: sequence counter ignored; no ACKs | Tunnelling §2.6.2 ✅ | not implemented (gap G3) |
| 2.7.10–2.7.15, 2.7.18, 2.7.19 | connect error codes | Tunnelling §5.4.3.3; values in Overview ❓ | status values partly unverified |
| 2.7.23 | extended CRI | Tunnelling §5.4.3.2 ✅ | not implemented (G5) |

## 2. TSSJ v1.11 AS (2020-12-21) — numbered leaf headings (TOC count, **not** a verified test count)

Written "in accordance with" (as printed in its summary): **AN158/13 v07 AS**, AN163/13 v04 **DV**, AN177/15 v03 AS, AN170/15 v03 AS,
AN193/18 v04 AS, AN194/19 v02 AS. Test bodies are EITT telegram scripts.

| Chapter | Leaf headings | Subject | Relevance to SupremeOS |
|---|---|---|---|
| 3.1 S-A_Data with Tool Key | 29 | point-to-point secured PDUs (tool key), SCF/SAI/APCI validity, sequence handling | S-AL codec rules (App. Layer §5.1.3, §5.2, §5.3.1); tool key used by ETS, not at runtime |
| 3.2 S-A_Data with **Group Key** | 19 | secured **group** read/write/response; A vs A+C vs plain per Group Object; sender/receiver keys | **most relevant** (App. Layer §5.5.3) |
| 3.3 S-A_Sync_Req | 22 | sync request handling, rate limit, serial-number rules | App. Layer §5.3.2 |
| 3.4 S-A_Sync_Res | 10 | response contents, challenge/random, sequence conclusions | §5.3.2 |
| 3.5 S-A_Data for routing | (single section) | secured frames over routing | AN192 / IP |
| 3.6 KNX Secure Access | 11 | access to secure device functions | device-side |
| 3.7 Access Policies | 16 | per-service policy in security mode (AN193) | device-side |
| 3.8 KNX Secure Properties with Tool Key | 99 | security interface-object properties | device-side (resources [04] absent) |
| 3.9 TL repetitions in secure mode | (single) | transport-layer repeats | device-side |
| 4.x AN163 Extended Interface Object Addressing | 61 | PropertyExt services | device-side, plain/secure |
| 5.x AN177 Extended Memory | 13 | MemoryExtended | device-side |
| 6.x AN170 Group Object Diagnostics | 30 | PID_OPERATION_MODE, PID_GO_DIAGNOSTICS | device-side |

TSSJ uses **symbolic keys** (TK1, GK1…GK5, FDSK; no literal key bytes) and its hex runs are *pre-encryption* telegram scripts that the
test tool encrypts ("Key: TK1"); it contains **no ciphertext or MAC reference values**. **The only numeric Data Secure vectors in the
bundle are Application Layer Annex C.1.1–C.1.4** (informative). The only numeric IP Secure vectors are IP Secure Annex A.1–A.6 (informative).
AN209 rev 3 amends TSSJ v1.11 test templates (sequence-number magnitudes, clean-up steps) and is itself not yet shown as finally
approved (§ inventory #12).

## 3. Cross-checks between the two independent descriptions (consistent unless noted)

| Item | Normative text says | Test spec says | Result |
|---|---|---|---|
| Session setup order | REQUEST → RESPONSE → wrapped AUTHENTICATE → wrapped STATUS | `GlPro_SecureSessionSetup` same | consistent |
| Response checks the tester performs | MAC "optionally" validated by client (§2.2.3.7.5) | tester **always** checks header, length 38h, session id ≠ 00h, **Y ≠ 0, Y ≠ X, Y not repeated**, MAC vs device auth code | the tester's checks are stricter than "optional" — adopt them in SupremeOS |
| Default Device Authentication Code | = FDSK in ex-factory state (§2.2.3.4, §2.3.1.3.3) | default parameter `deviceAuthenticationCode = Fdsk` | consistent |
| Tunnel connect inside secure session | wrapped CONNECT_REQUEST (§2.4.1) | "Send a ConnectRequest with two Route Back HPAIs and CRI" | consistent (HPAI TCP details are Core v2 ❓) |
| Replay rule | ≤ stored → discard (§2.2.3.3) | highest-ever, not last/not counter (2.2.24) | consistent; test also flags the AN159 v05 prose as misleading |
| Resource clause numbers | PID_BACKBONE_KEY at 2.3.1.2 | cites 2.3.1.1 | **drift** — never copy a TSSK clause number into the matrix without re-locating it |

## 4. Unanswered questions (cannot be resolved from the bundle)

1. Core v2 (3/8/2) rules for TCP: idle timeout, behaviour on malformed header, CONNECT_REQUEST HPAI/CRI validity over TCP, heartbeat inside TCP.
2. Numeric values of E_CONNECTION_IN_USE, E_AUTHORISATION_ERROR, E_NO_TUNNELLING_ADDRESS, E_CONNECTION_OPTION, E_CONNECTION_ID (Overview).
3. How a **client** that holds only keyring data initialises its knowledge of each peer's Last Valid SeqNr for Data Secure (sync vs keyring-supplied value) — keyring format absent.
4. Group Object security flags and Group Key Table semantics (Resources [04]) — determines whether a *plain* telegram to a secured Group Object must be dropped.
5. Whether SupremeOS's tunnel individual address must be registered in peers' Security IA tables (ETS commissioning) before its secured group telegrams are accepted.
6. Which Volume 6 profile applies to a tunnelling *client* (feature-service mandatory status).
7. Whether AN170/AN183/AN193 integration into the Application Layer is complete.

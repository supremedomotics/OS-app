# KNX Secure — Specification Acquisition Plan

Goal: obtain the normative documents, exact revisions and lawful conformance material that `knx-secure-requirements-matrix.md`
§0.3 lists, through channels the KNX Association itself provides. Nothing here involves bypassing licensing.

**Basis and limits.** The only statement about access terms is the one supplied by the project from the KNX Specifications page:
the full specifications are available **to KNX members**, and the Navigator is an aid, not an authority. Everything about
*which* membership category, price, licence conditions, or whether test material is included is **UNKNOWN** and is a question
for the KNX Association, not something to assume. This environment cannot reach any KNX site, so none of it was checked here.

## Shortest legitimate route (in order)

1. **Check what Supreme Domotics already holds (days, no cost).** Ask whoever manages KNX tooling whether the company already
   has a **MyKNX account**, a **KNX membership** of any category, or ETS licences. ETS users commonly already have a MyKNX login;
   whether that login exposes the specifications and application notes is **U** — try it with the page "KNX Specifications".
2. **If the existing login shows the specs:** download the documents in matrix §0.3 into a **restricted location outside the
   repository** (licence), record exact title / number / revision / date, then do the "On receipt" steps below. This is the
   fastest possible outcome.
3. **If not: ask the KNX Association directly** through its official contact/membership channel (via knx.org). Ask the
   questions in the box below. Request a written answer, because licence terms govern what may be implemented, quoted or
   reproduced in tests.
4. **Join at the category the Association confirms gives specification access for product development.** Do not guess the
   category; fees and lead time are **U**.
5. **In parallel (do not wait on 1–4):** obtain an **ETS licence** able to create a *secure* test project and export a keyring
   with test credentials, and source a **KNX IP Secure interface/router** and **Data Secure devices** for a bench. Both are needed
   at the hardware-validation stage regardless of the documents.

### Questions for the KNX Association (copy into the request)
1. Which membership category gives access to the full KNX Specifications including **AN 158, 163, 177, 170, 193, 194, 159, 183,
   184, 185**, the **keyring file format** description, and the base specification volumes those ANs reference? Cost and timeline?
2. What are the **current revisions** of each, and is any superseded or merged into a Standard release? Minimum revisions for a
   new Secure implementation (the "Updating stack for KNX Secure" page)?
3. Under what licence may a company implement KNX Secure **from the specifications in its own stack** (not a licensed third-party
   stack), including patent/IPR terms, and are there restrictions on quoting spec text or test vectors in an internal test suite?
4. Are **conformance test specifications and test vectors** for IP Secure and Data Secure available, to whom, and do they require
   an accredited test lab or certification process? What certification is required to ship a product claiming KNX Secure?
5. Are there **interoperability test events** or reference devices for developers?
6. Does an implementation that talks to ETS-produced keyrings require any additional agreement?

## On receipt (before any code)
- Keep documents out of git; log them in the matrix by number/revision/section only.
- Turn each §0.3 row into verified requirements: set Source to **C** with `AN nnn rev x §y`, fill unresolved items as **U**.
- Re-check the existing `native/` classic tunnelling against AN 183/184/185 (IPS-11) *before* building secure sessions on it.
- Derive test vectors only as the licence allows; author negative/property tests independently; never use `knxultimate` as the oracle.
- Then, and only then, start plan stage S3/S4 (`knx-secure-implementation-plan.md`).

## Fallback if membership/licensing proves impractical (decision for the product owner, not made here)
A KNX-certified licensed Secure stack from a vendor would satisfy "Secure supported" sooner but conflicts with the clean-room,
no-third-party goal and has its own licence/cost; reference open-source implementations may be read only to understand
interoperability, subject to their licences, and never copied. This trade-off needs an explicit decision if step 3–4 stall.

## Owner / status
| Step | Owner | Status |
|---|---|---|
| Inventory existing MyKNX/membership/ETS | project owner | **open — needs a human** |
| Retrieve documents (if accessible) | person with login | open |
| Membership enquiry | project owner | open |
| ETS licence + secure bench hardware | project owner | open |

---

## Addendum 2026-10-17 — exact documents and questions to close the secure-tunnelling blockers

Blocker IDs (B1–B9) are defined in `knx-secure-blocker-matrix.md`. Document names follow the numbering of the supplied bundle
(`03_08_xx <Title> vNN.NN.NN AS`, KNX Standard v3.0). **Revisions marked "?" are not known to us; ask for the current Approved Standard.**
Revisions quoted from the conformance test spec are those the *2018 test baseline* used — they are older drafts, not the target.

### A. Documents needed (priority order)

| # | Exact document | Why / unblocks | Revisions we can name | Notes |
|---|---|---|---|---|
| 1 | **03_08_02 KNXnet/IP Core** (the "Core v2" chapter, integrating **AN184** v2, 2020.12.22 per the Tunnelling front matter) | B1, B3, B4, B5, B8: HPAI rules on TCP, TCP receive/idle/frame-sync rules, CONNECTIONSTATE/DISCONNECT on TCP, header validation list | Final Approved Standard in Specifications v3.0: **?**. Test baseline cited `KSG696-08.01` (2017.04.04/07) and `AN184 v01 DP` (2016.11.18) / `v02 DV` (2017.05.02) | Clauses to read first (per TSSK citations, numbering may have drifted): 2.2.3.2.3, 2.2.3.2.3.1, 2.2.3.2.4.1, 2.2.3.2.5, 2.2.3.2.7, 2.2.3.2.8, 2.2.3.4 |
| 2 | **03_08_01 KNXnet/IP Overview** | B1, B5: numeric status/error codes (E_CONNECTION_ID …), **timeout constants §5.8** (TimeoutKnxConnection, …ConnectionStateResponse, …ConnectResponse), service-type ranges | TSSK cites **v01.04.02 AS, §5.8**; current: **?** | Also confirm `TimeoutIdleTcpConnection` source (TSSK lists it as "AN184 v01 DP 2.2.2.2.3", i.e. Core, not Overview) |
| 3 | **AN183 "IP System Broadcast"** (standalone, current revision) | B2 | TSSK cites `KSG668-15.01 System Broadcast` (2017.07.04) and "AN 183"; Application Layer v02.01.01 notes integration *started* 2020.10.26 | Need current revision and whether its integration into AL is complete |
| 4 | **ETS keyring (`.knxkeys`) format description** | B6 (password representation), credential mapping KR-01..03 | – | Not in the bundle; also decides how DAC/FDSK/user passwords reach SupremeOS |
| 5 | **03_05_01 Resources** | Data Secure keys/sequence state (DS-05/07/11) | ? | Not needed for IP Secure tunnelling itself |
| 6 | **Volume 6 Profiles** (IP Secure / Tunnelling client profile) | which TUN features a client must support | ? | |
| 7 | **TSSK** current revision and **EITT templates** | executing, not just describing, conformance; re-baselined against IPS v01.01.02 | supplied TSSK v1.1 AS (2018.03.07) is older than IPS v01.01.02 (2021.10.08) | |
| 8 | Standalone **AN158 v07 AS** (2019.08.20), **AN159 v06** | to confirm the integrated texts are complete | – | low priority |

### B. Questions for the KNX Association (blocker-specific; paste with the membership questions above)

1. **[B3]** For a CONNECT_REQUEST, CONNECTIONSTATE_REQUEST and DISCONNECT_REQUEST sent *inside* a TCP connection, which HPAI is required for control and
   data endpoints (we understand TCP route-back 02h 0.0.0.0:0), and which HPAI does the server return in CONNECT_RESPONSE? Which clause states that a request with any
   other HPAI is silently ignored?
2. **[B4]** On a KNX connection carried over TCP (plain and inside a secure session): is CONNECTIONSTATE_REQUEST still the keep-alive? What resets
   `TimeoutKnxConnection` — only CONNECTIONSTATE, or any received frame? What must a client do when CONNECTIONSTATE_RESPONSE is missing?
3. **[B4/B8]** What are the receive timeout for an incomplete frame and `TimeoutIdleTcpConnection` for a *client*, and are they normative for clients or only servers?
4. **[B5]** Numeric value of `E_CONNECTION_ID` and the other connection status codes (confirm: E_CONNECTION_ID 21h, E_CONNECTION_TYPE 22h, E_CONNECTION_OPTION 23h,
   E_NO_MORE_CONNECTIONS 24h, E_TUNNELLING_LAYER 29h — these are in our code but unverified). Is DISCONNECT_REQUEST required before closing a session/TCP connection? Is it confirmed on TCP?
5. **[B7]** May a client send SESSION_STATUS(CLOSE) before authentication succeeds? What does a server do with it? Is merely closing the TCP connection always acceptable?
6. **[B6]** What character encoding/normalisation is applied to the user password before PBKDF2 (UTF-8, Latin-1, other)? Maximum length? Does ETS apply the same?
7. **[B8]** Which malformed-header conditions must a *client* treat as fatal for a TCP connection, and what is the maximum KNXnet/IP frame a client must accept?
8. **[B2]** Does AN183 impose any obligation on a tunnelling client that only sends/receives group-addressed telegrams?
9. **[B9]** Which KNX serial number may a software client without an assigned device serial place in the SECURE_WRAPPER security information? Is a serial allocated for software tools?
10. **[D5]** Is it guaranteed that a server never uses the client's serial number in wrappers it sends? Do servers ever reject a client wrapper because of its serial?
11. Do interoperability events or a reference gateway with known test credentials exist for a *client* implementation?

### C. Question register for the KNX Association (2026-10-17 revision — supersedes the ordering of B above where they differ)

Legend — **Published?**: can the question be settled from the published specifications alone (once the named document is available to us), or does it need a
**written** KNX Association statement? Evidence classes N/T/I/U as in `knx-secure-blocker-matrix.md`. Document names are the ones used in the supplied bundle
(`03_08_xx …`); **revisions are not invented** — where we do not know the current revision the question asks for it.

| # | Topic | Published? | What we already have | Question to send (written answer requested) |
|---|---|---|---|---|
| 1 | Password character encoding / normalisation (B6) | **Written clarification** (also possibly the keyring-format document) | N: PBKDF2 inputs and an ASCII worked example; nothing on encoding (U). Guard: non-ASCII refused (I) | Which encoding and normalisation is applied to a user password and to the Device Authentication Code input before PBKDF2? Maximum length? Same as ETS? |
| 2 | Client serial assignment / uniqueness (B9) | **Written clarification** | N: serial = sender's KNX serial, part of the nonce; not exchanged in the handshake. Unicast uniqueness between directions is only inferred (U) | Which serial number must a software client without a device serial place in SECURE_WRAPPER? Is one allocated for software/tools? Must it differ from the server's? Does a server ever validate it? |
| 3 | Pre-authentication close (B7) | **Answered by published text** — IPS v01.01.02 §2.2.3.5.2.5, E03/UNAUTHENTICATED | N (see matrix B7) | none required. Optional confirmation only: "a client that closes before the SESSION_RESPONSE simply closes TCP — correct?" |
| 4 | AN183 applicability to a group-telegram tunnelling client | **Published (once AN183 / current System Broadcast text is available), else written** | T: TSSK 2.4 tests *routers*; Application Layer notes integration "started"; IPS profile table has a "KNX IP System Broadcast" row (U for clients) | Does AN183 (IP System Broadcast) impose any obligation on a KNXnet/IP tunnelling client that only exchanges group-addressed telegrams? Which document/revision is normative? |
| 5 | TCP HPAI / addressing (B3) | **Published in KNXnet/IP Core (03_08_02), not yet supplied** | N: HPAI in SESSION_REQUEST only; T: TSSK 2.5.21 (UDP HPAI over TCP ignored) | (if Core stays unavailable) Which HPAI is required in CONNECT_REQUEST / CONNECTIONSTATE_REQUEST / DISCONNECT_REQUEST inside TCP, and which does the server return? |
| 6 | TCP heartbeat and liveness (B4) | **Published in Core**, not supplied | T only (TSSK 2.5.13/2.5.18: server idle timers) | Is CONNECTIONSTATE_REQUEST still the keep-alive on TCP and inside a secure session? What resets the server's connection timeout? Client obligations when the response is missing? |
| 7 | E_CONNECTION_ID value; disconnect behaviour (B5) | **Published in KNXnet/IP Overview (03_08_01) and Core**, not supplied | N: IPS §2.4.1 names E_CONNECTION_ID, §2.4.2 implicit close; numeric values U (our code's 0x21 etc. unverified) | Numeric status codes (confirm or correct); is DISCONNECT_REQUEST required/confirmed before closing a session or TCP connection? |
| 8 | Frame-size and partial-frame limits (B8) | **Partly published** — wrapper ≤ 4 118 / P ≤ 4 080 is N (IPS §2.2.1.3.2 note); stream rules are in Core | N-derived for the wrapper; client receive timeout for a partial frame, oversize plain-frame handling: U | Maximum KNXnet/IP frame a client must accept on TCP; receive timeout for an incomplete frame (client side); which malformed headers must a client treat as fatal? |
| 9 | Applicable Core v2 and Overview revisions | **Written clarification** (revision numbers are not known to us) | Tunnelling v01.07.01 front matter says it integrates AN184 (2020.12.22) and AN185 (2021.01.05); no Core/Overview text supplied | Which are the current Approved Standard revisions of KNXnet/IP Core (incl. Core v2/AN184) and Overview that IPS v01.01.02 and Tunnelling v01.07.01 are consistent with? |
| 10 | Conformance templates / certification | **Written clarification** | T: TSSK v1.1 AS (2018) describes server-side tests only; no EITT templates; no client certification procedure known | Are EITT templates or a client-side test procedure available? What certification is required to ship a product claiming KNX Secure as a *client*? Is TSSK re-baselined against IPS v01.01.02? |

Items 3 and (partly) 8 were closed or narrowed by reading the supplied text; everything else needs a document we do not have (5–7) or a written statement (1, 2, 4, 9, 10).

### D. Archive re-inspection and access status (2026-10-17)

**What exists in the working environment (checked, not assumed).** The only licensed material is the user-supplied `KNX_Secure_Claude_Bundle.zip` (13 245 516 bytes upload; identical to the working copy
`raw/bundle.zip`, `cmp` equal): `README_FIRST.txt` + 12 PDFs. There is **no** 199-entry `The KNX Standard v3.0.0.zip` in the container, no other archive, no PDF elsewhere on the filesystem. Extracted
text exists for all 12. Inventory (title → role): 03_08_09 KNX IP Secure v01.01.02 AS · 03_08_04 Tunnelling v01.07.01 AS · 03_03_07 Application Layer v02.01.01 AS · 03_03_03 Network Layer v02.01.01 AS ·
03_03_04 Transport Layer v01.02.03 AS · AN193 v04 · AN194 v02 · AN192 v06 Coupler security extensions AS · AN169 v03 Secure PB-Mode configuration DV · AN209 update 8 (TSSJ r3) · TSSK v1.1 AS · TSSJ v1.11 AS.
**MyKNX:** the container has no outbound route to knx.org / my.knx.org (HTTP status 000 on a probe) and no MyKNX credentials, so the user's access route cannot be exercised from here; documents can only reach
the session as an uploaded archive. Nothing was downloaded, nothing licensed was committed (tree scan for the 35 long vector values: 0 hits).

**Searched in the 12 documents for the blocking content — result:**

| Needed | Present? | Evidence |
|---|---|---|
| KNXnet/IP Core (v2) text: TCP HPAI rules, heartbeat, disconnect, receive timeouts, frame sync | **No** | `grep` for CONNECTIONSTATE_REQUEST finds only one IPS sentence; "heartbeat" appears once (TSSK); `TimeoutKnx…` constants exist only in TSSK |
| KNXnet/IP Overview (status codes, timeout constants §5.8) | **No** | – |
| AN183 / KNXnet/IP System Broadcast text | **No** (standalone); **partial scope evidence** | NL v02.01.01 change table "AN183 integration started 2020.10.27"; NL §2.4.2.4.5.7.5 scopes IP System Broadcast handling to the *KNXnet/IP Router* (PID_IP_SBC_CONTROL); the word "tunnel" occurs **0** times in NL, TL, AL |
| EITT templates / client-side certification procedure | **No** | TSSK is descriptions only |
| Volume 6 Profiles, Resources 3/5/1, keyring format | **No** | – |

**Newly extracted, usable facts (N unless stated):** Tunnelling v01.07.01 Table 11: **E_NO_ERROR = 00h**, **E_TUNNELLING_LAYER = 29h**; §2.x text: **E_NO_MORE_UNIQUE_CONNECTIONS = 25h** (and §4.3 client behaviour).
Numeric values of E_CONNECTION_ID, E_CONNECTION_TYPE/OPTION, E_NO_MORE_CONNECTIONS, E_DATA_CONNECTION, E_KNX_CONNECTION are *named* but **not valued** in any supplied text (U; our code's 0x21–0x24, 0x26, 0x27 remain unverified).
T: TSSK 2.5.19/2.5.20 (citing Core v2 2017.04 §2.2.3.2.4.1 / §2.2.3.4) corroborate §2.6.2 for *all* connection types: a server must accept constant sequence values (42, 0) over TCP, must not send ACKs and must not drop the
connection when it receives one; the BDUT "may send any sequence counter values it wants".

**Exact pull list for the person with MyKNX access** (titles as numbered in the bundle; revisions unknown to us — ask for the current Approved Standard of each, do not guess): (1) `03_08_02` KNXnet/IP Core (the revision integrating AN184 "Core v2"); (2) `03_08_01` KNXnet/IP Overview;
(3) AN183 "KNXnet/IP System Broadcast" (standalone, current) — or written confirmation it does not apply to tunnelling clients; (4) the EITT test templates / any client-side conformance procedure for KNXnet/IP Secure; (5) `03_05_01` Resources; (6) Volume 6 Profiles; (7) the ETS keyring file format description.
Upload as one archive with the same folder layout; keep it outside Git. Until then each item stays **BLOCKED — document not available**, and it blocks exactly the rows named in `knx-secure-blocker-matrix.md` (Core → B3, B4, B5, B8; Overview → B1; AN183 → B2; EITT → conformance claims; keyring → B6 completion).

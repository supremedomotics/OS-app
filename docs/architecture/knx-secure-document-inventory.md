# KNX Secure — Specification Document Inventory & Provenance

Date of inventory: 2026-10-17. **Source of every statement below: the document's own contents, opened and read in this
session** (text extracted with `pdftotext -layout`; page counts from `pdfinfo`). Filenames and PDF metadata were NOT relied on:
PDF metadata is wrong for at least one file (see §3).

## 1. Provenance and handling

| Item | Value |
|---|---|
| Delivered as | `KNX_Secure_Claude_Bundle.zip` — a 12-PDF + README subset the project prepared from its licensed `The KNX Standard v3.0.0.zip` (the original 199-entry archive was **not** available to this session) |
| Bundle SHA-256 | `a6219271c44bca74da134949d54c742babaad79744ab79e4bb6b552cf109290e` |
| Stored at | outside the Git repository (session scratchpad, mode 0700, in its own directory); **never committed** |
| Licence | the project's own KNX licence/access terms apply; README_FIRST.txt: "not permission to redistribute licensed material" |
| What is committed | only this metadata: titles, versions, dates, clause numbers, test IDs, and our own analysis. No document text, tables, figures or test vectors. |

## 2. Inventory (all 12 documents opened and read at least at front-matter level; depth of reading noted)

| # | File (as supplied) | Title (from contents) | Version / status / date (from contents) | Pages | SHA-256 (first 16) | Read depth |
|---|---|---|---|---|---|---|
| 1 | `03_08_09 KNX IP Secure v01.01.02 AS.pdf` | KNXnet/IP — KNX IP Secure | v01.01.02, **KNX Approved Standard**, saved 2021.10.08; created 2020.02.11 "based on AN159 'KNX IP Secure' v06 AS"; 2021.01.21 corrected E_COMMAND_INVALID value; 2021.10.08 prepared for Specifications v3.0 | 71 | `a9deb84d2ba134ca` | **Read in full** (all clauses + Annex A, B) |
| 2 | `08_TSSK … KNXnetIP Security_0318_v1_1_AS.pdf` | KNX System Conformance Testing — Test Suite Supplement K — KNX IP Secure Tests | v1.1, **Approved Standard**, saved 2018.03.07 (internal filename `KNXnetIPSecureTestSpec_0318_v1_1_AS.docx`) | 376 | `5deaa894083b1f0d` | TOC, intro, 6 tests + 3 global procedures in full; all 203 test headers/IDs/spec-citations parsed programmatically |
| 3 | `08_TSSJ … Data Security Tests v1.11 AS.pdf` | KNX System Conformance Testing — Test Suite Supplement J — KNX Data Security Tests | v1.11, **Approved Standard**, saved 2020.12.21 ("resolution of comments from Final Voting – Publication as AS") | 277 | `a9a6206ad58bc6d6` | Front matter, TOC, environment, one test chapter sample; leaf headings counted from TOC |
| 4 | `03_08_04 Tunnelling v01.07.01 AS.pdf` | KNXnet/IP — Tunnelling | v01.07.01, **Approved Standard**, saved 2021.10.07; **integrates AN184 "KNXnet/IP Core v2" (2020.12.22) and AN185 "KNXnet/IP Tunnelling v2" (2021.01.05)** | 35 | `36d336d2ac8008ac` | **Read in full** |
| 5 | `03_03_07 Application Layer v02.01.01 AS.pdf` | System Specifications — Communication — Application Layer | v02.01.01, **Approved Standard**, saved 2021.09.28; **integrates AN163 "Extended Interface Object Addressing" (2019.12.17, first row of v02.01.01), AN158 "KNX Data security" (2020.01.03), AN177 Extended Memory (2020.01.07), AN189, AN178 (integration started), AN183 System Broadcast (integration started 2020.10.26), AN193 Access Policies (integration started 2021.05.18), AN160** | 191 | `34047bffc9d1ebc1` | **§5 "Secure Application Layer" + Annex A (CCM) + Annex C (examples) read in full**; rest of the document (plain AL services) not read |
| 6 | `03_03_03 Network Layer v02.01.01 AS.pdf` | Network Layer | v02.01.01, Approved Standard, saved 2021.09.28 | 34 | `c8ace8c6588f2924` | front matter + security keyword search only |
| 7 | `03_03_04 Transport Layer v01.02.03 AS.pdf` | Transport Layer | v01.02.03, Approved Standard, saved 2021.09.28 | 38 | `4ec1e952d0d9bc75` | front matter + keyword search only |
| 8 | `AN192 v06 Coupler security extensions AS.pdf` | AN192/18 v06 — Coupler security extensions | **Approved Standard**, dated 2022.01.04; "Extensions for the Coupler for Security Proxy functionality" | 59 | `9925a1ec68572356` | front matter, scope |
| 9 | `AN193 v04 Access Policies AS.pdf` | AN193/18 v04 — Access Policies | **Approved Standard**, 2019.04.18; "Completion and review of the Access Policies defined for KNX Data Security"; refs AN158 v04, AN159 v06 | 19 | `bf23a761af924f16` | front matter, scope |
| 10 | `AN194 v02 Master Reset of Resources AS.pdf` | AN194/19 v02 — Master Reset of Resources | **Approved Standard**, 2019.04.01 | 25 | `bb23344421fdad1f` | front matter, scope |
| 11 | `AN169 v03 Secure PB-Mode configuration DV.pdf` | AN169/16 v03 — Secure PB-Mode configuration | **Draft for Voting** (2016.11.18) — **NOT an approved standard** | 61 | `1daeaaeada00a456` | front matter, scope |
| 12 | `AN209 update 8_TSS J … r3_ntc_nocomments.pdf` | KNX Certification and Licence System — **Application Note No 209 rev 3** "Changes in Volume 8 TSS J Data Security V1.11 AS" | header: "Approved by KCG on 14/9/2021 – Approved in Release for Voting by KTB 10/21 – **To be approved in Final Voting by KTB 01/22**" → final approval status **not established** by this document | 21 | `7763d85569fafb81` | front matter + first changes |
| – | `README_FIRST.txt` | bundle readme | — | – | `9e68826078c2eae3` | read |

## 3. Discrepancies found in the supplied material (do not paper over)

1. **PDF metadata ≠ content (file 12).** The embedded PDF *Title* is "AN172 Phasing out Vol 9_4_1 and 9_4_2"; the contents are AN209 rev 3. Identification above is from contents.
2. **Test-suite revision skew (file 2).** TSSK (2018.03) cites older sources — "AN159 v05 KNXnet-IP Secure DV (2016.11.18)", "KSG696-08.01 KNXnet-IP Core v2 (2017.04.04/07)", "KSG643-20.01 KNXnet-IP Tunnelling v2 (2017.07.27)", "AN184 v02 … DV (2017.05.02)", "KSG616-18.04/20.03 KNXnet-IP Security", "KSG668-15.01 System Broadcast (2017.07.04)" — while the normative IP Secure text is v01.01.02 (2021, from AN159 **v06**). The tests were not re-baselined to the current text.
3. **Clause-number drift (files 1 vs 2).** TSSK 2.3.1 cites AN159 clause "2.3.1.1" for PID_BACKBONE_KEY; in the 2021 text 2.3.1.1 is the *Overview* and the Backbone Key is **2.3.1.2** (resource clauses shifted by one). The 2.2.x clauses cited by TSSK (2.2.3.6 Session Request, 2.2.3.7 Response, 2.2.3.8 Authenticate, 2.2.3.9 Status, 2.2.3.3 replay, 2.2.3.5.2.5 transition table) do match the 2021 numbering. Rule adopted: **TSSK clause references are leads; the normative clause is always re-located in the 2021 text.**
4. **Spec-internal inconsistency (file 4, Tunnelling §6.1 vs §6.2).** Figure 15 (TUNNELLING_REQUEST example) lists the connection-header structure length as `06h`; Figure 8 and Figure 16 (and the frame lengths in both examples) say `04h`. The 4-octet form is internally consistent everywhere else; Figure 15 appears to be an erratum. **Needs confirmation against a real device capture.**
5. **AN158 provenance.** TSSJ tests "AN158/13 v07"; AN192 cites "AN158 v07 AS of 2019.08.20"; AN193 cites "AN158 v04"; AN194 cites "AN158 v05 DP"; the Application Layer integrated AN158 on 2020.01.03 (version not stated). The standalone AN158 is **not** in the bundle, and the integrated text's completeness relative to AN158 v07 is **unverified**.
6. **Test spec self-reports ambiguity.** TSSK 2.2.24 "Open points": the replay-protection sentence in AN159 v05 "is misleading"; the test (not the prose) defines the behaviour (equal or lower sequence numbers are ignored; compared to the highest-ever received). The 2021 text §2.2.3.3 states "less than or equal to the stored number" — consistent.

## 4. Documents referenced by the supplied ones that are NOT in the bundle (needed or probably needed)

| Referenced as | Cited by | Why it matters here | Needed? |
|---|---|---|---|
| Chapter 3/8/1 "KNXnet/IP Overview" | IP Secure [05], Tunnelling [04] | service-type ranges, **error/status code values** (E_CONNECTION_IN_USE, E_AUTHORISATION_ERROR, E_NO_TUNNELLING_ADDRESS, E_CONNECTION_OPTION, E_CONNECTION_ID…), DIB codes, constants | **Yes — blocker** for status-code verification |
| Chapter 3/8/2 "KNXnet/IP Core" (**v2**) | IP Secure [06], Tunnelling [05] | CONNECT/CONNECTIONSTATE/DISCONNECT procedures and **timeouts**, HPAI rules for TCP, **TCP stream/idle behaviour**, Search Request Extended, supported-service-families DIB | **Yes — blocker** (our connect/heartbeat timings are unverified) |
| Chapter 3/8/3 "KNXnet/IP Device Management" (v2) | IP Secure [07], Tunnelling [06] | secure device-management connections, PID_KNXNETIP_* | only for management; not for runtime control |
| Chapter 3/5/1 "Resources" | IP Secure [04], Application Layer [04] | **Security Interface Object**, Group Key Table, P2P Key Table, Security IA table, Tool Key, PID_SEQUENCE_NUMBER_SENDING, FDSK definition, Group Object security flags | **Yes — blocker for Data Secure** |
| Chapter 3/5/2 "Management Procedures", 3/5/3 "Configuration Procedures" | AL, Tunnelling | secure sync procedures (DM_SecureSync_*), commissioning | if SupremeOS commissions (it does not yet) |
| Volume 6 "Profiles" | IP Secure [09], Tunnelling [09] | which features/interface features are mandatory for which device class | for classification of what SupremeOS must support |
| Chapter 3/2/6 "KNX IP", 3/4/1 "Application Interface Layer", 3/6/3 "External Message Interface" (cEMI) | IP Secure [01][03], Tunnelling [03] | cEMI details beyond what `native/cemi.ts` implements (e.g. L_Data extended frames) | for full cEMI audit |
| **ETS keyring (`.knxkeys`) format description** | project's own plan | importing credentials | **Yes — blocker.** **Searched all 12 documents: zero occurrences of "keyring", "knxkeys" or "knxproj".** Not in this bundle. |
| AN158 (standalone, v07 AS 2019.08.20), AN163 v04, AN170 v03, AN177 v03, AN183, AN184, AN185, AN159 v06 | many | standalone originals | Largely **integrated** into files 4/5 per their own change tables: AN158, AN163, AN177 (Application Layer); AN184, AN185 (Tunnelling). AN183 and AN193 are recorded only as "integration started" (completeness unverified). **AN170 integration is not shown** in the Application Layer change table (TSSJ nevertheless tests it) |
| Official conformance vectors / EITT templates | TSSJ ("EITT templates") | machine-executable test sets | not present; only the informative worked examples inside files 1 and 5 |
| Chapter 8/3/7 and other Volume 8 parts | AN193 | test infrastructure | no |

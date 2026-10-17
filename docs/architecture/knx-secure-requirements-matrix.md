# KNX Secure — Specification & Requirements Traceability Matrix

Last updated: 2026-10-17 (rev 2: official page content supplied by the project). **Zero normative requirements are verified.** No KNX specification document has been obtained or read by this project's tooling.

Evidence classes used in the "Source" column: **C** confirmed from an authorized normative document actually read ·
**P** supplied by the project as verified content of an official KNX page (reported by a person, NOT fetched by this tool) ·
**S** secondary-source interpretation · **U** unresolved · **D** SupremeOS implementation decision (not a KNX requirement).
`P` establishes *which documents apply*; it says nothing about their normative content. Every protocol requirement is still **U**; nothing is **C**.

## 0. Research log

### 0.1 Accessibility from this environment (re-tested 2026-10-17)

| Source | Result here | Basis |
|---|---|---|
| support.knx.org — Updating stack for KNX Secure | **Not reachable** | `WebFetch`: `ENOTFOUND`; `getent hosts` no DNS; `curl` via proxy → 000 |
| support.knx.org — KNX Specifications | **Not reachable** | same |
| support.knx.org — KNX Security overview | **Not reachable** | same |
| support.knx.org — Keyring File Format | **Not reachable** | same |
| chatgpt.com — KNX Specifications Navigator | **Not reachable** | `ENOTFOUND`. **No question has been put to it.** |
| knx.org, my.knx.org | **Not reachable** | no DNS |

**This tool fetched none of these pages.** Everything in 0.2 is content supplied by the project and recorded as evidence class **P**.

### 0.2 Evidence supplied by the project (class P — not independently fetched here)

| Item | Supplied statement | Where it is used |
|---|---|---|
| Official AN ↔ feature mapping | The KNX "stack requirements" page lists **Data Secure:** AN 158, 163, 177, 170, 193, 194. **IP Secure:** AN 159, 183, 185, 184. | document set in 0.3; corrects the earlier unconfirmed/conflicting mapping |
| Specifications page | The Navigator is an **aid, not an authoritative source**; the full specifications are available **to KNX members**. | rule below; acquisition route |
| Pages named | Updating stack for KNX Secure · KNX Specifications · KNX Security overview · Keyring File Format · Navigator | research leads |

**Corrections to earlier revisions of this repo's docs:** the previous revision said the mapping "AN 158 = Data, AN 159 = IP" conflicted with a search snippet and was unconfirmed. Per the supplied official mapping the project's mapping is **correct**; the earlier snippet was wrong or garbled. Also corrected: AN 183/184/185 are **IP Secure** dependencies (not generic IP documents), so classic-tunnelling assumptions in `native/` must be re-checked against them (see IPS-11).

**Navigator rule (from the supplied Specifications page):** Navigator answers are leads only. A requirement becomes **C** only when read in the member-licensed specification text itself, with document, revision and section recorded.

### 0.3 Document register — what is needed (class P for the *list*; nothing obtained)

| Document | Role | Title known? | Revision needed | Status |
|---|---|---|---|---|
| AN 158 | Data Secure (core) | "Data Security" (as supplied earlier; unverified on page) | exact current revision — **unknown** | BLOCKED |
| AN 163, 177, 170, 193, 194 | Data Secure additional requirements | **titles unknown — not recorded** | **unknown** | BLOCKED |
| AN 159 | IP Secure (core) | "IP Security" (as supplied; unverified on page) | **unknown** | BLOCKED |
| AN 183 | IP Secure dependency | "IP System Broadcast" (as supplied; unverified) | **unknown** | BLOCKED |
| AN 184 | IP Secure dependency | "IP Core v2" (as supplied; unverified) | **unknown** | BLOCKED |
| AN 185 | IP Secure dependency | "IP Tunneling v2" (as supplied; unverified) | **unknown** | BLOCKED |
| Keyring file format description | `.knxkeys` structure, integrity, encryption | page exists (P); content unseen | current revision **unknown** | BLOCKED |
| KNX Standard volumes the ANs reference (e.g. cEMI, application layer, KNXnet/IP Core/Tunnelling/Routing) | base protocol for the above | **not enumerated** — to be read off AN 158/159 normative references | **unknown** | BLOCKED |
| Conformance / test specifications and vectors for Secure | lawful test vectors | **existence and access terms unknown** | **unknown** | BLOCKED |

Open: whether ANs 158/159 are *superseded or merged* into a later Standard release (revision history unseen); the "Updating stack for KNX Secure" page presumably lists the minimum revisions — **U**, read it once reachable.

### Questions to put to the Navigator once reachable (and verify against documents)
Q1 exact documents/sections/revisions for IP Secure and Data Secure and their dependencies · Q2 secure session
establishment and credential derivation · Q3 secured frame format, authentication boundary, nonce construction ·
Q4 counters/sequence/replay/out-of-order rules and exhaustion · Q5 Data Secure APDU format, key roles, sequence
synchronisation · Q6 keyring file structure, integrity check, password handling, relationship rules · Q7 secure routing and
timer sync · Q8 reconnect/session-recovery rules · Q9 conformance vectors availability · Q10 v2 Core/Tunnelling impact.

## 1. Matrix

Columns: **Source** (evidence class + document; section/revision only when C) · **Obtained?** · **Impl** · **Tests** · **HW** · **Uncertainty / blocker**.

### 1.1 Delivered, spec-independent (decisions D, verifiable now)

| ID | Feature / layer | Source | Obtained? | Impl | Tests | HW | Uncertainty |
|---|---|---|---|---|---|---|---|
| S-01 | Secret redaction (all output paths) / key hygiene | D | n/a | **done** `secret.ts` | 3 | n/a | Cannot stop callers printing a `use()`d buffer |
| S-02 | At-rest encrypted store, no plaintext/names, mode 0600/0700 | D | n/a | **done** `keystore.ts` | 6 | n/a | No TPM; root/compromised process out of scope |
| S-03 | Wrong secret ≡ tampering (one error); header incl. mode+generation authenticated | D | n/a | **done** | 4 (+3 mutation-verified) | n/a | — |
| S-04 | Atomic write; failed/interrupted write leaves prior store intact | D | n/a | **done** | 3 (fault-injected; runs as root) | n/a | Dir-fsync after rename not done |
| S-05 | Value-free audit of every mutation | D | n/a | **done** | 2 | n/a | Audit sink tamper-evidence not provided |
| S-06 | Secure-required endpoint fails closed; no downgrade | D | n/a | **done** `policy.ts` | 3 | n/a | Enforced for the native client only; legacy driver unaudited |
| S-07 | Non-plain group APDUs withheld + counted, never decoded | D | n/a | **done** | 1 | n/a | Counter does not identify secured traffic |
| S-08 | Simulator isolated from production / real addresses | D | n/a | **done** | 2 | n/a | Static scan covers `src/` imports only |
| S-09 | Pluggable unlock provider; mode bound to store; no silent fallback | D | n/a | **done** `unlock.ts` | 7 | n/a | — |
| S-10 | TPM 2.0 unlock | D | n/a | **seam only** (`TpmUnlockProvider`, fake driver in tests) | 3 (fake) | **NOT validated; no TPM in sandbox** | Concrete driver, PCR policy, provisioning, recovery all unbuilt. Not hardware-backed. |
| S-11 | External key file unlock (transitional) | D | n/a | **done** | 1 | n/a | Weaker; flagged `transitional` |
| S-12 | Concurrent-writer safety: lock file + generation lost-update detection | D | n/a | **done** | 4 | n/a | Lock is advisory/local-host only; no cross-host/NFS safety |
| S-13 | Rollback resistance | D | n/a | **NOT PROVIDED** | 1 test asserts the limitation | n/a | Needs trusted monotonic counter (e.g. TPM NV counter) |
| S-14 | Transactional, confirmed, audited import activation (format-agnostic) | D | n/a | **done** `import-activation.ts` | 5 | n/a | No parser/validators for the real format |
| S-15 | Fail-closed feature flags (`SUPREME_KNX_NATIVE[_SECURE]`) | D | n/a | **done** `native-flags.ts` | 2 | n/a | Not yet consumed by any driver |

### 1.2 KNX IP Secure

| ID | Feature / layer | Source | Obtained? | Impl | Tests | HW | Blocker |
|---|---|---|---|---|---|---|---|
| IPS-01 | Secured IP frame format | P: AN 159 (§/rev U) | no | not started | — | — | BLOCKED-SPEC |
| IPS-02 | Session establishment / authentication | P: AN 159 (§/rev U) | no | not started | — | — | BLOCKED-SPEC |
| IPS-03 | Credential derivation from keyring | P: AN 159 + keyring page (§/rev U) | no | not started | — | — | BLOCKED-SPEC |
| IPS-04 | Per-message authentication/encryption, nonce | P: AN 159 (§/rev U) | no | not started | — | — | BLOCKED-SPEC |
| IPS-05 | Sequence / replay / reorder / duplicates | P: AN 159 (§/rev U) | no | not started | — | — | BLOCKED-SPEC |
| IPS-06 | Session status, timeouts, renewal, counter exhaustion | P: AN 159 (§/rev U) | no | not started | — | — | BLOCKED-SPEC |
| IPS-07 | Secure tunnelling | P: AN 159, 185 (§/rev U) | no | not started | — | not validated | BLOCKED-SPEC, BLOCKED-HW |
| IPS-08 | Secure routing, timer sync | P: AN 159, 183 (§/rev U) | no | not started | — | not validated | BLOCKED-SPEC, BLOCKED-HW |
| IPS-09 | Reconnect without counter reuse | P: AN 159 (§/rev U) | no | not started | — | — | BLOCKED-SPEC |
| IPS-10 | TCP transport variant (if required) | U (AN 159/185?) | no | not started | — | — | BLOCKED-SPEC |
| IPS-11 | v2 Core / Tunnelling / System Broadcast (AN 183/184/185) | P: AN 183, 184, 185 listed under IP Secure (applicability to plain tunnelling U) | no | not started | — | — | BLOCKED-SPEC |

### 1.3 KNX Data Secure

| ID | Feature / layer | Source | Obtained? | Impl | Tests | HW | Blocker |
|---|---|---|---|---|---|---|---|
| DS-01 | Secured APDU recognition and format | P: AN 158 (§/rev U) | no | not started | — | — | BLOCKED-SPEC |
| DS-02 | Verify-then-decode receive path | P: AN 158 (§/rev U) | no | policy half only (S-07) | — | — | BLOCKED-SPEC |
| DS-03 | Secured send | P: AN 158 (§/rev U) | no | not started | — | not validated | BLOCKED-SPEC, BLOCKED-HW |
| DS-04 | Sequence numbers, freshness, synchronisation | P: AN 158 (§/rev U) | no | not started | — | — | BLOCKED-SPEC |
| DS-05 | Per-GA / per-device key mapping | P: AN 158 + keyring page (§/rev U) | no | not started | — | — | BLOCKED-SPEC |
| DS-06 | Mixed secure + plain objects | P: AN 158 (§/rev U) | no | not started | — | not validated | BLOCKED-SPEC |
| DS-07 | Related application notes (163/177/170/193/194) | P: AN 163, 177, 170, 193, 194 listed (content/titles U) | no | not started | — | — | BLOCKED-SPEC |

### 1.4 Keyring

| ID | Feature | Source | Obtained? | Impl | Tests | HW | Blocker |
|---|---|---|---|---|---|---|---|
| KR-01 | File structure, integrity/signature | P: Keyring File Format page (content unseen) | no | not started | — | — | BLOCKED-SPEC |
| KR-02 | Decryption with keyring password | P: Keyring File Format page (content unseen) | no | not started | — | — | BLOCKED-SPEC |
| KR-03 | Relationship validation (interfaces, devices, GAs, projects) | P: Keyring File Format page (content unseen) | no | infrastructure only (S-14) | — | — | BLOCKED-SPEC |
| KR-04 | Separation of IP-Secure vs Data-Secure credentials in storage | P: Keyring File Format page; AN 158/159 (U) | no | namespacing convention only | — | — | BLOCKED-SPEC |

### 1.5 Standard KNX (no spec blocker; not Secure-specific)

| ID | Feature | Impl | Tests | HW |
|---|---|---|---|---|
| STD-01 | Tunnelling, framing, cEMI, DPT (15 mains), UDP loopback | done (classic KNXnet/IP) | 146 native + legacy 442 | **none — simulator/loopback only** |
| STD-02 | Routing | not started | — | — |
| STD-03 | Group-address state / feedback attribution in native stack | not started (legacy driver does it) | — | — |

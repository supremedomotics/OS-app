# KNX Secure — Specification & Requirements Traceability Matrix

Last updated: 2026-10-17. **Zero normative requirements are verified.** No KNX specification document has been obtained.

Evidence classes used in the "Source" column: **C** confirmed from an authorized document actually read ·
**S** secondary-source interpretation · **U** unresolved question · **D** SupremeOS implementation decision (not a KNX requirement).
Everything protocol-related below is **U** until a document is read; nothing is **C** yet.

## 0. Research log (what was actually attempted)

| Source | Attempt | Result |
|---|---|---|
| KNX Specifications Navigator (ChatGPT GPT) | `WebFetch` of the GPT URL | **Not accessible** — `chatgpt.com` does not resolve from the sandbox (`ENOTFOUND`); a hosted GPT would also need an authenticated session no tool here provides. **No question was put to it. Nothing in this repo is attributed to it.** |
| support.knx.org — "Updating stack for KNX Secure" | `WebFetch` (2 sessions) | Not accessible (`ENOTFOUND`) |
| support.knx.org — "KNX IP Secure", "KNX Data Secure", "Keyring File Format" | `WebFetch` | Not accessible (`ENOTFOUND`) |
| knx.org / web search | search snippets only | Snippets conflicted on which application note covers IP vs Data Secure. They are leads, not evidence. |
| Local repository | grep of docs/ and source | Contains no KNX specification text. |

### Reference list supplied by the project (leads only — titles/revisions/applicability UNVERIFIED)
AN 158 "Data Security" · AN 159 "IP Security" · AN 163, 177, 170, 193, 194 (Data Secure-related, per KNX Association) ·
AN 183 IP System Broadcast · AN 184 IP Core v2 · AN 185 IP Tunneling v2. Whether this list is complete or correctly
mapped is itself **U**. Note the brief's mapping (158 = Data, 159 = IP) disagrees with an earlier search snippet; neither is
confirmed. The tunnelling work already in `native/` follows classic KNXnet/IP; whether v2 Core/Tunnelling (AN 184/185) change
that behaviour is **U** and must be checked before any hardware validation.

### Questions to put to the Navigator once reachable (and verify against documents)
Q1 exact documents/sections/revisions for IP Secure and Data Secure and their dependencies · Q2 secure session
establishment and credential derivation · Q3 secured frame format, authentication boundary, nonce construction ·
Q4 counters/sequence/replay/out-of-order rules and exhaustion · Q5 Data Secure APDU format, key roles, sequence
synchronisation · Q6 keyring file structure, integrity check, password handling, relationship rules · Q7 secure routing and
timer sync · Q8 reconnect/session-recovery rules · Q9 conformance vectors availability · Q10 v2 Core/Tunnelling impact.

## 1. Matrix

Columns: **Source** (evidence class + exact doc/section/revision when C) · **Obtained?** · **Impl** · **Tests** · **HW** · **Uncertainty / blocker**.

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
| IPS-01 | Secured IP frame format | U | no | not started | — | — | BLOCKED-SPEC |
| IPS-02 | Session establishment / authentication | U | no | not started | — | — | BLOCKED-SPEC |
| IPS-03 | Credential derivation from keyring | U | no | not started | — | — | BLOCKED-SPEC |
| IPS-04 | Per-message authentication/encryption, nonce | U | no | not started | — | — | BLOCKED-SPEC |
| IPS-05 | Sequence / replay / reorder / duplicates | U | no | not started | — | — | BLOCKED-SPEC |
| IPS-06 | Session status, timeouts, renewal, counter exhaustion | U | no | not started | — | — | BLOCKED-SPEC |
| IPS-07 | Secure tunnelling | U | no | not started | — | not validated | BLOCKED-SPEC, BLOCKED-HW |
| IPS-08 | Secure routing, timer sync | U | no | not started | — | not validated | BLOCKED-SPEC, BLOCKED-HW |
| IPS-09 | Reconnect without counter reuse | U | no | not started | — | — | BLOCKED-SPEC |
| IPS-10 | TCP transport variant (if required) | U | no | not started | — | — | BLOCKED-SPEC |
| IPS-11 | v2 Core / Tunnelling (AN 184/185 applicability) | U | no | not started | — | — | BLOCKED-SPEC |

### 1.3 KNX Data Secure

| ID | Feature / layer | Source | Obtained? | Impl | Tests | HW | Blocker |
|---|---|---|---|---|---|---|---|
| DS-01 | Secured APDU recognition and format | U | no | not started | — | — | BLOCKED-SPEC |
| DS-02 | Verify-then-decode receive path | U | no | policy half only (S-07) | — | — | BLOCKED-SPEC |
| DS-03 | Secured send | U | no | not started | — | not validated | BLOCKED-SPEC, BLOCKED-HW |
| DS-04 | Sequence numbers, freshness, synchronisation | U | no | not started | — | — | BLOCKED-SPEC |
| DS-05 | Per-GA / per-device key mapping | U | no | not started | — | — | BLOCKED-SPEC |
| DS-06 | Mixed secure + plain objects | U | no | not started | — | not validated | BLOCKED-SPEC |
| DS-07 | Related application notes (163/177/170/193/194) | U | no | not started | — | — | BLOCKED-SPEC |

### 1.4 Keyring

| ID | Feature | Source | Obtained? | Impl | Tests | HW | Blocker |
|---|---|---|---|---|---|---|---|
| KR-01 | File structure, integrity/signature | U | no | not started | — | — | BLOCKED-SPEC |
| KR-02 | Decryption with keyring password | U | no | not started | — | — | BLOCKED-SPEC |
| KR-03 | Relationship validation (interfaces, devices, GAs, projects) | U | no | infrastructure only (S-14) | — | — | BLOCKED-SPEC |
| KR-04 | Separation of IP-Secure vs Data-Secure credentials in storage | U | no | namespacing convention only | — | — | BLOCKED-SPEC |

### 1.5 Standard KNX (no spec blocker; not Secure-specific)

| ID | Feature | Impl | Tests | HW |
|---|---|---|---|---|
| STD-01 | Tunnelling, framing, cEMI, DPT (15 mains), UDP loopback | done (classic KNXnet/IP) | 146 native + legacy 442 | **none — simulator/loopback only** |
| STD-02 | Routing | not started | — | — |
| STD-03 | Group-address state / feedback attribution in native stack | not started (legacy driver does it) | — | — |

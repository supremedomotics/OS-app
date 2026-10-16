# KNX Secure — Requirements & Specification-Traceability Matrix

Status legend: **BLOCKED-SPEC** = normative document not available to the project, so no behaviour may be implemented ·
**BLOCKED-HW** = needs real secure hardware · **DONE** = implemented and tested in this repo · **NOT STARTED**.

## 0. Specification audit (what could and could not be verified)

| Item | Finding |
|---|---|
| Authoritative sources | The KNX Association's published KNX Standard material for KNX IP Secure and KNX Data Secure (distributed as application notes and within the Standard's system/core volumes), plus the ETS keyring (`.knxkeys`) format documentation. |
| Document numbers / versions | **Unconfirmed.** Web search returned conflicting statements about which application-note number covers IP Secure versus Data Secure. No number or version is recorded here as fact. |
| Availability in this session | **None obtained.** `knx.org` and `support.knx.org` are unreachable from the build environment (DNS failure); no copy exists in the repository. |
| Consequence | Per the project rule *"record unavailable specification details as blockers; do not invent protocol behavior"*, **no KNX Secure cryptographic or wire procedure is implemented.** Contributor recollection of algorithm families exists but is deliberately NOT recorded or coded: unverified detail validated only by self-authored tests would be false assurance. |
| What is verifiable now | Secret handling, local key storage design, fail-closed policy, audit, redaction, simulator isolation (rows S-xx below). |
| To unblock | Obtain the current normative documents (KNX Association membership/portal or a licensed copy) and any official test vectors; place them OUTSIDE the repo (licence) and record exact title/version/section in the "Spec ref" column. |

## 1. Matrix

"Spec ref" stays `—` until a document is in hand. Acceptance criteria are stated so they can be verified once it is.

### 1.1 Delivered, spec-independent (verifiable now)

| ID | Requirement | Module | Evidence / vectors | Status |
|---|---|---|---|---|
| S-01 | Key material never appears in string/JSON/inspect/log/error output | `security/secret.ts` | `security.test.ts` Secret suite (raw, hex, base64 forms) | **DONE** |
| S-02 | Local encrypted storage; no plaintext or names on disk; no default passphrase; 0600/0700; refuses group/other-readable | `security/keystore.ts` | KeyStore suite (11 tests) | **DONE** (limits: threat model §5) |
| S-03 | Wrong passphrase and tampering indistinguishable; fail closed | `security/keystore.ts` | tamper test over ct/tag/iv/salt/KDF params | **DONE** |
| S-04 | Atomic persistence; failed write leaves previous store intact | `security/keystore.ts` | write-failure test (skipped when run as root — see report) | **DONE** (conditional) |
| S-05 | Auditable secure-config changes, value-free | `security/keystore.ts` | audit test asserts no secret in any event | **DONE** |
| S-06 | Secure-required endpoint fails closed; no downgrade to plain | `security/policy.ts`, `tunnel-client.ts` | client cannot be constructed; 0 sockets opened | **DONE** |
| S-07 | Group telegrams with non-plain APCI never decoded as values; counted | `tunnel-client.ts` | test with rewritten APCI | **DONE** (counter does not claim to identify secured traffic) |
| S-08 | Simulator cannot be reached from production code / real addresses | `simulator/*` | static import scan + no-route test | **DONE** |

### 1.2 KNX IP Secure (transport layer)

| ID | Required operation | Spec ref | Planned module | Acceptance criteria | Status |
|---|---|---|---|---|---|
| IPS-01 | Secure service framing / wrapper format | — | `secure/ip-frame.ts` | official or lawful vectors round-trip; truncation/malformed rejected | BLOCKED-SPEC |
| IPS-02 | Secure session establishment (key agreement, authentication of client and device) | — | `secure/ip-session.ts` | interop with spec vectors; wrong credential → typed failure, no plain fallback | BLOCKED-SPEC |
| IPS-03 | Credential derivation (user password / device authentication code) from keyring material | — | `secure/ip-keys.ts` | derived values match published vectors | BLOCKED-SPEC |
| IPS-04 | Per-message authentication/encryption, nonce construction | — | `secure/ip-frame.ts` | tamper (ciphertext/tag/header) always rejected; vectors | BLOCKED-SPEC |
| IPS-05 | Sequence / replay protection, out-of-order, duplicates | — | `secure/ip-session.ts` | replay, reorder, gap tests per spec rules | BLOCKED-SPEC |
| IPS-06 | Session status / termination / timeouts / renewal; counter exhaustion | — | `secure/ip-session.ts` | exhaustion forces new session, never wraps | BLOCKED-SPEC |
| IPS-07 | Secure tunnelling over the secure session (incl. heartbeat equivalents) | — | `secure/ip-tunnel.ts` | simulator + real device | BLOCKED-SPEC, BLOCKED-HW |
| IPS-08 | Secure routing (multicast), time/timer synchronisation, group key | — | `secure/ip-routing.ts` | per spec | BLOCKED-SPEC, BLOCKED-HW |
| IPS-09 | Reconnect without counter reuse | — | supervisor | persisted/monotonic counters or fresh session | BLOCKED-SPEC |
| IPS-10 | TCP transport for secure tunnelling (if required by spec) | — | `transport.ts` extension | — | BLOCKED-SPEC |

### 1.3 KNX Data Secure (application layer)

| ID | Required operation | Spec ref | Planned module | Acceptance criteria | Status |
|---|---|---|---|---|---|
| DS-01 | Secured APDU recognition and wire format in cEMI | — | `secure/data-apdu.ts` | vectors; plain telegrams unaffected | BLOCKED-SPEC |
| DS-02 | Authenticated + encrypted group telegram receive; decode DPT only after verification | — | `secure/data-secure.ts` | tampered → never reaches DPT codec | BLOCKED-SPEC |
| DS-03 | Secured group telegram send | — | same | interop with real device | BLOCKED-SPEC, BLOCKED-HW |
| DS-04 | Sequence numbers, freshness/replay, sequence synchronisation | — | same | replay/gap tests per spec | BLOCKED-SPEC |
| DS-05 | Per-group-address key and per-device tool/sender key mapping from keyring | — | `keyring/` | each GA resolves to exactly its key; missing → explicit "unknown key" | BLOCKED-SPEC |
| DS-06 | Secure and plain group objects coexisting; secured GA never accepted in plain form | — | driver adapter | mixed-installation test | BLOCKED-SPEC (policy half DONE: S-06/S-07) |

### 1.4 Keyring

| ID | Requirement | Spec ref | Status |
|---|---|---|---|
| KR-01 | Parse ETS keyring file structure and integrity/signature | — | BLOCKED-SPEC |
| KR-02 | Decrypt keyring contents with user password | — | BLOCKED-SPEC |
| KR-03 | Validate: malformed, incomplete, inconsistent, mismatched project/interface, unauthorized | — | BLOCKED-SPEC (generic transactional-activation design in threat model §6) |
| KR-04 | Atomic activation into `KeyStore`; audit; rollback | design only | NOT STARTED (store side DONE) |

### 1.5 Existing standard behaviour that must not regress

| ID | Requirement | Status |
|---|---|---|
| STD-01 | Standard tunnelling + all supported DPTs | **DONE** (146 foundation tests + 17 added now; 608 KNX tests green) |
| STD-02 | Standard routing | NOT STARTED (not a secure-specific item; no spec blocker) |
| STD-03 | Mixed secure/plain installation | BLOCKED-SPEC (see DS-06) |

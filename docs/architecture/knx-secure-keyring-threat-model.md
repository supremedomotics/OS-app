# KNX Keyring Import & Secret Storage — Threat Model

Implemented: `security/secret.ts`, `security/keystore.ts`. Keyring parsing/decryption is BLOCKED-SPEC.

## 1. Assets
Keyring-derived interface credentials; group-address keys; device/tool keys; the keyring password; the key-store
passphrase; audit trail integrity.

## 2. Actors / threats considered
| ID | Threat | Mitigation | Residual |
|---|---|---|---|
| T1 | Theft of disk, backup or support bundle | AES-256-GCM container, scrypt (N=2^15 default), names encrypted, no plaintext on disk | Offline guessing of a weak passphrase; ≥12-byte minimum only — choose a strong one |
| T2 | Local unprivileged user reads the file | 0600 file / 0700 dir; refuses to open if group/other-readable | Root and the service account can read it |
| T3 | Tampering / downgrade of the container | GCM tag over payload; header (KDF params, salt) bound as AAD; indistinguishable failure | Whole-file rollback to an older valid copy is **not** detected (no monotonic version) |
| T4 | Secret leaks via logs, errors, JSON, debugger output | `Secret` redacts everywhere; `redactSecrets` for foreign text; tests assert it | Callers who `use()` a buffer and print it; libraries that copy buffers |
| T5 | Crash mid-write corrupts store | temp file + fsync + rename; in-memory rollback on failure | Power loss between rename and directory fsync on some filesystems |
| T6 | Malicious/malformed keyring file import | Must be parsed in isolation and activated transactionally (§6) | Parser not written (spec) |
| T7 | Unauthorised config change | Value-free audit events with actor; operation requires unlocked store | Audit sink is caller-supplied; tamper-evidence of the audit log itself is not provided |
| T8 | Memory disclosure of live keys | `wipe()`/`close()` zero owned buffers | JS cannot guarantee zeroisation, mlock, or exclude swap/core dumps |
| T9 | Key reuse/replay after restore from backup | Counter persistence design (IPS-09) | Not implemented |
| T10 | Cloud dependency / exfiltration | None: no network code in these modules | — |

## 3. Out of scope / explicitly not provided
No TPM/HSM/secure-enclave binding; no protection against a compromised running hub process or root; no hardware-backed
unlock; no key escrow. **If production requires hardware-backed protection, production readiness stays blocked.**

## 4. Unlock strategy (decision needed from the product owner)
Options: (a) operator passphrase entered at start-up (strongest, hands-on); (b) key file on a separate protected mount
(unattended boot, protects only against theft of the main disk); (c) TPM-sealed key (needs platform work, not built).
No default is shipped; the store refuses to run without an explicit secret.

## 5. Operating-system assumptions
POSIX permissions honoured (Linux hub). On Windows the permission check is skipped by design and the store must live in a
ACL-restricted directory — **unverified, treat as unsupported for production**. Full-disk encryption recommended in addition.

## 6. Keyring import procedure (design; parser BLOCKED-SPEC)
1. Read the file into memory only; never extract to disk; size-limit it.
2. Verify integrity/authenticity per spec **before** trusting any field; decrypt with the user-supplied keyring password.
3. Validate structure and cross-references (every secured GA has a key; interface/project identifiers match the configured
   installation; no duplicate or conflicting entries; no unexpected extras) — any failure rejects the whole import.
4. Stage into a candidate set; diff against the active set; require explicit confirmation of what changes.
5. Activate atomically into `KeyStore`; emit audit events; keep the previous set until the new one has passed a
   self-check; rollback on failure.
6. Wipe parse buffers; the keyring password is never stored unless the operator opts in (then only inside the KeyStore).

## 7. Backup, recovery, rotation limits
Backup = the encrypted store file + the passphrase held separately (losing the passphrase loses all keys; re-import the
ETS keyring to recover). Passphrase rotation implemented; **key rotation is not**: group/interface keys change only through
a new ETS commissioning and keyring re-import. Restoring an old store can resurrect revoked keys (T3 residual).

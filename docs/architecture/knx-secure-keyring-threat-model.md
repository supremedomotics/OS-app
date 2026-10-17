# KNX Keyring Import & Secret Storage — Threat Model

Implemented: `security/secret.ts`, `keystore.ts`, `unlock.ts`, `import-activation.ts`. Keyring parsing/decryption is BLOCKED-SPEC.
Revision 2 (2026-10-17): unlock providers, generation/lock concurrency control, transactional import.

## 1. Assets
Keyring-derived interface credentials; group-address keys; device/tool keys; the keyring password; the key-store
passphrase; audit trail integrity.

## 2. Actors / threats considered
| ID | Threat | Mitigation | Residual |
|---|---|---|---|
| T1 | Theft of disk, backup or support bundle | AES-256-GCM container, scrypt (N=2^15 default), names encrypted, no plaintext on disk | Offline guessing of a weak passphrase; ≥12-byte minimum only — choose a strong one |
| T2 | Local unprivileged user reads the file | 0600 file / 0700 dir; refuses to open if group/other-readable | Root and the service account can read it |
| T3 | Tampering / downgrade of the container | GCM tag over payload; header (version, KDF params, salt, unlock mode, generation) bound as AAD; indistinguishable failure; mode downgrade impossible | **Whole-file rollback to an older valid copy is NOT detected** — `keystore-hardening.test.ts` asserts this limitation on purpose. The generation counter detects concurrent writers, not an attacker or a restore. |
| T4 | Secret leaks via logs, errors, JSON, debugger output | `Secret` redacts everywhere; `redactSecrets` for foreign text; tests assert it | Callers who `use()` a buffer and print it; libraries that copy buffers |
| T5 | Crash mid-write corrupts store | temp + fsync + rename under an exclusive lock; fault-injection tests for failed rename and crash after temp write; orphan temp files cleaned | Directory fsync after rename not performed; power loss there is untested |
| T11 | Two writers race | lock file (fail-fast `store_busy`), generation check (`stale_store`), stale lock reclaimed only for same-host dead pid | Local filesystem only; NFS/multi-host unsafe; lock is advisory |
| T6 | Malicious/malformed keyring file import | Must be parsed in isolation and activated transactionally (§6) | Parser not written (spec) |
| T7 | Unauthorised config change | Value-free audit events with actor; operation requires unlocked store | Audit sink is caller-supplied; tamper-evidence of the audit log itself is not provided |
| T8 | Memory disclosure of live keys | `wipe()`/`close()` zero buffers the module owns; tests prove: copies are independent, use-after-wipe throws, source buffers are copied | **Not testable/guaranteed in a managed runtime:** V8 may have copied strings/buffers (base64/JSON staging in `persist`, scrypt internals, GC moves), swap and core dumps are out of reach. Treat wiping as hygiene, not a guarantee. |
| T9 | Key reuse/replay after restore from backup | Counter persistence design (IPS-09) | Not implemented |
| T10 | Cloud dependency / exfiltration | None: no network code in these modules | — |

## 3. Out of scope / explicitly not provided
No TPM/HSM/secure-enclave binding; no protection against a compromised running hub process or root; no hardware-backed
unlock; no key escrow. **If production requires hardware-backed protection, production readiness stays blocked.**

## 4. Key-unlock design (decided; production target TPM 2.0, UNVALIDATED)
Providers are pluggable (`unlock.ts`); the mode is authenticated in the store header, so a store opens ONLY through the mode
that created it and never retries with a weaker one (tested, mutation-verified).

| Mode | Status | Protects against | Does not protect against |
|---|---|---|---|
| `tpm` (production target) | **seam only** — no concrete driver, **never run on a TPM** | offline theft of disk/backup; unattended boot | root / compromised running process |
| `passphrase` | implemented | offline theft | weak passphrase; needs an operator at boot |
| `external_key_file` | implemented, **transitional** | theft of the main disk only if the mount is physically separate | anyone with both; a mount left attached |

Fail-closed rules: TPM selected but unavailable/unseal fails → error, nothing else is tried. No default secret exists.

### TPM operational design (to be built and validated on the real hub; none of this is tested)
- **Provisioning:** generate a random 256-bit key-encryption secret, seal it to the TPM under a PCR policy, store only the sealed blob; create the store with it. Record the PCR set chosen and why.
- **Firmware/boot change:** PCR drift makes unseal fail (`tpm_unseal_failed`). Recovery = operator-passphrase **recovery wrapper** (a second, separately stored wrapping of the same secret, created at provisioning) or ETS keyring re-import. The recovery wrapper is an escrow and must itself be protected and documented — design not yet written.
- **Device replacement / TPM loss:** sealed key is unrecoverable by design; restore from encrypted backup + recovery wrapper, or re-import keyring from ETS and re-provision.
- **Rotation:** rotate the sealed secret by creating a new store generation under a new seal and re-encrypting; in-place passphrase rotation exists only for passphrase mode.
- **Rollback:** a TPM NV counter could provide rollback detection (S-13); not designed or built.

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

## 8. Addendum — IP Secure transport (2026-10-17)
Additional secrets, all handled as `Secret` (redacted, wipeable): Device Authentication Code, user-password hash (PBKDF2 output), ECDH private key, session key.
Never logged; `diagnostics()` exposes counters/states only. Threats addressed in the simulator: impostor server (mandatory DAC verification, D1), replay and
reordering (sequence ≤ stored discarded, MAC before state advance, D3), cross-session replay (fresh key per session, D2), nested wrappers (D4), TCP
fragmentation/merging and oversized frames (deframer limits), counter wrap (closes at 2^48-1), low-order/zero peer keys (rejected). Residual/unverified: no real
socket or gateway tested; Core v2 TCP rules (U); side-channel properties of Node crypto not assessed; passive traffic analysis is out of scope.

Review additions (2026-10-17): reflection of the client's own frames and nonce reuse between the two directions are mitigated by D5 (own serial
dropped; zero serial refused) — not specification text. Unexpected faults fail closed (D6). Real-socket exposure: connect timeout, bounded write
queue, handler faults contained; no destination policy in the socket layer (configuration owns the gateway address). See `knx-ip-secure-security-review.md`.

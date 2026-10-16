# KNX Secure — Security Test Report

Environment: Linux sandbox, Node 22, run as **root**, simulator + loopback only. **No real KNX hardware, no secure
device, no official conformance vectors.** `PASSED` means an automated test in this repo passed; it is not hardware evidence.

Native suite: 165 passed, 0 failed, 1 skipped (`src/knx/native`). Full KNX regression (`src/knx`, `knx-driver`,
`knx-discovery`, `knx-codec`): all pass (see handoff for the final run). Typecheck and package build clean.

## Passed (spec-independent controls)
| Case | Test |
|---|---|
| Secrets redacted in string/JSON/template/inspect/nested; hex/base64 forms scrubbed from foreign text | `security.test.ts` › Secret |
| Wipe zeroes owned buffer; use-after-wipe rejected | same |
| Store contains no plaintext key, no secret names; round-trip | KeyStore |
| File 0600 / dir 0700; no stray temp file | KeyStore |
| Wrong passphrase ≡ tampered ct/tag/iv/salt/KDF-param (one identical error) | KeyStore |
| Refuses group/other-readable store; no default passphrase; no overwrite | KeyStore |
| Passphrase rotation; invalid name/size; durable delete | KeyStore |
| Audit trail complete and value-free (no key, no passphrase) | KeyStore |
| Secure-required client cannot be constructed; zero sockets opened (no downgrade) | policy |
| Non-plain-APCI group telegram withheld and counted, session stays up | policy |
| No production module imports the simulator; simulator has no route to real addresses | isolation |
| Standard tunnelling, framing, cEMI, DPT, UDP loopback, leak gates (146 pre-existing native tests) | unchanged |

## Skipped
| Case | Why |
|---|---|
| Failed store write leaves previous store intact | Needs a non-root user (root ignores directory permissions). The code path is written but **unverified here**; run in CI as non-root. |

## Blocked — cannot be tested (normative specification not obtained)
Secure session establishment/teardown · authenticated+encrypted telegram exchange · invalid credentials / corrupted
authentication data · modified ciphertext / integrity failure · replay, duplicate, out-of-order, invalid sequence ·
session expiry, counter boundaries, reconnect recovery · keyring missing/malformed/mismatched · mixed secure/plain
devices (beyond the fail-closed policy) · official conformance vectors · secure transport over real UDP.
Each maps to matrix rows IPS-xx / DS-xx / KR-xx.

## Blocked — hardware
Interop with a real KNX IP Secure interface/router · Data Secure against real devices and captures · secure routing.

## Not yet tested (feasible now, not written)
Property/fuzz tests of a future keyring parser (no parser) · key-store behaviour on Windows · key-store concurrent access
from two processes (no file lock implemented — **known gap**) · rollback/restore-old-store detection (known residual T3).

## Verdict
**KNX IP Secure: NOT IMPLEMENTED. KNX Data Secure: NOT IMPLEMENTED.** What exists is a safe foundation that guarantees
failure rather than insecurity. Production must not claim KNX Secure support.

# KNX Secure — Security Test Report

2026-10-17 · Linux sandbox, Node 22, **root**, simulator + loopback only. **No KNX hardware, no TPM, no secure device, no
official conformance vectors, no KNX specification.** `PASSED` = an automated test in this repo passed; it is not
interoperability or hardware evidence.

## Actual results
| Run | Passed | Failed | Skipped |
|---|---|---|---|
| `src/knx/native` | **188** | 0 | 0 |
| KNX regression (`src/knx`, `knx-driver`, `knx-discovery`, `knx-codec`) | **630** | 0 | 0 |
| `tsc --noEmit` / `pnpm build` (`@supreme/protocols`) | clean | — | — |
| Full-monorepo repository checks | **not run** | — | — |

The previously skipped write-failure test now runs under root using deterministic fault injection; it is no longer skipped.
`dpt-differential.test.ts` (39) is temporary migration evidence and is not security evidence.

## Passed
Secret redaction (string/JSON/template/inspect/nested/hex/base64) · wipe & copy independence & use-after-close · encrypted
store: no plaintext/names, 0600/0700, no temp/lock left · wrong secret ≡ tampering ≡ identical error; tamper of ct/tag/iv/
salt/KDF params/**generation**/**unlock mode** fails · unsafe permissions refused · no default/short passphrase · rotation ·
audit completeness and value-freeness · failed rename and crash-after-temp-write leave the committed store byte-identical and
usable · orphan temp files harmless and cleaned · truncated/empty/binary/wrong-version files give typed errors · concurrent
handle cannot clobber a newer write (`stale_store`); live lock → `store_busy`; lock reclaimed only for same-host dead pid,
never for foreign host or garbage · unlock mode binding both directions · TPM provider with no driver/unavailable/unseal
failure/throwing driver fails closed with no detail leak and no file created · passphrase store refuses TPM provider · external
key file perms/symlink/size/missing · import: validator failure leaves store byte-identical, confirmation required, atomic
activation with correct diff, counts-only audit, failed write keeps previous set, empty/invalid name/invalid size/crashing
validator rejected without leaking its exception text · feature flags fail closed · secure-required client cannot be
constructed (0 sockets) · non-plain group APDU withheld and counted · simulator isolation.
**Mutation check:** removing the generation check, the mode check, or the AAD binding each makes ≥1 test fail (verified by hand).

## Passed but only with a FAKE
TPM provider behaviour (3 tests) uses an in-test fake driver. It proves the fail-closed logic, **not** that any TPM works.

## Known limitations asserted by tests (not defects fixed)
Stale-copy restore is accepted (no rollback resistance).

## Blocked — spec / hardware (all untested)
Every IPS-xx, DS-xx, KR-01..04 row · official vectors · replay/out-of-order/sequence/counter-exhaustion for secure traffic ·
valid secure session and telegram exchange · secure reconnect · mixed secure/plain devices · real-UDP secure transport ·
TPM on target hardware · IP Secure interface / Data Secure device interoperability · v2 Core/Tunnelling behaviour.

## Not yet tested (feasible, not written)
Windows behaviour · cross-process (not just cross-handle) lock contention · NFS · directory-fsync power-loss · property tests
for a keyring parser (none exists) · 24 h soak.

## Verdict
**KNX IP Secure: NOT IMPLEMENTED. KNX Data Secure: NOT IMPLEMENTED. Native driver: NOT production-ready.**

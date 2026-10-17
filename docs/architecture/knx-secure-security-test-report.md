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


## Addendum — IP Secure implementation stage (2026-10-17)
Run on `claude/great-keller-fmenbn` in the Linux sandbox; simulator only; no hardware.

| Run | Passed | Failed | Skipped |
|---|---|---|---|
| `src/knx/native/secure` **with** local licensed vectors (`KNX_SECURE_VECTORS`) | **83** | 0 | 0 |
| `src/knx/native/secure` **without** vectors (clean checkout/CI) | **61** | 0 | **22** (spec-vector tests; skipped, never reported as passed) |
| `src/knx` regression with vectors | **716** | 0 | 0 |
| `src/knx` regression without vectors | **694** | 0 | 22 |
| `tsc --noEmit`, `npm run build` (`@supreme/protocols`) | clean | — | — |

Per file: ccm 8 + ccm.vectors 10 · ip-keys 7 + vectors 5 · ip-frames 11 + vectors 7 · ip-session 35 (all simulator).
Test classes: **vector** (spec worked examples) · **independent** (cross-checks against Node primitives, tamper/mutation) ·
**simulator** (client vs our own `VirtualSecureGateway`) · **conformance** (none executed — TSSK is only mapped) · **hardware** (none).
A bug found by these tests: the virtual TCP stream dropped in-flight data on graceful close (fixed in the simulator, not the driver).
Not tested: real sockets, any real gateway, tunnelling inside a session, routing, Data Secure, keyring.

## Addendum 2 — security review gate + real TCP (2026-10-17)
Commit `93777b3`. Details: `knx-ip-secure-security-review.md`.

| Run | Passed | Failed | Skipped |
|---|---|---|---|
| `src/knx/native/secure` **with** licensed vectors | **87** | 0 | 0 |
| `src/knx/native/secure` **without** vectors | **65** | 0 | **22** (spec-vector tests) |
| `src/knx/native/tcp-socket.test.ts` (real loopback TCP, 127.0.0.1) | **24** | 0 | 0 |
| `src/knx` regression **with** vectors | **744** | 0 | 0 |
| `src/knx` regression **without** vectors | **722** | 0 | **22** |
| `tsc --noEmit`, `npm run build` | clean | — | — |

New: 4 review regressions in `ip-session.test.ts` (reflection ×2, zero serial, fault→closed) + 24 loopback TCP tests. Verification of the
vectors: all 53 hex values are present in the extracted spec text; none of the 35 long values occurs in the tree or any commit; tampering
with three vectors made 4 tests fail. Hardware: none. Conformance tests executed: none.

## Addendum 3 — blocker-closure milestone (2026-10-17)
Base `d5b78bf`, **no source code changed** (documentation only), so no new behaviour is tested; the suites were re-run to confirm the baseline and the
vector-mutation property. Linux sandbox, loopback only, no hardware.

| Run | Passed | Failed | Skipped |
|---|---|---|---|
| `src/knx/native/secure` **with** licensed vectors (`KNX_SECURE_VECTORS`, file outside Git) | **87** | 0 | 0 |
| `src/knx/native/secure` **without** vectors | **65** | 0 | **22** (skipped, never passed) |
| `src/knx/native/tcp-socket.test.ts` (real loopback TCP) | **24** | 0 | 0 |
| `src/knx` + `knx-driver` + `knx-discovery` + `knx-codec` regression **with** vectors | **744** | 0 | 0 |
| same **without** vectors | **722** | 0 | **22** |
| `tsc -p tsconfig.json --noEmit` (`@supreme/protocols`) | clean | – | – |
| `build` | **not run** (no code changed) | – | – |
| **Mutation:** local vector JSON copy with 4 expected values altered (`a2_mac`, `a2_session_key`, `a3_auth_mac`, `a3_wrap_key`) | – | **5 tests failed** (ccm, ip-frames, ip-keys vector files); copy deleted | – |

Git hygiene re-checked: `git ls-files` has no PDF/keyring/vector file; `knx-licensed/` is ignored. Conformance executed: none. Hardware: none.
Not tested (blocked): everything in `knx-secure-blocker-matrix.md` B1–B9 — tunnelling in the session, TCP HPAI, heartbeat on TCP, E_CONNECTION_ID, pre-authentication close.

## Addendum 3 — B6/B7/B8 guards and UDP transport extraction (2026-10-17)
Commits `25d92cc` (guards), `3dc6c31` (pre-extraction characterisation), `d1cff88` (extraction). Linux sandbox, Node 22, simulator + loopback only. **No hardware, no conformance run.**

| Run | Passed | Failed | Skipped |
|---|---|---|---|
| `src/knx` at `502d4bc` (session start), **with** vectors | 744 | 0 | 0 |
| `src/knx` at `502d4bc`, **without** vectors | 722 | 0 | 22 |
| `src/knx` at `25d92cc` (before extraction), with vectors | 758 | 0 | 0 |
| `src/knx` at `25d92cc` (before extraction), without vectors | 736 | 0 | 22 |
| `src/knx` at `d1cff88` (**after** extraction + 11 wire tests), with vectors | **769** | 0 | 0 |
| `src/knx` at `d1cff88`, without vectors | **747** | 0 | **22** |
| `src/knx/native/secure` with / without vectors | 101 / 79 | 0 / 0 | 0 / 22 |
| classic UDP + codec tunnelling: `tunnel-client` (37) + `tunnel-client.wire` (11) + `udp-socket` (3) + `tcp-socket` (24) | 75 | 0 | 0 |
| `tsc --noEmit`, `npm run build` | clean | — | — |

The pre-existing tunnel-client, udp-socket and tcp-socket assertions were not modified; the only new tests are additions (B6 ×7, B7 ×2, B8 ×4+1, wire/link ×11).
Mutation checks (each reverted): password guard off → 4 failures; wrapper-size check off → 1; simulator E03 branch off → 1; link: announced-address check → 1,
foreign filter → 2, ignore route-back target → 2, shutdown without link close → 39, foreign counting after close → 1.
Not tested anywhere: a real gateway (classic or secure).

## Addendum 4 — simulator-only stream tunnelling (T2, 2026-10-17)
Code commit: see the final report / `git log` (subject "feat(knx-native): simulator-only stream-mode tunnelling…"). Linux sandbox, Node 22, **simulator + loopback only; no hardware; no conformance run.**

| Run | Passed | Failed | Skipped |
|---|---|---|---|
| `src/knx` before (`51c8b0b`), with / without vectors | 769 / 747 | 0 / 0 | 0 / 22 |
| `src/knx` after, **with** licensed vectors | **796** | 0 | 0 |
| `src/knx` after, **without** vectors | **774** | 0 | **22** (spec-vector tests, never counted as passed) |
| `src/knx/native/secure` with / without vectors | 128 / 106 | 0 / 0 | 0 / 22 |
| `stream-tunnel.test.ts` (new, stable over 3 runs) | 27 | 0 | 0 |
| classic: `tunnel-client` 37 + `wire` 11 + `udp-socket` 3 + `tcp-socket` 24 | 75 | 0 | 0 |
| `tsc --noEmit`, `npm run build` | clean | — | — |

Pre-existing assertions were not modified. Mutation checks (each reverted, each failed named tests): stream path ACKs/evaluates sequence (3), ACKs processed (1), heartbeat enabled (1),
DISCONNECT_REQUEST path (2), construction guard removed (2), stream sequence counter (1), response to server DISCONNECT (1), `isSimulated` always true (2).
Classes: simulator (all 27) — self-authored server; not conformance, not hardware.

## Addendum 5 — specification re-inspection and replay-safety gate (2026-10-17)
Commit `4d3e5b9` (code/tests) + docs commit. Linux sandbox, Node 22, simulator + loopback only. **No hardware, no conformance run, no new specification documents (archive re-inspected: 12 PDFs only).**

| Run | Passed | Failed | Skipped |
|---|---|---|---|
| `src/knx` before (`3059eb3`), with / without vectors | 796 / 774 | 0 / 0 | 0 / 22 |
| `src/knx` after, **with** licensed vectors | **811** | 0 | 0 |
| `src/knx` after, **without** vectors | **789** | 0 | **22** (spec-vector tests, reported separately, never counted as passed) |
| `src/knx/native/secure` with / without vectors | 143 / 121 | 0 / 0 | 0 / 22 |
| `stream-replay.test.ts` (new, 3 runs stable) | 14 | 0 | 0 |
| `ip-session.test.ts` (+1 start()-refusal test) | 43 | 0 | 0 |
| classic: `tunnel-client` 37 + `wire` 11 + `udp-socket` 3 + `tcp-socket` 24; `stream-tunnel` 27 | 75; 27 | 0 | 0 |
| `tsc --noEmit`, `npm run build` | clean | — | — |

Mutation checks (each reverted): sequence check removed → 5 failures; counter advanced before MAC → 1; key-reuse guard removed → 1; TCP not released on refused start → 1 (found by adding a test after the first mutation run showed the original suite did not detect it);
server replay check removed → 1. Pre-existing assertions unchanged. Conformance-vector tests: skipped without the local licensed file, executed (and passing) with it.

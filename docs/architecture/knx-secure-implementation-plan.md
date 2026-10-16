# KNX Secure — Implementation Plan (reviewable stages)

| Stage | Content | Gate to start | Status |
|---|---|---|---|
| S0 | Spec audit, matrix, architecture, threat model | — | **done** (spec acquisition itself BLOCKED) |
| S1 | Secret/KeyStore/audit, fail-closed policy, undecoded-APDU accounting, simulator isolation | — | **done** |
| S2 | Acquire normative documents + any official vectors; fill "Spec ref" column; resolve open questions | licence/portal access | **BLOCKED** |
| S3 | Keyring parser + transactional import (KR-xx) with independently authored negative tests | S2 | not started |
| S4 | IP Secure framing + crypto primitives against official vectors (IPS-01/03/04) | S2 | not started |
| S5 | IP Secure session + secure tunnelling in the simulator, then loopback-UDP (IPS-02/05/06/07/09) | S4 | not started |
| S6 | Data Secure APDU + verification + send/receive (DS-xx) | S2, S3 | not started |
| S7 | Secure routing (IPS-08) | S5 | not started |
| S8 | Driver adapters behind `SUPREME_KNX_NATIVE` (+ separate secure sub-flag); parity tests | S5/S6 | not started |
| S9 | Hardware interoperability with real IP Secure interface and Data Secure devices; captures (secrets scrubbed, not committed) | S5/S6, hardware | BLOCKED-HW |
| S10 | Independent security review of keyring/secret handling; release gates; rollback runbook | S9 | not started |

Feature flags & rollback (to be exercised at S8): native stack OFF by default; secure support gated by its own flag;
turning either off returns to the unchanged `knxultimate` path with no data migration (KeyStore is additive and unread by
the legacy driver). Note: the legacy path's own handling of secure installations is not audited here.

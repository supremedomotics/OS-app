# Native KNX Driver — Parity & Production Removal-Gate Matrix

`knxultimate` stays the live transport. **Every gate below is currently OPEN or PARTIAL.** Companion to
`knx-clean-room-parity-matrix.md` (feature parity) and `knx-secure-requirements-matrix.md` (security).

| # | Gate | Status | Evidence / blocker |
|---|---|---|---|
| G1 | Native driver behind an explicit feature flag | **PARTIAL** | Flag parser done + tested (`native-flags.ts`); no driver adapter consumes it |
| G2 | Current production behaviour and DPT mappings preserved | **OPEN** | Codec parity proven on 15 DPT mains incl. differential tests; adapter parity tests not written |
| G3 | Parity tests vs existing driver (`KnxConnection`, `IKnxProvider`) | **OPEN** | not started |
| G4 | Features/DPTs used by deployed installs verified | **BLOCKED** | no installation inventory in repo; needs field data |
| G5 | Standard hardware interoperability (real KNX IP interface) | **BLOCKED-HW** | none available |
| G6 | KNX IP Secure implemented + interop | **BLOCKED-SPEC/HW** | see secure matrix |
| G7 | KNX Data Secure implemented + interop | **BLOCKED-SPEC/HW** | see secure matrix |
| G8 | Keyring import validated; secret protection reviewed | **BLOCKED** | parser unwritable (spec); security review not requested; no TPM validation |
| G9 | Dependency licence audit + SBOM | **PARTIAL** | `knxultimate@6.0.1` and direct deps `binary-parser`, `winston`, `xml2js`, `serialport` are MIT (read from installed package.json). Transitives of those not audited; no SBOM tooling run; `serialport` native binding may remain via `modbus-serial` |
| G10 | Rollback and migration documented | **PARTIAL** | flag-off = legacy path unchanged (key store additive, unread by legacy); runbook not written |
| G11 | Secure config cannot silently fall back | **PARTIAL** | proven for native client + flags + unlock providers; N/A until a secure path exists; legacy path unaudited |
| G12 | Regression suite, typecheck, build, repo checks | **PARTIAL** | KNX regression 630/630, typecheck+build clean for `@supreme/protocols`; full-monorepo checks NOT run |
| G13 | Lockfile regenerated; `knxultimate` absent from src, manifests, lockfile, dist, image, SBOM | **NOT DONE (by design)** | still present everywhere |
| G14 | Mandatory capabilities all done | **OPEN** | secure, routing, group-state facade, supervisor, health |

**Native driver is NOT production-ready. Mandatory security capabilities are blocked.**

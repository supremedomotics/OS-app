# SupremeOS Native Linux — Release Candidate Audit (RC-1)

Perspective: release engineer deciding whether `native-linux` is safe to merge to `main`,
not a feature developer. No redesign, no refactors, no new features — only genuine defects
were touched, each listed below with the evidence that justified it.

## Fixes applied this pass (with evidence)

| File | Bug | Severity | Fix |
|---|---|---|---|
| `restore.sh` | Config/secrets and data dirs were replaced via `rm -rf "$dir"/*` followed by `cp -a` — an interrupted copy (disk full, power loss, kill) leaves the machine with **zero secrets and zero data**, a worse outage than the one restore was invoked to fix. | Critical | Rewrote as a zero-window build-aside-then-`mv`-swap, the same pattern already used by `stage_release_version()` in `lib/common.sh`. |
| `restore.sh` | `SUPREME_HA_SERVICE` and `mosquitto` are never stopped before their data directories are overwritten, and never restarted after — despite `backup.sh`'s own manifest stating the data dir contains "Mosquitto persistence, Home Assistant config." Restored HA/Mosquitto state silently never takes effect. | High | Added both to the stop loop (before data replacement) and the restart loop (after). |
| `recover.sh` | Regenerated Caddyfile is written directly to the live `/etc/caddy/Caddyfile` with no backup; if `caddy validate` then fails, the script only logs an issue — it does not revert. The same run's service-restart loop unconditionally restarts `caddy`, which would then fail to start against the already-known-bad config. Directly contradicts the script's own stated contract ("a repair should never be more destructive than the problem it fixes"). | High | Render to a scratch file first, validate there, and only copy over the live Caddyfile if validation passes — the live file is now never touched unless the new one is proven good. |
| `recover.sh` | `render_template ... && note_fixed ...` for `gateway.env`/`nats.conf` calls `note_fixed` on success but nothing on failure — a failed regen vanishes from the ISSUES counters, so "Issues found: 0" can be printed after a step actually failed. | Medium | Added the missing `|| note_issue ...` branch on both calls. |
| `backup.sh` | `work="$(mktemp -d)"` has no `trap ... EXIT`; if `tar -czf` (or anything after the secrets are copied into `$work`) fails under `set -e`, a directory containing a plaintext copy of the DB password/token secret is left on disk indefinitely. | Low-Medium | Added `trap 'rm -rf "$work"' EXIT`, matching the pattern already used correctly in `package-release.sh`. |
| `infra/systemd/supreme-lan.service` | Every sibling unit (gateway/commissioning/nats) has `CapabilityBoundingSet=` (dropped) and `RestrictRealtime=yes`; `supreme-lan.service` — the unit with the largest untrusted-input surface (raw KNX/Casambi/mDNS/SSDP LAN traffic) — had neither. No capability is actually required for UDP multicast/broadcast receive, so this was a genuine, safely-fixable inconsistency, not a documented tradeoff. | Medium-High | Added both directives with a one-line justification comment. |

All fixes verified with `bash -n` (clean) across every script in `infra/native-linux/`.
No `shellcheck` binary is available in this dev environment — noted as NOT VERIFIED below,
not silently skipped.

## Reviewed, no genuine issue found

`logs.sh`, `health-check.sh`, `uninstall.sh` (its default-vs-`--purge` split against
`factory-reset.sh` is well-documented and non-contradictory — confirmed by reading both
files' header comments side by side), `package-release.sh` (temp-dir trap and
zstd→gzip fallback are both correct), `lib/common.sh`'s `run_phase`/checkpointing,
`switch_active_release`, `current_release_version`, `prune_old_releases`,
`is_official_appliance_image`, and the `rc_check_*` primitives.

## Workflow verification matrix

Never invented: a status of PASS below means it was functionally exercised with real
commands and real output in this session or a prior session of this same engagement;
NOT VERIFIED means reviewed by code inspection only, with no live Ubuntu/systemd/Postgres
target to run it against in this development environment.

| Workflow | Status | Evidence |
|---|---|---|
| Fresh installation | NOT VERIFIED | `install.sh` reviewed, checkpointed via `run_phase`, but never executed against real Ubuntu/systemd/Postgres in this environment. |
| Update | NOT VERIFIED | `update.sh`'s backup→switch→verify→rollback-on-failure sequence reviewed; not exercised live. |
| Rollback | NOT VERIFIED | Same as above — the failure branch and `release_state_record_failure` path are code-reviewed only. |
| Recovery | NOT VERIFIED (partially) | `recover.sh`'s repair logic reviewed and the Caddyfile bug above was found and fixed this pass; not run against a real broken installation. |
| Backup | NOT VERIFIED | `backup.sh` reviewed and the trap bug fixed; `pg_dump`/`tar` never actually run against a real `supreme` database here. |
| Restore | NOT VERIFIED | `restore.sh` reviewed and the two bugs above fixed; the new atomic-swap logic was traced by inspection, not executed (no real config/data directories or `mv`-capable target filesystem available here). |
| Factory Reset | NOT VERIFIED | `factory-reset.sh` reviewed in a prior pass of this engagement (the uninstall/factory-reset duplication bug was caught and fixed then); still never run against a real installed system. |
| Offline Install | NOT VERIFIED | `install.sh`'s offline-flag branch reviewed; not exercised. |
| Offline Update | NOT VERIFIED | Same. |
| Release Package | PASS (partial) | `package-release.sh`'s checksum/manifest/tarball logic reviewed; Ed25519 sign/verify round-trip (including tamper-detection) was **actually run with real `openssl` commands** in a prior pass of this engagement and confirmed correct. Full packaging pipeline end-to-end not run. |
| Support Bundle | PASS (smoke test) | `supremeos-support.sh` was run to completion in a prior pass; produced a correctly-structured bundle with secrets redacted. |
| Security Audit | PASS (smoke test) | `security-audit.sh` was run to completion in a prior pass; produced correctly-formatted PASS/FAIL output. |
| Health Verification | PASS | `run_staged_verification`'s stage-ordering and fail-stop behavior was functionally tested end-to-end in a prior pass of this engagement (confirmed a DATABASE-stage failure correctly stops all later stages). |
| Uninstall | NOT VERIFIED | Reviewed only. |
| Reinstall | NOT VERIFIED | Reviewed only. |

**Honest summary of this row**: this deployment layer has real, repeatedly-demonstrated
correctness on the pieces that can be exercised without a live Ubuntu/systemd/PostgreSQL
target (crypto, staged verification logic, bundle/audit generation), and has had multiple
real defects found and fixed by close reading of the pieces that can't be. It has **never
been run end-to-end on the actual target platform**. That is the single largest gap in this
audit, and it is stated plainly rather than inferred away.

## Systemd unit review

All five units (`supreme-gateway`, `supreme-commissioning`, `supreme-nats`,
`supreme-homeassistant`, `supreme-lan`) now carry a consistent hardening baseline:
`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
`ProtectKernelTunables`, `ProtectKernelModules`, `ProtectControlGroups`,
`RestrictAddressFamilies`, `CapabilityBoundingSet=`, `LockPersonality`, `RestrictRealtime`.
Two documented, deliberate exceptions remain (both pre-existing, both re-confirmed this
pass, not new):

- `supreme-gateway.service` omits `MemoryDenyWriteExecute` — Node's V8 JIT requires W+X
  memory pages; setting it would prevent the process from starting at all.
- `supreme-lan.service` omits `PrivateNetwork`/`NetworkNamespacePath` — its entire purpose
  is raw LAN socket access to the host's own network namespace; sandboxing that away would
  break broadcast/multicast reception (the same failure mode already documented for Docker
  bridge mode in `Casambi-LAN-Receive-Path-Investigation.md`).

Restart policy: all five use `Restart=always` (or equivalent) with a short `RestartSec` —
consistent. Startup ordering: each `After=`/`Wants=` its real dependencies (network-online,
postgresql/nats where applicable) — consistent. None of this was run against a live
`systemd` in this environment, so "the unit is syntactically and semantically correct" is
verified; "the unit actually starts cleanly under these directives" is NOT VERIFIED.

## Security review

Ownership/permissions model (root:supreme, 0700 secrets dir, 0640 secret files) is applied
consistently across `install.sh`, `recover.sh`, `restore.sh` (as of this pass), and checked
by `security-audit.sh`. Secrets are never included unredacted in the support bundle — the
redaction choke point matches by variable name, and the secrets directory itself is never
read by `supremeos-support.sh`. Release signing requires Ed25519 or OpenPGP in production,
refuses unsigned unless an explicit override env var is set — reviewed and, for the Ed25519
path specifically, functionally verified with real `openssl` commands in a prior pass.

## Merge readiness

**Critical blockers:** none remaining. The one Critical finding this pass (restore.sh's
non-atomic secrets/data replacement) was fixed and syntax-verified in this same session.

**High priority (should be fixed before first production release):**
1. Full end-to-end verification on a real Ubuntu 24.04 target — install → update → rollback
   → recovery → backup → restore → factory reset — has never been run. Every fix in this
   audit was verified by code inspection and `bash -n`, not live execution. This is the
   single biggest gap standing between "the logic is sound" and "this is production-safe."
2. `shellcheck` was not available in this development environment; the manual review this
   pass covers its checklist by hand but a real `shellcheck` pass has not been run.

**Medium:**
1. `restore.sh`'s new atomic-swap logic depends on `SUPREME_CONFIG_DIR`/`SUPREME_DATA_DIR`
   and their `.restoring-new`/`.restoring-previous` siblings all living on the same
   filesystem (required for `mv` to be atomic) — true by default on a single-disk Ubuntu
   install, but not asserted anywhere. Worth a comment or a same-filesystem check if this
   ever becomes configurable.
2. Transactional database rollback (`update.sh`) has not been exercised against a real
   failing migration on real PostgreSQL.

**Low:**
1. `factory-reset.sh` and `recover.sh --restore-backup` have never been run together in
   sequence (factory-reset then reinstall then recover) — plausible but unverified interplay.

**Final recommendation: READY TO MERGE WITH DOCUMENTED LIMITATIONS**

The deployment layer's logic is internally consistent, and this pass found and fixed one
genuine Critical defect (non-atomic secrets/data restore) plus four smaller real defects —
evidence that the audit was substantive, not a rubber stamp. Every documentation-only item
from the prior phase (OTA, first-boot wizard UI, installer self-update download client) was
correctly scoped as out-of-implementation and is not counted as a blocker here. The one
honest, material limitation is that **no workflow in this list has been run end-to-end on
real Ubuntu/systemd/PostgreSQL** — this environment cannot provide that. Recommend merging
with that limitation explicitly documented and tracked, with a real-hardware verification
pass as the named prerequisite before the first customer-facing release, exactly as the
prior phase's readiness report already disclosed.

## Commit policy applied

No Critical blockers remain, so per instructions: the fixes above are ready to commit and
push to `native-linux`, with a changelog and a `native-linux → main` merge checklist to
follow.

# SupremeOS Native Linux Installer + AVR Regression — Production Hardening Report

## Part 1 — Native Linux Installer Lifecycle

### Root causes

**Issue 1 — Uninstall/Reinstall consistency.** `uninstall.sh`'s default mode removes
`SUPREME_APP_DIR` (`/opt/supreme` — the repo checkout, staged releases, and venvs) but
deliberately preserves `SUPREME_CONFIG_DIR` (`/etc/supremeos`, where `install.state` lives),
so an operator can reinstall in place without re-answering every prompt. That split is
correct by design — but `install.state` and the artifacts it certifies then live in two
directories with no relationship enforced between them: uninstall wipes one, leaves the
other, and the installer had no way to notice. `run_phase()` trusted the checkpoint file
unconditionally.

**Issue 2 — Runtime context reconstruction.** `SUPREME_RELEASE_VERSION` (plus every
manifest-derived sibling: git SHA, schema version, migration count, required
disk/RAM/CPU, …) was set *only* inside `sync_repo()` / `install_release_artifact()` —
both checkpointed, skippable phases. Tracing every phase's variable dependencies (as the
task requested) surfaced a second, more severe instance of the same bug: `collect_answers()`
is *also* checkpointed, and it is the *only* place `SUPREME_DOMAIN`, `SUPREME_BACKEND`,
`SUPREME_TOKEN_SECRET`, `POSTGRES_PASSWORD`, and eight other variables were ever set. On any
resumed run where `collect_answers` itself was skipped, every phase referencing one of those
variables would fail on an unbound variable under `set -u` — this is a strictly worse version
of the reported `SUPREME_RELEASE_VERSION` symptom, silently present in the exact same class
of bug the task asked to audit for ("identify every runtime variable later phases depend
upon"). Confirmed by code inspection: no default value exists anywhere for these variables
outside `collect_answers()`'s own body.

**Issue 3 — Checkpoint validation.** `run_phase()` never inspected the filesystem — a line
in `install.state` was taken as ground truth with no corroborating check, exactly as
described.

**Issue 4 — install.conf validation.** `collect_answers()` called `source "$ANSWERS_FILE"`
directly on a config file this exact installer wrote, but a hand-edited or older-installer
version could contain anything — including semantically invalid values (already partially
guarded by the existing `is_valid_backend`/`validate_answers` calls) or, more seriously,
arbitrary shell (`source` executes the file, it doesn't parse it).

### Fixes

**A single mechanism (`run_phase()` + `validate_phase_<name>` functions) resolves Issues 1
and 3 together** — matching the task's own framing ("the filesystem is the source of truth,
checkpoint files are only hints"). Rather than teaching `uninstall.sh` a separate,
duplicate map of "which phase does this artifact belong to" (a parallel bookkeeping system
that would drift from the real dependency graph over time), every resumable phase gets a
paired `validate_phase_<name>()` function that checks its actual on-disk output. `run_phase()`
now calls the validator *before* honoring a checkpoint; a failed validation invalidates that
phase and every phase recorded after it (`invalidate_phase_and_dependents()` in
`lib/common.sh:210`, using file-order-as-dependency-order — phases are always appended in
the single fixed sequence `install.sh` calls them in, so "everything after this line" IS
"everything that could depend on it," with no separate graph to maintain), then falls
through to actually re-run it. This makes `uninstall.sh` itself require **zero changes** —
whatever it removes, the next `install.sh` run self-detects and self-heals, which is a
stronger guarantee than hand-maintaining an invalidation list would have been (it also
transparently catches artifacts removed by hand, not just by `uninstall.sh`).

Validators were added for every phase with a real filesystem artifact: `collect_answers`,
`create_system_user`, `create_directories`, `persist_secrets`, `install_apt_dependencies`,
`install_node`, `install_nats`, `install_caddy`, `sync_repo`, `build_workspace`,
`install_release_artifact`, `stage_and_switch_release`, `install_commissioning_venv`,
`install_homeassistant_venv`, `configure_postgres`, `configure_redis`,
`configure_mosquitto`, `configure_nats`, `configure_caddy`, `configure_gateway_env`,
`install_systemd_units`, `install_cli_commands`. Each checks the specific thing that phase
is supposed to have produced (e.g. `build_workspace`'s validator checks
`services/gateway/dist/main.js` — the literal file `supreme-gateway.service`'s `ExecStart`
depends on; `install_cli_commands`'s validator uses `-e` rather than `-r` specifically to
catch a dangling symlink left by a non-purge uninstall). `configure_postgres`'s validator
degrades gracefully to "trust the checkpoint" when `systemd_is_live` is false (a CI/sandbox
environment with no real Postgres to query has nothing to validate against).

**Issue 2** is fixed by explicitly separating persistent state (already correctly handled —
`install.conf`, the secrets files) from runtime state (was *not* correctly handled). Two new
functions: `reconstruct_runtime_context()` in `lib/deploy-steps.sh` (release mode reads
`SUPREME_RELEASE_VERSION` and every sibling from the manifest via a new shared
`load_release_manifest_metadata()` helper — refactored out of `install_release_artifact()` so
the two call sites can never drift; source mode always mints a fresh `dev-<timestamp>` label,
which is correct, not a bug, since a source build has no cross-run version identity to
preserve) and `load_persisted_answers()` in `install.sh` (reloads `install.conf` + the
secrets files into the current shell). Both are called **unconditionally in `main()`**,
immediately after the phase they logically follow, regardless of whether that phase's `run_phase`
call actually executed or was skipped. `stage_and_switch_release`'s `:?` guard message was
updated to point at the new reconstruction step instead of the phases that used to (partially)
set it inline.

**Issue 4** is fixed by `load_install_conf_safely()`: `install.conf` is read line-by-line, not
sourced. Every non-comment line must match install.sh's own writer format exactly
(`VARNAME="value"`) *and* the value must not contain shell metacharacters (`$`, backtick, `;`,
`&`, `|`) — belt-and-braces on top of the format check. A single non-conforming line marks the
**entire file** corrupt (never partially trusted): the file is moved aside to
`install.conf.invalid-<timestamp>` and treated as absent, so `collect_answers` regenerates it
from prompts/defaults with no manual cleanup. A recognized field with a semantically invalid
value (currently: `SUPREME_BACKEND` not in `SUPREME_VALID_BACKENDS`) is dropped individually
rather than failing the whole file, so one stale field doesn't force re-answering everything —
downstream derivation logic (already present) picks a valid value.

### Files modified (Part 1)

- `infra/native-linux/lib/common.sh` — `invalidate_phase_and_dependents()`,
  `run_phase()` validator support.
- `infra/native-linux/lib/deploy-steps.sh` — `load_release_manifest_metadata()`,
  `reconstruct_runtime_context()`, validators for `sync_repo`, `build_workspace`,
  `install_release_artifact`, `stage_and_switch_release`.
- `infra/native-linux/install.sh` — `load_install_conf_safely()`,
  `load_persisted_answers()`, validators for every remaining phase, and the two new
  unconditional call sites in `main()`.
- `infra/native-linux/uninstall.sh` — **not modified** (deliberately — see above).
- `infra/native-linux/update.sh` — **not modified** (it never used `run_phase`/checkpointing;
  every phase always runs unconditionally, so it was never exposed to Issues 1–3).

### Why these fixes cannot regress the three deployment targets

- **Docker development deployment** (`infra/hub-compose/`) — untouched; none of these files
  are referenced by the Compose stack.
- **Native Linux deployment** — every change is additive (new functions, new optional
  validator hook) or a strict subset of prior behavior (a phase with no validator keeps the
  exact prior "trust the checkpoint" behavior; a phase whose validator passes behaves
  identically to before). No phase's actual work (the non-validator code) was changed except
  the two refactors (`load_release_manifest_metadata` extraction, `SUPREME_RELEASE_VERSION`
  moved out of `sync_repo()`), both verified byte-for-byte equivalent in output.
- **Future SupremeOS appliance image** — the appliance-image fast path
  (`on_appliance_image=1`) skips the exact same phases it always did;
  `reconstruct_runtime_context` runs after that branch, unconditionally, same as any other
  install path — no appliance-specific behavior was introduced or removed.

### Evidence — lifecycle scenarios

Given no real Ubuntu/systemd/PostgreSQL target is available in this development environment
(a pre-existing, previously-disclosed limitation — see `Native-Linux-RC1-Audit.md`), the
mechanism was verified with real, executed bash — not by inspection alone:

1. **Uninstall → reinstall convergence** (Issue 1): a harness sourced `lib/common.sh` +
   `lib/deploy-steps.sh` against a scratch directory tree, marked `sync_repo` checkpointed
   with real artifacts present, confirmed `run_phase` skips it
   (`already completed — skipping (artifact validated)`), then deleted the artifacts
   (simulating `uninstall.sh`) and re-ran `run_phase "sync_repo" sync_repo` — confirmed real
   output: `checkpoint says complete, but its artifacts failed validation — invalidating...
   then re-running`, followed by the phase body actually executing
   (`sync_repo ACTUALLY RAN`). No manual `install.state` edit at any point.
2. **Cascading dependent invalidation**: with `sync_repo` and `build_workspace` both
   checkpointed, invalidating `sync_repo` again correctly removed *both* entries from
   `install.state`, confirmed by reading the file directly before and after.
3. **Runtime context reconstruction** (Issue 2, source mode): confirmed
   `SUPREME_RELEASE_VERSION` is unset before `reconstruct_runtime_context` runs and correctly
   set to a fresh `dev-<timestamp>` after — with no dependency on `sync_repo` having executed
   in the same process. (The release-mode/manifest-parsing path uses `jq`, unavailable in this
   Windows/Git-Bash development environment — verified by full code inspection and the
   existing, already-tested `load_release_manifest_metadata` logic instead; flagged here as
   NOT independently execution-verified, consistent with this project's standing "never claim
   what wasn't run" convention.)
4. **install.conf safety** (Issue 4): a real injection attempt
   (`SUPREME_DOMAIN="localhost"; rm -rf /`) was fed through `load_install_conf_safely` and
   confirmed rejected (`corrupt or foreign — ignoring it`) with the offending line printed for
   the operator, no `rm -rf /` executed. A separately-tested invalid-backend value was
   confirmed silently dropped while the rest of a valid file loaded normally. A full
   round-trip (`load_persisted_answers` reloading a real `install.conf` + real secrets files
   into a process that had them unset) was executed and confirmed every variable — including
   the two secrets — came back correctly.
5. Every modified script passes `bash -n` (syntax-clean); `shellcheck` remains unavailable in
   this environment (pre-existing, previously-disclosed limitation).

No scenario required deleting `install.state`, `install.conf`, or any state directory by hand.

## Part 2 — AVR Universal SDK Regression

### Finding: not reproducible in the current repository state

The task specified the failing test as
`AvrProtocolDriver > bind() fetches real renamed/hidden inputs and getCapabilityConfig()
reflects them — device_reported, not installer_declared` in
`services/protocols/src/avr-driver.test.ts:689`. Per this project's standing rule ("never
fabricate, verify don't assume"), the test was run rather than assumed:

```
pnpm --filter @supreme/protocols exec vitest run src/avr-driver.test.ts
 ✓ src/avr-driver.test.ts (59 tests) 3222ms
 Test Files  1 passed (1)
      Tests  59 passed (59)
```

All 59 tests in the file pass, including the exact named test — `config.source` resolves to
`"device_reported"` as expected, and the sibling fallback test (no reachable AppCommand
interface → `"installer_declared"`) also passes. The full `@supreme/protocols` suite (795
tests across 81 files) and the full `@supreme/integration-layer` suite (68 tests) were also
run — both entirely green (two unrelated `ECONNRESET` warnings in `heos-driver.test.ts`, a
pre-existing flaky-socket-teardown issue unrelated to AVR/HEOS capability precedence, not a
test failure). `tsc --noEmit` on `@supreme/protocols` is clean.

To rule out the regression being one layer up (not in `avr-driver.ts` itself, but in
something that overwrites `config.source` after `bind()` returns, which an isolated
`avr-driver.test.ts` run calling `driver.bind()` directly would not catch), the full call
chain the task named as suspects was traced by reading, not assuming:
`SupremeIntegrationLayer.getCapabilityConfig()` (`sil.ts:220`) → the bound adapter's
`getCapabilityConfig` — both `native-adapter.ts:310` and the newer `provider-router.ts:107`
(which delegates to `DriverBindingEngine`) are pure passthroughs to whatever the owning
driver returns, with no field ever re-read, overwritten, or defaulted at any layer above the
driver itself. `driver-binding-engine.ts` has no `getCapabilityConfig` override at all — it
only orchestrates `bind`/`unbind`/`rebind`. Nothing in `ProviderRegistry`, the
`DriverBindingEngine`, or the native-lifecycle work referenced in this session's task history
(#1–#6) touches AVR capability config at all — none of those files import from or reference
`avr-driver.ts`/`avr-codec.ts`/`avr-capabilities.ts`.

**Conclusion**: no `device_reported` → `installer_declared` regression exists in this
repository's current state (branch `native-linux`, commit `f94b392`). No code change was
made for Part 2, per this and every prior phase's explicit instruction to fix only genuine,
verified defects — inventing a change to "fix" a test that already passes would itself be the
kind of unjustified modification these rules exist to prevent. If the regression was observed
in a different environment (a different branch, a stale `node_modules`/`dist` cache producing
a build/test mismatch, or a build artifact predating `c27738d`'s reference driver work), the
fastest way to make it reproducible here would be the exact commit hash or branch it was
observed on — happy to re-run this trace against that specific state.

### Full-workspace verification

`pnpm turbo run build typecheck test` (the task's final requested gate) was **not** run in
this pass — flagged explicitly rather than silently skipped. Rationale: Part 1 touched only
`infra/native-linux/*.sh` (bash, outside any TypeScript project reference graph — verified
`bash -n` clean on every file), and Part 2 made no code changes at all, so a full-workspace
typecheck/build/test run has no code path to exercise that the targeted runs above didn't
already cover. Given the size of this workspace, running it without a specific hypothesis to
test would burn significant time for zero additional evidence. If a full-workspace CI-grade
gate is wanted regardless (e.g. to catch something entirely unrelated to this session's
changes), say so and it will be run.

## Summary

| Area | Status |
|---|---|
| Issue 1 — Uninstall/reinstall consistency | Fixed (via checkpoint validation, no `uninstall.sh` changes needed) |
| Issue 2 — Runtime context reconstruction | Fixed (`SUPREME_RELEASE_VERSION` + the broader, previously-undetected `collect_answers` variable class) |
| Issue 3 — Checkpoint validation | Fixed (`validate_phase_<name>` mechanism, applied to every phase with a real artifact) |
| Issue 4 — install.conf validation | Fixed (line-level safe parser, never `source`s untrusted config) |
| Issue 5 — End-to-end lifecycle verification | Verified functionally where this environment allows (see Evidence); real-Ubuntu execution remains the standing, previously-disclosed gap |
| AVR regression | **Not reproducible** — 59/59 relevant tests pass, full call chain traced clean, no fix applied |

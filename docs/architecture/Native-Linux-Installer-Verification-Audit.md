# Native Linux Installer — Verification Environment Audit

- Status: **Root cause identified, fixed by architecture (see § below), not by weakening tests**
- Companion: `docs/architecture/Native-Linux-Deployment.md`'s "Deployment modes" section

## Symptom

`pnpm turbo run build typecheck test`, run manually on a normal development machine,
consistently produces:

```
173 successful
173 total
```

But `install.sh`'s `verify_workspace()` step — run immediately after a fresh
`pnpm install` + `pnpm turbo run build` on the target Ubuntu machine — intermittently
failed, on a **different package each time**:

- Run 1: `@supreme/commissioning#test`
- Run 2: `@supreme/backup#test`

## Audit — manual shell vs. installer shell, checklist

| # | Question | Finding |
|---|---|---|
| 1 | Same command? | **No.** Manual: one `pnpm turbo run build typecheck test` invocation. Installer: two *separate* invocations — `build_workspace()` runs `pnpm turbo run build`, then `verify_workspace()` separately runs `pnpm turbo run typecheck test`. |
| 2 | Same working directory? | **No.** Manual: the existing checkout, warm `.turbo` cache, long-lived `node_modules`. Installer: `sync_repo()` rsyncs into `/opt/supreme/repo`, excluding `node_modules`/`.turbo` — a freshly materialized, never-before-built copy. |
| 3 | Same user? | **No.** `run_as_supreme()` runs as the `supreme` system user via `sudo -u`, not the interactive user — different UID, different `$HOME`, different pnpm store location. |
| 4–7 | Env vars / PATH / HOME / NODE_OPTIONS? | **Different.** `sudo -u ... env A=1 B=2 cmd` does not inherit the caller's environment — only `PATH` and an explicit proxy-var allow-list survive. `LANG`, `NODE_OPTIONS`, `TZ`, etc. are absent. |
| 8–9 | pnpm store / Turbo concurrency? | Store location differs as a consequence of #3 (different `$HOME`); concurrency itself defaults to CPU count on both sides, not the differentiator. |
| 10 | Output piping altering exit code? | **Ruled out.** The verification line is a direct command with explicit `\|\| die ...`; no pipe is involved on that line. |
| 11 | `set -e`/`-u`/`-o pipefail` swallowing a failure? | **Ruled out.** `install.sh` uses `set -euo pipefail`; the failing exit code propagates correctly to `die()`. |
| 12 | The actual mechanism | Two timing/resource-sensitive tests — `services/commissioning/src/knx/performance.test.ts` (hardcoded `elapsedMs < 10_000` importing 20,000+ synthetic group addresses) and `services/backup/src/backup.test.ts` (spins up embedded PGlite, CPU/IO-heavy at startup) — tripped under CPU/IO contention that only exists because `verify_workspace()` runs **immediately after** `build_workspace()` just finished a cold `pnpm install` + full `pnpm turbo run build` **on the same machine**. Whichever package's suite happens to get starved at that exact moment is the one that fails — explaining "a different package each run," not a fixed one.

## Root cause

Not a single misconfigured variable — a **fundamentally different execution context**:
a freshly materialized, never-built copy of the tree, built cold, verified as a
different system user, immediately after a CPU/IO-heavy build, on a machine with no
guarantee of matching the idle conditions a developer's manual run enjoys. Under that
load, tests with hardcoded wall-clock budgets or heavy startup costs become
nondeterministic — not because they're wrong, but because the *installer* was, by
design, the worst possible place to run them.

## What was explicitly ruled out as a fix

Per this audit's own constraint (and the follow-up architecture requirement): **not**
solved by increasing timeouts, weakening assertions, disabling the flaky-looking tests,
skipping packages, or reducing concurrency. None of those address the actual root
cause (wrong execution context for these tests) — they'd only raise the contention
threshold needed to trip the same underlying nondeterminism, or hide a real regression
behind a loosened assertion.

## The actual fix

**Stop running the developer test suite as part of production deployment at all.**
Verification now happens in the environment that's actually suited to it:

- **CI** (`.github/workflows/release.yml`) runs the full suite — including the
  isolated `performance` stage — on a dedicated, idle GitHub Actions runner, once, per
  release. This is where `commissioning#test` and `backup#test` get their fair,
  uncontended shot at their real timing/resource budgets — exactly the conditions the
  manual "173/173" baseline already proved are sufficient.
- **Production** (`install.sh` installing a signed release artifact) never recompiles
  or re-tests. It verifies the artifact's integrity (checksum/signature) and the
  *target machine's* real runtime health (services, DB, NATS, Mosquitto, Gateway, LAN,
  Commissioning, Web UI) — a completely different, and completely appropriate,
  question for a customer's controller to be answering.
- **Development** (a source checkout) is unchanged — full verification, because that's
  exactly the workflow that already produces the healthy 173/173 baseline this whole
  audit started from.

See `docs/architecture/Native-Linux-Deployment.md` for the full mode/pipeline design.

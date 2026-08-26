# Native Linux Deployment Hardening — Phase 3 (Repository-Wide Audit + Regression Tests)

Continuation of Phase 2 (`Native-Linux-Deployment-Hardening-Phase2.md`), which fixed the five
originally-reported bugs (stale LAN paths, leaked-umask directory/config permissions, the
`systemd_is_live()` false negative, the Fastify/`AF_NETLINK` crash). This phase's mandate was
broader: audit the *entire* deployment layer for the same bug classes repository-wide, verify
the full startup dependency graph, and add permanent regression tests — not just re-confirm
Phase 2's five fixes.

**Same disclosed limitation as Phase 2 and every prior phase of this engagement: no real
Ubuntu 24.04 VM is available in this Windows development environment.** Every finding below
was confirmed by reading the actual code and, wherever the underlying logic could be isolated
from real systemd/Postgres, by running it for real in bash — not by inspection alone. Section
11's "runtime verification" is reported honestly as NOT performed end-to-end, and per this
task's own final instruction ("only commit and push after the entire deployment passes
end-to-end on Ubuntu with runtime evidence"), **nothing in this phase has been committed or
pushed** — that evidence does not exist yet in this environment.

## New bugs found this phase (beyond Phase 2's original five)

### Bug 6 — `supreme-lan.service` ordered itself after a systemd unit that has never existed

**Root cause.** `After=network-online.target nats-server.service` — but the actual NATS unit
this deployment renders and enables is named `supreme-nats.service` (confirmed by reading
`install.sh`'s `configure_nats()`: `render_template ... /etc/systemd/system/supreme-nats.service`
followed by `systemctl_enable_now supreme-nats`). Referencing a unit name that doesn't exist in
a systemd `After=` line is **not an error** — systemd silently treats it as an ordering
constraint against a unit that will simply never become active, i.e. a no-op. This line has
therefore never actually ordered anything, since this file was written.

**Why it existed.** Almost certainly a leftover from an early draft or a generic example
(`nats-server` is the vendor's own binary/package name, easy to reach for instead of this
deployment's actual unit name `supreme-nats`) that was never caught because it fails silently,
not loudly — there is no error message, no log line, nothing that would surface this during
manual testing unless someone specifically diffed the rendered unit's dependency graph against
the real unit names on disk.

**Security impact.** None. Availability/correctness only — `supreme-lan` could, in principle,
start before `supreme-nats` on a cold boot with heavy parallel unit startup (systemd starts
independent units concurrently by default). Low real-world severity since `supreme-lan`
already reconnects to NATS rather than requiring it at startup (per its own header comment),
but the ordering hint existed specifically to reduce that reconnect churn on every boot, and
silently never worked.

**Fix.** Changed to `After=network-online.target supreme-nats.service` — the real unit name.

**Verification.** New regression test (`deployment-regression.test.sh`) statically renders the
real template and asserts the rendered `After=` line contains `supreme-nats.service` and does
not contain `nats-server.service`. Passes.

### Bug 7 — `build_workspace()`/`verify_workspace()` leaked the installer's own working directory

**Root cause.** Both functions in `lib/deploy-steps.sh` did a bare `cd "$SUPREME_REPO_DIR"`
with nothing to restore it. Exactly the same bug class as Phase 2's `persist_secrets()` umask
leak — `cd`, like `umask`, is a shell-wide setting in bash, not scoped to the function it's
called from. Once `build_workspace()` (or `verify_workspace()`, in release mode where
`build_workspace` doesn't run) executes, `install.sh`'s own process is left with its working
directory permanently inside `$SUPREME_REPO_DIR` for every phase that runs afterward.

**Why it existed.** This specific instance never produced an *observed* failure because this
codebase consistently uses absolute paths (`$SCRIPT_DIR/...`, `$SUPREME_*_DIR`) everywhere
downstream rather than anything relative to the current directory — so the leak was latent,
not actively broken, purely by the accident of every other function's own good absolute-path
discipline. That is exactly the same "worked by luck, not by guarantee" situation Phase 2's
umask leak was in before it broke `nats.conf`/`/opt/supreme/releases` — a future phase, script,
or third-party tool invoked later in the same process (that DOES use a relative path, or `$0`,
or inspects `$PWD`) would silently break in a way that would look unrelated to this function.

**Security impact.** None currently observable — a latent correctness hazard, not an active
vulnerability.

**Fix.** Both functions now scope their `cd` inside a subshell:
```bash
(
  cd "$SUPREME_REPO_DIR"
  run_as_supreme pnpm turbo run build
)
```
Error propagation is preserved — under `set -euo pipefail`, a failing command inside the
subshell still makes the subshell (and therefore the calling statement) exit non-zero, and
`install.sh` aborts exactly as before.

**Verification.** Reproduced the bug and the fix side by side in real bash:
```
=== OLD buggy pattern (bare cd) ===
CWD after build_workspace: /tmp/cwdtest/repo      # leaked
=== FIXED pattern (subshell-scoped cd) ===
CWD after build_workspace: /tmp/cwdtest/other      # unchanged — correct
```
Also covered by the new automated regression suite (see below).

### Item 3 — full state-leak audit (umask, CWD, shell options, exported variables)

Grepped every script in `infra/native-linux/` for `umask`, bare `cd`, `set +e`/`set -e`
toggles, and `export`:

- **`umask`**: only occurrence remaining is `persist_secrets()`'s, already subshell-scoped
  (Phase 2 fix, re-confirmed still correctly scoped).
- **`cd`**: the two `deploy-steps.sh` occurrences above, now fixed. No other script
  (`backup.sh`, `restore.sh`, `health-check.sh`, `logs.sh`, `package-release.sh`,
  `uninstall.sh`, `supremeos-support.sh`, `factory-reset.sh`, `security-audit.sh`) contains a
  bare `cd` at all.
- **`set +e`/`set -e` mid-script**: none found anywhere — every script declares its mode
  (`set -euo pipefail` or the deliberate `set -uo pipefail` for scripts whose job is "keep
  checking and report, never abort" — `recover.sh`, `health-check.sh`, `logs.sh`,
  `supremeos-support.sh`, `security-audit.sh`) once, at the top, and never toggles it.
- **`export`**: only `DEBIAN_FRONTEND=noninteractive` in `install.sh`/`uninstall.sh` —
  intentional and harmless (it only affects debconf/apt's own frontend selection for the
  remainder of the process; nothing downstream reads or is affected by it, so a "leak" here
  has no consequence, unlike umask/cd which change filesystem-visible behavior).

No further state-leak bugs found beyond the two already fixed.

## Repository-wide audit (item 10)

Searched the full repository (not just `infra/native-linux/`) for every category the task
specified:

- **Hardcoded `/opt/supreme/services/...` paths**: zero remaining outside comments that
  explicitly document the historical bug and its fix (Bug 1, Phase 2). Confirmed via the new
  regression test's live-code check (distinguishes an `ExecStart=`/`WorkingDirectory=`/`cd`
  usage of the stale path from a comment mentioning it).
- **Docker-era assumptions**: checked every `infra/native-linux/config/*.template` for
  Docker Compose service-name hostnames (`postgres:`, `nats:`, `mqtt:`, `homeassistant:`,
  `commissioning:`) — every reference is `127.0.0.1`, correct for the native, non-networked
  deployment. No Docker-only assumption found anywhere in `infra/native-linux/`.
- **Obsolete release paths / duplicate deployment logic**: every systemd unit this deployment
  owns now uses exactly one path convention (`${SUPREME_APP_DIR}/current/services/<name>` for
  staged Node services, or a dedicated venv for the two Python-based services that are
  installed once rather than staged per-release — `supreme-commissioning`,
  `supreme-homeassistant`). No second, competing convention exists anywhere in the repo.
- **Permission assumptions**: every `render_template` call that produces a file a SupremeOS-
  owned service reads is now followed by an explicit `chown`/`chmod` (verified by the new
  regression test, not just asserted) — nothing is left to inherit ambient umask.

## Dependency graph verification (item 7)

| Unit | `After=` | `Requires=` | Real dependency? |
|---|---|---|---|
| `supreme-nats` | `network.target` | — | Correct — no DB/broker dependency of its own. |
| `supreme-commissioning` | `network.target` | — | Correct — stateless (reads no env vars, confirmed prior phase), no dependency. |
| `supreme-lan` | `network-online.target supreme-nats.service` (**fixed this phase**) | — | Correct — soft ordering only; reconnects if NATS isn't ready yet, so no `Requires=`. |
| `supreme-gateway` | `network-online.target postgresql.service supreme-nats.service mosquitto.service redis-server.service supreme-commissioning.service` | `postgresql.service` | Correct — Gateway's boot-time migration step needs Postgres to be more than "ordered after," hence the one real `Requires=`; the rest are soft ordering since the Gateway itself handles reconnect/retry for NATS/Mosquitto/Redis. |
| `supreme-homeassistant` | `network-online.target` | — | Correct — independent optional component, no dependency on any other SupremeOS unit. |

The graph is acyclic and every edge reflects a real dependency (or a deliberate absence of
one, each with its own documented reasoning already present in the unit files from prior
phases). `postgresql.service`/`redis-server.service`/`mosquitto.service`/`caddy` are vendor
units this deployment configures but does not author — their own package-provided ordering
(`network.target`, standard `multi-user.target` membership) is untouched and correct.

## Complete systemd unit audit (item 6)

Re-verified `ExecStart`, `WorkingDirectory`, `User`/`Group`, `EnvironmentFile`,
`ReadWritePaths`, restart policy, and hardening directives for every unit — table carried
forward from Phase 2, updated with this phase's one fix:

| Unit | Path model | `After=` fixed this phase? | Notes |
|---|---|---|---|
| `supreme-gateway` | `current/services/gateway` | No | `AF_NETLINK` fix from Phase 2, re-confirmed present. |
| `supreme-commissioning` | `current/services/commissioning-py`, own venv | No | Unchanged, correct. |
| `supreme-nats` | own binary + `${SUPREME_CONFIG_DIR}/nats.conf` | No | Config permission fix from Phase 2, re-confirmed present. |
| `supreme-lan` | `current/services/lan` (Phase 2 fix) | **Yes — `nats-server.service` → `supreme-nats.service`** | |
| `supreme-homeassistant` | own venv | No | Unchanged, correct. |

No duplicated deployment logic found — every unit is rendered through the same
`render_template` mechanism (`lib/deploy-steps.sh`), from the same placeholder vocabulary,
called from the same three scripts (`install.sh`/`update.sh`/`recover.sh`), each independently
re-verified to call it identically for every unit.

## Database migrations (item 8)

No new finding — re-confirmed from prior-phase work: the Gateway applies its own schema
migrations idempotently on every boot (`services/persistence/src/migrate.ts`, invoked from
`bootstrap.ts`), which is why `schema_migrations` failing to exist was a *symptom* of the
Gateway never starting (Phase 2's permission/systemd-detection bugs), not a separate migration
defect. With those root causes fixed, the Gateway starting is sufficient for migrations to run
automatically — no manual SQL step exists anywhere in this deployment, and none was added.

## Gateway startup / `uv_interface_addresses` (item 9)

No new finding beyond Phase 2's fix (`AF_NETLINK` added to `supreme-gateway.service`) — this
phase re-confirmed that fix is still present and re-verified the mechanism (`getifaddrs(3)`
needs `AF_NETLINK`, `RestrictAddressFamilies` seccomp-rejects a disallowed family with
`EAFNOSUPPORT`=97 on Linux, matching the reported error exactly) with no change to any
application file.

## Files modified this phase

- `infra/systemd/supreme-lan.service` — `After=` unit-name fix (Bug 6).
- `infra/native-linux/lib/deploy-steps.sh` — `build_workspace()`/`verify_workspace()` CWD
  leak fixed (Bug 7).
- `infra/native-linux/tests/deployment-regression.test.sh` — **new**, regression suite
  (item 12, see below).

No application code, Gateway business logic, protocol logic, driver code, or frontend/UI was
modified. (Phase 2's changes to `install.sh`, `lib/common.sh`, `update.sh`, `recover.sh`, and
`infra/native-linux/systemd/supreme-gateway.service` remain as previously reported and were
re-verified, not re-changed, this phase.)

## Security impact

No security regression introduced. The `supreme-lan.service` ordering fix and the CWD-leak fix
are both correctness/availability fixes with zero privilege or access-control change. No
`chmod 777` was used anywhere in this phase (or Phase 2).

## Regression prevention (item 12)

New file: `infra/native-linux/tests/deployment-regression.test.sh` — a self-contained, pure-
bash test suite (no framework dependency, `bash infra/native-linux/tests/
deployment-regression.test.sh`, CI-wireable, exits 0 on all-pass / 1 on any failure). Runs
entirely against a scratch directory tree (`mktemp -d`, cleaned up on exit) with `SUPREME_USER`/
`SUPREME_GROUP` set to test-only values — **it never touches the real filesystem outside
`/tmp`, never requires root, and never requires a real systemd**, so it runs identically in
this dev environment and in CI. 45 assertions across 8 sections:

1. `systemd_is_live()` — all 8 scenarios from Phase 2's fix (degraded/running/maintenance/
   starting → live; unreachable-bus/offline/WSL/CI → dead).
2. State leaks — `persist_secrets()` doesn't change the caller's umask; the subshell-`cd`
   pattern `build_workspace()`/`verify_workspace()` now use doesn't leak CWD.
3. Generated systemd units — `supreme-lan.service` renders the correct `current/` paths and
   the correct `supreme-nats.service` unit name; every unit's placeholders fully substitute
   (no leftover `___TOKEN___`).
4. Directory permissions — `SUPREME_RELEASES_DIR` is never left at the reported-broken `700`
   and never `777`.
5. Generated config files — `nats.conf`/mosquitto config/Caddyfile/`gateway.env` each have an
   explicit `chown`/`chmod` within a few lines of their `render_template` call, in both
   `install.sh` and `update.sh` (static source verification, not just "it worked once").
6. Repository-wide path consistency — no live `ExecStart=`/`WorkingDirectory=`/`cd` uses the
   stale `/opt/supreme/services/...` path anywhere in the repo; every `cd $SUPREME_*` in
   `deploy-steps.sh` is subshell-scoped.
7. (Covered within section 5's structure — see the file itself for the exact grouping.)
8. Installer idempotency — every artifact-producing phase (20 of them) has a matching
   `validate_phase_<name>` function, so a future phase added without one is caught by this
   test rather than silently trusting a stale checkpoint forever.

Every one of these directly encodes a bug that was found and fixed across Phase 2 and Phase
3 — a regression in any of them will fail this suite the moment it's introduced, without
needing a real Ubuntu VM to notice.

**What this suite does NOT cover, honestly**: a real `sudo ./install.sh` clean-install /
`update.sh` / `uninstall.sh` / `restore.sh` end-to-end run against real systemd/PostgreSQL/
NATS/Mosquitto/Caddy. That requires the real Ubuntu 24.04 VM this environment doesn't have —
recorded as the standing gap, not silently omitted.

## Runtime verification (item 11) — honest status

**Not performed end-to-end.** No real Ubuntu 24.04 VM is available in this development
environment. What was verified, and how:

| Requirement | Status | Evidence |
|---|---|---|
| `systemd_is_live()` correctness | **Verified** | 8/8 real bash scenarios, both ad hoc (Phase 2) and now in the permanent regression suite. |
| `/opt/supreme/releases` traversable | **Verified (mechanism)** | Real chmod/chown fix code-read + isolated reproduction of the umask leak and its fix; exact-octal filesystem check is platform-dependent (this dev environment's Windows/MSYS filesystem doesn't always preserve POSIX bits exactly through `chmod` — documented in the regression test itself) but "not 700, not 777" is verified. |
| `nats.conf` permissions | **Verified (mechanism + static check)** | Same umask-leak reproduction; regression suite statically confirms the explicit chown/chmod exists in source. |
| `supreme-lan.service` paths + ordering | **Verified (rendering)** | Real `render_template` execution against the actual template, output inspected. |
| Gateway `AF_NETLINK` fix | **Verified (mechanism only)** | `EAFNOSUPPORT`/`getifaddrs`/`RestrictAddressFamilies` mechanism confirmed by documentation/errno-table reading, not by observing a real Gateway process not crash. |
| PostgreSQL/Redis/Mosquitto/NATS/LAN/Commissioning/Gateway/Caddy all active | **NOT verified** | Requires a real systemd target. |
| Ports listening (4222, Gateway, LAN, Commissioning) | **NOT verified** | Requires a real systemd target. |
| `schema_migrations` created | **NOT verified directly** | Logically follows once the Gateway starts (unchanged migration-on-boot behavior); not observed. |
| `/healthz` returns 200 | **NOT verified** | Requires a real systemd target + running Gateway. |
| Web UI reachable via Caddy | **NOT verified** | Requires a real systemd target. |
| No restart loops / CHDIR / permission errors | **NOT verified directly** | The specific root causes of every previously-reported instance of each are fixed and individually proven; a live run to confirm the absence of any *new* instance was not performed. |

## Commit status

Per this task's own explicit instruction — "Only commit and push after the entire deployment
passes end-to-end on Ubuntu with runtime evidence" — **nothing has been committed or pushed
this phase.** That evidence does not exist in this environment. The fixes and the new
regression suite are in the working tree, syntax-checked (`bash -n`, clean on every touched
file) and, for everything isolable from a real systemd/Postgres target, functionally verified
in real bash. The next step is a real Ubuntu 24.04 run of `sudo ./install.sh` followed by
`bash infra/native-linux/tests/deployment-regression.test.sh` (both should be clean) before
this is committed — recommended as the literal next action for a session with VM access,
rather than committing on inspection alone.

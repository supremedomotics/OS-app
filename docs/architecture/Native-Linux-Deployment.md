# Native Linux Deployment (`infra/native-linux/`)

- Status: **Accepted** (Phase 1 — see "Known scope gaps" below for what is intentionally not yet
  covered)
- Companion: `docs/architecture/adr/0024-native-linux-deployment.md`
- **Update**: Home Assistant has been fully removed from SupremeOS (see
  `docs/architecture/Home-Assistant-Dependency-Audit.md`). Every reference below to
  `supreme-homeassistant.service`, `SUPREME_INSTALL_HA`, `install_homeassistant_venv`, or
  a headless HA install is historical — `install.sh` no longer installs, configures, or
  starts Home Assistant in any form; `SUPREME_BACKEND` is always `native` (or `mock` for
  tests).

## Purpose

SupremeOS ships two independent, parallel deployment layers for the exact same application code:

| Layer | Location | Use case |
|---|---|---|
| Docker Compose | `infra/hub-compose/` | Development, CI, any platform Docker Desktop runs on |
| Native systemd | `infra/native-linux/` | Production Ubuntu 24.04 LTS hub deployments, and the base for the future SupremeOS Linux OS image |

Neither layer modifies the other. `infra/hub-compose/` is untouched by this work. Nothing in
`services/`, `apps/`, `packages/`, or `cloud/` was modified either — this is a deployment-layer
addition only, confirmed by `git diff main -- . ':!infra/native-linux'` returning empty on the
`native-linux` branch. No protocol logic (Casambi, KNX, Matter, or any other driver) was touched.

The end state: on a clean Ubuntu 24.04 LTS machine, `sudo ./install.sh` produces a fully
operational SupremeOS controller — the same Gateway, LAN service, Commissioning service, and web
UI, wired to real PostgreSQL/Redis/NATS/Mosquitto instead of containers, supervised by systemd
instead of `docker compose`.

## Installation wizard

`sudo ./install.sh` asks the fewest questions that produce a valid, unambiguous
configuration — no invalid states, no legacy-architecture assumptions:

```
System Name
  ↓
Domain
  ↓
Timezone
  ↓
Install Home Assistant? (Yes/No)
  ↓
  (if Yes)
  Home Assistant Username
  ↓
  Home Assistant Password
  ↓
Installation Begins
```

There is **no separate "Backend" question**. The backend is derived automatically from
the Home Assistant answer (ADR-0023's provider architecture: Home Assistant is an
optional provider, never a required backend):

- **"Install Home Assistant?" → No** — `SUPREME_BACKEND=native` is configured silently.
  No Home Assistant username, password, or any other Home Assistant question is ever
  shown. This is the production default and the fastest path through the wizard.
- **"Install Home Assistant?" → Yes** — `SUPREME_BACKEND=ha` is configured
  automatically; the wizard asks for a Home Assistant admin username and password
  (minimum 8 characters), then proceeds. No additional backend question is needed.

Every answer is validated before installation begins (domain format, timezone against
`/usr/share/zoneinfo`, Home Assistant credentials when applicable, and the resulting
backend against the fixed set `native | ha | mock`) — an invalid value fails loudly
with a clear error rather than being silently accepted. `mock` is a valid backend
value (unattended/CI installs may set `SUPREME_BACKEND=mock` explicitly via
environment) but is never prompted for and never the default — it exists for testing
only and must never be used in a production install.

On completion the installer prints a clear summary of what was actually configured:

```
SupremeOS Native Installation

Target OS:          Ubuntu 24.04 LTS
Backend:             Native
Deployment:          Systemd
Container Runtime:   Not Used
```

## Deployment modes — Development, CI, Production

Three separate concerns, three separate places they run — never conflated into one
"the installer verifies everything, always" step. This is the direct fix for a real
production incident: the installer's own build-then-test sequence left the machine
CPU/IO-loaded right into the test phase, so a hardcoded wall-clock budget (KNX's
20,000-group-address import test, `< 10s`) or a resource-heavy embedded-Postgres
startup (backup's PGlite-based test) would occasionally trip — a different package each
run, on an otherwise 173/173-healthy repository. Full root-cause audit:
`docs/architecture/Native-Linux-Installer-Verification-Audit.md`. The tests were never
wrong; running them at deploy time, on a just-finished-building machine, was.

| Mode | Who | Runs | Where |
|---|---|---|---|
| **Development** | Engineers, on a git checkout | `pnpm install` → `pnpm turbo run build` → `pnpm turbo run typecheck` → `pnpm turbo run test` (the full ~800-test suite) | Local machine, or `install.sh`/`update.sh` run directly from a source checkout |
| **CI** | GitHub Actions, on every release tag | build → typecheck → test → integration → performance → package → sign → publish | `.github/workflows/release.yml` — dedicated, idle runners; never a customer machine |
| **Production** | The installer, on a customer's controller | Release integrity (checksum/signature) → migration success → configuration validity → service installation/startup → runtime health (dependencies, DB, NATS, Mosquitto, Gateway, LAN, Commissioning, Web UI) | `install.sh`/`update.sh`, installing a signed release artifact |

Production **never** runs `pnpm install`, `pnpm turbo run build`, or the developer test
suite. Everything that suite verifies about the *code* already ran once, rigorously, in
CI, before the artifact was signed. What production verifies instead is that *this
specific machine* — its config, its migrated database, its running services — is
actually healthy, which the developer test suite was never capable of checking anyway
(it doesn't touch the target machine at all).

### Mode detection

`install.sh`/`update.sh` detect which one they're installing automatically
(`lib/common.sh`'s `detect_install_mode`) — never guessed, a plain fact check:

- **`release-manifest.json` present at the tree root** → **production/release mode**.
  Written once, by `package-release.sh`, inside CI — never regenerated or trusted from
  anywhere else.
- **`.git` present, no manifest** → **development/source mode**. Keeps the full
  build+typecheck+test verification exactly as before this redesign — a developer
  workflow gets the developer suite, always.
- **Neither** → refuses to install (`SUPREME_INSTALL_MODE=source|release` overrides
  explicitly, for the rare case of testing one path from the other's tree shape).

```
Source install (git checkout)              Prebuilt release (signed artifact)
        │                                            │
        ▼                                            ▼
  Development verification                  Production verification
  (full build+typecheck+test)                (integrity + runtime health)
        │                                            │
        └──────────────────┬─────────────────────────┘
                            ▼
                  Same systemd services,
                  same config templates,
                  same runtime — one
                  installer, two verified
                  paths onto it.
```

This is also the seam the future SupremeOS Linux image builds on unmodified: the image
ships a release artifact baked in and runs `install.sh` once at first boot in
production mode — no application code changes required, because the mode split already
lives entirely in the installer.

## Release artifact design

Produced by `infra/native-linux/package-release.sh <output-dir>`, called only from CI
(`.github/workflows/release.yml`) after build+typecheck+test+integration+performance
have all already passed — packaging is a later, separate stage from verification, not a
substitute for it.

**Contents** (`supremeos-<version>-<arch>.tar.zst` — zstd, falling back to `.tar.gz`
automatically when the packaging machine has no zstd): the repository tree with `dist/`
already compiled, production-only `node_modules` (dev dependencies pruned after build),
and a `release-manifest.json` at the root:

```json
{
  "version": "1.0.0",
  "git_sha": "abcdef1234567890...",
  "built_at": "2026-01-01T00:00:00Z",
  "schema_version": 25,
  "migration_count": 25,
  "supported_os": "ubuntu-24.04",
  "architecture": "amd64",
  "node_version": "v22.x.x",
  "pnpm_version": "10.33.0",
  "package_format_version": "1",
  "required_disk_mb": 2048,
  "required_ram_mb": 2048,
  "required_cpu_arch": "amd64",
  "checksum_algo": "sha256",
  "bundled_services": ["supreme-gateway", "supreme-lan", "supreme-commissioning", "supreme-nats"],
  "bundled_web_version": "1.0.0",
  "bundled_protocol_versions": { "protocols": "1.0.0" },
  "compatibility_matrix": { "min_upgrade_from_schema_version": 1, "max_schema_version": 25 }
}
```

`schema_version` (the shape of the database) and `migration_count` (how many migration
files produced it) are deliberately separate fields — the installer uses the first for
upgrade-path compatibility decisions and the second to verify the DB's own
`schema_migrations` row count actually matches after migrations run.

**Sidecar files** (next to the tarball, never inside it — a file cannot contain its own
checksum before its last byte exists): `<tarball>.sha256` (always) and `<tarball>.sig`
(a detached GPG signature, when `RELEASE_GPG_PRIVATE_KEY` is configured in CI — optional,
per requirement, but a release without one is refused at CI's own Publish stage, so an
UNSIGNED release never reaches a customer even though install.sh could technically accept
one).

**What the installer validates** (`lib/deploy-steps.sh`'s `install_release_artifact` +
`validate_release_manifest`, § requirements 2/4/11) — every field, before touching
anything:
1. `release-manifest.json` exists and has a real `version` — refuses an unversioned
   artifact.
2. Tarball checksum matches the `.sha256` sidecar — refuses a corrupted/tampered
   download. (Skipped, with a loud warning rather than a fabricated pass, if only an
   already-extracted directory is available with no tarball to hash.)
3. GPG signature verified against `.sig`, when present — refuses an unsigned/tampered
   release.
4. `supported_os`/`architecture` match this host — refuses a mismatched OS/CPU target.
5. `package_format_version` is one this installer understands (`"1"` today) — refuses
   an artifact packaged in a future, incompatible layout with a clear message rather
   than misreading it.
6. `schema_version` is not older than what's currently installed (no downgrades) and
   `compatibility_matrix.min_upgrade_from_schema_version` is satisfied by the current
   schema (no unsupported upgrade paths) — see § Version compatibility below.
7. `required_ram_mb`/`required_disk_mb`/`required_cpu_arch` against the actual host —
   fails fast, before staging anything, rather than discovering a resource shortfall
   mid-install.
8. `migration_count` is carried forward into the post-switch runtime check as the
   expected `schema_migrations` row count — a real, queried number, not a log line
   trusted at face value.

## Transactional updates

`update.sh` implements the full cycle (§ requirement 3):

```
backup (automatic, no-prune)
  ↓
install (stage into SUPREME_REPO_DIR — never touches the live symlink yet)
  ↓
migration (runs automatically when the Gateway boots against the unchanged, additive-
  ↓         only database — see services/persistence/src/migrate.ts)
  ↓
switch active version (ONE atomic `ln -sfn` — lib/common.sh's switch_active_release;
  ↓                     POSIX guarantees readers see either the old or new target, never
  ↓                     a half-written one)
  ↓
verification (run_runtime_verification — services, dependencies, migrations, endpoints)
  ↓
cleanup (delete the pre-update backup ONLY now — requirement 4's literal ordering —
           then prune old release directories beyond SUPREME_RELEASE_RETAIN)
```

**If any stage from backup onward fails**, `update.sh`'s `rollback_update` runs
automatically (triggered either by an explicit failed-verification check or an `ERR`
trap catching any unexpected command failure):

1. Switch the `current` symlink back to the previous version (instant — no re-copy).
2. Restore database/config/data from the pre-update backup via the SAME `restore.sh`
   this deployment already ships (§ Automatic backup below) — not a separate,
   parallel restore implementation.
3. Re-render config, restart services, wait for health.
4. Re-run runtime verification and report the post-rollback state.

The controller always ends an update run on a version that's actually running — either
the new one, verified healthy, or the previous one, restored and re-verified. There is
no state in between where an operator would find half-old, half-new code and a
partially-migrated database.

### Versioned releases on disk

```
/opt/supreme/
  releases/
    1.0.0/              ← immutable once staged
    1.1.0/              ← the update currently being verified
  current -> releases/1.1.0/     ← ONE symlink; every systemd unit's ExecStart
                                    references this stable path, never a version number
  repo/                 ← reusable staging area every install/update writes into first
```

`SUPREME_RELEASE_RETAIN` (default 3) old release directories are kept on disk after a
successful update — instant rollback material without needing the backup archive at all
for a pure code-only revert.

## Automatic backup

Every `update.sh` run starts with `backup.sh --no-prune` (§ requirement 4) — no manual
step, no flag to opt out. The archive (a real `pg_dump`, config including secrets, and
the NATS/Mosquitto/Home Assistant data directory — see `backup.sh`'s own header) is kept
until the update is confirmed healthy, then deleted. A failed update's backup is instead
consumed by `rollback_update` to restore database/config/data, and is NOT deleted (an
operator investigating a failed update should still have it available).

## Offline installation and updates

```
sudo ./install.sh --offline /path/to/supremeos-1.0.0-amd64.tar.zst
sudo ./update.sh  --offline /path/to/supremeos-1.1.0-amd64.tar.zst
```

For luxury residences commissioned before internet service is active (§ requirement 5).
The release package is extracted locally (`extract_release_tarball` — pure `tar`/`zstd`,
no network call) and installed exactly like a normal release from that point on; every
verification step (checksum, signature, manifest validation, runtime health) still runs
in full. What genuinely still needs network access, and is honestly disclosed rather than
silently broken, on a bare (non-appliance-image) Ubuntu box:

- `apt-get update` is skipped when offline — requires a pre-seeded local apt
  cache/mirror with every dependency `install_apt_dependencies` lists.
- NATS/Caddy `.deb` packages must be supplied locally via `SUPREME_NATS_DEB_PATH`/
  `SUPREME_CADDY_DEB_PATH` (checksummed exactly like an online download).
- Node.js must already be installed, or the machine must be an official SupremeOS
  appliance image (§ below), which ships it pre-provisioned.

## Recovery mode

`sudo ./recover.sh` (§ requirement 7) — detects and repairs a broken installation
without touching the database unless explicitly asked to:

1. Confirms `install.conf` and secrets exist (refuses to "fix" a machine that was never
   actually installed).
2. Repairs ownership/permissions on the app, data, and secrets directories.
3. Detects a broken/missing `current` release symlink and re-points it at the most
   recent release directory still on disk.
4. Regenerates `gateway.env`, `nats.conf`, `Caddyfile`, and every systemd unit from the
   current templates — never trusts possibly-corrupted on-disk config.
5. `sudo ./recover.sh --restore-backup` additionally restores the most recent
   `backup.sh` archive (database + config + data) before proceeding.
6. Resets any failed systemd unit state and restarts every service in dependency order.
7. Runs full runtime verification and reports PASS/FAIL — exits non-zero if the
   controller is still unhealthy, printing the next step (`--restore-backup`, or
   generate a support bundle).

## Support bundle

`sudo supremeos-support` (installed as a real system command by `install.sh`'s
`install_cli_commands` phase; also runnable directly as
`./infra/native-linux/supremeos-support.sh`) — § requirement 8. Produces ONE
`.tar.gz` containing system info, release/migration state, per-service logs (last 500
journal lines each for Gateway/LAN/Commissioning/Home Assistant/Web), live driver
diagnostics, a full health report, network state (interfaces/routes/ports/firewall),
and configuration.

**Secrets are always redacted** — every config file passed into the bundle goes through
`redact_secrets` (a single, reused choke point matching by variable NAME —
`*PASSWORD*`/`*SECRET*`/`*TOKEN*`/`*_KEY`, not a value-shape guess that could miss a
short one) before it's written; the secrets directory itself is never read, listed, or
included, redacted or otherwise. This is the standard file to send to Supreme Domotics
support — read-only, changes nothing on the machine it runs on.

## Version compatibility

`validate_release_manifest` (§ requirement 11) rejects, with a clear message and no
guessing:
- An **older** `schema_version` than what's currently installed — downgrades aren't
  supported; restore a backup from before the current version instead.
- An upgrade whose `compatibility_matrix.min_upgrade_from_schema_version` the current
  machine's schema doesn't satisfy — install an intermediate release first.
- An unsupported `package_format_version` — upgrade `install.sh` itself first.
- A mismatched `supported_os`/`architecture` — the release genuinely wasn't built for
  this machine.

## Release State Manager

One authoritative file, `/etc/supremeos/release-state.json` (`lib/common.sh`'s
`release_state_*` functions — every reader/writer goes through these, nothing else
touches the file directly): `active_release`, `previous_release`, `pending_release`,
`failed_release`, `rollback_target`, `installed_at`, `upgrade_timestamp`,
`health_status`. The `current` symlink still exists and is still what systemd units
actually resolve — this file is the layer ON TOP that answers "what's pending," "what
failed and was rolled back," and "when," none of which a symlink alone can express.
Updated automatically by `stage_and_switch_release` (switch) and
`release_state_record_failure`/`release_state_record_health` (update.sh's rollback and
verification outcomes). View it any time: `sudo ./health-check.sh` (prints it first) or
`jq . /etc/supremeos/release-state.json`.

## Staged health verification

`run_staged_verification` (`lib/common.sh`) — the same `rc_*` checks
`run_runtime_verification` already performs, reorganized into ORDERED stages, each
timed and reported independently, with a failure stopping every later stage:

```
BOOT → CORE OS → FILESYSTEM → DATABASE → MESSAGING → NETWORK →
SUPREME SERVICES → PROTOCOLS → WEB UI → READY
```

Used by `install.sh` and `update.sh`'s post-switch verification gate (§ Transactional
updates) — a broken database means checking messaging/network/services/web afterward
would only produce a wall of secondary failures burying the one actual root cause.
`health-check.sh` and `recover.sh` still use the flat, all-checks `run_runtime_
verification` instead — an operator asking "what's wrong right now" wants the full
picture in one pass, not a report that stops at the first thing it finds. Every check
still reports PASS/FAIL/WARNING/N-A exactly as before; only the sequencing and
per-stage timing are new.

## Transactional database rollback

Migrations run automatically when the Gateway boots against the database (unchanged —
`services/persistence/src/migrate.ts`, additive-only, sequential). A migration failure
manifests as the Gateway failing to start or the DATABASE stage of staged verification
failing (schema_migrations row count mismatch, or the query itself erroring) — either
way, `update.sh`'s transactional flow treats it exactly like any other post-switch
failure: `rollback_update` switches the code back (symlink), restores the database from
the pre-update `pg_dump` backup.sh already took, restarts services on the previous
version, and re-verifies. There is no separate "undo this migration" step, because
there is no partial-migration state to undo — the previous release's binaries are
restored alongside a database restored to its pre-migration snapshot, together, in the
same rollback, so "previous binaries + previous schema" is the only combination that
ever runs. A partially-migrated database paired with old code (or vice versa) is
exactly the state this design makes structurally impossible to reach.

## Release signing & key management

**SHA256 alone proves integrity, not provenance** — anyone who can intercept a download
can recompute a matching checksum for a tampered file. A signature proves the release
was produced by whoever holds the private key. Production (release-mode) installs
**refuse an unsigned release outright** — `install_release_artifact` dies unless a valid
signature verifies, or `SUPREME_ALLOW_UNSIGNED_RELEASE=1` is explicitly set (local
release-pipeline testing only, never a real deployment).

**Ed25519 (preferred)** — small keys, fast verification, no keyring/trust-model
complexity:
```bash
# One-time key generation (keep the private key OFFLINE except in the CI signer):
openssl genpkey -algorithm ed25519 -out release-signing-ed25519.key
openssl pkey -in release-signing-ed25519.key -pubout -out release-signing-ed25519.pub

# Sign (package-release.sh prints this command after packaging):
openssl pkeyutl -sign -rawin -inkey release-signing-ed25519.key -in <tarball> -out <tarball>.ed25519.sig

# install.sh verifies against this public key (default path shown; override with
# SUPREME_RELEASE_ED25519_PUBKEY):
infra/native-linux/release-signing-ed25519.pub
```

**OpenPGP (alternative)** — `gpg --detach-sign --armor`, verified via `gpg --verify`;
useful when an existing organizational PGP key/trust chain already exists.

**In CI** (`.github/workflows/release.yml`): the private key lives ONLY as a GitHub
Actions secret (`RELEASE_ED25519_PRIVATE_KEY` or `RELEASE_GPG_PRIVATE_KEY`) — never
committed, never logged (the signing step writes it to a runner-local temp file and
removes it immediately after use). The `publish` job refuses to run if neither secret
is configured — an unsigned release can structurally never reach a GitHub Release.

**Key rotation**: publish the new public key alongside a release built with it (a
release's manifest doesn't need to identify WHICH key signed it — the installer simply
tries whatever public key it has); rotate the CI secret; retire the old private key.
Multiple valid public keys on an installed machine is out of scope for this phase
(single active key, matching the single-signer CI pipeline today) — noted as a Known
scope gap below, not silently assumed solved.

## OTA architecture

No cloud service is implemented in this phase (§ requirement 5) — this section
documents the framework the reusable primitives already built here compose into, once a
release server exists:

```
Release Server (future)
  ↓
Check Version    — compare installed release-state.json's active_release against the
  ↓                 server's latest — a simple version comparison, no new primitive
  ↓
Download         — future work; everything AFTER this point already exists today
  ↓
Verify Signature — install_release_artifact's existing Ed25519/OpenPGP check
  ↓
Stage Release    — stage_release_version (atomic build-then-swap, zero-downtime-window)
  ↓
Switch           — switch_active_release (one atomic symlink flip)
  ↓
Verify           — run_staged_verification (ordered, fail-stop, exactly what update.sh
  ↓                 already runs after every transactional update)
  ↓
Cleanup          — prune_old_releases + backup deletion (update.sh's existing cleanup)
```

Everything from "Verify Signature" onward is `update.sh`'s existing transactional flow,
unmodified — an OTA client is a thin wrapper that answers "Check Version" and "Download"
and then calls `update.sh --offline <downloaded-package>` (offline mode is, structurally,
exactly what "already have the package locally, don't fetch it yourself" means — OTA
reuses it rather than needing a separate online-fetch code path). No cloud
infrastructure, release server, or download client was built in this phase.

## Factory reset

`sudo ./factory-reset.sh [--force] [--preserve-network] [--preserve-license]
[--preserve-backups] [--preserve-ssh-keys] [--preserve-static-ip]` (§ requirement 6).

**Distinct from `uninstall.sh --purge`**, which REMOVES the software (systemd units,
app code, third-party packages, the system user) — that's "get rid of SupremeOS
entirely." Factory reset is the opposite intent: an appliance OOBE reset wipes
data/config/secrets/database, leaves the installed release and every systemd unit in
place, and comes back up fast (no apt/Node/NATS/Caddy reinstall) already serving the
Setup Wizard. Network config (`/etc/netplan`) and SSH host keys (`/etc/ssh`) live
entirely outside SupremeOS's own directories and are never touched regardless of
flags — the `--preserve-network`/`--preserve-static-ip`/`--preserve-ssh-keys` flags
exist so an operator can state and confirm that intent explicitly rather than trusting
an undocumented default. `--preserve-backups`/`--preserve-license` stash and restore
those specific paths around the wipe.

## First boot architecture

```
Boot
  ↓
Detect first run    — SUPREME_SETUP_WIZARD=1 (install.sh's existing config field) or
  ↓                    no owner/admin account yet in the database
  ↓
Wizard               — application-layer UI (out of scope for this deployment-only
  ↓                    phase — no UI changes made here)
  ↓
Hostname             — SUPREME_SYSTEM_NAME, already an install.sh answer
  ↓
Timezone             — SUPREME_TZ, already an install.sh answer, already validated
  ↓                     against /usr/share/zoneinfo
  ↓
Network              — /etc/netplan, outside this deployment's scope (OS-level)
  ↓
Administrator        — application-layer (Setup Wizard creates the first owner account)
  ↓
License              — application-layer; factory-reset.sh's --preserve-license shows
  ↓                     where a license artifact would live (${SUPREME_CONFIG_DIR}/
  ↓                     license.json) for a future licensing phase to fill in
  ↓
Ready                — run_staged_verification's READY stage
```

This documents the intended flow; it does not redesign the existing deployment or add
UI (out of scope for a deployment-only phase, per this phase's own constraints). The
installer-side anchors already exist: `SUPREME_SETUP_WIZARD`, `SUPREME_SYSTEM_NAME`,
`SUPREME_TZ` (validated), and the READY stage of staged verification. What's
genuinely not yet built (disclosed, not assumed done): the Wizard UI itself, first-run
admin-account creation, and license activation — all application-layer, out of scope
for this deployment-only phase.

## Systemd hardening

Every unit this deployment authors (`supreme-gateway`, `supreme-commissioning`,
`supreme-nats`, `supreme-homeassistant`) already carried substantial hardening from
earlier phases (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
`ProtectKernelTunables`, `ProtectControlGroups`, `RestrictNamespaces`,
`RestrictSUIDSGID`, `LockPersonality`, `RestrictAddressFamilies`). This phase completed
the set:

| Directive | gateway | commissioning | nats | homeassistant |
|---|---|---|---|---|
| `CapabilityBoundingSet=` (drop all) | ✅ | ✅ | ✅ | ✅ |
| `RestrictRealtime=yes` | ✅ | ✅ | ✅ | ✅ |
| `MemoryDenyWriteExecute=yes` | ❌ **documented exception** | ✅ | ✅ | ✅ |

**Documented exception**: `supreme-gateway.service` does NOT set
`MemoryDenyWriteExecute=yes`. Node.js' V8 JIT compiler requires `mmap`/`mprotect`
requesting simultaneous write+execute permission on its code cache — a real, verified
technical incompatibility (V8's JIT compilation model), not an oversight. Every other
directive still applies to the Gateway unit; only this one is excluded, and only for
this reason.

**`supreme-lan.service` is intentionally NOT modified** — it is the repository's own
pre-existing native unit (`infra/systemd/supreme-lan.service`, owned by the LAN
service's own deployment target, established before this deployment-hardening phase)
and this phase's own constraints require never touching Gateway/LAN Service/protocol
logic. Its existing hardening (verified present: `NoNewPrivileges`, `ProtectSystem`,
`CapabilityBoundingSet`, `RestrictAddressFamilies`) was read, not changed.

`ProtectKernelModules` and full `RestrictAddressFamilies` lockdown are intentionally
**not** applied to `supreme-homeassistant.service` beyond what was already there before
this phase — HA Core's real dependency tree (C extensions, its own integration surface)
was never exercised end-to-end against live hardware in the environment that produced
this deployment (see § Verification below); loosening was already the deliberate,
disclosed stance the unit's own header comment states, and this phase did not change it.

## Runtime security audit

`sudo ./security-audit.sh` (§ requirement 9) — read-only, reuses the same `rc_pass`/
`rc_fail`/`rc_warn` reporting primitives as runtime verification. Checks:
- **Service user** — every unit's `User=` actually matches `SUPREME_USER` (not root).
- **File ownership** — app/data directories owned by `SUPREME_USER:SUPREME_GROUP`,
  secrets owned by `root:SUPREME_GROUP`.
- **Directory/secrets permissions** — secrets directory `0700`, individual secret files
  `0640`/`0600`, `gateway.env` `0640`.
- **Executable/writable paths** — no world-writable files, no unexpected setuid
  binaries under the app directory.
- **Listening ports & exposed interfaces** — every port this deployment is expected to
  bind is checked against its expected binding (loopback-only for internal services,
  public only for Caddy's 80/443) — a service that ends up bound to `0.0.0.0` when it
  should be `127.0.0.1` is a FAIL, not a warning. Unrecognized listening ports are
  flagged as warnings for manual review, never silently ignored.

Included automatically in `supremeos-support`'s bundle (`security-audit.txt`).

## Installer self-update architecture

No download client is implemented in this phase (§ requirement 10) — documented for
future implementation:

```
Installer
  ↓
Check installer version   — compare this checkout's infra/native-linux/ version (a
  ↓                          future VERSION file or git tag) against the release
  ↓                          server's published installer version
  ↓
Replace installer          — download + checksum/signature-verify the new infra/
  ↓                          native-linux/ tree (same verification primitives release
  ↓                          artifacts already use), swap it into place
  ↓
Resume installation         — re-exec install.sh/update.sh from the new version,
                               continuing from the SAME checkpoint (install.state) the
                               old installer process was using — lib/common.sh's
                               run_phase checkpointing already makes "resume after being
                               replaced mid-run" the same mechanism as "resume after any
                               other interruption," no new state format needed.
```

The checkpoint/resume machinery (§ Native installer improvements, already built) is
what makes this safe to add later without a redesign: an installer self-update is, from
the checkpoint file's point of view, indistinguishable from any other interruption.

## Future SupremeOS appliance image

An official SupremeOS Linux image ships with `/etc/supremeos/image-release` present
(§ requirement 9) — a marker `install.sh` and `update.sh` never create themselves, only
ever read via `is_official_appliance_image`. Its presence means Node/pnpm/NATS/Caddy are
already provisioned at image-build time; `install.sh` detects it and skips
`install_apt_dependencies`/`install_node`/`install_nats`/`install_caddy`/venv creation
entirely, going straight to configure → migrate → start services → health verification.
An appliance image is also required to install from a signed release artifact, never a
source checkout — `install.sh` refuses otherwise. This is the same installer, same
verification, same rollback machinery a source/release install on plain Ubuntu already
uses — no application code changes were needed to support it, exactly per requirement 5.

## Release pipeline (CI)

```
GitHub (tag push: release-X.Y.Z)
  ↓
Build            pnpm turbo run build
  ↓
Typecheck        pnpm turbo run build typecheck
  ↓
Test             pnpm turbo run build test            (unit + component, full suite)
  ↓
Integration      pnpm --filter @supreme/gateway test -- e2e   (named stage, same suite,
  ↓                                                             isolated for CI reporting)
Performance      pnpm turbo run test -- performance    (timing-sensitive suites, run
  ↓                                                      alone on a dedicated, idle runner
  ↓                                                      — never on a customer's machine
  ↓                                                      mid-build, which is what produced
  ↓                                                      the original flake)
Package          package-release.sh → tarball + release-manifest.json
  ↓
Sign             gpg --detach-sign  (skipped, with a hard failure at Publish, if no key)
  ↓
Publish Release  GitHub Release: tarball + .sha256 + .sig
  ↓
  ↓  (on a customer's controller)
  ↓
Native installer downloads the verified release
  ↓
Configure        render systemd units + config from templates
  ↓
Start services   systemctl enable --now, in dependency order
  ↓
Health verify    run_runtime_verification() — services, TCP, migrations, HTTP endpoints
  ↓
Ready
```

`integration` and `performance` are not new test frameworks or new test files — they
run the SAME suites `test` already covers, filtered by filename (vitest's own
substring-match positional filter), purely so a release's CI summary distinguishes
"a unit test broke" from "a real e2e flow broke" from "a timing budget was missed" at a
glance. No test was modified, weakened, or skipped to build this pipeline.

## Native installer improvements — checkpoints, resume, structured logs

Every phase in `install.sh`'s `main()` (and `update.sh`'s build/install step) runs
through `lib/common.sh`'s `run_phase`:

- **Checkpointed.** Each completed phase's name is appended to
  `/etc/supremeos/install.state`. Re-running the installer — after a dropped SSH
  session mid-`apt-get`, a reboot mid-install, a transient network failure — skips
  every phase already recorded complete and resumes from the first one that isn't.
  `SUPREME_FORCE_REDO=1` re-runs everything, opt-in only.
- **Structured, persistent logs.** Every run tees its full output to
  `/etc/supremeos/logs/install-<UTC-timestamp>.log`, in addition to the terminal — an
  interrupted install leaves a complete record of what happened up to the point it
  stopped, not just whatever scrolled past in a lost session.
- **Progress display.** Each phase logs a `[phase] <name>` marker on start and an
  `OK (<N>s)` / `FAILED after <N>s` on completion — plain, greppable, safe to redirect
  (matches this deployment's existing logging convention, no TTY-only color codes).
- **Clear failure reports.** A failed phase dies with the specific error from that
  phase (never a generic "installation failed"); the next re-run skips every phase that
  already succeeded and retries only the one that didn't.

## Directory layout

```
infra/native-linux/
  install.sh          # first-time install: deps, build, configure, start, verify
  update.sh           # re-sync repo, rebuild, re-render config, restart services
  uninstall.sh        # remove SupremeOS (--purge for full teardown incl. third-party packages)
  backup.sh           # pg_dump + config/secrets/data tarball, retention pruning
  restore.sh          # restore from a backup.sh tarball (destructive, confirmation-gated)
  health-check.sh     # read-only PASS/FAIL/NOT-EVALUATED report across every component
  logs.sh             # journalctl wrapper, per-service or interleaved "all" mode
  lib/
    common.sh         # paths, logging, require_root/require_ubuntu_24_04, systemd guards,
                       # generate_secret, run_as_supreme (PATH/proxy/CA forwarding)
    deploy-steps.sh   # shared by install.sh/update.sh: sync_repo, build_workspace,
                       # verify_workspace, render_template, load_answers/load_secrets
  config/
    Caddyfile.template
    nats.conf.template
    mosquitto-supremeos.conf.template
    gateway.env.template
  systemd/
    supreme-gateway.service
    supreme-commissioning.service
    supreme-nats.service
    supreme-homeassistant.service        # optional unit, only installed if HA is selected
```

`infra/systemd/supreme-lan.service` already existed on `main` before this work — `install.sh`
copies it directly rather than duplicating a second definition, per the standing "extend, don't
fork" rule.

## Filesystem conventions

| Path | Purpose |
|---|---|
| `/opt/supreme/repo` | rsync'd copy of the monorepo, built in place |
| `/opt/supreme/current` | symlink to `/opt/supreme/repo` (stable path for unit files/Caddyfile) |
| `/opt/supreme/venvs/{commissioning,homeassistant}` | Python virtualenvs for the two Python services |
| `/etc/supremeos/install.conf` | persisted install-time answers, reused by `update.sh`/`backup.sh`/`health-check.sh` |
| `/etc/supremeos/secrets/{token-secret,postgres-password}` | generated once (32 random bytes, hex-encoded), never regenerated on re-run |
| `/etc/supremeos/gateway.env`, `nats.conf` | rendered from `config/*.template`, mode 0640, owned `root:supreme` |
| `/etc/caddy/Caddyfile` | rendered from `Caddyfile.template` |
| `/etc/mosquitto/conf.d/supremeos.conf` | rendered from `mosquitto-supremeos.conf.template` |
| `/var/lib/supremeos/` | NATS JetStream store, Matter storage — SupremeOS-owned runtime data |
| `/var/backups/supremeos/` | `backup.sh` output, retention-pruned |
| `supreme` system user/group | owns `/opt/supreme`, runs the Node/Python services |

## Port layout

Identical to the Docker deployment's internal ports — only the transport changes (loopback TCP
instead of a container bridge network):

| Service | Port | Binding |
|---|---|---|
| Caddy (public HTTPS) | 443 | `0.0.0.0` |
| Caddy (HTTP→HTTPS redirect) | 80 | `0.0.0.0` |
| Gateway | 8080 | `127.0.0.1` (fronted by Caddy) |
| Commissioning | 9100 | `127.0.0.1` |
| PostgreSQL | 5432 | `127.0.0.1` |
| Redis | 6379 | `127.0.0.1` |
| NATS (+ JetStream) | 4222 | `127.0.0.1` |
| Mosquitto | 1883 | `127.0.0.1` |
| Home Assistant (optional) | 8123 | `127.0.0.1` — never exposed publicly, same rule as Docker |

## Systemd service graph

`supreme-gateway.service` declares `After=network-online.target postgresql.service
supreme-nats.service mosquitto.service redis-server.service supreme-commissioning.service` and
`Requires=postgresql.service`, so a reboot brings the stack up in dependency order automatically
once every unit is `enable`d. `TimeoutStartSec=180` on the Gateway unit accounts for
migration-on-boot against a cold Postgres. All units carry standard hardening
(`ProtectSystem=strict`, `NoNewPrivileges=yes`, dedicated `User=supreme`) except
`supreme-homeassistant.service`, which is deliberately less locked down — HA's integration surface
may need broader device/kernel access even run headlessly, and this was not validated against real
hardware in this phase (see "Known scope gaps").

## Supply-chain integrity

NATS (`2.10.24`) and Caddy (`2.8.4`) are the two binaries not available as an Ubuntu 24.04 apt
package at the version this stack targets. `install.sh` downloads each directly from its own
GitHub release and verifies it against a checksum pinned in `install.sh` itself
(`NATS_DEB_SHA256`, `CADDY_DEB_SHA512`) — both checksums were obtained by downloading the real
release assets and diffing them against that release's own published `SHA256SUMS`/`checksums.txt`
manifest during this work, not invented. Nothing in the install path pipes an unauthenticated
`curl` straight into a shell.

## Known deviations from Docker (disclosed by design, not oversights)

1. **Mosquitto persistence path.** Ubuntu's package-provided `/etc/mosquitto/mosquitto.conf`
   already sets `persistence`, `persistence_location`, and `log_dest` before it includes
   `/etc/mosquitto/conf.d/`; a conf.d file cannot redeclare those directives (confirmed by
   actually starting Mosquitto against a file that tried — Mosquitto hard-errors with "Duplicate
   persistence_location value in configuration" and refuses to start). `mosquitto-supremeos.conf.
   template` therefore only sets `listener 1883 127.0.0.1` and `allow_anonymous true`, leaving
   persistence at Ubuntu's own default (`/var/lib/mosquitto/`) rather than under
   `/var/lib/supremeos/`. `backup.sh` does not capture this path — retained MQTT state is a broker
   cache no client in this codebase depends on surviving a restart, so this is a stated decision.

2. **Caddy serves static files directly.** The Docker deployment fronts the homeowner/installer
   web bundles with separate nginx containers behind Caddy. The native deployment has Caddy serve
   those `dist/` directories directly via `file_server` — one fewer moving part, same routes, same
   response bytes. This is a deployment-layer simplification, not a behavior change.

3. **Caddyfile directive ordering.** The Docker Caddyfile and an early draft of the native
   Caddyfile both used bare top-level directives (`reverse_proxy`, `file_server`, …). This is a
   real, confirmed footgun: Caddy does not execute top-level directives in file order — it applies
   a fixed internal priority order where `file_server`/`root` outrank `reverse_proxy` regardless of
   position. An early version of `Caddyfile.template` passed `caddy validate` cleanly but, when
   actually run, served `/healthz` from the homeowner app's `index.html` instead of proxying it to
   the Gateway. The template now wraps every route in an explicit `route { handle {...} }` block,
   which does execute in written order — verified by re-running the same test and confirming
   `/healthz` correctly 502s (nothing listening on :8080 in that test) while `/` and `/installer/`
   still correctly return static content.

## Known scope gaps (Phase 1 — explicitly out of scope, not silently dropped)

These mirror gaps that already exist in the Docker deployment when their env vars are left unset,
so this is not a regression relative to Docker — it's the same honest-empty pattern applied to a
new deployment layer:

- **`ai` (local LLM planner) and `appletv` (pyatv bridge) services** are not yet part of this
  native deployment. `SUPREME_AI_URL`/`SUPREME_APPLETV_URL` are left empty in `gateway.env.
  template`, which is exactly how the Gateway already behaves when those are unset under Docker —
  it falls back to its built-in planner / disables the Apple TV bridge, honestly, rather than
  pointing at a nonexistent localhost port.
- **go2rtc (camera streaming)** is likewise not wired up. `SUPREME_STREAM_API_URL` is left empty;
  the Caddyfile's `/stream/*` route is left in place pointed at `127.0.0.1:1984` so it 502s
  cleanly if ever hit, matching Docker's own behavior when the `streamer` container isn't running.
- **Home Assistant Core venv bring-up** was not executed end-to-end against real hardware in this
  phase — only reviewed and scripted (`install_homeassistant_venv`,
  `supreme-homeassistant.service`). Treat first real HA installs via this path as needing a
  supervised first run.

## Verification performed in this phase (and what genuinely could not be)

This sandbox is real Ubuntu 24.04.4 LTS with real root and apt access, but is **not running
systemd as PID 1** (`ps -p 1 -o comm=` reports `process_api`; `systemctl is-system-running` reports
"System has not been booted with systemd as init system"). That shaped exactly what could be
proven for real versus what requires actual target hardware:

**Genuinely executed in this sandbox, end-to-end, with real processes:**
- Every apt dependency install path.
- Downloading and checksum-verifying the real NATS and Caddy release binaries.
- A full `pnpm install --frozen-lockfile && pnpm turbo run build` of the entire workspace via the
  script's own `run_as_supreme` path (including the PATH/CA-forwarding fixes this uncovered).
- Real PostgreSQL: role/database creation, a live `psql` login check, and a real Gateway boot that
  ran its own internal migration against it successfully.
- Real Redis (`PING`/`PONG`), real Mosquitto (pub/sub), real NATS JetStream (real listener).
- Real Caddy as a TLS-terminating reverse proxy, including catching and fixing the directive-order
  bug above.
- The real compiled Gateway (`node dist/main.js`) running against all of the above, reachable at
  `https://127.0.0.1/healthz` → `200 {"status":"ok","backend":"routing","backendHealthy":true}`,
  with `/` and `/installer/` returning `200` and the HTTP→HTTPS redirect returning `301`.
- `shellcheck -x` clean on all seven lifecycle scripts; `bash -n` syntax checks; `systemd-analyze
  verify` against every unit file (with stub executables, since no live systemd was available to
  actually load them).

**Not genuinely executable in this sandbox, disclosed rather than fabricated:**
- `systemctl enable`/`start` semantics, and reboot-persistence of the enabled units — this
  requires a real systemd PID 1. `lib/common.sh`'s `systemd_is_live()` guard exists specifically
  so that `install.sh`/`update.sh` degrade to a clear warning instead of a silent no-op or a
  fabricated success when run somewhere systemd isn't live (like this sandbox); on real target
  hardware the same code path runs `systemctl enable --now` for real.
- A real reboot test proving service auto-start survives a power cycle.

Requirement 17 (build/typecheck/test parity with `main`) was verified two ways: first by building
the temporary rsync copy this testing produced, which built/typechecked/tested identically to
`main`; and, after that scratch copy was deleted, formally reconfirmed against the actual tracked
`native-linux` branch — `git diff main -- . ':!infra/native-linux'` is empty (zero application code
changed), and `pnpm turbo run build typecheck test` reports **173/173 tasks successful**, the same
count as `main`.

## Compatibility with a future SupremeOS Linux image

Superseded by, and now fully specified in, § Future SupremeOS appliance image above —
kept here as a pointer since this section's original claim (`install.sh` requires
nothing Docker-specific and works fully unattended) is still the underlying reason the
marker-file/skip-toolchain design above was possible to add without any application
code changes: `install.sh`'s steps (system user, directories, secrets, third-party
services, systemd units, config rendering) were already environment-agnostic, so
appliance-image support is purely an installer-side detection + skip, not a redesign.

## Operating the native deployment

```bash
sudo ./install.sh                 # first-time install (interactive, or set SUPREME_UNATTENDED=1)
sudo ./install.sh --offline <pkg> # first-time install fully offline from a release package
sudo ./update.sh                  # transactional update: backup, install, migrate, verify, switch, cleanup
sudo ./update.sh --offline <pkg>  # offline update from a local release package
sudo ./recover.sh                 # detect + repair a broken installation
sudo ./recover.sh --restore-backup # recover AND restore the most recent backup
sudo supremeos-support             # generate a redacted support bundle for Supreme Domotics
sudo ./health-check.sh            # read-only PASS/FAIL/WARNING/N-A report, safe to run anytime
sudo ./backup.sh                  # pg_dump + config/secrets/data tarball under /var/backups/supremeos
sudo ./restore.sh <backup-file>   # destructive restore, requires typing "yes" (or --force)
sudo ./logs.sh gateway            # journalctl -u supreme-gateway -n 100
sudo ./logs.sh all                # interleaved gateway + lan + commissioning + nats
sudo ./uninstall.sh               # stop + remove SupremeOS units and /opt/supreme (keeps config/data)
sudo ./uninstall.sh --purge       # also remove config/secrets/data and third-party packages
sudo ./factory-reset.sh           # wipe data/config, keep software installed — appliance OOBE reset
sudo ./security-audit.sh          # read-only security posture report (user/ownership/perms/ports)
```

## Release lifecycle

The permanent SupremeOS deployment lifecycle (§ requirement 11) — every stage already
built in this and prior phases, end to end:

```
Developer commits
  ↓
GitHub (tag push: release-X.Y.Z)
  ↓
CI            build → typecheck → test → integration → performance
  ↓             (.github/workflows/release.yml — the ONLY place the developer suite
  ↓             runs for a release; see § Deployment modes)
  ↓
Package       package-release.sh — versioned .tar.zst + expanded release-manifest.json
  ↓
Sign          Ed25519 (preferred) or OpenPGP — mandatory; CI refuses to publish unsigned
  ↓
Publish       GitHub Release: tarball + .sha256 + .ed25519.sig/.sig
  ↓
Download      operator (or, in a future OTA phase, an automated client) downloads the
  ↓             release, or copies it via USB for an offline install
  ↓
Install       install.sh / update.sh — checksum + signature + manifest validation,
  ↓             staged build, atomic switch, staged runtime verification
  ↓
Operate       health-check.sh, security-audit.sh, supremeos-support, logs.sh
  ↓
Update        update.sh — automatic backup, transactional switch, automatic rollback
  ↓             on any failure (including a failed migration)
  ↓
Rollback      automatic (update.sh) or manual (recover.sh) — always lands back on a
  ↓             verified-running version, never a partial state
  ↓
Factory Reset factory-reset.sh — data/config wiped, software stays installed, OOBE
  ↓
Retire        uninstall.sh --purge — software and (optionally) data fully removed
```

This is the same lifecycle a future SupremeOS Linux appliance image uses unmodified —
"Download" becomes "the image ships with a release baked in," "Install" becomes the
first-boot run of `install.sh` against `is_official_appliance_image()`, and everything
from "Operate" onward is byte-for-byte identical. No stage required an application code
change to reach this point.

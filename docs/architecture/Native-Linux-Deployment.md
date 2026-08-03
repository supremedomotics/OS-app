# Native Linux Deployment (`infra/native-linux/`)

- Status: **Accepted** (Phase 1 — see "Known scope gaps" below for what is intentionally not yet
  covered)
- Companion: `docs/architecture/adr/0024-native-linux-deployment.md`

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

`infra/native-linux/` was written to be embeddable as-is: `install.sh`'s steps (system user,
directories, secrets, third-party services, systemd units, config rendering) require nothing
Docker-specific and nothing interactive when `SUPREME_UNATTENDED=1` is set with pre-seeded answers
(`SUPREME_SYSTEM_NAME`, `SUPREME_DOMAIN`, etc.), which is the intended path for baking an image:
run `install.sh` once during image build with unattended answers, and the resulting image boots
directly into a running SupremeOS controller with no further interaction required.

## Operating the native deployment

```bash
sudo ./install.sh                 # first-time install (interactive, or set SUPREME_UNATTENDED=1)
sudo ./update.sh                  # pull latest code, rebuild, re-render config, restart
sudo ./health-check.sh            # read-only PASS/FAIL report, safe to run anytime
sudo ./backup.sh                  # pg_dump + config/secrets/data tarball under /var/backups/supremeos
sudo ./restore.sh <backup-file>   # destructive restore, requires typing "yes" (or --force)
sudo ./logs.sh gateway            # journalctl -u supreme-gateway -n 100
sudo ./logs.sh all                # interleaved gateway + lan + commissioning + nats
sudo ./uninstall.sh               # stop + remove SupremeOS units and /opt/supreme (keeps config/data)
sudo ./uninstall.sh --purge       # also remove config/secrets/data and third-party packages
```

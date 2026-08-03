# ADR 0023 — Native systemd deployment as a parallel layer to Docker Compose

- Status: **Accepted**
- Date: 2026-08-03
- Context: production hardening milestone — SupremeOS must ship on bare Ubuntu 24.04 LTS hub
  hardware without a Docker dependency, while Docker remains the development/CI path.

## Context

`infra/hub-compose/` (Docker Compose) has been the only deployment path for SupremeOS. It works
well for development and CI, but a production luxury-controller appliance running on dedicated
hub hardware should not carry a full container runtime as a mandatory dependency: it's one more
moving part between the OS and the product, and the target end state — a dedicated SupremeOS Linux
OS image — needs the application supervised by the OS's own init system, not a container engine
layered on top of it.

## Decision

Add `infra/native-linux/` as a second, independent deployment layer for the exact same
application code, never modifying `infra/hub-compose/`:

- Every stateful dependency (PostgreSQL, Redis, NATS, Mosquitto) runs as a native Ubuntu
  service/package instead of a container, bound to `127.0.0.1`.
- The Gateway, LAN service, and Commissioning service run as systemd units executing the same
  build artifacts (`services/*/dist`) the Docker images already produce — no application code
  changed, no protocol/driver logic touched.
- Caddy replaces the Docker deployment's Caddy+nginx pair as a single native TLS-terminating
  reverse proxy, serving the built web bundles directly via `file_server`.
- Docker Compose's `docker-compose.yml`/override files are replaced, for this deployment path
  only, by seven lifecycle scripts (`install.sh`, `update.sh`, `uninstall.sh`, `backup.sh`,
  `restore.sh`, `health-check.sh`, `logs.sh`) plus systemd unit files, generated from templates
  in `config/` so install-time answers (domain, timezone, HA opt-in) are the only per-deployment
  variable.
- `install.sh` is idempotent and supports an unattended, pre-seeded mode
  (`SUPREME_UNATTENDED=1`), so the same script can be the install step of a future SupremeOS Linux
  OS image build, not just an interactive one-off.

See `docs/architecture/Native-Linux-Deployment.md` for the full directory layout, port map,
supply-chain integrity approach, disclosed deviations from Docker, disclosed scope gaps, and the
verification performed (and explicitly not performed, for lack of a live systemd PID 1) during
this work.

## Consequences

- Two deployment layers must now be kept in sync when a new backend service, port, or environment
  variable is added: `infra/hub-compose/docker-compose.yml` and the corresponding
  `infra/native-linux/config/*.template` / `systemd/*.service`. Future service-affecting PRs
  should update both, or explicitly note in the PR that the native-linux side is deferred.
  Nothing about this ADR requires them to update in lockstep same-PR when there's a reason not to,
  but silent drift is a real risk this decision accepts.
- The native deployment currently omits the `ai`/`appletv`/go2rtc services (see the architecture
  doc's "Known scope gaps") — this is not a regression relative to Docker (those already degrade
  to an honest no-op when unset there too), but it does mean native-linux is not yet a byte-for-
  byte feature match. Closing that gap is future work, not blocking for this ADR's acceptance.
- `assertSecureConfig()`'s `SUPREME_CORS_ORIGINS` production-hardening check (`services/gateway/
  src/config.ts`) was found, during this work, to be a latent boot-failure trap in Docker's own
  `.env.example` default too (empty value + `NODE_ENV=production` = refuse to boot). This ADR does
  not fix Docker's default — that's outside this deployment-layer-only change — but flags it as a
  known gap worth a follow-up fix to `infra/hub-compose/.env.example` and its docs.
- Genuine systemd behaviors (`enable`/`start` persistence across reboot) could not be executed in
  the sandbox this work was done in (no live systemd PID 1 there); `lib/common.sh`'s
  `systemd_is_live()` guard makes this an explicit, visible skip rather than a silent no-op, but
  real-hardware validation of reboot persistence remains a recommended next step before shipping
  the first production unit.

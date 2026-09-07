# SupremeOS Production Readiness Audit (Commercial Release Assessment)

> **Status:** Complete — read-only audit, no application code modified.
> **Scope:** Entire SupremeOS platform across two unmerged branches:
> `claude/casambi-driver-refactor-lvu23e` (current branch, contains the Native Backend /
> Core Capability Audit work) and `native-linux` (contains the systemd-based native Linux
> deployment and an independent device-lifecycle rewrite). Evidence gathered via direct
> source inspection plus 7 parallel research passes, each cross-verified against actual
> file:line citations. Where evidence could not be established, this document says
> **Not Verified** rather than estimating.
> **Rules honored:** no application code was modified, no architecture was redesigned, no
> new protocol features were added, no existing functionality was removed. This document is
> the only artifact this phase produces.

---

## Executive Summary

SupremeOS has a genuinely strong architectural foundation: a capability-driven device
model, a real ABAC/RBAC permission engine, Argon2id + TOTP + WebAuthn authentication, a
hardened systemd deployment path with real least-privilege sandboxing, and several
protocol drivers (AVR, HEOS, Yamaha, CoolMaster) built to a production-grade standard with
reconnect logic, diagnostics, and offline detection. The Core Capability Audit's own prior
phase (Phase 1 correctness fixes, `SupremeOS-Core-Capability-Audit-Phase1-Fixes.md`)
already removed several instances of fabricated success from the codebase — this audit
found no fabricated-success regressions of that class.

However, **SupremeOS is not ready for commercial deployment today**, for reasons that are
evidence-backed, not speculative:

1. **The codebase currently exists as two incompatible, unmerged rewrites of the same core
   architecture.** `claude/casambi-driver-refactor-lvu23e` extended the existing
   `OwnershipRegistry`/`HaUnavailableAdapter` model to make Home Assistant optional.
   Independently, the `native-linux` branch replaced the same subsystem with a different
   `provider` + `DeviceLifecycleState` model (ADR-0023, "Native Device Lifecycle
   Architecture"). Neither branch's device-lifecycle work exists on the other. Shipping
   either branch alone abandons real, working code on the other side; reconciling them is
   itself a significant, unscoped engineering project.
2. **A critical backup/recovery defect makes disaster recovery non-functional as designed**:
   the gateway's backup-signing keypair (`services/gateway/src/installer-context.ts:294,305`)
   is generated fresh, in memory, on every process start, with no persistence and no config
   override. A backup created via the API cannot be restored after the gateway process that
   created it restarts — which defeats the primary purpose of backup/recovery (surviving a
   reinstall, crash, or hardware swap).
3. **Three advertised protocols — Matter, DALI, and Zigbee — cannot connect to any real
   device in production.** Their default controller/bus factories throw unconditionally, and
   nothing in `bootstrap.ts` or `native-driver-factory.ts` ever injects a working one.
4. **There is zero evidence the platform has ever been tested at any meaningful device or
   entity scale.** The one CI job designed to produce a real load number (100 VUs / 60s) has
   failed 100% of its 32 scheduled runs due to a broken command, and has never been run
   manually. No test simulates 100/500/1000/5000 devices — only ~12, the fixed demo home.
5. **The installer experience is split across two apps with real functional gaps**: the
   dedicated installer app cannot restore a backup, cannot configure or update a driver, and
   has no automations/scenes/floor UI — those exist only in the homeowner app, with no
   documented boundary for which an installer is meant to use.

None of this means the underlying engineering is weak — the opposite is often true in
isolation (the security posture, the AVR/HEOS/Yamaha driver tier, and the systemd hardening
are all genuinely commercial-grade). The gap is **operational maturity and integration**:
unresolved architecture forks, unverified scale, and installer/recovery workflows that
still assume a developer is present. See Phase 10 for the full ranked blocker list.

**Final Production Readiness Score: 3.6 / 10 — Pre-Production.** Full scoring rationale in
the Commercial Competitiveness Assessment section below.

---

## Methodology

- Two git worktrees were used to inspect both unmerged branches without switching the
  active branch: `/tmp/audit-worktrees/native-linux` (`origin/native-linux`) and
  `/tmp/audit-worktrees/main` (`origin/main`).
- Seven parallel research passes were run, each independently reading source files and
  citing `file:line` for every claim: (1) Boot & Update systems, (2) Driver audit part A
  (KNX/Casambi/Matter/MQTT/DALI/Zigbee/Modbus), (3) Driver audit part B
  (AVR/HEOS/Yamaha/Apple TV/AirPlay/Sonos/WiiM/Devialet/CoolMaster/SIP/Lutron/Tuya/Shelly/
  Ajax + Frigate/Bluetooth/ESPHome absence), (4) Installer experience & backup/recovery,
  (5) Diagnostics coverage, (6) Security posture, (7) Performance & scaling evidence.
- Phase 9 (Commercial Readiness scoring) and Phase 10 (ranked blocker list) below are this
  session's own synthesis across all seven passes plus direct findings — not delegated,
  since they require holistic judgment no single pass could make in isolation.
- No files were modified. No architecture decision was made or reversed in this document —
  the branch-fragmentation finding is reported as a fact for a future session to resolve,
  not resolved here.

---

## 1. Production Readiness Report — Phase 1 (Boot) & Phase 6 (Update)

### Clean installation

`infra/native-linux/install.sh` (863 lines) is a real, non-stub installer: creates a
dedicated system user, installs OS packages, checksum-verifies NATS/Caddy `.deb` downloads,
provisions Postgres/Redis/Mosquitto, installs systemd units, and runs a staged runtime
health verification before declaring success. It is checkpointed/idempotent
(`run_phase`, `lib/common.sh:244–271`) — a resumed run after an interrupted SSH session
re-verifies on-disk state rather than blindly skipping. No `TODO`/stub logic was found in
the script body.

The deployment's own self-audit (`Native-Linux-Deployment.md:812–840`,
`Native-Linux-Appliance-Readiness-Report.md:73–94`) honestly discloses its verification
ceiling: the environment that authored it had **no live systemd (not PID 1), no `jq`, and
was never rebooted** — so `systemctl enable`/reboot-persistence and the JSON
`release-state.json` machinery are implemented but never exercised end-to-end on a real
target. This is candor, not fabrication, but it remains the single largest unverified claim
behind "reboot recovery."

### Startup sequence / service ordering

Systemd ordering is correct for the common case but has two undisclosed gaps:
- `supreme-gateway.service` only `Requires=postgresql.service`; NATS, Mosquitto, and Redis
  are `After=`-only, so a failed broker/cache does not block Gateway startup at the systemd
  level (`supreme-gateway.service:19–21`).
- The Gateway has no `After=`/ordering dependency on `supreme-homeassistant.service`, even
  though HA is the live backend under `SUPREME_BACKEND=ha` and its own unit allows up to
  300s to start (`supreme-homeassistant.service:36`) — the Gateway can start and begin
  serving before HA is ready.

### Reboot recovery

`systemctl enable --now` is used consistently for every SupremeOS-owned unit
(`lib/common.sh:106–113`, called from `install.sh:641–649`), so units are genuinely enabled
for boot, not merely started. As above, this was never live-tested against a real reboot.

### Crash recovery / health monitoring

`Restart=always` with a short `RestartSec` (2s for gateway/commissioning/NATS/LAN, 10s for
HA) is configured on every unit. `services/gateway/src/main.ts` has **no
`process.on("uncaughtException"/"unhandledRejection")` handler** — only graceful
SIGINT/SIGTERM shutdown — so any uncaught error crashes the whole process, with systemd
restart as the only recovery mechanism (no in-process resilience/draining).

`health-check.sh` performs real, non-superficial checks (systemd unit state, TCP
reachability, live HTTP `/healthz` calls, a real SQL query against `schema_migrations`,
disk/memory/CPU checks against a release manifest) shared with the installer's own
verification function — one definition of "healthy," not two. **Gap: there is no systemd
`.timer` unit and no cron entry anywhere in the deployment** — health is checked only when a
human runs the script by hand. Nothing polls health automatically after first boot.

### Update system

`update.sh` implements a real transactional flow: unconditional pre-update backup (dies if
none is produced), atomic release-symlink swap (`ln -sfn`), ordered service restart, staged
post-update verification, and automatic rollback (release symlink reverted, DB/config
restored from the pre-update backup, services restarted, health re-verified) on any
failure caught by a bash `ERR` trap.

**Gap: the rollback guarantee is a bash `ERR` trap, which cannot fire on `SIGKILL` or a lost
SSH session's `SIGHUP`.** A kill between the release-symlink swap and service restart can
leave the symlink pointing at new code while old-code processes stay running, with
`release-state.json` stuck at `pending_release` and no automatic rollback triggered.
`recover.sh` exists as the documented manual remedy, but it is operator-invoked, not
automatic.

**Gap: no schema-level rollback/down-migrations exist.** `services/persistence/src/migrate.ts`
applies 24 migration files idempotently via a simple `pool.query(sql)` per file — atomic
per-file, but with no cross-migration transaction and no `down.sql`. A failing migration N
leaves 1..N-1 committed and recorded, with no automatic reversal; the only rollback path is
a full `pg_dump`/`restore.sh --force` from the pre-update backup, which is much coarser than
the migration that actually failed.

Driver updates are handled independently of a full hub redeploy, via
`installer-context.ts`'s `installDriver`/`uninstallDriver`/`enableDriver` — a live,
in-process API, not tied to `update.sh`.

---

## 2. Driver Readiness Matrix (Phase 2)

Consolidated from both driver-audit research passes. "Ready" = discovery + real production
control transport + at least basic resilience. "Partial" = works but is missing a
significant piece (diagnostics, reconnect, or offline detection). "Not Ready" = the
production control path is not wired at all (throws by default) or is structurally
unreachable. "Not Found" = no implementation exists.

| Driver | Discovery | Control transport wired in prod | Diagnostics | Reconnect | Offline detection | Verdict |
|---|---|---|---|---|---|---|
| AVR (Denon/Marantz) | Real (SSDP+UPnP) | Real | Full (getDiagnostics/getTrace/getCapabilityConfig) | Real, backoff | Yes (heartbeat) | **Ready** |
| HEOS | Real (SSDP+query) | Real | Full | Real, backoff (shared transport) | Yes (heartbeat) | **Ready** |
| Yamaha | Real (SSDP+getFeatures) | Real, wire-queried capabilities | Full | N/A (HTTP); host-down tracked | Yes | **Ready** |
| CoolMaster (HVAC) | Real (bus scan, auto-creates units) | Real, automatic | Partial (getCapabilityConfig only) | Real, backoff | Yes (missed-poll tracking) | **Ready** |
| KNX (legacy, live command driver) | Hardcoded `[]` | Real bus I/O | None | **None** (dropped tunnel after connect goes undetected) | Bare non-null check | **Partial** |
| KNX (`SupremeKnxDriver`, discovery-only) | Real (KNX IoT + ETS) | **Not used for live commands** — discovery scans only | Custom, non-interface | Real (ConnectionManager, backoff) | Real | N/A — not the production driver |
| Casambi | Real (cloud REST; progressive local) | Real, cloud-verified; local UDP structurally works but **never validated against real gateway hardware** (own doc's verdict: "NOT EVALUATED") | Custom, rich, but not Diagnostics-Console-reachable | Real w/ backoff (cloud only); **none for local UDP** | Real | **Not Ready** (own documented verdict) |
| MQTT | Real (Z2M-bridge only) | Real | None | Library-default only; **no driver-level `.on("error")` handler** | Library-maintained flag | **Partial** |
| Modbus | Hardcoded `[]` | Real (default TCP client, no injection needed) | None | **None** | Bare non-null check | **Partial** |
| Matter | Real code, but unreachable | **No controller ever injected in production — throws unconditionally** | None | None | Bare non-null check | **Not Ready** |
| DALI | Real code, but unreachable | **No bus ever injected in production — throws unconditionally** | None | None | Bare non-null check | **Not Ready** |
| Zigbee (native ZCL) | Real code, but unreachable | **No controller ever injected in production — throws unconditionally** | None | None | Bare non-null check | **Not Ready** |
| Sonos | Real (SSDP) | Real (node-sonos wired) | None | Poll-only, no backoff | None | **Partial** |
| Apple TV | Real (mDNS) | Real (PIN pairing via Python bridge) | None | None | None | **Partial** — also: session leak on unbind (bridge `close()` never called); **bridge is entirely absent from the native-linux deployment** (documented gap) |
| WiiM | Real (SSDP) | Real (self-contained HTTP) | None | Poll-only | None | **Partial** |
| Devialet | Real (mDNS) | Real (self-contained HTTP) | None | Poll-only | None | **Partial** |
| Shelly | Real (mDNS+RPC) | Real (self-contained HTTP) | None | Poll-only | None | **Partial** |
| Lutron | None (manual add) | Real (login handshake) | None | **None** (misleading no-op comment; dropped socket requires external restart) | None | **Partial** |
| AirPlay | Real (mDNS) | **No real sender wired anywhere — throws** | None | N/A | None | **Not Ready** |
| SIP (door station) | None (manual add) | **No real SIP UA wired anywhere — throws** (lock-fabrication correctness fix confirmed still present) | None | None | None | **Not Ready** |
| Tuya | None (cloud, unbuilt) | **No real client wired — throws** | None | N/A | None | **Not Ready** |
| Ajax (security sensors) | None (cloud, unbuilt) | **No real client wired — throws** | None | N/A | None | **Not Ready** (correctly honest: read-only commands unconditionally throw rather than no-op) |
| Frigate (NVR) | — | — | — | — | — | **Not Found** — camera support is generic RTSP/snapshot only |
| Bluetooth (device driver) | — | — | — | — | — | **Not Found** — exists only as a presence-detection source weight, not a driver |
| ESPHome | — | — | — | — | — | **Not Found** — zero references anywhere |

**Cross-cutting finding**: 3 of ~22 drivers (Matter, DALI, Zigbee) are structurally
non-functional by construction — real mapping/discovery code exists but nothing ever
supplies a working controller. 5 more (AirPlay, SIP, Tuya, Ajax, and Apple TV specifically
on the native-linux path) have no real production control transport wired at all. Only 4
drivers (AVR, HEOS, Yamaha, CoolMaster) meet a genuinely production-grade bar across
discovery, control, diagnostics, reconnect, and offline detection. The KNX production
driver and the fully-resilient KNX discovery driver are two different classes sharing one
protocol registration — a real architectural duplication risk independently flagged in the
prior Core Capability Audit.

---

## 3. Installer Workflow Audit (Phase 3)

| # | Capability | Verdict | Notes |
|---|---|---|---|
| Install (setup wizard) | Complete | Real 3-step wizard, `apps/web-homeowner` only — **not present in `apps/web-installer` at all** |
| Configure networking | **Not Found** | No static-IP/DNS/WiFi UI or API anywhere; assumed to be handled entirely at the OS level, outside SupremeOS |
| Commission devices | Complete | `apps/web-installer` — scan, manual add, KNX ETS import with preview-then-commit |
| Assign rooms | Complete | Both apps |
| Assign floors | Complete, **not in web-installer** | Only `apps/web-homeowner`'s Areas tab has building/floor fields |
| Configure automations | Complete, **not in web-installer** | Only `apps/web-homeowner` |
| Configure scenes | Complete, **not in web-installer** | Only `apps/web-homeowner` |
| Configure drivers | Complete, **split across two apps** | `web-installer`'s SDK client structurally lacks the config/update/connect/disconnect methods; only `web-homeowner`'s Extension Center has them |
| Update drivers | Complete, **only in web-homeowner** | No update control anywhere in `web-installer` |
| Backup | Complete | Present in both apps |
| Restore | **Partial — no UI in web-installer at all** | `web-installer`'s Backup/Restore component has no restore control, file picker, or SDK call, despite the SDK exposing `restore()`. Full guided restore wizard exists only in `web-homeowner` Settings |
| Factory reset | **Not Found** (as an installer-facing action) | `factory-reset.sh` is thorough but CLI/SSH/root-only; no gateway route, no UI button anywhere |
| Recover from failure | Partial | Driver-level recovery has a real UI (connect/disconnect, health verdict); system-level recovery (broken install/config) is CLI-only via `recover.sh` |

**Most significant missing steps**: no networking configuration surface anywhere; the
dedicated installer app cannot restore a backup, configure/update a driver, or set up
floors/automations/scenes — those all require switching to the homeowner app mid-workflow
with no documented role boundary; no factory reset or broken-hub recovery UI exists at all.
The stated goal — "can an installer, without developer intervention, do all of this" — is
**not met today**: several steps require either a second app whose access boundary for a
field installer is unclear, or SSH/root terminal access.

---

## 4. Diagnostics Coverage Report (Phase 4)

| Component | Surface exists? | Reachable? | Verdict |
|---|---|---|---|
| Gateway | `/metrics`, `/readyz`, `/healthz`, `/v1/diagnostics`, `/v1/system/health`, `/v1/system/logs` | Mostly UI-visible (dashboard, Settings, Dev-mode panel) | **Good** |
| LAN (Casambi) | 11-stage receive pipeline, transport monitor, network forensics | UI-visible for the receive pipeline; transport-monitor/deployment data is API-only, zero UI consumers | **Good** (Casambi only) |
| LAN (other protocols) | — | No equivalent for KNX or anything else | **Missing** |
| Drivers | `driverDiagnostics()`, `driverHealth()`, lifecycle status | UI-visible (drivers.tsx, Dev Driver Lifecycle panel) | **Good** |
| Commissioning | Per-driver discovery failure detail (`driverResults`) computed by the API | **Discarded by the installer UI** — exactly the "spinner with no detail" failure mode | **Partial** |
| Automation | `health()`, `recentRuns()`, full run trace, condition-level failure detail | UI-visible (Automation Debugger) | **Good** |
| Scenes | Per-step success/failure data exists at the service layer (reuses automation engine) | **Never routed or rendered** — a partially-failed scene looks identical to a fully successful one | **Partial** |
| Voice assistants (Alexa/Google/HomeKit) | Only a generic service `/healthz`; no per-link/sync/token status anywhere | No UI surface at all | **Missing** |
| Database | Basic `SELECT 1` connectivity check only; no pool metrics | API-only (`/readyz`), never called by any frontend | **Partial** |
| NATS | **No connection-health accessor exists on the gateway's own event bus at all** | Neither API nor UI | **Missing** |
| MQTT | Generic per-driver connection status only | UI-visible, same as any driver | **Partial** |
| Authentication | Active sessions (self-service only); failed-login/lockout tracked internally but never surfaced; no admin-wide session view; no audit-log entries for login attempts | Partial UI (own sessions only) | **Partial** |
| Networking (deployment mode / bridge vs. host) | Real forensics data exists | Mostly API-only; only a subset reaches the Casambi-specific UI | **Partial** |

**Conclusion**: diagnostics are genuinely strong for Gateway, Drivers, Automation, and
(narrowly) Casambi's LAN path — these expose real root-cause detail, not fabricated health.
But Voice assistants and NATS connection health are effectively invisible without a source
read, and Scenes/Commissioning/Database/general-Networking have the underlying data
computed but not wired to a route or UI. The stated goal — "every production issue should be
diagnosable without reading source code" — **is not met uniformly**.

---

## 5. Backup & Recovery Report (Phase 5)

| # | Question | Verdict | Evidence |
|---|---|---|---|
| Database backup | **Full** | Dynamically enumerates every table via `information_schema`, excluding only 3 internal tables |
| Configuration backup | **Yes, two paths** | Gateway API captures `home_config` (DB); `backup.sh` separately copies the entire `/etc/supremeos` tree including secrets |
| Driver configuration backup | **Yes, unmasked** | `installed_drivers.config` is stored raw in Postgres; API-side masking applies only to read responses, not the backup itself |
| Certificates | **Not Verified — likely excluded** | Caddy's Caddyfile/internal-CA store lives outside both `SUPREME_CONFIG_DIR` and `SUPREME_DATA_DIR`; neither backup path copies it. On-demand reissue would likely self-heal post-restore, but this is an assumption, not a guarantee in code |
| Licenses | **Yes** | Normal, non-excluded table; `factory-reset.sh` also has an explicit `--preserve-license` flag |
| User accounts | **Yes** | Confirmed by a real restore test proving login works post-restore |
| Automations / scenes / room assignments | **Yes** | All ordinary, non-excluded tables |
| Recovery after reinstall | **Partial — critical defect found** | See below |
| Recovery after hardware replacement | Not hardware-bound (license keys off `homeId`, not hardware identifiers) — but subject to the same defect below | |
| Rollback of a bad restore | **Partial** | Auto-reverts only if the restore itself fails mid-way; a successful-but-wrong restore has no undo. No schema-version compatibility check exists on restore at all |

### Critical defect: backups become permanently unrestorable after a gateway restart

`InstallerServices` generates its backup-signing Ed25519 keypair fresh, in memory, on every
construction, with **no persistence and no config override**
(`services/gateway/src/installer-context.ts:294,305`, `generateSigningKeyPair()` in
`packages/crypto/src/index.ts:23–29`) — unlike the licensing/driver-store public keys, which
*are* configurable. `createBackup()` signs with this process's private key;
`restore()`/`inspectRestore()` verify against this process's public key. **A backup created
by one gateway process cannot be restored once that process restarts** — `restore()` throws
`"backup signature verification failed"`. This directly breaks the wipe+reinstall+restore
and hardware-replacement recovery stories the audit brief asked about, and it is not
exercised by any existing test (the one backup/restore e2e test never restarts the context
between create and restore). `backup.sh`/`restore.sh`'s raw `pg_dump`/`pg_restore` path on
native-linux is unaffected, since it bypasses the signed-backup mechanism entirely — but the
API-driven backup path (what both installer apps' UI actually calls) is not.

---

## 6. Security Assessment (Phase 7)

**Strong, evidenced, production-grade**: Argon2id password hashing at OWASP-recommended
parameters with anti-enumeration timing protection and brute-force lockout; short-lived
JWTs with refresh-token rotation and reuse detection; real RFC 6238 TOTP MFA; a genuine
dependency-free WebAuthn/passkey implementation (CBOR/COSE parsing, ES256 verification);
granular, consistently-enforced ABAC-over-RBAC authorization on every mutating route
(spot-checked 4 route files, 100% coverage); correct network exposure (only the reverse
proxy publishes host ports; Postgres/Redis/NATS/Mosquitto/HA never bound to a non-loopback
interface in either deployment path); solid public-facing TLS; genuinely opt-in-only cloud
features; and real, non-superficial systemd least-privilege hardening (dedicated
`nologin` system user, empty `CapabilityBoundingSet`, `ProtectSystem=strict`, and other
directives — with disclosed, reasoned exceptions rather than blanket omissions).

**Ranked gaps found:**

1. **CRITICAL — production hardening check is incomplete, allowing a silently-created
   default admin account.** `assertSecureConfig()` validates only `tokenSecret`,
   `corsOrigins`, and `backend !== "mock"`. It does not require `setupWizard=true` in
   production. If a production deployment ever has `SUPREME_SETUP_WIZARD=0`,
   `AppContext.create()` silently commissions a Master account at
   `owner@supreme.local` / `supreme-owner-demo-pass` — a password visible in this source
   tree — with zero runtime warning.
2. **HIGH — driver/integration secrets are stored as plaintext JSON at rest.**
   Casambi/Lutron/HEOS/etc. credentials persist unencrypted in Postgres; masking applies
   only on the way out to the API, not on the way in.
3. **MEDIUM — personal API tokens (`sup_pat_*`) never expire.** No TTL field exists at all;
   a leaked token is valid indefinitely until manually revoked.
4. **MEDIUM — driver plugins run fully in-process with no isolation boundary.** Every
   protocol driver is a plain class in the same Node process as the gateway core, with the
   same memory space and privileges — a compromised driver is a compromised gateway.
5. **MEDIUM — WebAuthn omits the RP-ID-hash check** on both registration and authentication,
   and never verifies `signCount` is monotonically increasing — two spec-recommended
   defense-in-depth checks are absent (the origin check and signature verification that
   remain cover the primary attack).
6. **LOW-MEDIUM — weak default password policy**: 8-char minimum, no letter/number
   requirement, a 24-entry blocklist.
7. **LOW — NATS and Mosquitto both run without authentication**, relying entirely on
   Docker network isolation — a disclosed, reasoned tradeoff, but a single point of failure
   if that network boundary is ever misconfigured or a co-located container is compromised.

---

## 7. Performance Assessment (Phase 8)

**No genuine evidence of testing at any meaningful device/entity scale exists.** The only
load testing that actually runs and passes is a ~2-second CI gate (20 concurrent virtual
users hitting one device in a fixed ~12-device demo home, plus a 40-connection WebSocket
storm) — real, but trivial. The CI job whose explicit purpose was to produce a heavier
number (100 VUs / 60s) **has failed 100% of its 32 scheduled runs** due to a broken pnpm
invocation, and has **never been triggered manually**. No test anywhere simulates a
specific device or entity count (100/500/1000/5000 as the audit brief asked about) — the
tool measures concurrent *users*, not device population.

Architectural reads (not measurements, and stated as such):
- The native device-state engine (`SupremeNativeAdapter`) uses O(1) Map lookups on the
  command/state hot path — architecturally sound for scaling. One O(n)-in-total-state-size
  operation exists (`unbindDevice()`), confined to device removal, not the hot path.
- Database: 18 real indexes exist; `listDevices()` is a genuine single query, not N+1; but
  connection pooling uses node-postgres's untuned default (no explicit `max`/timeout
  configuration) at any scale.
- Web UI: no virtualization library exists anywhere in `apps/web-homeowner` — every
  device/room card is a real DOM node — and the single global live-state React Context
  re-renders **every** consumer on **every** single incoming device-state delta, regardless
  of which device changed. This is an architectural risk at scale, not a measured one.
- No startup-time, discovery-latency-against-real-hardware, CPU/memory-soak, or NATS
  throughput measurement exists anywhere in the repository — several of these areas contain
  the codebase's own honest written admission that real-hardware measurement was never
  possible in this environment.

**Performance at the 100/500/1000/5000-device scale the audit brief specifically asked
about is Not Verified, across the board, with no exception.**

---

## 8. Commercial Competitiveness Assessment (Phase 9)

*This section is this session's own synthesis, not delegated to a research agent, since it
requires weighing all prior findings holistically against how RTI/Savant/Crestron/Control4
actually operate in the field: certified-dealer installation, proven multi-thousand-site
deployment, mature field-service tooling, and years of hardware-in-the-loop hardening.*

| Category | Score (1–10) | Rationale (repository evidence) |
|---|---|---|
| **Reliability** | 4 | `Restart=always` exists and per-driver errors are caught rather than crashing boot, but there's no in-process crash resilience (`main.ts` has no uncaught-exception handler), 3 of ~22 drivers can never connect by construction (Matter/DALI/Zigbee), and the update system's rollback guarantee cannot survive `SIGKILL`. Contrast: Control4/Crestron controllers are designed to run unattended for years with automatic self-healing at the OS level; that has never been demonstrated here even at the "genuinely tested" bar. |
| **Maintainability** | 5 | The capability-driven architecture, zod-schema-derived types, and consistent driver-interface pattern are genuinely clean and well-documented (module-level ADR references, comprehensive test suite — 306+ gateway tests alone). This would score 7-8 in isolation. It is capped at 5 by the **unresolved branch fork**: two incompatible core-architecture rewrites of the same subsystem exist simultaneously, unmerged, which is a maintainability crisis by definition — every future session must first determine which reality it's working in. |
| **Diagnostics** | 5 | Gateway/Drivers/Automation diagnostics are genuinely excellent — root-cause detail, not fabricated health, comparable to (or exceeding) what a Crestron Toolbox session shows for a single processor. But NATS and Voice-assistant diagnostics are entirely absent, and Commissioning/Scenes compute real failure data that's silently dropped before reaching any UI — the exact "no detail on failure" pattern professional installers file support tickets over. |
| **Commissioning** | 4 | Real discovery/binding pipelines exist for several protocols (KNX ETS import + live discovery through one unified pipeline is a genuinely nice piece of engineering), but 5+ drivers throw immediately on `connect()` in production, and per-driver discovery failures are computed by the API and discarded by the installer UI. A commercial platform's commissioning tool cannot silently fail with no detail — this is the category RTI/Savant most visibly beat SupremeOS on today. |
| **Recovery** | 3 | The **critical backup-signing-key defect** means the platform's designed recovery path (API-driven backup → restore) does not survive the single most common recovery scenario (process/service restart). `update.sh`'s DB-restore rollback is real but coarse-grained, and cannot survive `SIGKILL`. Compare to Control4/Savant, where disaster recovery via a cloud-backed project file restore to replacement hardware is a routine, tested dealer operation. |
| **Scalability** | 3 | Hot-path code is architecturally O(1) and would likely perform well — but this is inference, not measurement. The one CI job meant to prove it has never once succeeded. A non-virtualized device list plus a monolithic re-rendering-on-every-update React Context is a specific, identifiable risk at real (500+ device) commercial-install scale that has not been addressed. Commercial competitors are proven at exactly this scale in the field; SupremeOS has zero comparable evidence. |
| **Installer experience** | 3 | Splitting installer-critical functions (restore, driver config/update, floors, automations, scenes) across two apps with no documented access boundary, plus no networking-configuration UI and no factory-reset UI, falls well short of "a certified installer can do this without a developer" — which is table stakes for RTI/Savant/Crestron/Control4's entire business model (dealer-only installation with a purpose-built, complete tool). |
| **Serviceability** | 4 | Driver-level health/reconnect controls are real and UI-reachable. But system-level recovery from a broken install is CLI/SSH/root-only (`recover.sh`), and there is no scheduled health monitoring (no timer/cron — checks are manual-invocation only) — a genuine gap against any platform with a remote-monitoring dealer portal (all four named competitors have one). |
| **Extensibility** | 7 | This is SupremeOS's clearest relative strength. The capability-driven, protocol-agnostic architecture (`IBackendAdapter`, capability mapper pattern, driver-manifest system) is a cleaner extension model on paper than most closed commercial platforms, whose protocol support is typically hardware-vendor-gated. The gap between "clean extension architecture" and "22 production-grade drivers" (currently only 4 of 22 meet a full bar) is the execution debt, not a design flaw. |

**Aggregate: 3.78 / 10** (unweighted mean of the 9 categories above).

**Positioning relative to RTI/Savant/Crestron/Control4**: those platforms compete on
*proven reliability at scale, dealer-exclusive commissioning tooling, and years of
field-hardened driver libraries* — precisely the three areas this audit found weakest.
SupremeOS's differentiated strength is architectural: a genuinely more modern,
capability-first, local-first design that, if the operational gaps below are closed, could
be a real competitive advantage (no other platform in that set is open, capability-driven,
or local-first by design). Today, it is not a competitor to any of them in a real
installation — it is a promising pre-production research platform with excellent bones.

---

## 9. Remaining Blocker Roadmap (Phase 10)

Ranked Critical → Low. Each entry: description, affected component, production impact,
recommended fix, estimated complexity, dependencies.

### Critical

**C1. Two incompatible, unmerged core-architecture rewrites of device lifecycle/ownership.**
- **Component:** Core device model (`services/home`, `services/integration-layer`).
- **Impact:** The codebase does not have one production reality. `claude/casambi-driver-refactor-lvu23e` extended `OwnershipRegistry`/added `HaUnavailableAdapter`; `native-linux` independently replaced the same subsystem with a `provider`+`DeviceLifecycleState` model under ADR-0023. Shipping either branch alone discards real, working code from the other.
- **Recommended fix:** A dedicated reconciliation session: compare both models against the same requirements, choose one (or a merged design), and migrate the abandoned branch's improvements forward. This is architecture work explicitly out of scope for this audit.
- **Complexity:** High.
- **Dependencies:** Blocks a clean "production branch" existing at all; should be resolved before any other blocker below is fixed on a specific branch, to avoid doing the work twice.

**C2. Backup-signing key is ephemeral — API-driven backups are unrestorable after a gateway restart.**
- **Component:** `services/gateway/src/installer-context.ts:294,305`, `packages/crypto/src/index.ts:23–29`.
- **Impact:** Defeats disaster recovery for reinstall/hardware-replacement — the exact scenario backup exists for.
- **Recommended fix:** Persist the keypair (config-backed, mirroring how `licensingPublicKey`/`driverStorePublicKey` are already handled) or derive it deterministically from a stored secret.
- **Complexity:** Low–Medium.
- **Dependencies:** None.

**C3. Matter, DALI, and Zigbee drivers are structurally non-functional in production.**
- **Component:** `services/protocols/src/matter-driver.ts`, `dali-driver.ts`, `zigbee-driver.ts`; wiring in `services/gateway/src/bootstrap.ts`, `native-driver-factory.ts`.
- **Impact:** Three advertised protocols cannot connect to any real device out of the box — a customer enabling any of them gets an honest error, not a working feature.
- **Recommended fix:** Wire real controller/bus implementations (`@matter/main` for Matter, a real DALI gateway client, `zigbee-herdsman` for native Zigbee) into `bootstrap.ts` and `native-driver-factory.ts`, matching the pattern already proven for Sonos/Modbus.
- **Complexity:** High (Matter especially — a full `@matter/main` integration is substantial).
- **Dependencies:** None blocking, but should be sequenced deliberately (per the user's own stated phasing preference) rather than bundled with unrelated feature work.

**C4. Production hardening check misses the default-admin-account risk.**
- **Component:** `services/gateway/src/config.ts:307–321` (`assertSecureConfig`), `services/gateway/src/context.ts:474–493`.
- **Impact:** A production deployment with `SUPREME_SETUP_WIZARD=0` silently gets a Master account at a hardcoded, source-visible password, with zero warning.
- **Recommended fix:** `assertSecureConfig()` must reject `setupWizard=false` in production (or require an explicit, deliberate override flag).
- **Complexity:** Low.
- **Dependencies:** None.

**C5. Zero verified evidence of performance/scale at any real device count.**
- **Component:** `tools/loadtest`, `.github/workflows/loadtest.yml`.
- **Impact:** The platform's readiness for real residential/commercial installs (claimed target: 100s–1000s of devices) is completely unproven; the one CI job meant to prove it is broken and has been for its entire run history (32/32 failures).
- **Recommended fix:** Fix the broken pnpm invocation, get the heavier run actually executing in CI, then extend the harness to simulate device/entity *count* (not just concurrent users) at 100/500/1000/5000 scale.
- **Complexity:** Medium.
- **Dependencies:** None blocking, but should precede any commercial scale claim.

### High

**H1. AirPlay, SIP, Tuya, and Ajax have no real production control transport wired — `connect()` throws.**
- **Component:** respective driver files; `bootstrap.ts`.
- **Impact:** Capabilities are mapped and appear in the UI but are non-functional at runtime.
- **Fix:** Wire real client libraries per protocol (pattern already proven for Sonos via `node-sonos`).
- **Complexity:** Medium–High per protocol.
- **Dependencies:** None.

**H2. Driver plugins run fully in-process with no isolation boundary.**
- **Component:** `services/gateway/src/native-driver-factory.ts` and all of `services/protocols`.
- **Impact:** A compromised or buggy driver has the same privileges as the gateway core — secrets, DB, every other driver.
- **Fix:** Process- or worker-thread-level isolation with a restricted capability surface.
- **Complexity:** High (architectural).
- **Dependencies:** None, but large enough to warrant its own dedicated phase.

**H3. Driver/integration secrets stored as plaintext JSON in Postgres.**
- **Component:** `installed_drivers.config`, `home_config` tables.
- **Impact:** DB or backup compromise exposes every driver credential in clear text.
- **Fix:** Envelope-encrypt secret fields at rest.
- **Complexity:** Medium.
- **Dependencies:** Should be sequenced with C2 (backup key) since both touch the backup/secret-handling surface.

**H4. No scheduled/automatic health monitoring.**
- **Component:** `infra/native-linux/health-check.sh`.
- **Impact:** A degraded/failed service between manual runs goes undetected.
- **Fix:** Add a systemd `.timer` unit (or cron entry) with an alerting hook.
- **Complexity:** Low.
- **Dependencies:** None.

**H5. Update rollback cannot survive `SIGKILL`/lost SSH session.**
- **Component:** `infra/native-linux/update.sh`.
- **Impact:** An interrupted update can leave the hub in a state only `recover.sh` (manual) can fix.
- **Fix:** A supervising wrapper or systemd transient-unit pattern with its own crash detection, independent of the bash `ERR` trap.
- **Complexity:** Medium–High.
- **Dependencies:** None.

**H6. No schema-level migration rollback.**
- **Component:** `services/persistence/src/migrate.ts`.
- **Impact:** A failing migration leaves prior migrations committed with no automatic reversal; recovery is a full DB restore, far coarser than the actual failure.
- **Fix:** Wrap update-time migrations in a single transaction where possible, or add down-migrations.
- **Complexity:** Medium.
- **Dependencies:** None.

**H7. `apps/web-installer` is missing restore, driver config/update, and floor/automation/scene UI.**
- **Component:** `apps/web-installer`.
- **Impact:** An installer using only the dedicated app cannot complete a full site setup or disaster recovery without switching to the homeowner app, whose access boundary for a field installer is undocumented.
- **Fix:** Either bring the missing functionality into `web-installer`, or explicitly document and enforce which app installers are meant to use for which task.
- **Complexity:** Medium.
- **Dependencies:** None.

**H8. No networking configuration UI/API anywhere.**
- **Component:** installer apps + native-linux deployment.
- **Impact:** Installers must configure the OS network out-of-band via terminal access — inconsistent with an "appliance" commercial positioning.
- **Fix:** OS-level network integration (e.g., netplan) exposed through a gateway route + installer UI.
- **Complexity:** Medium–High.
- **Dependencies:** None.

**H9. No factory reset or broken-install recovery UI.**
- **Component:** `factory-reset.sh`, `recover.sh`.
- **Impact:** Both are CLI/SSH/root-only — a field technician without terminal access cannot reset or recover a broken hub.
- **Fix:** Gateway routes + UI wrapping both scripts with appropriate confirmation/authorization.
- **Complexity:** Medium.
- **Dependencies:** Should follow C4 (production hardening) since factory reset is a sensitive, high-privilege action.

**H10. Diagnostics gaps: NATS health has no accessor at all; Voice assistants have no diagnostics surface; Scenes/Commissioning compute real failure data that never reaches the UI.**
- **Component:** `services/messaging/src/event-bus.ts`; `cloud/voice`; `services/homekit`; `services/scenes`; `apps/web-installer/src/pages.tsx` (discards `driverResults`).
- **Impact:** Several classes of production failure are invisible without a source-code read or log dive — directly contradicts the "diagnosable without reading source" goal.
- **Fix:** Mostly wiring existing service-layer data to a route/UI, not new engineering — low-medium effort per gap.
- **Complexity:** Low–Medium per gap.
- **Dependencies:** None.

### Medium

**M1.** Two parallel KNX drivers registered under the same `"knx"` protocol string; the live command-routing driver lacks the reconnect/diagnostics machinery that exists only on the unused discovery-only driver. *(Complexity: Medium — consolidate onto one driver.)*

**M2.** `supreme-gateway.service` treats NATS/Mosquitto/Redis as `After=`-only, not `Requires=`; no ordering dependency on `supreme-homeassistant.service`. *(Complexity: Low — unit file edit.)*

**M3.** Personal API tokens (`sup_pat_*`) never expire. *(Complexity: Low — add TTL field.)*

**M4.** WebAuthn omits the RP-ID-hash check and doesn't verify `signCount` monotonicity. *(Complexity: Low.)*

**M5.** Weak default password policy (8-char minimum, no complexity requirement). *(Complexity: Low.)*

**M6.** Non-virtualized device/room lists plus a monolithic live-state React Context that re-renders every consumer on every single device update. *(Complexity: Medium — virtualize lists, split/scope the context.)*

**M7.** No verified backup of Caddy's TLS/internal-CA state; relies on an unverified on-demand-reissue assumption. *(Complexity: Low — verify and document, or add explicit backup.)*

**M8.** No schema-version compatibility check on restore — an incompatible/stale backup can be applied without a gate. *(Complexity: Low–Medium.)*

**M9.** No connection-pool tuning for Postgres (untuned node-postgres default at any scale). *(Complexity: Low.)*

### Low

**L1.** NATS and Mosquitto run without authentication (disclosed tradeoff, relies on network isolation only). *(Complexity: Medium if adding auth.)*

**L2.** MQTT/DALI/Modbus drivers accept any capability at `bind()` time without validation, failing only later at first command. *(Complexity: Low.)*

**L3.** Apple TV Python bridge is entirely absent from the native-linux deployment (a documented, deliberate gap) — Apple TV control unavailable on that path today. *(Complexity: Medium — port the Docker-Compose bridge service to a native-linux systemd unit.)*

**L4.** `mqtt-driver.ts` registers a `"message"` handler but never an `.on("error", ...)` handler — unverified whether this is a live crash risk. *(Complexity: Low — add the handler, verify.)*

---

## Final Production Readiness Score

**3.6 / 10 — Pre-Production.**

This score is the unweighted mean of the 9 Commercial Competitiveness categories (3.78),
adjusted down slightly to reflect that the two most severe findings — the unmerged
architecture fork (C1) and the non-functional backup/restore path (C2) — are not
adequately captured by any single category average; both are cross-cutting "the platform
cannot currently be said to have one coherent, recoverable production state" facts that
weigh on the overall number more than a single 1-10 line item can show.

**What "3.6" means in practice**: SupremeOS is not a demo or a prototype — large parts of it
(security, several drivers, the systemd deployment hardening, the capability architecture)
are built to a standard that would be genuinely competitive if integrated and finished. But
it is not yet a shippable commercial automation controller. The path from here is legible
and mostly evidence-gathering-and-wiring work rather than a fundamental redesign — which is
itself a meaningfully different, better position than "3.6" might suggest in isolation.
Closing the 5 Critical blockers (C1–C5) would be the correct next-phase scope before any
further feature work, exactly as the user's own closing note in the audit brief anticipated.

---

## Appendix: Cross-reference to prior audit work

This audit builds on, and does not repeat or contradict, three prior sessions' work on this
branch:
- `docs/architecture/Native-Backend-Implementation.md` — made Home Assistant a genuinely
  optional compatibility adapter (the `HaUnavailableAdapter`/`OwnershipRegistry` side of the
  C1 fork described above).
- `docs/architecture/SupremeOS-Core-Capability-Audit.md` — the full capability-fabrication
  audit this session's driver findings extend (e.g., the KNX dual-driver duplication was
  first flagged there).
- `docs/architecture/SupremeOS-Core-Capability-Audit-Phase1-Fixes.md` — fixed 5 specific
  fabrication bugs (sensor sheet, SIP lock, KNX fan capability, Matter silent device drop,
  voice-platform empty-capability sync). This audit's driver/diagnostics passes independently
  re-confirmed all 5 fixes are still present and did not find any new instance of that same
  fabrication pattern.

Also cross-referenced: `infra/native-linux/`'s own self-audits
(`Native-Linux-Deployment.md`, `Native-Linux-Appliance-Readiness-Report.md`) and
`docs/architecture/Casambi-Final-Hardware-Validation-Report.md` and
`docs/architecture/avr-framework-production-audit.md`, both of which this audit found to be
honest, evidence-scoped prior self-assessments consistent with this document's findings —
not superseded, but reinforced.

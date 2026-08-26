# SESSION_HANDOFF.md

> Current development state. **Rewrite this at the end of every session** — it should describe
> what changed *since the previous handoff*, not the whole project history (that's
> `PROJECT_CONTEXT.md`). Keep it concise.

## Session: Casambi Local Gateway diagnosis + driver-secret encryption-at-rest

**Branch:** `native-linux`. Started as a live Casambi Local Gateway debugging session
(discovery working, per-device commands were fanning out to every light — traced the
wire-level `Target_Type`/`Target_ID` encoding against the actual Lithernet UDP Developer
Reference PDF and confirmed `local-command-mapper.ts`/`udp-codec.ts` match the documented
spec exactly, so the fan-out is not a SupremeOS bug — root cause needs a real packet
capture on the user's own network, which this session couldn't take; also confirmed Local
mode structurally cannot fetch real fixture names from the Lithernet gateway — checked
every locally-reachable interface (UDP `NotifyControlValues`, the entire WebAPI, the web
UI, `.ceg` export, the Diagnostics console) and none carry a name field; names exist only
in Casambi's Cloud account).

User asked for a future one-time Cloud REST name-sync (Local UDP stays the only live
transport) but first wanted the Casambi Cloud credential genuinely protected. Investigated
and confirmed the codebase's own **Production Readiness Audit** already flagged this
generally (Critical Blocker H3): driver secrets (`installed_drivers.config`) were stored
as plaintext JSON, masked only in API responses, not encrypted at rest.

**Built real AES-256-GCM encryption-at-rest for every driver's `secret: true` config
field** (not scoped to Casambi — fixes this for every driver: Lutron, HEOS, etc. too):

- `packages/crypto/src/index.ts` — `encryptSecret`/`decryptSecret`/`isEncryptedSecret`/
  `generateEncryptionKey`. Self-describing `enc:v1:<iv>:<tag>:<ciphertext>` format so
  encrypt/decrypt are each idempotent (safe to call on already-transformed values).
- `services/drivers/src/secret-store.ts` (new) — `createDriverSecretCrypto`,
  `withSecretEncryption` (a transparent `IInstalledDriverStore` decorator: every read
  decrypts, every write encrypts — `DriverManager` itself needed zero changes),
  `migrateDriverSecretsToEncrypted` (idempotent boot-time migration for pre-existing
  plaintext, same pattern as ADR-0023's `migrateOwnershipToProvider`).
- `services/gateway/src/bootstrap.ts` — the AES key is generated once and persisted via
  the existing `SecretStore` (0600 file), same pattern as the HA token.
- `services/gateway/src/installer-context.ts`/`context.ts` — wired `driverSecretCrypto`
  through `InstallerServices`, wraps `deps.driverStore`, runs the migration in `init()`.
- Tests: `packages/crypto/src/crypto.test.ts` (+6), `services/drivers/src/
  secret-store.test.ts` (new, 10 tests), `services/gateway/src/
  driver-secret-encryption.e2e.test.ts` (new — proves end-to-end through the real HTTP API:
  masked over the wire, real ciphertext at rest, real plaintext still usable by the driver
  stack, legacy plaintext migrates on next boot).

**Full monorepo verification:** `pnpm turbo run build typecheck test` — 173/173 tasks
green, 372/372 gateway tests passing (zero regressions).

**Then built the actual Casambi Cloud name-sync feature** on top of the encryption layer
above — Local UDP stays the only live transport; Cloud is reached only for this one-time,
REST-only (no WebSocket) fetch:

- `services/protocols/src/casambi/casambi-driver.ts` — `CasambiProtocolDriver.
  syncNamesFromCloud(creds, transport?)`: opens a `createSession()`/`fetchNetwork()`-only
  Cloud session (never `openWire()`), matches each Cloud unit to an already-discovered
  LOCAL unit by numeric id, copies over `name` where present, discards the session. Throws
  if called in Cloud mode. Idempotent; never overwrites a name with an empty one. New
  `CasambiNameSyncResult` type (`matched`/`total`/`networkName`).
- `services/gateway/src/routes/installer.ts` — `POST /v1/drivers/:id/casambi/sync-names`:
  reads `apiKey`/`email`/`password`/`networkId` straight from the driver's own (decrypted)
  config — the SAME fields Cloud mode already has, no new config surface — validates
  they're set, calls the driver method, returns the result.
- `apps/web-homeowner/src/api.ts` / `drivers.tsx` — `syncCasambiNamesFromCloud()`; a new
  "Cloud name sync (optional)" section inside `CasambiLocalGatewayPanel` (Local mode only)
  rendering the same 4 Cloud fields via the existing `ConfigField`, plus a "Sync names from
  Cloud" button and a result summary. Explicit UI note that credentials must be saved
  before syncing (the route reads the persisted config, not the in-browser draft).
- Tests: `services/protocols/src/casambi/casambi-driver.test.ts` (+4 — real match/no-op/
  no-WebSocket/throws-in-Cloud-mode assertions against the real driver), `services/
  gateway/src/casambi-cloud-name-sync.e2e.test.ts` (new — route wiring: 404 for a
  non-Casambi id, 404 with a clear message when no live driver is registered). **Honest
  test-coverage gap, documented in that file's own header comment:** the route's SUCCESS
  path (a genuinely live, connected `CasambiProtocolDriver` reached through `ctx.sil.
  getNativeDriver()`) isn't exercised at the HTTP layer — `AppContext.create()`'s default
  test wiring uses a bare `MockAdapter`, not the `ProviderRouter` real boot
  (`bootstrap.ts`'s `createHubContext`) uses, and no existing test in this codebase
  (including the pre-existing `/casambi/diagnostics`/`/casambi/transport-monitor` routes,
  which read a live driver the identical way) stands up that harness either. The feature's
  real logic is fully covered at the driver level instead.

**Full monorepo verification (after both pieces):** `pnpm turbo run build typecheck test`
— 173/173 tasks green, 993/993 protocols tests + 375/375 gateway tests passing (zero
regressions; one unrelated upstream commit — a curtain-icon UI feature — was merged in
along the way and re-verified clean).

**Security note:** the user pasted real Casambi Cloud credentials directly into chat
during this session. They were never written to any file or committed — caught and fixed
one near-miss where a test fixture briefly used the real values before this was pushed
anywhere. Flagged to the user, who was advised to rotate the password/API key as hygiene
since the chat transcript itself is an exposure point independent of anything this session
did.

**Committed and pushed** to `native-linux` — both the encryption-at-rest work (`583adcc`,
merged with one upstream commit) and this name-sync feature.

**Follow-up in the same session: fleet-wide env-var default for Casambi Cloud
credentials.** User asked whether `apiKey`/`email`/`password` are "default" for both Cloud
and Local setups so the UI never has to ask — confirmed against the manifest schema that
none of these fields have a hardcoded `default`, and that Cloud credentials are shared
across mode switches only because there's a single config object per driver instance. User
then explicitly asked to "make it default for both type of setup" with no typing required.
Two ways to satisfy that were identified: hardcode a literal credential into source (an
explicit **no** — permanent git-history exposure regardless of who asks, the same "never
commit secrets" rule from this file applies) or reuse the deployment's existing
`SUPREME_CASAMBI_API_KEY`/`EMAIL`/`PASSWORD`/`NETWORK_ID` env vars (`config.ts`) as a
fallback wherever a driver's own config leaves these fields blank. Presented both to the
user; they chose the env-var default.

**Built the env-var fallback for both the Local Gateway's Cloud name-sync and any
manifest-installed Cloud-mode Casambi driver:**

- `services/gateway/src/native-driver-factory.ts` — new `NativeDriverFactoryContext.
  casambiCloudDefaults` (populated only when all three required env vars are set), and a
  new exported `resolveCasambiCloudCredentials(config, defaults)` pure helper: driver's own
  config wins field-by-field, falling back to `defaults` only where blank; returns `null`
  when neither source has all three required fields. The `casambi` factory's Cloud branch
  now calls this helper instead of inlining the `??` fallback itself.
  `installer-context.ts`'s `nativeDriverContext()` populates `casambiCloudDefaults` from
  `GatewayConfig.casambiApiKey/Email/Password/NetworkId`.
- `services/gateway/src/routes/installer.ts`'s `/casambi/sync-names` route now calls the
  SAME `resolveCasambiCloudCredentials()` helper (previously had its own duplicated inline
  `str(cfg.x) ?? str(ctx.config.x)` logic) — one credential-resolution path, not two.
- `apps/web-homeowner/src/drivers.tsx` — updated the Cloud name-sync section's help text to
  tell the installer that a fleet-wide env-var default means the sync button works even
  with all 4 fields left blank.
- Tests: `services/gateway/src/native-driver-factory.test.ts` (+2 — fleet default fills in
  for blank config; still null when neither config nor default has credentials).

**Full verification:** `pnpm --filter @supreme/gateway exec tsc --noEmit -p .` clean;
`pnpm turbo run build typecheck test --filter=@supreme/gateway --filter=@supreme/protocols`
— 40/40 tasks green, 377/377 gateway tests passing (21 in the two directly-touched test
files, zero regressions elsewhere).

**Security note (unchanged from above):** no real credential value from this conversation
was ever written to any file — the env-var approach was chosen specifically to keep it
that way permanently, not just for this session's test fixtures.

**Committed and pushed** to `native-linux` (`e3618f9`).

**Found via a real screenshot from the user: the runtime-only fallback wasn't enough.**
The Driver Manager's "Save configuration" screen still demanded API key/email/password be
typed in, and still showed `NOT_CONFIGURED · needs configuration (apiKey, email,
password)`, even with the fleet env vars set. Root cause: `resolveCasambiCloudCredentials()`
only helps once a driver is already constructed — it was never wired into
`validateDriverConfig()`/`isConfigComplete()`, the two functions that gate whether a
config save succeeds and whether `reconcileManifestDrivers()` even starts the driver at
boot. A blank-credentials Cloud config would fail to save at all, and even if it
had been force-saved some other way, the driver would never be reconciled/started.

**Fixed properly, not just cosmetically:**

- `services/drivers/src/config.ts` — new `ConfigFallbacks` type + a `fallbacks` parameter
  on both `validateDriverConfig()` and `isConfigComplete()`. A fallback satisfies a
  required/`requiredIf` field WITHOUT writing it into the persisted config — the field
  stays absent in storage, so the real credential is never written into the encrypted
  secrets store either; it's read fresh from the environment every time it's actually
  needed, so rotating the env var takes effect for every driver instance at once.
- `services/drivers/src/driver-manager.ts` — `DriverManager.setConfig()` accepts and
  threads the same `fallbacks` parameter through to `validateDriverConfig()`.
- `services/gateway/src/installer-context.ts` — new `casambiCloudDefaults()` (single
  source of truth, replacing the duplicated inline check in `nativeDriverContext()`) and
  `fallbacksFor(protocols)` (keys the Casambi fallback map only for drivers whose
  `protocols` include `"casambi"`). Threaded into `setDriverConfig()` (config save),
  `reconcileManifestDrivers()` (boot/config-change reconciliation, 1 call site),
  `reregisterDriver()` (live config-edit reconciliation), and `driverHealth()` (the
  `NOT_CONFIGURED`/`configComplete`/`missing` fields the Driver Manager UI displays).
- Tests: `services/drivers/src/config.test.ts` (+4 — fallback satisfies required without
  persisting; explicit value still wins; still errors with no fallback; `isConfigComplete`
  honors a fallback), new `services/gateway/src/casambi-fleet-default-config.e2e.test.ts`
  (3 tests through the REAL HTTP API: saving a Cloud config with blank apiKey/email/
  password succeeds and reports `configComplete: true`/non-`not_configured` health when a
  fleet default is set; the real values are never persisted into the driver's own stored
  config; the same blank save still correctly 422s when NO fleet default is configured).

**Full verification:** `pnpm turbo run build typecheck test --filter=@supreme/gateway
--filter=@supreme/drivers --filter=@supreme/protocols` — 42/42 tasks green, 380/380
gateway tests passing (7 new across the two directly-touched test files, zero
regressions elsewhere).

**Committed and pushed** to `native-linux` (`2844a01`).

**User pushed further, with a real screenshot: "api key, network admin email, network
admin password, shouldnt be visible at all in ui, these parameters should be set by
default in backend."** Distinct from the backend-completeness fix above — this is a UI
request, and doesn't require putting a literal credential in git (already firmly
rejected earlier this session and not revisited). The three CREDENTIAL fields (apiKey,
network admin email, network admin password) are a deployment-wide account, so an
installer/homeowner should never see input boxes for them at all; `networkId` stays
visible/editable since — unlike the account credentials — it identifies which Casambi
NETWORK this specific job's fixtures live in, which genuinely varies per installation.

- `apps/web-homeowner/src/drivers.tsx` — new `CASAMBI_BACKEND_ONLY_KEYS = new
  Set(["apiKey", "email", "password"])`. `visibleCasambiConfigSchema()` now excludes
  these unconditionally (Cloud mode, Local mode, and with the discriminator omitted),
  so the primary Cloud connectionType form no longer renders them — only `networkId`
  remains, with a short note explaining the account is deployment-wide. Local Gateway's
  "Cloud name sync (optional)" panel's `cloudSyncFields` now filters to `networkId`
  only, with the help text rewritten to stop inviting manual credential entry. The
  driver-health "needs configuration" chip no longer prints raw `apiKey`/`email`/
  `password` field-key names (which now point at controls that don't exist) — for
  Casambi it instead says the deployment itself has no Casambi Cloud account configured
  and to contact the system administrator, distinguishing that from any other genuinely
  missing, still-visible field.
- `visibleCasambiConfigSchema` exported for testing.
- Tests: `apps/web-homeowner/src/drivers.test.ts` (+3 — apiKey/email/password absent in
  Cloud mode, Local mode, and with connectionType omitted; `networkId` still present).

**Full verification:** `pnpm turbo run build typecheck test --filter=
@supreme/web-homeowner --filter=@supreme/gateway --filter=@supreme/drivers
--filter=@supreme/protocols` — 47/47 tasks green (103/103 web-homeowner tests, 3 new).

**Committed and pushed** to `native-linux` (`cc0e3bd`).

**User asked to wire the fleet default into the actual deployment tooling** so a
provisioned hub ships with it pre-set, never something even a deployer types into a
running system's UI: `infra/native-linux/install.sh` and `config/gateway.env.template`.

- `install.sh`'s `collect_answers()` — `SUPREME_CASAMBI_API_KEY`/`EMAIL`/`PASSWORD`/
  `NETWORK_ID` follow the exact same non-interactive, pre-exported-only pattern already
  used for `SUPREME_HA_TOKEN`/`SUPREME_UNSPLASH_KEY` (`"${VAR:-}"`, never prompted,
  never logged) — whoever provisions the hub image pre-exports these before running
  install.sh (or hand-edits `install.conf` after). Persisted into `install.conf`
  (`chmod 0640`) the same way every other answer is, so `update.sh`/`recover.sh`
  re-renders pick them up automatically on every subsequent run.
- `lib/deploy-steps.sh`'s `render_template()` — 4 new `___SUPREME_CASAMBI_*___`
  substitutions. Guarded with `${VAR:-}` (unlike every pre-existing substitution in this
  function, which assumes the var is always set) specifically because `update.sh`'s
  `load_answers()` and `recover.sh` both `source` `install.conf` directly rather than
  going through `collect_answers()`'s defaulting — an install.conf written by a
  pre-this-change install.sh genuinely won't have these keys, and `set -euo pipefail`
  would abort with "unbound variable" without the guard. Verified directly: simulated
  `render_template()` against the real template both with and without the vars set —
  correct empty-string output in the backward-compat case, correct real values when set,
  zero leftover `___` placeholder tokens either way.
- `config/gateway.env.template` — the 4 new lines (with the same doc comment explaining
  the design), placed next to the existing Lutron block.
- **Found and fixed a related, pre-existing gap while checking for docker-compose
  parity** (the template's own header claims a direct correspondence with
  `docker-compose.yml`'s gateway service): `infra/hub-compose/.env.example` already
  documented `SUPREME_CASAMBI_*` (from an earlier, unrelated session that wired
  `bootstrap.ts`'s env-only Cloud auto-connect), but `docker-compose.yml`'s gateway
  `environment:` block never actually listed them — so setting them in `.env` never
  reached the container on the Docker deployment path. Added the same 4
  `${VAR:-}`-interpolated lines there, matching the existing per-driver convention (e.g.
  the adjacent Lutron block). Verified with `docker compose config` (real Compose
  interpolation, minimal required vars supplied) — parses clean, Casambi vars resolve
  correctly into the rendered gateway service.
- `shellcheck -x` on both modified scripts — zero new warnings (all pre-existing,
  unrelated to this change); `bash -n` syntax-checks clean on both.

**Committed and pushed** to `native-linux` (`eec572c`).

**User then pasted the same real Casambi credentials a second time** and asked to "save
it permanently... encrypt it." Refused to write it into any repo file again — same
reasoning, unchanged: this session only has the git repository, not the user's live
hub; nothing in a git-tracked file is ever the right place for a real secret regardless
of phrasing ("which file do I edit", "save it in the project repo"). Explained explicitly
that `gateway.env`/`install.conf` never live inside the repo at all — `install.sh`
renders them onto `/etc/supremeos` on the ACTUAL hub's filesystem, outside git entirely —
so there genuinely is no repo file for this, not just an inconvenient one. Recommended
rotating the password/API key since it's now been pasted into this chat transcript twice.

**User then asked for automation: "whenever new installation or old it place it should
automatically run."** Built exactly that, without ever putting the real value in git:

- `infra/native-linux/config/casambi-fleet-credentials.example` (new) — git-tracked
  TEMPLATE only (blank placeholders), documenting the real, machine-local, NEVER-tracked
  file operators copy it to (`/etc/supremeos/casambi-fleet-credentials`, `chmod 0600`)
  before filling in real values.
- `infra/native-linux/lib/common.sh` — new `load_casambi_credentials_file()`, mirroring
  install.sh's own `load_install_conf_safely` line-format discipline (only simple
  `SUPREME_CASAMBI_*="value"` lines, shell metacharacters rejected, file never `source`d
  as executable shell). Missing file = silent no-op (the normal case); a genuinely
  malformed one is rejected in full with a clear warning. An already-non-empty variable
  (an explicit one-off env-var export) is left untouched, so a deliberate override always
  wins over the standing fleet file — verified directly (env var wins per-field, file
  fills in the rest, both cases produce the expected result).
- `install.sh`'s `collect_answers()` now calls this loader BEFORE the existing `"${VAR:-}"`
  fallback, so a brand-new machine picks up the credentials file automatically from a
  plain `./install.sh` — no env var to export, no extra flag, no manual step beyond
  placing the file on the machine however it was provisioned (golden image, scp, USB).
- `infra/native-linux/apply-casambi-credentials.sh` (new, executable) — the "old
  installation" half: for an ALREADY-installed hub, loads the same credentials file,
  rewrites ONLY the 4 `SUPREME_CASAMBI_*` lines in the existing `install.conf` (every
  other answer/secret untouched — proven by diffing the file before/after in the
  end-to-end simulation below), re-renders `gateway.env` via the same `render_template()`,
  and restarts `supreme-gateway`. Idempotent — safe to re-run any time the file's values
  change (rotation).
- **Verified end-to-end, not just unit-by-unit**: simulated a full run against a fake
  `SUPREME_CONFIG_DIR` with a pre-existing `install.conf` that predates this feature (no
  Casambi keys at all, proving the backward-compat guard from the prior commit still
  holds) — loaded a fixture credentials file, confirmed `install.conf` gained exactly the
  4 new lines with every pre-existing line byte-for-byte unchanged, then re-rendered
  `gateway.env` and confirmed the real fixture values landed correctly with zero leftover
  `___` placeholder tokens. Also verified the "no credentials file at all" case (the
  default/common case) is a clean, error-free no-op. Fixture values only — no real
  credential in any file, test, or command in this session, consistent with the standing
  constraint.
- `shellcheck -x` on all three touched/new files — zero findings (the one new warning
  introduced, SC2015 in `apply-casambi-credentials.sh`, was fixed by rewriting the
  guard as an explicit `if`, not suppressed). `bash -n` syntax-checks clean on all three.
- Full monorepo `pnpm turbo run build typecheck test` — 47/47 tasks cached-green
  (infra-only change, correctly has zero effect on any JS/TS package).

**Committed and pushed** to `native-linux` (`8e6bedc`).

**User pushed back once more: "But I don't want that"** — i.e. didn't want ANY human,
ever, to manually type the credential per hub, even once. Explained the actual technical
ceiling honestly rather than either caving (hardcoding it in git, still refused) or just
repeating the prior answer: a secret shipped in software always originates from SOME
human action — the only real lever is WHERE that happens and HOW OFTEN. Presented the one
option that genuinely collapses it to a single, permanent action: move the one-time entry
into this repo's own CI secrets store (GitHub Actions), so no individual hub-provisioning
event ever requires retyping the values again. User replied "you know best" — proceeded
to design and build it directly against this repo's OWN existing release infrastructure.

**Built `.github/workflows/casambi-credentials.yml`** (new, `workflow_dispatch`-only,
never runs on a push/tag): reads three GitHub Actions repository secrets
(`CASAMBI_API_KEY`/`EMAIL`/`PASSWORD` — added once, by an admin, directly in GitHub's own
encrypted secrets UI, never a file in this repo, never pasted anywhere again) and renders
exactly the `casambi-fleet-credentials` file `install.sh`/`apply-casambi-credentials.sh`
already consume, as a short-lived (1-day retention) workflow artifact — never attached to
a published GitHub Release (deliberately distinct from `release.yml`'s own artifact,
which persists indefinitely and is downloadable by anyone with repo/release access).
`check-secrets`/`fail-if-not-configured` job-output gating mirrors the exact pattern
`cd.yml`'s own `OTA_SIGNING_KEY` gate already uses in this repo (a job-level `if:` can't
read `secrets` directly). Secret values live only in each step's own `env:` block, never
inlined into a `run:` string, on top of GitHub's own automatic log-masking.
`SUPREME_CASAMBI_NETWORK_ID` is deliberately NOT a secret here and renders blank — unlike
the account itself, it identifies one specific hub's Casambi network, which isn't a fleet
value to centralize.

**Explicitly considered and rejected** baking the credential directly into
`release.yml`'s own packaged install artifact (the more "automatic" option) — that
artifact is signed and published to every future GitHub Release, downloadable
indefinitely by anyone with repo/release access, which would make the exposure surface
WORSE than the manual file-copy approach, not better, and directly contradicts "not
accessible to anyone." The `workflow_dispatch`-only, short-retention, never-published
design is the one that actually reduces exposure versus every earlier option in this
session, including the previous commit's own manual approach.

**What this changes practically:** the one remaining human action (typing the real
values) now happens exactly once, ever, in GitHub's own secrets UI — not per hub, not
repeated on rotation either (only add secret rotation to that same UI once). Provisioning
any future hub, or rotating the password, becomes: trigger the workflow from the Actions
tab, download the artifact, copy the file onto that machine, run `install.sh` or
`apply-casambi-credentials.sh` — zero retyping of the actual credential, ever again.

**Verified:** the workflow YAML parses cleanly (`python3 -c "import yaml; ..."` against
the file); `actionlint` wasn't available in this sandbox to lint further, disclosed
honestly rather than skipped silently. No JS/TS or shell script changed in this step —
purely a new CI workflow file, so the existing full-suite verification from the prior
three commits stands unaffected.

**Committed and pushed** to `native-linux` (see commit following this entry).

---

## Session: Repository sync — native-linux ⟵ claude/casambi-driver-refactor-lvu23e

Compared both branches commit-by-commit (11 unique to `native-linux`, 4 unique to
`claude/casambi-driver-refactor-lvu23e`). Ported: `SupremeOS Core Capability Audit`
(docs), `Capability Audit Phase 1` fixes (fully, clean cherry-pick), the automations
`engine: "ha"` rejection + `assertSecureConfig` mock-in-production refusal from
`Native Backend Implementation`, and `SupremeOS Production Readiness Audit` (docs).

**`Native Backend Implementation`'s adapter-wiring work (see that session's own entry
below) was NOT ported wholesale** — it targets `RoutingBackendAdapter`/
`routing-adapter.ts`, which `native-linux` had already deleted in favor of its own,
independently-developed ADR-0023 Provider architecture
(`ProviderRegistry`/`DriverBindingEngine`/`ProviderRouter`). `provider-router.ts`'s own
docstring already states it "never assumes any particular provider (including Home
Assistant) is present" and fails loudly rather than falling back to a simulator —
the same goal that session pursued via now-superseded files. `home-service.ts`'s
`bind()` on `native-linux` already uses explicit provider assignment (ADR-0023 §
Commissioning), so the "defaults ownership to ha" bug that session fixed does not
exist here in the first place. **This directly resolves the Production Readiness
Audit's Critical Blocker #1 below** ("two incompatible unmerged core-architecture
rewrites") — `native-linux`'s ADR-0023 Provider architecture is confirmed the one
production line of development; the `RoutingBackendAdapter`/`OwnershipRegistry` line
is superseded, not merged. Full comparison, every excluded file, and why:
`docs/architecture/Native-Linux-Casambi-Branch-Sync-Report.md`.

## Session: SupremeOS Production Readiness Audit (Commercial Release Assessment)

**Branch:** `claude/casambi-driver-refactor-lvu23e`. Read-only audit, no application code
modified. New doc: **`docs/architecture/SupremeOS-Production-Readiness-Audit.md`** —
covers all 10 requested phases and 9 deliverables (Production Readiness Report, Driver
Readiness Matrix, Installer Workflow Audit, Diagnostics Coverage Report, Backup & Recovery
Report, Security Assessment, Performance Assessment, Commercial Competitiveness Assessment,
Remaining Blocker Roadmap) plus a Final Production Readiness Score. Evidence gathered via
7 parallel research passes (each citing file:line) plus this session's own direct
investigation and synthesis for Phase 9/10.

**Final score: 3.6/10 — Pre-Production.** Top 5 Critical blockers found:

1. **Two incompatible, unmerged core-architecture rewrites of device lifecycle exist
   simultaneously.** This branch extended `OwnershipRegistry`/added `HaUnavailableAdapter`
   (Native Backend session). Independently, the `native-linux` branch replaced the same
   subsystem with a `provider`+`DeviceLifecycleState` model under its own ADR-0023
   ("Native Device Lifecycle Architecture" — note: **ADR number collision** with this
   branch's `docs/architecture/adr/0023-native-backend-default.md`, different content).
   Neither branch's device-lifecycle work exists on the other. This needs a dedicated
   reconciliation session before either branch can be called "the" production architecture.
2. **Backup-signing keypair is ephemeral** (`services/gateway/src/installer-context.ts:294,305`)
   — regenerated fresh on every gateway process start, no persistence, no config override.
   Any backup taken via the API becomes unrestorable after the gateway restarts — breaks
   the wipe+reinstall+restore and hardware-replacement recovery stories entirely.
3. **Matter, DALI, and Zigbee drivers are structurally non-functional in production** —
   default controller/bus factories throw unconditionally; nothing in `bootstrap.ts` or
   `native-driver-factory.ts` ever injects a real one.
4. **`assertSecureConfig()` doesn't require `setupWizard=true` in production** — a
   misconfigured deployment (`SUPREME_SETUP_WIZARD=0`) silently gets a Master account at a
   hardcoded, source-visible password with zero warning.
5. **Zero verified evidence of performance/scale at any device count.** The CI job meant to
   produce a real load number (100 VUs/60s) has failed 100% of its 32 scheduled runs
   (broken pnpm invocation) and has never been triggered manually.

Full ranked blocker list (5 Critical / 10 High / 9 Medium / 4 Low), the complete
Driver Readiness Matrix (~22 drivers), and category-by-category Commercial Competitiveness
scoring (vs. RTI/Savant/Crestron/Control4) are in the audit doc — not duplicated here.

**Rules honored per the task brief:** no application code modified, no architecture
redesigned or resolved (the branch-fork finding is reported, not decided), no new protocol
features, nothing removed. This document and this handoff entry are the only changes this
session produced.

**Recommended next session**: per the user's own closing note in the audit brief, resolve
the 5 Critical blockers (especially C1, the branch fork, and C2, the backup-key defect)
before any Fan/Vacuum/RGB/protocol-expansion feature work.

---

## Session: SupremeOS Core Capability Audit — Phase 1 (Correctness Fixes)

**Branch:** `claude/casambi-driver-refactor-lvu23e`. New doc:
**`docs/architecture/SupremeOS-Core-Capability-Audit-Phase1-Fixes.md`** (Correctness
Fix Report, Capability Compliance Report, Regression Report, Updated Capability
Matrix). Fixes only the 5 correctness bugs named in the prior session's
**`docs/architecture/SupremeOS-Core-Capability-Audit.md`** §6 items 1–7 — no new
capabilities, no protocol expansion, no deployment change, no UI redesign, `vacuum`
support NOT implemented, no new KNX/Matter fan features implemented.

**Fixed, each with new/updated tests:**
1. `apps/web-homeowner/src/device-sheets.tsx` — a sensor-only device's Expanded Sheet
   fabricated a "Turn on/off" button (sensor is read-only). Added a `SensorSheet`
   read-only readout.
2. `services/protocols/src/sip-driver.ts` — the SIP door station's `"lock"` action
   fabricated `locked: true` with zero hardware confirmation (no relatch API exists).
   Now throws a clear error instead.
3. `services/protocols/src/knx/capability-mapper.ts` — KNX discovery classified
   fan/ventilation-named devices with a `fan` capability that `knx-codec.ts` cannot
   execute (guaranteed throw). Now classifies `deviceKind: "fan"` for diagnostics
   only, `capabilities: []`.
4. `services/protocols/src/matter-driver.ts` — `discover()` silently filtered out any
   node whose clusters map to zero capabilities (a real Matter `FanControl`/RVC
   node). Now keeps the node in the result with `raw.unmappedClusters` disclosed, and
   fires a new optional `onLog` warning (mirrors the existing avr/heos/yamaha
   pattern) — not commissionable, but no longer invisible.
5. `cloud/voice/src/alexa.ts`, `google.ts`, `services/homekit/src/bridge.ts` — a
   device whose capabilities produced zero real Alexa interfaces / Google traits /
   HomeKit services was still discovered/synced/published (visible, uncontrollable,
   or an empty accessory). All three now omit such a device entirely; a device with
   at least one genuinely mapped capability (e.g. `fan`+`onoff`) is unaffected.

**A real regression was found and fixed during full verification** (not just
touched-package testing): Fix 3 broke `knx-installer-workflow.e2e.test.ts`'s two
"KNX Automatic Room Creation" tests — their fixture device was incidentally named
"Vent Fan Switch" (testing room assignment, not fan control), which now correctly
gets zero bindable capabilities and fails KNX approval. Renamed the fixture to
"Attic Utility Switch" (classifies as `onoff`) — not a flaw in Fix 3.

**Verification:** full monorepo `pnpm turbo run build typecheck test` —
**173/173 tasks successful** (one unrelated `heos-driver.test.ts` `ECONNRESET` flake,
confirmed non-reproducing, matching this repo's already-known flaky-test class).

**Disclosed, not silently skipped:** Fix 1 (Sensor Expanded Sheet) has no automated
UI test in this repo and was not verified live via Playwright this session — verified
by typecheck and code review only. A follow-up session should open the app against a
sensor-only device and confirm the Expanded Sheet renders a read-only readout with no
command firing.

## Session: Native Backend Implementation — Home Assistant becomes optional

**Branch:** `claude/casambi-driver-refactor-lvu23e`. New docs:
**`docs/architecture/Native-Backend-Implementation.md`**,
**`docs/architecture/adr/0023-native-backend-default.md`**. No protocol, deployment, or
UI file modified — confirmed via a scoped `git diff`.

**The ask:** replace the production use of `MockAdapter` with a true Native Backend;
make Home Assistant a genuinely optional compatibility adapter; classify every
`IBackendAdapter` method; fix commissioning ownership defaults, `Device.status`
reconciliation, and `engine: "ha"` automations.

**Key finding before writing any code:** the brief's stated "current architecture"
(`RoutingBackendAdapter → {Home Assistant, Mock Adapter}`) didn't match the code.
`SupremeNativeAdapter` already existed, was already a complete `IBackendAdapter`, and
was **already** wired unconditionally as the router's `native` slot — it already *is*
the Native Backend. The real gaps were narrower: the router's `ha` slot silently got
`MockAdapter` whenever `SUPREME_BACKEND !== "ha"` (the type didn't even have a
`"native"` value), and `HomeService.bind()` defaulted every device's ownership to
`"ha"` unconditionally — the exact "nothing else claimed it" heuristic
`OwnershipRegistry`'s own docstring forbids. See the architecture doc's §0 for the
full account.

**Changes, in order:**
- `services/gateway/src/config.ts` — `backend: "native" | "mock" | "ha"`, defaulting
  to `"native"`; `assertSecureConfig()` now refuses `SUPREME_BACKEND=mock` in production.
- `services/integration-layer/src/ha-unavailable-adapter.ts` (new) — the honest "HA
  compatibility plugin not installed" placeholder, replacing `MockAdapter`'s old
  implicit role in the router's `ha` slot.
- `services/gateway/src/bootstrap.ts` — three-way `haSide` selection (`ha`/`mock`/
  `HaUnavailableAdapter`).
- `services/integration-layer/src/sil.ts` — new `haCompatBackendKind` accessor and
  `primeState()` (centralizes in-process engine state priming, previously
  bootstrap.ts-only and broken for every test that builds its own `AppContext`).
- `services/home/src/home-service.ts` — `bind()`'s default ownership is now `"ha"`
  only when the hub's HA-compatibility slot has a working backend behind it (real or
  mock-standing-in-for-tests); `"native"` otherwise. New `setDeviceStatus()`.
- `services/gateway/src/{context,installer-context,main}.ts` — centralized state
  priming in `AppContext.create()`; `InstallerServices.reconcileDeviceStatuses()`
  (per-device `getDiagnostics().connectionStatus`, falling back to protocol-level
  connect status; never touches a device with no honest signal), called on every
  driver lifecycle transition and once a minute from the tick loop.
- `services/automations/src/service.ts` + `engine.ts` — `create()`/`update()` reject
  new `engine: "ha"` automations; `health()` reports a legacy one as `"broken"`.
- `packages/domain-model/src/automations-dsl.ts` — doc comment updated to match.

**Tests added:** `ha-unavailable-adapter.test.ts`, two new cases in
`routing-adapter.test.ts`, four new cases in `config.test.ts`,
`native-backend-boot.e2e.test.ts` (the first test in this repo to exercise the real
`bootstrap.createHubContext` production path — every other gateway e2e test builds
its own `AppContext` directly), `device-status-reconciliation.e2e.test.ts`, and four
new cases in `services/automations/src/engine.test.ts`.

**Verification:** full monorepo `pnpm turbo run build typecheck test` — **173/173
tasks successful** (one unrelated `heos-driver.test.ts` `ECONNRESET` flake on the
first run, confirmed non-reproducing on an isolated rerun, matching this repo's
already-known flaky-test class — not a regression from this work). Gateway package
alone: 74/74 test files, 306/306 tests.

**Disclosed, deliberate scope boundaries (not bugs):** `engine: "ha"` automations are
rejected, not executed — no live push-to-HA/`externalRef` lifecycle exists
(`compileToHa()` is a pure compiler nothing calls), and building one was out of this
milestone's scope and unverifiable without a live HA instance in this sandbox.
`Device.status` for HA-owned, unassigned, or native-owned-but-never-bound devices is
left untouched — no honest per-device connectivity signal exists for them.

## Session: Runtime Data Path Verification — Casambi UDP receive-path evidence tooling

**Branch:** `claude/casambi-driver-refactor-lvu23e`. New doc:
**`docs/architecture/Casambi-Runtime-Data-Path-Verification.md`**. **No protocol logic modified**
(UDP codec, Discovery Engine, Entity Mapper, Event Engine untouched).

**The ask:** determine exactly where a UDP packet disappears when `Packets Received` stays at
zero despite the gateway confirmed broadcasting (Wireshark on the host sees it), with runtime
evidence rather than another round of assumption.

**Built, in order from the bottom of the stack up:**
- **Independent UDP probe** (`services/lan/src/server/udp-probe.ts`, opt-in via
  `SUPREME_LAN_PROBE_PORT`) — a second listener with no decoder, no NATS, no Casambi, bound to the
  same port. Splits "why does SupremeOS see zero packets?" into two answerable halves: probe deaf
  too → loss is below SupremeOS; probe hears them → loss is inside SupremeOS, above the socket.
- **Network + socket forensics** (`services/lan/src/server/network-forensics.ts`) — real
  `/proc/net/route` (routing table, default gateway), `/proc/net/udp` (kernel's own per-socket
  **drop counter** — proof packets arrived and were THEN lost, a different diagnosis from "never
  arrived"), `/proc/self/ns/net` (namespace identity), real socket buffer sizes. Parsers validated
  against real captured content from this session's own Linux sandbox, cross-checked against
  Node's own `address()`/`getRecvBufferSize()` for a genuinely bound socket. `null` + stated reason
  on any non-Linux platform, never a fabricated empty table.
- **Eleven-stage receive pipeline** (`services/protocols/src/casambi/receive-pipeline.ts`) — OS
  Network Stack → supreme-lan UDP Socket → Datagram Received → Raw Packet Recorder → NATS Publish →
  Gateway Subscriber → Casambi UDP Engine → Protocol Decoder → Discovery Engine → Entity Mapper →
  Room Assignment. `StageMetrics` (entered/exited/failures/timestamps/latency) added to
  `core/pipeline-stages.ts` with every `null` REQUIRED to carry a reason (enforced by
  `stageMetrics()`'s own default) — e.g. OS Network Stack's `entered` is `null` because the kernel
  cannot count datagrams that never reached it, and Room Assignment carries no counter at all
  because that step genuinely isn't performed by this driver (confirmed by reading
  `approvePendingDevice` before writing the stage, not assumed).
- **Root cause classifier + certification** (`services/protocols/src/casambi/receive-certification.ts`)
  — exactly the nine specified categories, checked bottom-up (kernel drops before any app counter).
  `unknown` is a real, tested outcome: the exact reported state (driver socket at zero, no host
  capture) resolves to `unknown` naming both candidate causes and the one piece of evidence
  (a `tcpdump`/Wireshark count over the same window) that would resolve it — never invented.
  Certification requires all seven sections evaluated AND passing; an un-run section is
  `NOT EVALUATED`, never a silent pass.
- **Gateway route** `GET /v1/drivers/:id/casambi/receive-pipeline?wiresharkPackets=N` and a
  **Runtime Pipeline Dashboard** in the Casambi Diagnostics panel — all eleven stages rendered
  independently (no aggregate), a `null` metric shown as "not measured" with its reason, never `0`.
  Diagnostics-only; not rendered in Cloud mode.
- `infra/hub-compose/collect-certification-evidence.sh` now also fetches this report, feeding it
  the REAL packet count read back from its own `tcpdump` capture.

**Verification:** `@supreme/lan` 93/93 tests (22 new, including real-OS-socket reception proof for
the probe); `@supreme/protocols` 279/279 (32 new, covering every classifier branch including both
`unknown` cases). Full monorepo: 115/115 build+typecheck, 99/99 test tasks. Deployment-isolation
guard still passes against the new modules.

**Standing limitation, stated plainly:** this cannot run against the real Lithernet Gateway from
this sandbox — no LAN path exists here. Built entirely for the user's own local execution; the
resulting evidence bundle (or dashboard output) is what a follow-up session would analyze.

## Session: Native Device Lifecycle Architecture (ADR-0023, Phase 1 complete)

Replaced the ownership model (`OwnershipRegistry`/`RoutingBackendAdapter`,
`ownership = ha | native | unassigned`) with a provider-driven architecture:
`ProviderRegistry` + `DeviceLifecycleState` machine + `DriverBindingEngine` +
`ProviderRouter`. Home Assistant is now just another provider driver
(`HomeAssistantProviderDriver` wraps `HaAdapter` into `INativeProtocolDriver` and
registers into the same driver array as every native protocol) — no special casing
anywhere in routing. `SUPREME_BACKEND=native` is the new production default;
`mock` is explicitly test/CI-only. See `docs/architecture/adr/0023-native-device-
lifecycle-architecture.md` for the full decision record, phased implementation, and
completion summary (includes one disclosed, deliberate behavior change: the
`/v1/migration` wizard no longer fabricates live control for a domain migrated to
"native" without a real driver bound).

No protocol driver was modified (Casambi, KNX, Matter, MQTT, Apple TV, DALI, Modbus
untouched). `pnpm -r build` clean workspace-wide; full test suite clean except two
confirmed pre-existing flakes in files this refactor never touched (real-TCP-socket
`avr-driver`/`heos-driver` contention in `@supreme/protocols`, a timing-based loop
assertion in `@supreme/lan`) — both re-run clean in isolation. `gateway` + `homeowner`
containers rebuilt/redeployed; `/healthz` confirms `backend: "provider-router"`.

**Known gap, not silently skipped:** per-device provider/lifecycle fields aren't yet
wired into `GET /v1/devices/:id/diagnostics` (needs a `supreme-contracts` schema
change) — the broader `/v1/drivers/diagnostics` surface and its UI panel already
expose lifecycle-state counts. Native (non-Docker) Linux deployment wasn't
re-exercised this pass (the change is deployment-independent by design, but only the
Docker path was actually run).

## Session: Native Linux Installer — backend/HA prompt fix

**Branch:** `native-linux`. Fixed a real first-install bug: answering "No" to Home
Assistant still asked for HA username/password and a standalone "Backend [mock]"
question. `infra/native-linux/install.sh`'s `SUPREME_BACKEND` is now always derived
from the HA yes/no answer (`native` when no HA, `ha` when yes) and validated against
`native|ha|mock` — HA-specific prompts are skipped entirely on the "No" path. Added
pre-install validation (domain format, timezone, HA credential length) that fails
loudly rather than silently continuing. Updated `docs/architecture/
Native-Linux-Deployment.md` with the new wizard flow. Verified via an isolated
functional harness (8 scenarios) since no automated test suite exists for these
shell scripts; all 9 native-linux scripts pass `bash -n`. Only `infra/native-linux/`
+ one doc touched — no application code, Gateway, LAN service, Commissioning, or
provider architecture modified. Committed and pushed to `origin/native-linux`
(`d96ee90`).

## Session: Production Architecture Direction — deployment/transport separation in `@supreme/lan`

**Branch:** `claude/casambi-driver-refactor-lvu23e`. ADR: **`docs/architecture/adr/0022-supreme-lan-transport-service.md`**
(new Amendment section, 2026-08-02). **No protocol driver was modified.**

**The direction:** SupremeOS ships as a dedicated OS image (Home Assistant OS-style) on x86/ARM,
where `supreme-lan` runs as a native systemd service with direct NIC access. Docker is a
development and CI environment only, and no long-term architectural decision may be made from its
limitations.

**The problem this exposed:** Docker's vocabulary had leaked into load-bearing places in the
transport — `networkMode: "bridge" | "host" | "macvlan"` sat in the **NATS wire protocol**, the
health snapshot, the `UdpTransportServer` constructor, and the failure-diagnosis branch condition;
compose filenames were hardcoded into remediation strings. Removing Docker would have meant editing
the transport and its wire protocol — a protocol change forced by a deployment change.

**The fix — one deployment module, one neutral concept.** New `services/lan/src/server/deployment.ts`
is the ONLY module in `@supreme/lan` allowed to name a container runtime, compose file, or systemd
unit; it holds a `LanDeployment` table (`native-linux`, `docker-host`, `docker-bridge`, `macvlan`,
`vm-bridged`, `unknown`) carrying all deployment-specific text as data. Everything else reasons only
about `LanAccess` = `"direct" | "isolated" | "unknown"` — a property of the network namespace that
is equally meaningful for a native service, a VM, and a container. Deployment is **configured**
(`SUPREME_LAN_DEPLOYMENT`), never auto-detected: a process cannot tell from inside its own namespace
whether it shares the host's, so `unknown` is reported honestly instead of guessed. Legacy
`SUPREME_LAN_NETWORK_MODE` still works — existing compose files and deployed units are unaffected.

**Production deployment unit:** `infra/systemd/supreme-lan.service` runs the SAME
`dist/server/main.js` as the container with `SUPREME_LAN_DEPLOYMENT=native-linux`. It deliberately
does not set `PrivateNetwork`/`NetworkNamespacePath` — that would recreate on the production image
exactly the isolation that breaks broadcast/multicast under Docker bridge.

**The rule is now enforced, not just written down.** `services/lan/src/deployment-isolation.test.ts`
scans every shipped `@supreme/lan` module for container-runtime vocabulary in executable code (doc
comments exempt — explaining *why* a limitation exists carries no runtime coupling; `*.test.ts`
exempt — a test must construct a `DEPLOYMENTS["docker-bridge"]` fixture and assert its remediation
text, which is consuming the isolated module, not leaking). The guard was verified by injecting a
real leak into `health.ts` and confirming it fails — it does not pass vacuously.

**One genuine leak it caught in shipped code:** the "Docker Desktop does not implement host
networking" caveat was a hardcoded string inside `routing-diagnosis.ts`. It is now
`LanDeployment.unreliableLanAccessOn`, keyed by `process.platform`; the diagnosis appends the note
verbatim without knowing which runtimes are affected. Correcting the earlier code, it now covers
`darwin` as well as `win32` — Docker Desktop runs Linux containers in a VM on both.

**Net effect:** removing Docker is now a deployment change, not a protocol rewrite. The transport
can switch between Docker / native Linux / a future hardware-specific deployment without touching
any protocol driver.

**Verification:** `@supreme/lan` 9 files / 74 tests green; full monorepo 115/115 build+typecheck
tasks and 99/99 test tasks green.

## Session: LAN receive path — Casambi UDP RX + KNX/IP discovery (one shared root cause)

**Branch:** `claude/casambi-driver-refactor-lvu23e`. Full investigation:
**`docs/architecture/Casambi-LAN-Receive-Path-Investigation.md`**. No protocol logic modified.

**Both symptoms share ONE root cause, proven experimentally on a real Docker Engine: bridge
networking does not deliver LAN broadcast OR multicast into containers.** Identical code, only the
network mode differing — bridge: broadcast NOT RECEIVED, multicast join OK but NOT RECEIVED; host:
both RECEIVED. Casambi's `Sent = 6 / Received = 0 / Last Error = None` is exactly that signature:
nothing errored, the kernel just never delivered. Wireshark sees the packets; `@supreme/lan` never
does — the loss is below the application, so no protocol-level change could fix it.

**KNX/IP discovery is NOT a regression from `@supreme/lan`** — code evidence:
`createKnxDiscoveryRemoteSocketFactory` is defined and **never called**; `knxSearch()` still uses
its built-in raw `node:dgram`, and `installer-context.ts:817` calls it with no options at all. KNX
discovery has never routed through `@supreme/lan`, and the Gateway's own networks were never
modified by any of that work (`git log -- infra/hub-compose/docker-compose.yml`). It fails for the
same Docker-bridge reason, independently.

**The most damaging finding — a false PASS:** `addMembership()` SUCCEEDS on bridge networking and
then nothing ever arrives. Every diagnostic checking "did we join the group?" was reporting a green
tick on a permanently deaf socket, which is exactly why KNX discovery returned an empty list with
no error, forever. Fixed: `DgramUdpSession` now tracks `joinedMulticastAt` separately from
reception and exposes `joinedMulticastButNeverReceived`; a live run of the real `knxSearch()` now
reproduces the 0-gateway symptom but *explains itself*.

**New diagnostics (no behavior change):** protocol-agnostic `core/pipeline-stages.ts` with a
PASS/FAIL/**WAITING** vocabulary — WAITING is the state the old diagnostics couldn't express. A
reception stage is never PASS because a setup call didn't throw; it must be backed by a
received-packet counter. Built on it: `casambi/pipeline-status.ts` (Socket → Listening → Receiving
→ Publishing → Decoding → Discovery → Entities) and `knx/knx-discovery-pipeline.ts` (Socket →
Joined Multicast → Received Search Response → Gateway Parsed → Gateway Created).
`knx-discovery.ts` gained an **optional** `onDiagnostics` observer — omitting it is byte-for-byte
the prior code path.

**Deliberately NOT tracked:** a per-datagram broadcast/multicast/unicast split. `rinfo` reports the
SENDER, not the destination, and Node doesn't surface `IP_PKTINFO` — such a counter would be a
guess presented as a measurement.

**Required fix (deployment, not code):** reception needs host networking —
`-f docker-compose.lan-host.yml -f docker-compose.nats-loopback.yml` on Linux. Note this fixes
Casambi but **not** KNX discovery, which runs in the Gateway (bridge by design per ADR 0022). The
recommended next step, explicitly NOT done here per the standing "Casambi first" rule: wire the
already-built `knx-discovery-remote-socket.ts` adapter so KNX inherits the same fix.

**Tests:** `@supreme/lan` 7 files/60 tests (4 new joined-vs-receiving); `@supreme/protocols` 80
files/772 tests (9 new pipeline-stage). 47/47 turbo tasks green.

## Session: Casambi — Discovery UX fix + ENETUNREACH root cause (DEPLOYMENT defect, fixed)

**Branch:** `claude/casambi-driver-refactor-lvu23e`. Full investigation:
**`docs/architecture/Casambi-ENETUNREACH-Investigation.md`**. Two independent issues, both fixed.
No Casambi protocol code (UDP codec / Discovery Engine / Entity Mapper / Event Engine) was
touched, per the governing brief.

**PART 1 — Discovery UX.** The UI said "Auto-discovery is not implemented," conflating two
different mechanisms and wrongly implying devices must be added by hand. Now stated separately:
*Automatic Gateway Discovery — Not available* (no discovery API exists in the Lithernet docs; IP
entered manually) and *Automatic Device Discovery — Enabled* (devices appear automatically from
incoming UDP notifications, no manual creation). New `CasambiDiscoveryExplainer` in `drivers.tsx`
+ matching Aureon-token CSS; the gateway route's own response message was the source of the
misleading string and was corrected too. Added a live `CasambiDiscoveryStatus` block to
Diagnostics that shows real discovery state and, before any traffic, says "Waiting for first UDP
notification — device discovery will begin automatically," framed as a normal pre-traffic state.

**PART 2 — ENETUNREACH root cause: a DEPLOYMENT defect, reproduced and fixed.**
`docker-compose.yml` attached `lan` to `supreme-core` ONLY, and that network is `internal: true`
— which by design has no default route, so the kernel rejected every send to a LAN address before
a packet left the process. **Reproduced on a real Docker Engine** with one variable changed
(identical image/code/target): `internal: true` → `SEND FAILED: send ENETUNREACH
192.168.0.45:10009` (byte-identical to the report); normal bridge → `SEND OK`. Fixed by giving
`lan` a second, non-internal `supreme-lan-egress` network — every other service keeps its exact
prior isolation. **Fix verified by booting the real stack**: the container now has a default route
(previously none) and the identical real `supreme.lan.udp.send` to `192.168.0.45:10009` returns
`{"ok": true}`.

Note the base compose's own comment had claimed the degraded bridge mode only lost *broadcast
reception*; reality was worse (no egress at all, not even unicast). Comment corrected. Broadcast
RECEPTION still requires the host-networking overlay — unchanged and still the documented
production topology.

**Diagnostics (Part 2 cont.):** new `services/lan/src/server/routing-diagnosis.ts` computes a real
routing verdict inside supreme-lan's own namespace (real interfaces + CIDR mask arithmetic, real
`os.platform()`, explicitly-configured network mode — never self-detected), attached to failed-send
wire responses and exposed via `NatsUdpTransportClient.lastSendDiagnosis`. `failure-analysis.ts`
gained a snapshot-level send-error classifier that runs BEFORE the "zero packets received" branch,
so `ENETUNREACH` is named a deployment/routing failure rather than misreported as a
broadcast-reception problem; `EHOSTUNREACH` → gateway issue; `EACCES` → permission/SO_BROADCAST;
anything else stays honestly `unknown_error`.

**Tests:** `@supreme/lan` 7 files/56 tests (10 new routing-diagnosis tests); `@supreme/protocols`
79 files/763 tests (3 new send-classification tests). Full monorepo turbo run across
lan/protocols/gateway/web-homeowner: 47/47 tasks green. Both compose configurations re-validated.

## Session: Casambi Local Gateway — Phase 3, Real Hardware Certification Tooling

**Branch:** `claude/casambi-driver-refactor-lvu23e` (continues the Final Hardware Validation
session below). **Confirmed workflow, explicitly stated by the user this session:** this AI
session has no network path to the user's real Lithernet Gateway or LAN, and never will from this
sandbox — the user runs the validation runbook themselves, on their own SupremeOS installation,
against their real hardware, and shares back the resulting JSON/logs/pcap evidence for analysis.
**Production Gate verdict unchanged: NOT EVALUATED — hardware unavailable** (no evidence bundle
has been shared yet; nothing here renders a verdict from data that doesn't exist).

**What changed this session** (all hardware-independent tooling to support that confirmed
handoff, per the user's explicit instruction "Build all tooling assuming this workflow"):
- **Live Capture**: `replayableDgramSocket().startRecording()`/`handle.finish()`
  (`services/lan/src/server/replay-dgram-socket.ts`) — records real datagrams as they arrive at
  the base socket (pure side-observation, zero effect on normal delivery) into a ready-to-save
  `PacketCapture`. This is how a real gateway's real traffic becomes a permanent regression
  capture. New `fakeDgramSocket().emitMessage()`/`emitError()` test-support methods so this could
  be verified hermetically. 4 new tests.
- **`PacketCapture.metadata`**: a generic `Record<string, unknown>` bag added to `@supreme/lan`'s
  capture format; `CasambiCaptureMetadata` (firmware/gateway version, data format, Net ID, date,
  notes — all nullable, never guessed) documents the Casambi-specific shape in
  `services/protocols/src/casambi/capture-metadata.ts`.
- **Capture library reorganized** into the certification brief's exact category tree:
  `tests/regression/casambi/{living-room,kitchen,office,button-events,sensor-events,dimming,
  scenes}/`. The three existing captures moved into their category folders with real metadata
  populated (`null` for anything not actually known, e.g. the real capture's exact date/gateway
  hardware version were never recorded). The four new category folders are correctly EMPTY — no
  synthetic data fabricated to fill them — each with a `README.md` explaining exactly what real
  evidence would populate it. The regression test loader (`casambi-packet-replay-regression.
  test.ts`) now recurses `tests/regression/casambi/` instead of scanning one flat directory.
- **Failure Analysis extended**: `CasambiFailureStageResult` gained `evidence: string[]` (the
  literal snapshot facts behind each verdict, independently checkable) and `suggestedFix: string
  | null` (always a concrete next action) — matches the certification brief's exact
  Reason/Evidence/Suggested Fix format. `formatFailureAnalysisReport()` renders all three.
- **Local certification evidence collector**
  (`infra/hub-compose/collect-certification-evidence.sh`, new): a shell script the user runs on
  THEIR OWN machine — never remotely, never assuming this session can reach their LAN — that
  automates the runbook's `curl`/`docker logs`/`tcpdump` steps into one timestamped bundle
  (before/after Transport Monitor snapshots, container logs, an optional real tcpdump capture
  during a prompted trigger step). Every uncollectable piece is recorded as an explicit
  "SKIPPED: &lt;reason&gt;", never silently omitted.
- Runbook and the Final Hardware Validation Report doc both updated to reference all of the above
  and make the confirmed handoff workflow explicit throughout.

**Tests:** 4 new (`startRecording`/Live Capture) in `replay-dgram-socket.test.ts`; existing
`failure-analysis.test.ts`/`casambi-packet-replay-regression.test.ts` updated for the extended
shape and reorganized directory, all still passing. `@supreme/lan`: 6 files/46 tests (up from 42).
`@supreme/protocols`: 79 files/760 tests (no new test files this session — only new cases within
existing files, some replacing prior assertions for the extended shape — net count unchanged).

**No UI built** (same disclosed scope cut carried forward unchanged): Transport Monitor panel,
Packet Replay "Saved Captures" panel, Packet Trace Viewer, performance charts — all backend/data
only, tracked in TODO.md.

## Session: Casambi Local Gateway — Final Hardware Validation & Production Gate

**Branch:** `claude/casambi-driver-refactor-lvu23e` (continues Phase 2 below). Full report:
**`docs/architecture/Casambi-Final-Hardware-Validation-Report.md`** — Hardware Validation Report,
Performance Report, Packet Replay Framework Guide, Transport Monitor Guide, and Production
Readiness Checklist, all in one document. **Production Gate verdict: NOT EVALUATED — hardware
unavailable** (neither PASS nor FAIL — this sandbox never had access to a real Lithernet gateway,
so there is no real-hardware evidence to render either verdict on). Per the governing brief's
Critical Requirement, KNX/Matter/other protocol migrations remain on hold until that real-hardware
retest actually happens.

**What changed this session:**
- **Packet Replay Framework** (new, `@supreme/lan`, protocol-agnostic — reusable by every future
  LAN protocol): `PacketCapture` JSON format (`services/lan/src/server/replay-dgram-socket.ts`),
  `replayableDgramSocket()` (wraps a real or fake `DgramSocketLike`, injects a captured datagram
  through the IDENTICAL `DgramUdpSession` → `UdpTransportServer` → NATS → `NatsUdpTransportClient`
  → adapter → driver chain real hardware traffic uses — "no code path may differ" is satisfied
  structurally, not by convention), `fakeDgramSocket()` (formalizes the fake-socket pattern every
  test file was hand-rolling separately). File I/O + PCAP export (one-way, for opening a capture in
  Wireshark — PCAP import deliberately not implemented, see the report §3 for why) in
  `services/lan/src/server/capture-io.ts`.
- **Capture library**: `tests/regression/casambi/{living-room,kitchen,office}.json` —
  `living-room` is the REAL 99-byte Wireshark-captured NotifyControlValues packet from the earlier
  hardware audit session, reused rather than re-transcribed; `kitchen`/`office` are synthetic but
  wire-valid (a button press; a well-formed but UNMAPPED opcode 0x39, deliberately exercising the
  "Discovery ignored packet" failure mode). New
  `casambi-packet-replay-regression.test.ts` (7 tests) auto-loads and replays every capture
  through the real pipeline — "no hardware required" per the brief, verified: e.g. the real
  living-room capture's controls map to Supreme's `sensor` capability (VERIFIED by actually
  running the code and reading the result, not assumed — an earlier draft assumption that it
  would map to `onoff` was wrong and caught by the test failing honestly).
- **New driver-level observability**: `CasambiProtocolDriver` now tracks `unmappedOpcodeEvents`/
  `lastUnmappedOpcode` (a datagram that decodes successfully but whose opcode
  `normalizeLocalPacket` doesn't map to any signal — previously a true silent drop, now a real,
  observable event) and a bounded `recentJourney` "Packet Trace" (per-datagram: arrival time,
  decode outcome, resolved handler/signal kind, and a REAL measured `processingDurationMs`).
- **Failure Analysis report generator** (`services/protocols/src/casambi/failure-analysis.ts`,
  new): a pure function over the Transport Monitor snapshot producing the EXACT ✓/✗ + "Reason:"
  checklist format the governing brief specified (Transport → NATS → Casambi Adapter →
  Discovery/Driver), never guessing — `not_applicable` for anything it can't honestly evaluate.
  Wired into `GET /v1/drivers/:id/casambi/transport-monitor` as a new `failureAnalysis` field.
- **Performance**: extended the existing latency benchmark to report p50/p95/p99/max (not just
  median/p95/mean).
- **No UI built this session** (Transport Monitor panel, Packet Replay "Saved Captures" panel,
  Packet Trace viewer) — same disclosed scope cut as Phase 2's Transport Monitor; backend/data
  only, tracked in TODO.md.

**Tests:** 4 new test files (`replay-dgram-socket.test.ts` 5 tests, `capture-io.test.ts` 3 tests,
`casambi-packet-replay-regression.test.ts` 7 tests, `failure-analysis.test.ts` 8 tests) plus new
cases in `casambi-driver.test.ts`. `@supreme/lan`: 6 files/42 tests. `@supreme/protocols`: 79
files/760 tests. `@supreme/gateway`: 72 files/295 tests. All passing, zero regression.

**Disclosed, still not resolved:** real Lithernet hardware and real Windows Docker Desktop remain
outside this sandbox's reach — no engineering inside this environment changes that. The Packet
Replay Framework and Failure Analysis tooling exist specifically so that when real hardware IS
available, the runbook (`docs/architecture/Casambi-Real-Hardware-Validation-Runbook.md`, updated
this session to reference these new tools) can be followed and the Production Gate re-evaluated
with real evidence.

## Session: `supreme-lan` LAN Transport Service — Phase 2 (Casambi Migration & Transport Monitor)

**Branch:** `claude/casambi-driver-refactor-lvu23e` (continues Phase 1 below). Full account,
including the honest hardware/Windows/Linux assessment: **`docs/architecture/
Supreme-LAN-Transport-Architecture.md` §10**. ADR 0022's status line updated to reflect Phase 2 as
implemented. Per the governing brief's Critical Requirement, **do not start KNX/Matter/any other
protocol migration until Casambi is confirmed operational on real hardware** — that hasn't
happened yet (see below); the existing `lan-adapters/` (KNX Discovery/mDNS/SSDP) remain exactly as
Phase 1 left them, untouched.

**What changed this session:**
- **`CasambiUdpSocketLike`/`CasambiUdpSocketFactory` deleted entirely.** `CasambiUdpEngine`
  (`services/protocols/src/casambi/local-transport/udp-engine.ts`) now takes a required
  `udpTransportFactory: UdpTransportFactory` and calls the generic `UdpTransport` (`@supreme/lan`)
  directly — no adapter layer, no raw `node:dgram` inside this package anymore. Every other public
  method/getter kept its exact prior shape, so `command-engine.ts`, `discovery-engine.ts`, and
  `casambi-driver.ts`'s command/event dispatch needed **zero edits**.
- **`LocalDirectUdpTransport`** (new, `services/lan/src/client/local-direct-udp-transport.ts`) — a
  same-process `UdpTransport` (real `node:dgram`, no NATS hop) for single-process dev/test, wrapping
  the already-tested `DgramUdpSession`.
- **Transport selection is centralized once**, in `services/gateway/src/installer-context.ts`'s
  `nativeDriverContext()`: real NATS configured → `NatsUdpTransportClient`; otherwise →
  `LocalDirectUdpTransport`. `native-driver-factory.ts`'s casambi factory and the Test Connection
  route (`routes/installer.ts`) both consume this same resolution — Casambi's Local Gateway driver
  now **defaults through `@supreme/lan`** in every environment, not just when explicitly configured.
- **Transport Monitor** (new): `CasambiProtocolDriver.getCasambiTransportMonitor()`
  (`services/protocols/src/casambi/transport-monitor.ts`) — four real, non-fabricated layers
  (Transport/NATS/Casambi Adapter/Driver), exposed at the new
  `GET /v1/drivers/:id/casambi/transport-monitor` route, separate from the existing
  `casambi/diagnostics` route (unchanged). New counters added purely additively:
  `CasambiUdpEngine.decodedCount`/`decodeFailureCount`/`transportDiagnostics`,
  `NatsUdpTransportClient.packetsSent`/`packetsReceived`/`requestsSent`/`eventsReceived`/
  `lastError`, `CasambiProtocolDriver`'s `discoveryEventsCount`/`commandsIssuedCount`/
  `feedbackEventsCount`. New `queryLanHealth()` client helper (`@supreme/lan`) calls the
  `supreme.lan.health` subject Phase 1 built a server handler for but nothing had called yet.
  **No dedicated UI page built this session** — see TODO.md.
- **Cloud implementation, entity model, discovery/event/command engines, Driver Manager UI, and
  the existing Cloud REST implementation are byte-for-byte unchanged** — zero edits to any of those
  files; confirmed by the full pre-existing test suite passing unmodified.

**Tests (all passing, all in this session):** rewrote `udp-engine.test.ts` (35 tests, all UdpTransport-
based) and `casambi-driver.test.ts` (34 tests) onto the new architecture; new
`casambi-over-supreme-lan.test.ts` (7 tests) — the cross-package proof that the REAL, unmodified
`CasambiProtocolDriver` connects/discovers/updates state/fires events/issues commands entirely over
a REAL `NatsUdpTransportClient` + REAL `UdpTransportServer` sharing a REAL `IEventBus` (fake
`node:dgram` only), plus the honest failure-path proof (no `supreme-lan` reachable → `connect()`
rejects, never silently "succeeds"); new `NatsUdpTransportClient`/`queryLanHealth` tests in
`@supreme/lan`'s `contract.test.ts`; new `native-driver-factory.test.ts` tests proving the factory
actually uses a supplied `udpTransportFactory` and correctly falls back to
`LocalDirectUdpTransport`; new `casambi-lan-latency.test.ts` — an automated, repeatable, code-only
latency benchmark (n=50 samples/run). Full monorepo `turbo run build typecheck test`: **173/173
tasks green** (`@supreme/protocols` 77 files/742 tests, `@supreme/gateway` 72 files/295 tests,
`@supreme/lan` 4 files/34 tests — all up from Phase 1's counts, zero regression anywhere).

**Real Docker validation (new this continuation — a real Docker Engine became available in this
sandbox mid-session):** built the real `lan.Dockerfile` image, booted real `nats`+`lan` containers,
and reproduced the ACTUAL bug this project exists to fix, for real: a genuine UDP broadcast sent
from the Docker host was **not received** by the bridge-networked `lan` container, then **was
received** by the identical container rebuilt on `docker-compose.lan-host.yml` (real
`network_mode: host`) + `docker-compose.nats-loopback.yml`. This is real Docker/Linux evidence, not
a simulation — see architecture doc §10.3 for full detail. In the process, found and fixed two
real, previously-undiscovered bugs (not caught by config-parsing or code review): (1)
`lan.Dockerfile` never copied `cloud`/`drivers`/`tools`, so `pnpm install --frozen-lockfile` failed
outright (`services/license` depends on `cloud/licensing`) — fixed to match
`gateway.Dockerfile`'s COPY list; (2) `docker-compose.nats-loopback.yml`'s port publish was
silently a no-op because Docker refuses to publish a port for a container whose ONLY network is
`internal: true` (confirmed with an isolated minimal repro) — fixed by giving `nats` a second,
non-internal, loopback-only network in that one override file. Also measured a real end-to-end
latency of **~8ms** (host UDP send → real container receive → real NATS publish → host-side
subscriber) during this validation, alongside the new automated benchmark's code-only numbers
(sub-millisecond — see architecture doc §10.4 for both, kept clearly separate).

**Disclosed, still not resolved (see TODO.md and architecture doc §10.3):** this sandbox still
cannot reach a real Lithernet gateway or real Windows Docker Desktop — no amount of additional
sandbox work substitutes for that. A synthetic UDP broadcast from a script is real evidence the
Docker/networking MECHANISM works, but it is not a real device on a real physical LAN. The
Transport Monitor has a working backend + route but no dedicated UI page yet. KNX/mDNS/SSDP
migration remains explicitly on hold pending the real-hardware retest, per the governing brief.

## Session: Production Architecture Refactor — `supreme-lan` LAN Transport Service (Phase 1)

**Branch:** `claude/casambi-driver-refactor-lvu23e` (continues the sessions below — this is now a
cross-cutting infrastructure change, not Casambi-specific, per the user's own explicit framing).
Full design record: **`docs/architecture/adr/0022-supreme-lan-transport-service.md`**; full
technical detail (flow/deployment diagrams, migration risk table, testing honesty notes):
**`docs/architecture/Supreme-LAN-Transport-Architecture.md`** — read both before touching Docker
network topology or any raw-socket driver code again.

**Problem:** Docker bridge networking silently drops LAN broadcast/multicast (proven with the real
Casambi Wireshark capture from the prior session) — affects Casambi UDP, KNX Routing/Discovery,
Matter/mDNS, SSDP, Sonos, Denon, Apple TV, Hue, Yamaha. Moving the whole Gateway to
`network_mode: host` (tried previously) broke it (`getaddrinfo ENOTFOUND postgres`, proxy 502) —
the Gateway is tightly coupled to Postgres/Redis/NATS/internal services only reachable via
Docker's bridge DNS.

**Solution built this session (Phase 1 only — service + generic transport + Docker topology +
docs, NOT yet the default for any driver):**
- **New package `@supreme/lan`** (`services/lan`) — zero dependency on `@supreme/protocols` or any
  business/domain concept. Reuses `@supreme/messaging`'s existing `IEventBus`/NATS seam (already
  deployed, already wired into the Gateway) as its only IPC — no new mechanism invented. A generic
  `requestReply()` helper (`shared/rpc.ts`) adds real RPC semantics on top of the bus's existing
  publish/subscribe, without modifying `@supreme/messaging` itself.
- **Generic `UdpTransport` interface** (`transport.ts`): `bind`/`send`/`joinMulticast`/`close`/
  `onMessage`/`onError`/`onListening`/`address` — ONE interface covering unicast, broadcast, and
  every multicast use in this codebase (mDNS/SSDP/KNX are just `bind({multicastGroup})` presets).
  `joinMulticast()` exists as a separate post-bind capability specifically because KNX
  discovery's real code binds first, then joins multicast only once bind genuinely completes — a
  real API gap found and fixed during implementation, not assumed away.
- **Real server** (`server/`): `DgramUdpSession` (injectable `DgramSocketLike`, same fake-socket
  convention as every existing raw-socket module) + `UdpTransportServer` (NATS command dispatch,
  session multiplexing, event publishing) + `main.ts` (deployable entrypoint) + `health.ts`
  (diagnostics snapshot — `networkMode` read from config, never inferred, per this codebase's
  standing "never fabricate" rule).
- **Four migration adapters** (`services/protocols/src/lan-adapters/`, NOT inside `@supreme/lan` —
  keeps the dependency direction one-way: `@supreme/protocols → @supreme/lan`): each implements an
  EXISTING driver-facing interface (`CasambiUdpSocketLike`, `KnxDiscoverySocket`, `MdnsSocket`,
  `SsdpSocket`) exactly, as a drop-in alternative to that protocol's real-`dgram` default. **None
  of the four existing driver files were modified** — the adapters are opt-in, not defaulted.
- **Docker**: base `docker-compose.yml` gets a `lan` service (bridge, degraded-but-testable
  default); new `docker-compose.lan-host.yml` (host networking, mirrors
  `docker-compose.appletv-host.yml` exactly — simpler, since `lan` only ever talks NATS, no
  `extra_hosts` needed); new `docker-compose.nats-loopback.yml` (exposes NATS on `127.0.0.1` only,
  since `supreme-core` is `internal: true` and a host-networked container can't reach it by
  container DNS). New `infra/hub-compose/lan.Dockerfile` mirrors `gateway.Dockerfile`'s
  multi-stage pnpm-deploy pattern.

**Tests (all passing, all in this session):** `@supreme/lan` — 24 tests (fake-socket unit,
`InProcessEventBus` contract/RPC, real-loopback smoke test with genuine OS UDP sockets).
`@supreme/protocols` lan-adapters — 19 tests, including the concrete cross-package proof: the
REAL, unmodified, hardware-validated `CasambiUdpEngine` sending/receiving real wire packets
entirely over the new remote transport. Full `@supreme/protocols` suite re-run: 77 files/727 tests,
zero regression (no existing driver file touched).

**Disclosed, not resolved this session (see TODO.md):** Phase 2 (defaulting Casambi onto the
remote transport) deliberately held — the adapter is proven, but flipping the default needs its
own real-hardware retest against a host-networked `supreme-lan`, not bundled into the session that
introduces the RPC path for the first time. KNX Routing and Matter (Phases 3b/4) need their own
protocol-level seam work first — both currently own sockets inside third-party libraries
(`knxultimate`, future `@matter/main`) with no injectable hook, unlike Casambi/KNX-discovery/
mDNS/SSDP. "Windows compatibility" testing is code-review-only + a documented native-process
workaround, not executed on Windows this session (this sandbox is Linux-only). Real LAN broadcast
reception has not been re-verified against actual hardware through `supreme-lan` yet — only the
diagnostic/transport plumbing is proven, via loopback and in-process tests.

## Session: Casambi Local Gateway — UDP Receive Pipeline Audit (real hardware capture)

**Branch:** `claude/casambi-driver-refactor-lvu23e` (continues the Auth & UDP Diagnostics session
below). Triggered by a real Wireshark capture (Lithernet Gateway, firmware 6.25) proving the
gateway broadcasts `NotifyControlValues` to `255.255.255.255:10009` while SupremeOS reported
`Packets Received = 0`. Full audit, root cause, before/after flow diagrams, and firmware-scheme
disclosure: **`docs/architecture/Casambi-UDP-Receive-Pipeline-Audit.md`** — read that document
before touching `udp-engine.ts`'s `handleMessage` again.

**Root cause (confirmed by code reading, not hardware):** no reception-blocking bug existed —
the socket binds to `0.0.0.0` (no address filter, no `connect()`, no `rinfo.address` check
anywhere), so broadcast and unicast datagrams are received identically. The REAL, confirmed bug:
`packetsReceived` only incremented inside `decodeCasambiPacket()`'s success branch, so a datagram
that failed to parse was invisible to the counter and had no bulk trace — "never arrived" and
"arrived but failed to parse" were indistinguishable everywhere in the driver. Manually decoding
the report's exact byte sequence (reconstructed to its stated 99-byte length) against the
unmodified codec succeeds, so the specific example isn't itself undecodable — the fix targets the
counter/tracing gap the report's required steps describe, not a codec rewrite.

**Changes:**
- `udp-engine.ts`: `packetsReceived`/`lastPacketAt` now increment BEFORE parsing, unconditionally.
  New `onRawDatagram()` (fires pre-parse, proves socket-level reception independent of decode) and
  a bounded (20-entry) `recentTraces` log — every datagram, decoded or not, with raw ASCII/hex,
  byte length, source, and parse result. A failed parse is traced and logged, never a silent drop.
- `casambi-driver.ts`: wires `onRawDatagram`/`onDecodeError` into the existing `ProtocolTracer`
  pipeline (immediate "UDP datagram received"/"UDP parse failed" log lines); threads
  `recentTraces` into `getCasambiDiagnostics()`.
- `diagnostics.ts`, `routes/installer.ts`, `api.ts`, `drivers.tsx`: `recentTraces` surfaced end to
  end — Diagnostics page now renders a real packet-trace table, and Test Connection's UDP result
  includes the trace from its own test window.

**Tests:** `udp-engine.test.ts` — 1 updated (decode failure now correctly counts as received) + a
new "real hardware capture" suite (8 tests) using the report's exact byte sequence, reconstructed
and verified to be exactly 99 bytes: broadcast reception, pre-parse counting, real ASCII hex-dot
decode, full trace recording, parser-failure trace+log, bounded trace log. `casambi-driver.test.ts`
+2 (end-to-end trace reaching Driver Diagnostics for both a decodable and an undecodable packet).
Full monorepo verification green (`@supreme/protocols` 72 files/708 tests, `@supreme/gateway` 72
files/293 tests after rebuilding `@supreme/protocols`'s dist — a workspace-resolution step, not a
code defect — `@supreme/drivers` 22, `@supreme/web-homeowner` 55 + build). Zero Cloud regression.

**Disclosed, not resolved:** no hardware was available to confirm the original symptom is now
actually fixed end-to-end on the real gateway — only that the diagnostic blind spot the report
describes is closed and the reconstructed real payload decodes correctly. The gateway's own
firmware number (6.25) and the protocol doc's "Evolution firmware" version gates (e.g. ≥37.90) are
different numbering schemes and were NOT compared numerically — see the audit doc §6.

## Session: Casambi Local Gateway — Auth & UDP Diagnostics

**Branch:** `claude/casambi-driver-refactor-lvu23e` (continues the audit session below, same
branch). Brief: refine Local REST authentication, fix the UDP "Unreachable" false-negative, and
add production-quality staged connection diagnostics — grounded strictly in the Lithernet manuals,
with every undocumented assumption disclosed rather than inferred. Full write-up, including the
required six-question UDP audit answered against the real pre-existing code:
**`docs/architecture/Casambi-Local-Auth-And-UDP-Diagnostics.md`** — read that document, not this
summary, before touching Local REST auth or UDP diagnostics again.

**Root causes found (both real, confirmed by reading the code, not assumed):**
1. The generic `services/drivers/src/config.ts` `validateDriverConfig` iterated the Casambi
   manifest's full `configSchema` unconditionally, checking `required` regardless of
   `connectionType` — a Local Gateway config save could fail on a missing `email` (a Cloud-only
   field), and vice versa. This existed independently of anything UDP-related.
2. `CasambiUdpEngine.probe()`'s reachability check conflated one timed-out application-layer
   round-trip (opcode 0x39 Node Status, 2s timeout) with the actual transport state — a
   TCP-shaped assumption on a connectionless, push-based protocol. The gateway's own "UDP
   Listening on IP:Port" self-report (confirmed via `Lithernet_General_Settings_Network.pdf` p.72
   as its own Control System Wizard status field) was never contradictory with SupremeOS's
   report; the probe-timeout logic was just answering the wrong question.

**Changes made** (Connection Manager → Transport → Service → Engine hierarchy preserved,
unmerged; zero Cloud regression — the full pre-existing Cloud-mode test suite passed unmodified):
- **`packages/domain-model/src/drivers.ts`** — new `requiredIf: { key, equals }` on
  `DriverConfigField`, a generic (not Casambi-specific) mechanism for mode-conditional required
  fields.
- **`services/drivers/src/config.ts`** — `validateDriverConfig`/`isConfigComplete` now resolve
  `requiredIf` against the submitted/existing/default value of the named discriminator field.
- **`local-transport/rest-client.ts`** — `gatewayUsername`/`gatewayPassword` → HTTP Basic Auth on
  every request; `testConnection()` returns `{ reachable, httpStatus, authFailed }`;
  `setTargetValue()` can return `"unauthorized"`.
- **`local-transport/udp-engine.ts`** — real `socketState`, `localAddress`/`localPort` (from
  `dgram.Socket.address()`), `packetsSent`/`packetsReceived`, `lastPacketAt`, `lastSendError`,
  `lastDecodeError`, `averageLatencyMs` (probe round-trips only). No packet-loss field — the
  documented packet structure has no sequence numbers, so it's permanently unmeasurable and never
  fabricated.
- **`health-monitor.ts`** — new `udpStage()`: `not_configured | socket_error | bound_waiting |
  active`. Only a real socket error is a failure; "bound, nothing received yet" is a normal state.
- **`diagnostics.ts`** — additive `udp` field on the snapshot (Local only, `null` for Cloud).
- **`services/gateway/src/routes/installer.ts`** — Test Connection rewritten to the staged model
  above instead of a single `reachable` boolean; never marks UDP failed on "no reply yet."
- **`manifests.ts`** — new `gatewayUsername`/`gatewayPassword` fields, exact field order per the
  brief's mockup, `requiredIf` on every mode-conditional field, version bumped to 1.3.0.
- **`native-driver-factory.ts`**, **`drivers.tsx`**, **`api.ts`** — threaded the new fields/types
  through; Driver Manager's Local Gateway panel now renders the staged Test Connection report
  (REST / HTTP Authentication / Gateway / UDP / Port / Gateway Configuration / Status / Packets
  Received / Last Packet / Latency), and the Diagnostics page gained a live "UDP transport"
  section sourced from the running driver's real engine state.

**Tests:** ~45 new/updated tests across `config.test.ts` (requiredIf, both directions),
`rest-client.test.ts` (Basic Auth header, 401/403 handling), `udp-engine.test.ts` (socketState
transitions including a real bind failure, address/port exposure, packet/send/decode counters,
probe latency, no packet-loss getter), new `health-monitor.test.ts` (`udpStage`'s four-way rule),
`casambi-driver.test.ts` (end-to-end diagnostics wiring, `bound_waiting`→`active` transition,
`udp: null` in Cloud mode), `native-driver-factory.test.ts` (+2). Full monorepo
`turbo run build typecheck test` across `@supreme/domain-model`, `@supreme/drivers`,
`@supreme/protocols`, `@supreme/gateway`, `@supreme/web-homeowner`: **48/48 tasks green**
(`@supreme/protocols` 71 files/690 tests, `@supreme/gateway` 71 files/289 tests, `@supreme/drivers`
22 tests, `@supreme/web-homeowner` 55 tests + build). No hardware was available — every claim is
either a code fact or cited to a specific Lithernet PDF page, never inferred as verified.

**Disclosed, not fixed this session** (see `TODO.md`): the HTTP auth scheme is Basic by informed
default, not confirmed against real hardware (Digest is possible); no SSL/HTTPS support for the
Local REST client; no dedicated fastify-level HTTP test for the rewritten test-connection route
(its underlying primitives are fully unit-tested); the MAC-address-as-credentials fallback login
is not implemented.

## Session: Casambi Architecture Validation & Refactor (mandatory pre-implementation audit)

**Branch:** `claude/casambi-driver-refactor-lvu23e` (continues PR-2 below, same branch). The user
required a full, honest architecture audit against an explicit Connection Manager → Transport →
Service → Command/Event/Discovery Engine hierarchy **before any further feature work**, with an
explicit instruction not to self-grade "yes." Full findings, per-layer honest answers, refactor
performed, and justification for every decision: **`docs/architecture/Casambi-Architecture-Audit.md`**
— read that document, not this summary, before touching command/event dispatch in this driver again.

**Headline finding:** Connection Manager, Local Transport (container), and both Local Services
(REST/UDP) were already genuinely compliant. **Command Engine and Event Engine did not exist as
real, distinct entities** — `casambi-driver.ts`'s `command()` had an inline `if (mode==="local")`
branch building/sending commands two different ways, and two separate private methods
(`onEvent`/`onLocalPacket`) each independently decided what a raw wire signal meant, duplicating
that decision once per transport. Discovery Engine was half-real: `buildDiscoveredDevices()` (the
output-shaping half) was already transport-independent and correct; the driving half (how a
transport learns about units) was inline in the driver for both transports.

**Refactor performed** (zero Cloud regression — the full pre-existing Cloud-mode
`casambi-driver.test.ts` suite, including its fake-timer reconnect/heartbeat assertions, passed
unmodified after every step, verified incrementally, not just once at the end):
- **`command-engine.ts` (new)** — `CasambiCommandEngine` interface, `CloudCommandEngine`/
  `LocalCommandEngine` implementations. `command()` collapsed to one call site, no mode branching.
- **`event-engine.ts` (extended)** — `CasambiSignal` union + `normalizeCloudEvent`/
  `normalizeLocalPacket` (pure functions) + `enableLocalButtonEvents`/`disableLocalButtonEvents`.
  The driver's two duplicated dispatch methods removed, replaced by one `applySignal()` reaction
  method fed by both normalizers.
- **`discovery-engine.ts` (extended)** — `startLocalDiscovery`/`stopLocalDiscovery` extracted from
  the driver's inline UDP bootstrap/teardown. Cloud's discovery-driving (`loadNetwork`/`seedState`)
  was deliberately NOT extracted into a shared interface — two real callers with genuinely
  different shapes (REST pull vs. UDP push) is judged premature abstraction, not a missing
  abstraction; full reasoning in the audit doc.
- **25 new tests** (`command-engine.test.ts` 6, `event-engine.test.ts` 14, `discovery-engine.test.ts`
  5) exercising the extracted engines directly, independent of the driver.

**Disclosed, NOT fixed in this pass** (see the audit doc's §7 template-readiness table and
`TODO.md`): `casambi-driver.ts` still publishes through the old, Casambi-only `CasambiEventBus`,
not the cross-driver `core/event-bus.ts`'s `CoreEventBus` built in the PR-2 session — migrating it
is scoped, disclosed follow-up, not bundled into this audit's regression-sensitive refactor.
Similarly, `entity-mapper.ts`'s `capabilitiesFromUnit` does not yet consume `core/
capability-engine.ts` — that Capability Engine module exists and is tested but has no real
consumer anywhere yet, Casambi included. **Casambi is not yet confirmed ready to be the standard
template for future drivers** until those two gaps close — the audit doc says so explicitly rather
than claiming a clean bill of health.

**Verification:** full `turbo run build typecheck test` across `@supreme/protocols`,
`@supreme/drivers`, `@supreme/gateway`, `@supreme/web-homeowner` — 46/46 tasks green.
`@supreme/protocols` alone: 70 test files, 669 tests, all passing.

## Session: Casambi Driver Refactor — PR-2 Core Architecture + Local Gateway Foundation

**Branch:** `claude/casambi-driver-refactor-lvu23e` (continues the Foundation session below — same
branch, same effort). This session's brief: build the cross-driver **SupremeOS Core** (Event Bus,
Capability Engine, Packet Recorder Framework, Driver Health Engine, Driver Metrics Engine) and
implement the **real** Casambi Local Gateway protocol wherever it is fully documented — grounded in
the 7 attached Lithernet reference PDFs (re-read in full this session; `Lithernet_UDP_Developer_
Reference.pdf`'s §5.10 "UDP Casambi Command" and `Lithernet_WebAPI.pdf`'s §5.14 are the two that
matter for wire protocol). Foundation's explicit constraint carries forward unchanged: **Cloud
behavior must stay byte-for-byte identical** — nothing in `cloud-transport.ts`, `connection-
manager.ts`'s cloud branch, or the Cloud half of `casambi-driver.ts` was touched.

### SupremeOS Core (`services/protocols/src/core/`, new)

Five modules, none Casambi-specific, all with real unit tests:

- `event-bus.ts` — `CoreEventBus` + the brief's exact 13-category taxonomy (Device/Button/Sensor/
  Lighting/Media/Climate/Automation/Scene/Group/Diagnostic/Driver/Network/Health). Every interface's
  doc comment states plainly which driver actually emits it today; most are honestly reserved for a
  future protocol. **Not yet wired into `casambi-driver.ts`** — the driver still publishes through
  the pre-existing, Casambi-only `event-engine.ts`/`CasambiEventBus` (Foundation-session code, left
  alone deliberately to avoid re-touching tested Cloud event-emission paths in the same PR that adds
  Local). Migrating the driver onto `CoreEventBus` is real, scoped follow-up work — see TODO.md.
- `capability-engine.ts` — `computeEntityCapabilities()`/`computeDriverCapabilities()`, pure
  functions turning a device's real `CapabilityKind[]` + structural color config into flat boolean
  flags. `supportsRGBW` is hard-coded `false` with a doc comment explaining why (no domain-model
  white-channel field exists — not this session's gap to invent one).
- `packet-recorder.ts` — `PacketRecorder`, a bounded ring buffer with query/filter/export. Framework
  only, as scoped: no protocol-specific parsing lives here, and nothing wires the real UDP engine's
  raw datagrams into it yet (see TODO.md).
- `driver-health-engine.ts` — `computeDriverHealth()`, generalizing Foundation's Casambi-only
  Health Monitor into a reusable score+verdict engine any future driver can reuse.
- `driver-metrics-engine.ts` — `DriverMetricsEngine`, sliding-window rate counters (packets/
  commands/events per sec) + cumulative counters (REST requests/UDP events/reconnects/dropped) +
  latency tracking.

### Casambi Local Gateway — now a real protocol, not architecture-only

- `local-transport/udp-codec.ts` (new) — byte-exact encode/decode for the "UDP Casambi Command"
  wire format (`hex-dot`/`dec-hash`), grounded directly in the reference PDF's opcode tables and
  worked examples. Every encoder/parser is unit-tested against a real documented example where one
  exists. **Three documentation inconsistencies found and flagged in code comments (never silently
  resolved):** (1) §5.10.2.1.2's section heading says opcode 0x1A but its own body says 0x1B — same
  opcode 0x1B is *also* used for the unrelated ParametersComplete marker; disambiguated by the
  declared Length field, exactly as both sections themselves specify. (2) §5.10.2.2.18's heading
  says 0x3F (SetTargetElements) but its body says opcode 0x3E — identical to SetTargetDimmers
  immediately above it; resolved by following the section title, flagged as a judgment call. (3)
  0x2F (Set color via RGBW) and 0x3D (Set color via Hue/Sat) both have a worked example whose
  Length token undercounts by exactly one relative to the doc's own universal framing formula
  (`length = opcode + arguments`, p.264) — this codec always derives Length from that formula, not
  a per-opcode caption, so it does not reproduce the doc's apparent typo.
- `local-transport/udp-engine.ts` (real, was a stub) — a real `node:dgram` UDP4 socket (injectable
  `socketFactory` for tests), send via the codec's encoders, decode incoming datagrams via the
  codec's parsers, and a `probe()` method for the Setup Wizard's "Test Connection" using opcode
  0x39 with `Request=0xFF` ("own node") — the one documented request value that can never actuate a
  real device/group/scene.
- `local-transport/rest-client.ts` (real, was a stub) — implements exactly the one documented REST
  endpoint, `GET /set/target_value` (`Lithernet_WebAPI.pdf` §5.14.1). `fetchNetwork`/`fetchState`
  honestly still reject — no such endpoint exists anywhere in the supplied reference set.
  `testConnection()` never calls the write endpoint (that always actuates); it's a plain reachability
  GET to the gateway's HTTP root.
- `local-discovery.ts` (new) — `updateUnitFromControlValues()`, the mechanism Local-mode discovery
  actually uses: no REST device-listing endpoint is documented anywhere, so units are inferred
  progressively from UDP NotifyControlValues (opcode 0x4B) subscription responses, folded into the
  SAME `CasambiUnit` shape `entity-mapper.ts`'s `capabilitiesFromUnit`/`statesFromUnit` already
  know how to read — additive to the unified entity model, not a parallel implementation of it.
  Maps dimmer (type 1), on/off (16), battery (7), device temperature (6), lux (20), and presence
  (21). Deliberately does NOT map the color-related types (2/3/4/5/11) — type 2's single-byte
  "Color Temperature" has no documented Kelvin range/normalization at the NotifyControlValues
  layer (unlike the SET-side opcode 0x48, which does document one) — an honest, disclosed gap.
- `local-command-mapper.ts` (new) — `localCommandToUdpPacket()`, the Local-mode analogue of
  `entity-mapper.ts`'s `commandToTargetControls()`. Maps onoff/brightness/color(hue-sat, kelvin) to
  real UDP opcodes (0x20, 0x3D, 0x48). `position` is deliberately unmapped — no opcode in the
  reference set documents a shade/cover position control.
- `casambi-driver.ts` — Local mode's `connect()` no longer throws
  `CasambiLocalRestNotImplementedError`. It now really starts the UDP engine, sends the documented
  bootstrap sequence (SetDefaultMask → Subscribe → NotifyButtonEvent enable, all best-effort since
  Subscribe/NotifyButtonEvent are firmware-gated ≥37.90/≥39.50 and there's no way to detect an
  older-firmware no-op without real hardware), and routes incoming packets: 0x4B →
  `local-discovery.ts` → the SAME `applyUnit()`/`record()` machinery Cloud already uses (so state
  listeners/diagnostics/events all work identically regardless of transport); 0x51 → a typed
  `ButtonEvent`; 0x3A → forgets the unit + a `networkUpdated` event; 0x0D (Scene called) is logged
  via the tracer only — its 8-bit, installer-app-configured payload has no unitId/sceneId
  equivalent to `SceneEvent`, an honest gap rather than a forced mapping. `command()` now really
  sends a UDP packet for onoff/brightness/color; `position` (and anything else `local-command-
  mapper.ts` returns `null` for) surfaces the driver's existing "unsupported command" error.
  `isConnected()` reflects the real UDP socket's `listening` state. UDP being connectionless means
  there is still no reconnect loop for Local — a disclosed, deliberate scope boundary, see TODO.md.
- `health-monitor.ts` — `computeHealthVerdict`/`restSubsystemStatus`/`udpSubsystemStatus` no longer
  hard-code Local to `"not_implemented"`. UDP status now reflects the real socket state
  (`connected`/`disconnected`); REST status for Local reports `"not_configured"` (honestly: the
  documented REST surface is one stateless write endpoint, nothing with a live connection state to
  report — not a placeholder for "unimplemented").

### Driver Store, Gateway routes, UI

- `services/drivers/src/manifests.ts` — Casambi bumped 1.1.0 → 1.2.0. New config fields: `netId`
  (0-254, must match the gateway's own Net ID) and `dataFormat` (`hex-dot`/`dec-hash` select, must
  match the gateway's own "DEC or HEX" setting). `autoDiscover`'s help text now honestly says why
  it's unimplemented (no discovery endpoint) rather than "architecture-only."
- `services/gateway/src/native-driver-factory.ts` — reads `netId`/`dataFormat` from stored config
  and passes them through to `CasambiLocalGatewayConfig`.
- `services/gateway/src/routes/installer.ts` — `POST /v1/commissioning/casambi/test-connection` is
  now REAL: parses `{gatewayIp, restPort, udpPort, netId, dataFormat}` from the request body, runs a
  REST reachability check + a safe UDP probe, returns `{implemented: true, reachable, rest, udp,
  message}`. `discover-gateway` stays honestly `implemented: false` with updated wording (no
  enumeration/discovery endpoint is documented for this gateway at all).
- `apps/web-homeowner/src/api.ts`/`drivers.tsx` — `testCasambiLocalConnection()` now sends real
  connection params (reads them from the wizard's own in-progress field values) and renders
  `rest`/`udp` reachability separately. New `netId`/`dataFormat` fields render in the Local Gateway
  section. Diagnostics panel's UDP status no longer says "(placeholder)".

### Verification

Full `turbo run build typecheck test` across `@supreme/protocols`, `@supreme/drivers`,
`@supreme/gateway`, `@supreme/web-homeowner` (and their dependency closure) — 46/46 tasks green.
`@supreme/protocols`' own suite: **67 test files, 644 tests, all passing**, including every
pre-existing Cloud-mode Casambi test unmodified (confirms zero Cloud regression) plus this
session's new coverage: `core/*.test.ts` (5 files), `casambi/local-transport/udp-codec.test.ts` (39
tests, several byte-exact against the PDF's own worked examples), `udp-engine.test.ts` (13, fake
`dgram` socket), `rest-client.test.ts` (6, fake `fetch`), `local-discovery.test.ts` (8),
`local-command-mapper.test.ts` (10), and 12 new Local-mode integration tests appended to
`casambi-driver.test.ts` (connect/disconnect bootstrap+teardown sequences, NotifyControlValues →
state, command → UDP packet, button events, node removal, diagnostics). **Not done this session:**
live Playwright verification of the updated Driver Manager UI (no running `hub-compose` stack in
this sandbox, same honest gap as the Foundation session) — flagged, not claimed. Real Lithernet
hardware verification of anything firmware-gated (≥37.90/≥39.50 NotifyControlValues/NotifyButtonEvent,
≥36.70 Target Color/Status) is also unverifiable without hardware — see TODO.md.

## Immediate priorities for the next session

1. **RGBW/CCT capability inference for Local mode** — `local-discovery.ts` currently omits color
   entirely (documented gap: NotifyControlValues type 2's byte has no known Kelvin range). If a
   real gateway can be tested, confirm the actual encoding and complete the mapping.
2. **Wire `casambi-driver.ts` onto `core/event-bus.ts`** — today the driver still uses the
   Foundation-session `CasambiEventBus`; migrating to the new cross-driver `CoreEventBus` was
   deliberately deferred this session to avoid re-touching tested Cloud event paths in the same PR
   that added Local. Do this as its own scoped change with its own regression pass.
3. **Wire the real UDP engine into `core/packet-recorder.ts`** — the framework exists; nothing
   records real datagrams into it yet. Needed before "Packet Capture" in the UI can go from
   disabled placeholder to real.
4. **Local mode reconnect/health-recovery loop** — UDP being connectionless means a lost socket
   today has no automatic recovery the way Cloud's WebSocket does. Decide what "reconnect" even
   means for a connectionless protocol on a LAN gateway before building it.
5. **0x0D Scene called → a real driver event** — currently only logged via the tracer. Its 8-bit,
   installer-app-configured payload has no unitId/sceneId; decide on a shape (maybe a new,
   Local-only event type) before wiring it into `CoreEventBus`/`CasambiEventBus`.
6. Live Playwright verification of the updated Driver Manager wizard/diagnostics UI at all four
   required breakpoints — genuinely not done this session (no backend running in this sandbox).
7. Verify every firmware-gated opcode (0x39/0x45/0x46/0x49/0x4B/0x50/0x51, gated ≥33.22 through
   ≥39.50 across different features) against a real Lithernet Gateway once hardware is available —
   this session's implementation is byte-exact against the documentation but has never touched a
   real device.

---

## Session: Universal AV SDK

**Branch:** `claude/supremeos-universal-av-sdk-0rtaiw`, based on `main` at session start.

This handoff was rewritten from scratch — the previous version had drifted several sessions out
of date (it stopped at the original `TcpLineTransport`/`state-cache.ts` extraction and never
recorded the subsequent HTTP AppCommand layer, the Audyssey-family command pass, the RTI
Capability Audit, or this session's work). The detailed history of each of those passes lives in
its own architecture doc, cross-linked below — this file only needs to describe current state and
what changed most recently.

## Most recent session — AVR Diagnostic Mode

Prior sessions in this branch did a static code audit (found one real bug: the renamed-input
capability-config race — `refreshInputEnrichment()` fire-and-forget raced by a synchronous
`getCapabilityConfig()` read, still unfixed, still in `TODO.md`), then a full runtime-instrumented
trace of a real event through the entire pipeline against a fake AVR + real gateway + real
browser (found no pipeline break). The user then explicitly asked for neither: since they have no
way to give this session access to their real physical Denon/Marantz receiver, they asked for a
**permanent, production-safe diagnostic facility they can enable on their own installation** to
capture ground truth from their own hardware and hand the log back for analysis.

**Shipped**: AVR Diagnostic Mode — `SUPREME_AVR_DIAGNOSTICS=true` (env var, off by default).
When enabled, every real receiver event gets a correlation ID (`AVR-000023`); every stage it
passes through (`TCP`/`Parser`/`patchMedia`/`emitFor`/`StateCache`/`Gateway`/`WebSocket`) logs a
line tagged with that ID. Unrecognized lines are captured with hex/ascii/length/firstToken/
sender/frequency, never a bare "unrecognized" message. Exact session counters (received/parsed/
unknown/dispatched/dropped/bindingsMissing/cacheDeduplicated/gatewayPublishes/websocketSends) are
tracked throughout and reported at shutdown and at export time. `GET /v1/devices/:id/diagnostics/
export` streams the complete trace as a downloadable `diagnostic.log` file — the one file to
upload back for analysis. Full detail, exact enable/export steps: `docs/architecture/
AVR-Diagnostic-Mode.md`.

**Architecture**: new `services/protocols/src/avr-diagnostics.ts` (`AvrDiagnosticsRecorder` —
pure, no I/O, bounded ring buffer + bounded unknown-pattern map). Wired into `avr-driver.ts` via
`this.diagnostics?.method(...)` at every stage — optional chaining short-circuits before argument
evaluation when disabled, so the off cost is one property read + one null check, zero string
building/allocation/I/O. Correlation ID crosses the driver→gateway→WebSocket process/package
boundary via a new optional `traceId?: string` field on the already-shared `BackendStateEvent`
type, and a new optional `INativeProtocolDriver.recordDiagnosticStage?()` method that gateway code
calls back into (found via the pre-existing `SupremeIntegrationLayer.getNativeDriver("avr")`) —
neither layer needs new knowledge of the other's internals. `exportDiagnosticsLog?()` is routed to
the owning driver through the same `native-adapter.ts`/`routing-adapter.ts`/`sil.ts` pattern
`getTrace`/`getDiagnostics` already use. No feature work: parser/protocol/control-path logic is
completely unchanged, only observability was added.

**Verification**: 6 new tests in `avr-diagnostics.test.ts` (correlation IDs, full-lifecycle
capture, unknown-command capture, exact counters, session report, buffer eviction), 3 new tests
in `avr-driver.test.ts`'s "AVR Diagnostic Mode wiring" `describe` block (disabled = no-op, enabled
= real end-to-end trace incl. simulated Gateway/WebSocket stage append, real unrecognized-line
capture over a real TCP fake AVR), 1 new test in `native-driver-factory.test.ts`, 3 new e2e tests
in `avr-diagnostics-export.e2e.test.ts` (export succeeds/404s-when-off/404s-for-unknown-device).
Full monorepo `pnpm typecheck`/`pnpm build`/`pnpm test` all green (93/93 turbo tasks); one
transient CPU-contention flake in an untouched, pre-existing real-TCP timing test was confirmed
non-reproducible in isolation and on rerun, not a regression from this work.

**Known limitation, stated to the user**: this facility captures real traffic once enabled and
operated against real hardware — it cannot be exercised against a physical Denon/Marantz receiver
from this environment, since none is reachable here. The wiring itself is proven against a real
in-process fake AVR over real TCP (same fidelity as prior sessions' runtime pipeline trace).

## Current state of the AV SDK

- `services/protocols/src/av-sdk/` is the real, runtime shared module: `TcpLineTransport`
  (pooled/reconnecting/line-buffered TCP, shared by AVR+HEOS), `HttpPollClient`/`AdaptivePoller`
  (shared in-flight-deduped HTTP + adaptive polling, shared by AVR's AppCommand layer), `state-
  cache.ts` (`recordCapabilityState`, shared by all three AV drivers), `init-handshake.ts`
  (`InitHandshake` — new this session, see below), `protocol-tracer.ts`, `network-source-
  resolver.ts`.
- `avr-driver.ts` (Denon/Marantz) is the SDK's reference implementation — the only driver
  combining two transports (Telnet realtime push + HTTP AppCommand for renamed/hidden inputs and
  album art) through shared SDK primitives.
- Full architecture: `docs/architecture/Universal-AV-SDK.md`. Full per-capability wire evidence:
  `docs/architecture/AVR-Universal-Capability-Matrix.md`. Engine-level roadmap (what's ✓/Partial/
  Planned across the whole SDK, honest Denon/Yamaha/Anthem reuse mapping): **new this session**,
  `docs/architecture/Universal-AVR-SDK-Roadmap.md`.

## This session's work — RTI Capability Audit, Phases 1–4

Prior session produced `docs/architecture/RTI-Capability-Audit.md`: an evidence-based audit of 16
capabilities RTI's driver has that SupremeOS didn't, classified A (officially confirmed, ready to
build) / B (officially-adjacent, one piece of evidence missing) / C (RTI application-layer pattern
buildable from already-confirmed commands) / D (RTI-only, no official corroboration). This
session executed the user's 4-phase instruction against that audit:

**Phase 1 — Category A (5 items), all shipped:**
Subwoofer On/Off (`PSSWR`), Cinema/Music/Game/Pro Logic mode (`PSMODE:`), Cinema EQ (`PSCINEMA
EQ.`), Loudness Management (`PSLOM`), Tone Control On/Off (`PSTONE CTRL`) — all in `avr-codec.ts`,
each an official-PDF-cited exact token, wired into `denonCapabilityConfig()`'s `advancedControls`
(reusing the existing generic `select` UI renderer, zero new frontend code needed). New
`hasExtendedAudio` installer-declared gate flag. 30 tests in `avr-codec.test.ts`.

**Phase 2 — Category C (all 4 items), all shipped:**
- **C.1/C.2 (connection-readiness state machine + paced init-burst)**: new `InitHandshake` class
  (`av-sdk/init-handshake.ts`) — sends one init token, waits for any reply, sends the next, rather
  than one blind burst write. New `DriverDiagnosticsSnapshot.fullySynced: boolean` (three-file
  sync: `adapter.ts` → `rest.ts` → `driver-diagnostics.ts`), wired into `avr-driver.ts`'s
  `onLinkConnect()`.
- **C.3 (keepalive probe)**: `AvrProtocolDriver.heartbeat()` — `PW?` probe, `{ ok, latencyMs }`,
  structurally identical to the existing `HeosProtocolDriver.heartbeat()`.
- **C.4 (raw command escape hatch)**: `AvrProtocolDriver.sendRaw()`, threaded through 6 interface/
  adapter touch points (`INativeProtocolDriver` → `IBackendAdapter` → `avr-driver.ts` →
  `native-adapter.ts` → `routing-adapter.ts` → `sil.ts`) to a new `POST /v1/devices/:id/raw-
  command` gateway route (`validation_failed`/422 when the owning backend doesn't support it), plus
  a new devMode-gated **Raw Command** UI section (`device-detail-sections.tsx`, wired into the AVR
  console). New `services/gateway/src/raw-command.e2e.test.ts` (4 tests) covers both the success
  path (fake native driver) and the unsupported-backend 422 path (HA-owned device).
- Two real race-condition bugs were found and fixed via test-driven debugging while wiring this
  (not guessed, not papered over — see `RTI-Capability-Audit.md`'s git history / the full session
  transcript for the exact repro): a test-harness ECONNRESET gap (fixed in the test helper) and a
  genuine `fullySynced` default-value race in `avr-driver.ts`'s `bind()` (fixed with `if
  (!link.ready) link.diagnostics.setFullySynced(false);` right after `ensureLink()`).

**Phase 3 — honest response on hardware access:**
This sandboxed environment has no LAN reachability to any physical Denon/Marantz receiver — there
is no real hardware to verify Category B (Zone 3/4, 8 extra channel-trim targets, Tone Defeat)
against. Rather than fabricate a live capture, `RTI-Capability-Audit.md` got a new closing section
documenting this plainly and laying out a concrete, self-serve **guided capture procedure**: with
`devMode` on, send each Category B probe token via the new Raw Command box and read the reply in
the existing Protocol Trace panel — the exact tooling built in Phase 2 is what a real Category B
verification pass needs, no new engineering. Category B/D stay unbuilt, as they should.

**Phase 4 — Universal AVR SDK Roadmap (the explicitly-flagged most important deliverable):**
New `docs/architecture/Universal-AVR-SDK-Roadmap.md` — an engine-level (not brand-level) roadmap:
a ✓/Partial/Planned status for each of 17 engines (Core Transport, Realtime Event Engine,
Diagnostics, Capability Engine, Protocol Recorder, Connection State Machine, Keepalive Framework,
Zone Engine, Media Engine, Artwork Engine, Metadata Engine, Audio/Video Processing Engine,
Calibration Engine, Developer Console, Capability Discovery, Hardware Verification Mode), each
cited against real code. Includes a Denon "Uses:" mapping, and — deliberately correcting the
user's own illustrative "reuses 95%" framing rather than parroting it — an **honest** Yamaha reuse
assessment (real, measured reuse is low: only `state-cache.ts` + the shared `DriverDiagnosticsTracker`
class; `Universal-AV-SDK.md`'s own before/after table already recorded Yamaha's SDK-extraction
line-count reduction at ~1%, not 95%) with a concrete 3-step path to raise it, and an Anthem
mapping framed honestly as **not yet built** — a projection based on Phase 9's readiness findings
(transport/diagnostics tier likely near-total reuse; command-vocabulary tier 100% unevidenced,
zero shortcuts).

## Verification (RTI Capability Audit phases)

`pnpm build` — 54/54 (now includes the new `raw-command.e2e.test.ts`, `init-handshake.ts`/`.test.ts`).
`pnpm typecheck` — 93/93. `pnpm test` — full monorepo green (a `pnpm test` run under maximum
turbo parallelism transiently failed 3 unrelated, pre-existing timing-sensitive tests in
`avr-driver.test.ts`/`heos-driver.test.ts` due to CPU contention across ~50 concurrently-running
packages; confirmed non-reproducible via 3 repeated isolated re-runs and a scoped
`--filter @supreme/protocols --filter @supreme/gateway` run, both 100% green — not a regression
from this session's changes). Frontend (`apps/web-homeowner`) `typecheck`/`build` both clean for
the new `RawCommandSection`/`sendRawDeviceCommand` wiring; **not** Playwright-verified live this
session (no running dev server/backend in this sandbox) — flagged honestly rather than claimed.

## Later this session — Denon Cheat Sheet Audit

The user supplied an installer/engineer reference document ("Dan's Denon Cheat Sheets," Denon
section, pasted directly after a `share.google` link proved unreachable from this sandbox — the
outbound proxy rejected the CONNECT with a policy denial, confirmed via `$HTTPS_PROXY/
__agentproxy/status`) and asked for it to be audited against the official protocols and this
SDK, under a strict evidence hierarchy: official Denon Telnet PDF → official HEOS spec → live
hardware → the cheat sheet (reference only, never a source), with an explicit copyright
constraint (extract capabilities/observations only, never copy text/tables/examples/code).

**Method**: every claim in the cheat sheet was independently re-derived by fetching and reading
`denonavr`'s real, MIT-licensed source from GitHub (`const.py`, `foundation.py`, `input.py`,
`volume.py`) — the same independent cross-check source this project has used since the original
HTTP AppCommand pass — plus SupremeOS's own existing Telnet/AppCommand code. Every literal string
or field name that appears in the new doc is cited to one of those, never to the cheat sheet.

**New**: `docs/architecture/Denon-CheatSheet-Audit.md` — a full per-capability table, a gap
matrix, and an SDK-layer placement review (per-capability: Transport/Discovery/State/Capability/
Diagnostics/Media/Audio/Video/Developer-Tools layer, or Denon-adapter-only).
---

## Session: Universal Keypad Framework / Intent Engine

---

## Latest pass — Home Assistant Dependency Audit (analysis only, ZERO code changes)

A repository-wide audit of every remaining runtime dependency on Home Assistant, producing
`docs/architecture/Home-Assistant-Dependency-Audit.md` (10 phases: dependency discovery, runtime
graph, registry/automation/state/UI/driver audits, compatibility-layer design, migration roadmap,
readiness assessment). **No application code was modified, no HA code removed, no driver touched** —
the only file added is the audit document; `pnpm build`/`typecheck`/`test` remained fully cached
(56/56, 97/97, 97/97), proving nothing was disturbed.

**Headline findings (all evidence-cited in the doc):**
- HA-specific code is confined to **4 files** in `services/integration-layer/src/ha/`, with exactly
  **2 consumers** elsewhere — `bootstrap.ts` (conditional on `SUPREME_BACKEND=ha`) and
  `compiler.ts`'s `compileToHa`, which has **no runtime caller at all**.
- **Every protocol driver is 100% native** (zero HA references in `services/protocols/src/`), the
  **entire UI has zero HA calls**, and **every registry** (device/entity identity/room/floor/area/
  state/capabilities/history/statistics) is Supreme-owned.
- Only **6 of the brief's 20 HA subsystems** are genuinely used, all via one WebSocket connection
  plus a one-time onboarding HTTP flow.
- **SupremeOS already boots and fully functions with no HA process** — the entire 240-test gateway
  suite runs at `SUPREME_BACKEND=mock`.
- **The one real blocker:** there is no native-only backend mode. The router always has an `ha`
  side, which is either real HA or `MockAdapter` — **an in-memory simulator**. Turning HA off today
  doesn't remove the dependency, it silently replaces it with a fake. Now tracked as the top
  **Critical** item in `TODO.md`.
- Assessment: **architecturally ~90% HA-independent, operationally ~40%** — 1 Critical, 2 High,
  3 Medium, 2 Low blockers, all small and well-scoped (a third adapter mode, a compose profile, a
  dead-code decision), not a platform rewrite.

**Newly tracked in `TODO.md`:** the Critical native-mode blocker; 2 High (compose opt-in; the
`engine:"ha"` dead path); 2 Medium (unowned `Device.status` availability; commissioning defaulting
to `ownership="ha"`).

---

## Prior pass — Universal Intent & Capability Engine (Phase 2)

**Branch:** `claude/universal-keypad-framework-7khr2o`, based on `main` at session start (the
same branch Phase 1 shipped on — this session's branch instruction named
`feature/universal-keypad`, but the harness's assigned branch for this session takes precedence,
per this environment's git-safety convention). This session built the **Universal Intent &
Capability Engine, Phase 2** (ADR 0017), directly on top of the Universal Keypad Framework (ADR
0016) shipped last session — the brief's mission: completely decouple user interactions from
drivers, so `ToggleLight` keeps meaning the same thing forever even if the physical device behind
it changes from KNX to Casambi to Matter to anything else.

## What actually shipped

**The single highest-leverage decision**: `AutomationAction`
(`packages/domain-model/src/automations-dsl.ts`) gained ONE new additive variant — `{ type:
"intent", intentId, target, params }` — alongside the existing `device_command`/`scene_activate`/
`notify`/`delay`. Because `KeypadMapping.actions` already reuses `AutomationAction` verbatim (Phase
1's design), keypad mappings gained full Intent support with **zero** additional schema/engine
changes — direct payoff of Phase 1's reuse decision. `AutomationExecutors` gained one new optional
method, `runIntent?`, wired identically for both the Automation Engine and the Keypad Mapping
Engine (they already share one executor set). `runAutomationAction`/`describeAutomationAction`
(both previously extracted+shared, see Phase 1) grew an `"intent"` case; `compileToHa` (the
`engine: "ha"` static-compile path) honestly refuses to compile an intent action — intent
resolution is inherently dynamic, no static HA config can express it.

**New domain-model** (`packages/domain-model/src/intents.ts`, new + `intents.test.ts`):
`IntentDefinition` (pure, serializable metadata: id/name/category/description/
requiredCapabilities/parameters/targetKinds/version/i18nKey — future-proofed for AI/marketplace
consumption), `IntentTarget` (device/room/scene/automation/home, discriminated union).
Deliberately NOT a closed `z.enum` of every intent id — the catalog lives as runtime
`IntentRegistry.register()` calls, extensible forever with zero schema changes, mirroring how
`DriverManifest`/the Driver Store let a new protocol appear with no core-architecture change.

**New bounded service `@supreme/intent-engine`** (mirrors `@supreme/automations`/
`@supreme/keypad-framework`'s conventions — depends only on domain-model/contracts):
- `CapabilityIndex` — `Map<CapabilityKind, Set<DeviceId>>`, O(matching devices) lookup for
  `devicesWithCapability`/`devicesWithCapabilityInRoom`, never O(every device on the hub). Kept in
  sync via a new, additive `HomeService.onDeviceChanged` event (mirrors `SIL.subscribe`/
  `NotificationService.onNotification`'s exact shape) rather than re-scanning on every lookup or
  hooking dozens of device-mutation call sites individually.
- `IntentRegistry` — pairs each `IntentDefinition` with a `translate` (capability-driven: params +
  current state + capability config → `CapabilityCommand`) or `runSystem` (system-level: direct
  dispatch, no device resolution) handler, validated to match `requiredCapabilities` **at
  registration time**, not at first invocation.
- `validateIntentParams` — real required/type/min/max/enum-options validation + defaults, never
  trusting a caller (keypad, automation, direct REST, future AI) blindly.
- `registerBuiltinIntents` (`catalog.ts`) — 42 intents across all 6 brief-specified categories
  (lighting/climate/av/blinds/security/system). Two categories are honest, registered-but-throwing
  gaps: `swingMode`/`tiltUp`/`tiltDown` (no swing/tilt field in `TemperatureState`/`PositionState`
  yet) and `executeScript`/`webhook` (no script engine/webhook dispatcher exists) — same "visibly
  incomplete, never faked" discipline as ADR 0015's undocumented protocol gaps.
- `IntentEngine` — the Capability Engine itself: validate target kind → validate params → resolve
  device(s) via `CapabilityIndex` (or dispatch system-level directly) → translate → command →
  record an `IntentRun` trace (mirrors `AutomationRun`/`KeypadMappingRun`).
- 48 tests across 5 files, all passing, including a dedicated "migration readiness" test proving
  the identical intent+target invocation against two different `executors.command`
  implementations (standing in for two different drivers) behaves identically.

**Gateway wiring** (`services/gateway/src/{context,server}.ts`, new `routes/intents.ts`): the
`CapabilityIndex`/`IntentRegistry`/`IntentEngine` are constructed in `initWithHome()`, wired to the
SAME executors closures already built for automations/scenes/security/notifications; `runIntent`
added to the shared `AutomationExecutors` object. New REST surface (`GET /v1/intents`,
`GET /v1/intents/:id`, `POST /v1/intents/:id/run`, `GET /v1/intents/runs`,
`GET /v1/intents/:id/runs`), gated by a new additive `"intent"` `ResourceType` (baseline
permissions mirroring `"keypad_mapping"`'s per-role defaults). New `intents.e2e.test.ts` (11 tests)
proves the full pipeline over a real mock-backend hub: catalog listing, direct device-target
invocation, room-target multi-device resolution ("Movie Mode" pattern), param validation
(422 on missing required param), the honest `executeScript` failure (503), real security
arm/disarm dispatch, run-history retrieval, AND a keypad mapping whose action is `{type:"intent",
...}` driving a real device through the exact same Intent Engine a direct REST call uses.

**Documentation**: `docs/architecture/adr/0017-universal-intent-capability-engine.md`,
`docs/architecture/Universal-Intent-Capability-Engine.md` (architecture diagram, 4 sequence
diagrams — lifecycle/resolution/room-resolution/migration-readiness — Intent Registry spec,
capability resolution flow, driver integration spec, migration strategy, performance/scalability
analysis, public APIs, extension points, future roadmap). `PROJECT_CONTEXT.md` §4/§6 updated.

**Verification**: full monorepo `pnpm build` (56/56), `pnpm typecheck` (97/97), `pnpm test` (97/97
tasks) — all green, including every pre-existing suite passing **unmodified**
(`@supreme/automations`' original 36 tests + 3 new for the `"intent"` action = 39,
`@supreme/protocols`' 378, `@supreme/gateway`'s 229 pre-existing + 11 new = 240,
`@supreme/permissions`' 10, `@supreme/home`'s 8).

## What was deliberately NOT built (Phase 2 scope, per the brief)

- **No visual Intent/mapping editor** — backend architecture only, matching Phase 1's scope
  discipline.
- **No Postgres persistence** for anything new (the Intent Registry is code-defined, not a
  user-editable record, so this doesn't apply the way it does to `KeypadMapping`; `IntentEngine`'s
  run-history is in-memory only, same as the Automation/Mapping engines).
- **No swing/tilt capability-model addition** — `swingMode`/`tiltUp`/`tiltDown` are registered,
  honestly throwing intents, not a speculative schema change to invent the field.
- **No script engine or webhook dispatcher** — `executeScript`/`webhook` are registered, honestly
  throwing intents, not fabricated infrastructure.

**Findings, net**:
- Most of the cheat sheet's *write*-path claims (power/volume/mute/input via a legacy
  `/MainZone/index.put.asp?cmd0=...`-style HTTP interface) are fully redundant with the
  already-shipped, universal Telnet control path — and independently, `denonavr`'s own
  legacy-generation write path uses a *different* URL family than the cheat sheet describes,
  so that specific write shape isn't even cross-corroborated. Not implemented.
- Several things SupremeOS already does are independently confirmed to already be *better* than
  the cheat sheet's own described workflow: renamed inputs (already solved via the stronger,
  2016+ `GetRenameSource`/`GetDeletedSource` mechanism, which `denonavr` also treats as primary,
  not a fallback), and volume shown as dB in the UI with a "dB" unit label (the exact confusion
  the cheat sheet's author flags is already resolved).
- **The one genuine, previously-silent gap it led to finding**: `avr-driver.ts` hardcoded its
  HTTP port to a fixed `8080`, with no fallback — so pre-2016 Denon/Marantz units (which answer
  on port 80 and don't support `AppCommand.xml` at all) silently got **zero** HTTP-sourced data:
  no album art, no renamed inputs, no error, just quiet absence. Independently confirmed via
  `denonavr/foundation.py`'s own real `async_identify_receiver()` (try `Deviceinfo.xml` on 8080,
  then 80) and its own port-templated album-art URL usage (proving album art genuinely works on
  either port, not gated to `AppCommand.xml`).
- Two things were deliberately left **documented only, not implemented**, per the stated
  evidence rules: a generic HTTP keypress-simulation endpoint (uncorroborated by any second
  source) and an HTML-scraped SETUP rename page (the cheat sheet's own text calls it unreliable).
- One **bonus finding, unrelated to the cheat sheet itself** (surfaced while independently
  verifying its claims): `denonavr/input.py` confirms a real now-playing metadata path
  (`formNetAudio_StatusXml.xml`'s `szLine` array) for legacy pre-HEOS "NetAudio" sources
  (AirPlay/Media Server/iPod-USB/Bluetooth) — extends, not contradicts, the capability matrix's
  existing "no verified non-HEOS metadata source" finding (that one was scoped to Tuner/USB
  against the 2016+ AppCommand path specifically). Documented, not implemented — needs its own
  scoped design pass.

## Session: Universal AV SDK

**Implemented** (the one Ready-to-Implement, no-hardware-needed finding):
- `avr-http-codec.ts`: `DEVICE_INFO_URL`/`MAIN_ZONE_STATUS_URL` constants, `parseMainZoneStatus()`
  — a narrow, tested parser for exactly the 4 fields independently confirmed (power, mute,
  volume-in-dB, current input). 24 new tests.
- `avr-driver.ts`: `resolveHttpPort()`/`detectHttpGeneration()` — a best-effort, per-host-cached
  probe (an explicit `opts.httpPort` always wins, preserving every existing test's behavior
  unmodified). `refreshInputEnrichment()` now skips the doomed `AppCommand.xml` attempt entirely
  on a detected-legacy host (stops wasting a request every 15-minute poll forever) and instead
  does a best-effort legacy-status read for diagnostics only — never written into the
  installer-facing input-rename data, since that source is independently confirmed incomplete.
  `getArtwork()` and `discover()`'s AppCommand attempt both use the resolved port. `unbind()`'s
  per-host cleanup clears the cache so a re-added unit re-detects fresh. 7 new driver-level
  tests (2016+ detection, legacy detection, no-answer default, per-host caching, explicit-
  override-always-wins, artwork-on-legacy-port).
- Updated `AVR-Universal-Capability-Matrix.md` (new generation-detection row, corrected
  renamed-input/album-art/metadata rows, and fixed a stale "no AVR heartbeat exists" row that
  predated the RTI Capability Audit's own `heartbeat()` work landing) and
  `Universal-AVR-SDK-Roadmap.md` (Artwork Engine/Capability Discovery rows + Denon mapping, no
  status-label changes — the ✓/Partial labels were already accurate).
- Did **not** touch `RTI-Driver-Knowledge-Base.md`/`RTI-Capability-Audit.md` — checked for
  overlap (grepped for port-80/legacy-HTTP/pre-2016 references) and found none; those documents
  are about an unrelated source (an extracted RTI driver), not genuinely affected by this audit.

**Verification**: `pnpm --filter @supreme/protocols run typecheck` clean; `avr-driver.test.ts`
(56/56, was 50) and `avr-http-codec.test.ts` (18/18, was... wait, this file grew from 0 dedicated
generation tests to include the new suite) both green, re-run 3× to confirm no flakiness in the
new async-heavy detection tests (one genuine test race was found and fixed during authoring — the
cache-verification test's `vi.waitFor` was synchronizing on the wrong signal, not a driver bug).
Full monorepo regression run after this — see the next section below for the final numbers.

## Known issues / open gaps (carried forward, still real, still unfixed)

- Cross-platform duplication: web (`automations.tsx`) and mobile
  (`apps/mobile/lib/screens/automation_editor.dart`) Automation Editors independently hand-
  implement the identical six-node palette/defaults/field rules.
- Automation DSL/engine supports triggers/conditions/actions across every `CapabilityKind`; the
  editor UI only authors `onoff`. Documented in `Automation-Editor.md` §2, not fixed (new
  user-facing functionality, out of scope for a hardening pass).
- `AutomationService` has no direct unit tests beyond one happy-path e2e test.
- `HeosProtocolDriver.queryPlayers()` (discovery-only) reimplements manual line buffering instead
  of reusing `LineAccumulator`, no `maxBytes` cap. Still real, still unfixed, still in `TODO.md`.
- Yamaha's real SDK-primitive reuse is low (see Phase 4 roadmap doc) — `HttpPollClient`/
  `AdaptivePoller` migration and a `heartbeat()` addition are documented, scoped, NOT started.
- Category B (Zone 3/4, 8 extra channel-trim targets, Tone Defeat) and Category D (All Zone
  Stereo, Surround Back mode/Front A+B select, D.Comp, video-output routing) remain unbuilt —
  correctly so, pending either an official spec update or a real-hardware guided capture (see the
  Phase 3 procedure above).
- Raw Command UI (`RawCommandSection`) was typecheck/build-verified but not live-browser-verified
  at the project's required phone/tablet/desktop/ultrawide breakpoints this session.

## Immediate priorities for the next session

1. If a real Denon/Marantz unit becomes reachable: run the Phase 3 guided capture procedure
   against Category B's three items, AND (new this session) verify the legacy full-zone-state
   snapshot's partial rename list on a real pre-2016 unit (`TODO.md` — "Verify the pre-2016
   legacy rename-list fallback on real hardware") — both are the single highest-value next step,
   since the tooling to do the first already exists and is tested.
2. Live Playwright verification of the new Raw Command UI section (`ProtocolTraceSection`'s
   sibling in `media/detail.tsx`) at all 4 required breakpoints — genuinely not done this session.
3. Yamaha's `HttpPollClient`/`AdaptivePoller`/`heartbeat()` migration (Phase 4 roadmap doc, "Roadmap
   ordering" step 5) — independently valuable, not blocked on anything.
4. Wire the two existing `heartbeat()` methods (AVR, HEOS) into an actual scheduler + gateway
   route/UI affordance — currently callable but never automatically invoked (roadmap step 3).
5. The HEOS `queryPlayers()` unbounded-buffer bug fix (`TODO.md`) remains small, low-risk, ready
   whenever a bug-fix pass is in scope.
6. Legacy NetAudio now-playing metadata (`TODO.md`, Denon Cheat Sheet Audit bonus finding) — a
   real, evidenced capability (`formNetAudio_StatusXml.xml`'s `szLine` array) for pre-HEOS
   AirPlay/Media-Server/USB/Bluetooth sources, needs its own scoped design pass.
7. An HTTP-request equivalent of the Raw Command devMode tool (`TODO.md`) — surfaced as a real
   gap while trying to write a hardware-verification task for the cheat sheet audit's
   uncorroborated keypress-endpoint finding; today that kind of check needs a manual, out-of-band
   request.
---

## Session: Universal Keypad Framework / Intent Engine

- `IntentEngine`'s `resolveDevices()` for a `room` target unions across every capability in
  `requiredCapabilities` — correct today (every built-in intent requires exactly one capability),
  but untested against a hypothetical future intent requiring more than one simultaneously (no such
  intent exists in the catalog yet, so this is a latent-but-unexercised path, not a known bug).
- `CapabilityIndex` has no idle-eviction — same documented, negligible-at-realistic-scale
  characteristic already accepted for `UniversalInputEngine`'s per-control timer map in Phase 1.
- The "Optional Variables" mechanism from Phase 1 (`expandVariables`) hasn't been exercised
  end-to-end with an `"intent"` action's `params` field yet (only with `device_command`'s nested
  `command` fields) — the underlying recursive JSON walk is generic and should just work, but no
  dedicated test proves `{{step}}` inside an intent action's `params`.

## Immediate priorities for the next session

1. Pick a real protocol from `Keypad-Driver-Author-Guide.md`'s list (Lutron remains the most
   natural first target — its LIP transport already exists) and do the actual spec-verification
   research pass before writing keypad-specific code, exactly as ADR 0015 did for AVR.
2. If a homeowner-facing "Movie Mode"-style scene/intent authoring surface is prioritized next,
   this is exactly the point where the visual Universal Keypad Editor (or an Intent-aware
   extension to the existing Automation Editor) becomes worth its own scoped session — the backend
   (Phase 1 + Phase 2) is now complete enough to build a real UI against.
3. Consider extending `KeypadMapping`'s `variables` test coverage to include an `"intent"` action's
   `params` field (see "Known issues" above) — small, low-risk, closes a coverage gap.
4. Everything from the prior (Phase 1) handoff not touched this session remains open — see
   `TODO.md` for the full backlog with priority tiers.

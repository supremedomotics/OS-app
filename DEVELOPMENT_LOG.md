# Development Log — Supreme OS

Chronological record derived from `git log` (299 commits, `06be8d5` → `14351fa`)
and `docs/production-readiness.md`. Dates are commit dates. For the current
snapshot see [`SESSION_HANDOFF.md`](SESSION_HANDOFF.md); for forward plan see
[`ROADMAP.md`](ROADMAP.md) and [`TODO.md`](TODO.md).

## Completed

### Founding & Phase 0 — Foundations
- `06be8d5` Initial commit
- `4def2bd` Founding technical blueprint + UX references added
- `31d08a3` Monorepo tooling + `domain-model`, `supreme-contracts`, SIL core
- `669a429` Identity + permissions services
- `0252448` API Gateway + WSS — first vertical slice proven end-to-end ("tap a
  light through the full stack")
- `b14280d` SDKs, Aureon design system, Flutter homeowner app
- `579090b` Hub Docker Compose (hidden HA), ADRs, CI, docs

### Phase 1 — Homeowner MVP
- `4a0dbb4` Home, scenes, notifications services + grants/user management
- `258734d` Gateway routes for scenes, users, grants, favorites, notifications
- `cbb4651` Real HA WebSocket transport + hub boot edge
- `ace7148` Postgres persistence (PGlite-verified) wired into the hub
- `b0784bf` Flutter homeowner MVP screens + richer Dart SDK
- `2297d6f` Docs — persistence ADR + README status/verification

### Phase 2 — Installer & Drivers
- `ac5a35d` Signing/licensing primitives + driver SDK
- `34de6ae` Hub Driver Manager + first-party driver catalog
- `ce7d56c` Commissioning + signed backup/restore
- `da537f4` Gateway installer surfaces + installed-driver persistence
- `7c56417` Python protocol-commissioning service + Node scanner bridge
- `518e2aa` TS SDK installer surface + web Installer Portal
- `920ac56` Hub Compose wiring, CI Python job, ADR + README

### Phase 3 — Intelligence & Scale
- `75e4634` Native automation engine + DSL
- `a3c4a62` Energy/analytics + tamper-evident audit log
- `7371c81` AI assistant (deterministic NL → Supreme DSL planner)
- `f822849` Wire automations/energy/audit/AI into the gateway + Python AI
- `c37987d` Security panel + cameras + cloud fleet, wired to gateway
- `8d43c65` Flutter homeowner surfaces (security, assistant, energy)
- `2e292c7` Compose (AI sidecar), CI (ai-py), ADR 0005, README

### Environment/tooling hardening
- `7e31da9` Native toolchains enabled in-environment + durable provisioning
- `37b05d1` Docker made to work within the network policy (mirror + proxy CA)
- `dd75fa3` Flutter end-to-end verified: analyze clean + web build + widget test

### Phase 4 — Native migration
- `ee0d80f` Native migration (strangler-fig): per-domain HA → Supreme
- `acf7b57` Real on-box LLM (llama.cpp) for the AI assistant
- `6e0226b` Follow-up (1/4): stronger on-box LLM + better prompting
- `2c1b081` Follow-up (2/4): cloud Fleet HTTP API + installer-portal page
- `f52a23a` Follow-up (3/4): visual Automation Builder (Flutter)
- `63b822d` Follow-up (4/4): native-migration controls in the installer portal

### Production hardening cycle
- `cc8c25c` Tracked production-readiness checklist + scorecard (living doc introduced)
- `4f1a4bf` Security §1 pass 1: headers, CORS, rate limit, fail-closed config
- `e508b1a` HA §2 pass 1: adapter resilience + live-HA harness
- `da99531` Security §1 pass 2: refresh rotation + revocation
- Subsequent commits build out: MFA/TOTP, observability (metrics/tracing/
  alerts/runbooks), CD pipeline + signed OTA channel, load/soak/chaos harness,
  cloud IaC, Redis/NATS wiring, real protocol drivers (KNX, MQTT, Modbus,
  Matter, Zigbee, DALI, AVR, CoolMasterNet, WiiM, Devialet, Sonos, Ajax, SIP,
  Shelly, AirPlay, Apple TV, Lutron LIP, Tuya), voice/HomeKit/Matter ecosystem
  integrations (ADR 0009–0012), dealer licensing, off-site backup vault.

### Extension Center & platform UX
- `15fca29` / `99847c4` Web/mobile platform navigation shell + Extension
  Center + Discover Devices + Device Manager
- `3814458` / `92ff640` / `499d6f1` / `66e0745` Real extension/device metadata
  replacing placeholders; real host telemetry backend; real device IP/MAC
  capture at discovery
- `00bb19d` / `aae4a7e` / `c3f023b` Building › Floor › Area location hierarchy
  + location-cascade onboarding (web + mobile parity)
- `d6a056e` / `e3b8744` Dashboard redesign: project overview (web + mobile)

### Security Center & account management (critical-path features)
- `73f1739` Auth hardening: brute-force lockout + password policy/strength
- `4bf3f7f` Device Approval: pending-device queue with approve/reject
- `77e5909` Operations command-center: health score + ops cards
- `efb7853` MFA recovery codes: one-time backup codes
- `80383a7` Personal API tokens: long-lived credentials for programmatic access
- `2f37282` Email verification: token flow + verified state
- `9dbd011` Restore Wizard: guided, safe restore UX
- `28bfafa` Device Platform: bulk edit (move/remove) + device clone
- `becd367` Global search / command palette
- `a85e3a4` Passkeys / WebAuthn: passwordless sign-in + credential management
- `e363af7` Settings consistency: unify security sub-sections + code display
- `e2657b1` Favorites: pin devices & scenes, one-tap on the dashboard
- `fc2dd53` Security score: computed posture in the Security Center
- `717ea96` Notification Center + Update Center
- `4149177` Security Center: active-session management + remote logout + login history
- `058988f` Backup: scheduler + dry-run + rollback-safe restore + health indicator
- `158ef0d` Extension Center: release notes, changelog, docs + update-available
- `e85dfd8` Observability: request correlation IDs across logs + traces
- `25e28bb` Automation Debugger: real execution timeline

### UI/UX evolution ("Ovio-minimal" → "Project Aurelia" → "Project Monolith" → craftsmanship)
- `28dec9a` / `e4642d4` / `a7a1dd0` / `6530c77` / `ee5eeb0` Themed icons,
  muted-taupe accent retune, floating icon-only bottom bar (web + mobile)
- `1a1529c` / `2ce4b78` / `9587ffd` Ovio-minimal dashboard, room bands, 5-tab nav
- `a1529cb` / `33432eb` / `190c4db` / `767f6bf` / `ecaad38` Real interior room
  photos (keyless Openverse / Unsplash), designed room-card gradients
- `15029a8` / `448b175` / `c39faa4` / `811162c` **Project Aurelia**: "My Home"
  dashboard redesign + secondary-screen visual polish (web + mobile parity)
- `2c29203` / `7db2924` / `fa6e70e` / `af840b4` / `6b7b68d` **Project Monolith**:
  home redesign ("you enter your home"), warmer language, device-card depth,
  base button styling
- `050839f` / `63b5ff1` / `a18c958` / `421ad1c` / `680cd2c` Typography-as-hero,
  emotional narrative, glyph room summaries, personalized greeting, hero room-
  card rhythm
- `6f8e608` / `22d8354` / `68775c2` / `f05a916` Room cards show live state
  summary; RGBW color wheel + tunable white
- `cfb6454` / `a8c9713` / `7b257c3` / `d556e13` Typography foundation (self-
  hosted Inter) + signature room-card entrance motion (web + mobile parity)

### Latest (most recent commits)
- `391a646`/`92ff640`/`519affb` Switched KNX runtime dependency to
  `knxultimate`, adapted the driver, fixed observer dispatch
- `d556e13` / `7b257c3` Motion: signature room-card entrance + tactile press
- `b7b9b32` Use frozen pnpm lockfile in gateway Docker build (build reliability)
- `14351fa` Restore Flutter android + ios platform folders (buildable, no
  manual setup) — **most recent commit**

## Current work

Per `docs/production-readiness.md`, the active focus area is the **security
hardening → real HA integration** critical path, plus continued UI
craftsmanship (typography, motion) on the homeowner surfaces. The most recent
commits are stabilizing the KNX driver's runtime dependency (`knxultimate`)
and Flutter's native platform folders — both build/toolchain reliability work
rather than net-new features.

## Known issues / tech debt

See [`TODO.md`](TODO.md) for the itemized, prioritized backlog. Highlights
pulled from `docs/production-readiness.md`:

- No lint/CI boundary yet forbidding HA-specific imports above the SIL (ADR
  0001 calls for one; only the e2e "no HA identifiers leak" assertion exists
  today).
- Sealed secret store is partial (`*_FILE` convention works; no full vault/age
  integration).
- No mTLS on the hub↔cloud tunnel yet.
- Per-command authorization re-check at services (defense in depth) is only
  partially done at the gateway.
- `packages/domain-model/src/ids.ts` uses `Math.random()` for ULID entropy —
  flagged as low-priority in `docs/security-review.md` (IDs aren't used as
  security tokens today, but `crypto.randomBytes` would remove the risk if
  that ever changes).
- Casambi driver not implemented (needs official Cloud API access).
- No app-store signing pipeline with real credentials; no real-hardware
  multi-hour soak; no third-party penetration test.
- Real credential/hardware wiring for Alexa/Google/HomeKit/Matter dispatch is
  the last-mile boundary on every ecosystem integration (each is otherwise
  fully built + tested against fakes).

## Upcoming work

Per the production-readiness critical path (in order):
1. Finish security hardening (§1): mTLS tunnel, secrets never logged, pen test.
2. Harden real HA integration (§2): discovery breadth, headless-hardening
   verification, real-device round-trip regression.
3. Wire Redis/NATS for real multi-process scale in production deployments.
4. Cloud IaC + CD + observability maturity.
5. Real drivers/protocols breadth (Casambi) + remote-access relay hardening
   (mTLS, real FCM/APNs/WebPush creds).

See [`ROADMAP.md`](ROADMAP.md) for phase-level framing.

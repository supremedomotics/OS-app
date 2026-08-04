# TODO.md — SupremeOS Engineering Backlog

> Prioritized backlog. When work completes, **move it to Completed — never delete it.** This is
> project history, not a scratchpad. For "what changed most recently," see `SESSION_HANDOFF.md`.

---

## Critical

### Real-world deployment readiness gap
- **Description:** `docs/production-readiness.md`'s own assessment: feature-complete
  development is ~80%, but real-world deployment readiness is ~25–30%. Nothing has run against
  real field-bus hardware, an unattended multi-week soak, real cloud providers, or a security
  audit.
- **Reason:** shipping without closing this gap risks the product failing in the field in ways
  unit/integration tests can't catch.
- **Dependencies:** none — this is the top-level gate.
- **Complexity:** Large (multi-session).
- **Status:** Not started. Recommended order from the doc itself: (1) security hardening →
  (2) real HA integration → (3) wire real Redis/NATS + persist remaining state → (4) cloud IaC +
  CD + observability → (5) real drivers/protocols + remote-access relay against live hardware.

### App-wide density-breakpoint remount bug
- **Description:** Resizing the browser across the `expanded`↔`comfortable` boundary (~1200px)
  mid-session remounts `App.tsx`'s entire page tree (two structurally different root trees for
  `wide` true/false), silently discarding in-page navigation state.
- **Reason:** real, reproducible; affects every page in the app, not just newly-built ones.
- **Dependencies:** none.
- **Complexity:** Medium — likely fixable by hoisting the page content into one stable render
  path shared by both the sidebar and bottom-tab shells, rather than branching the whole return.
- **Status:** Diagnosed, not fixed. Found during Security/Media module Playwright verification.

---

## High

### Finish the UI/UX Design Polish phase
- **Description:** The user-directed polish brief (Phase 2) is partially done — icon system,
  card/button/capability-chip polish, and a first slice of device-category ambient color identity
  now shipped (`color.category.security`/`color.category.media` in `aureon.tokens.json`; Camera +
  NVR heroes use the blue "surveillance tech" identity, Television/Projector's `on` state uses the
  violet "cinematic" identity — all via existing/new tokens, zero new component API). Remaining:
  extend category identity to Lighting/Climate (brief calls for warm-gold/amber — Lighting's
  existing gold may already satisfy this, needs a deliberate check not just an assumption) and to
  the Infrastructure module once it exists; and layout-rhythm variation so each device category
  feels structurally distinct rather than reusing one hero→controls→more-controls shape everywhere
  (not started at all — the color pass didn't touch composition/layout).
- **Reason:** explicit, repeated user request — "not a CRUD app," compete visually with
  Control4/Savant/Crestron/Tesla/Sonos.
- **Dependencies:** none — builds on the now-complete icon/card/button work.
- **Complexity:** Large — touches every premium device page's composition, not just its colors.
- **Status:** In progress. Color identity: Security (Camera/NVR) + Media (TV/Projector) done;
  Lock/Alarm deliberately left on their existing state-driven red/green/gold (jammed/unlocked/
  armed are safety-meaningful, not arbitrary, so category tint would compete with real state
  semantics there); AVR/Speaker's rich console deliberately left untouched (its own tuned
  album-art/halo system predates this brief). Layout-rhythm variation: not started.

### Infrastructure module (Premium Device Experience Library, remaining device types)
- **Description:** Build the remaining device types from the original 18-item priority list:
  Tesla/Vehicle (#11), Energy (#12), EV Charger (#13), Pool (#14), Irrigation (#15), Water Tank
  (#16), Generator (#17), Building Management (#18) — each needing Standard Card, Expanded
  Sheet, Premium Detail Page, capability mapper, and honest capability-gating per the "UI is the
  contract" principle already established for Media/Security.
- **Reason:** explicit original roadmap item; user paused it to prioritize the polish phase, not
  cancelled it.
- **Dependencies:** should wait for the polish phase (above) to land first, so new modules are
  built to the *new* premium standard instead of needing a second pass.
- **Complexity:** Large — 8 device types × full page set. Energy has real backend support
  (`services/analytics`, `/v1/energy/*`); the rest currently have little-to-no backend
  representation (KNX generic `onoff` for Pool/Irrigation; nothing for the rest) — expect most
  controls to be honestly capability-gated at first, same as Camera/NVR were.
- **Status:** Not started.

### Finish emoji migration in generic device quick-sheets
- **Description:** `device-sheets.tsx`'s Climate/Fan/Vacuum/generic-Media quick-sheets still use
  emoji (heat/cool/fan-mode glyphs, shuffle/repeat icons) — out of scope for the Security/Media
  redesign pass but a loose end for "replace every emoji" (icon.tsx already has the pattern
  established, just needs ~6 more `PATHS` entries).
- **Reason:** consistency — the rest of the app no longer uses emoji.
- **Dependencies:** none.
- **Complexity:** Small.
- **Status:** Not started.

---

## Medium

### Wire real Redis/NATS backends behind the messaging seam
- **Description:** `services/messaging` uses in-process fakes for the event bus (NATS) and
  ephemeral/presence store (Redis) by default; real backends exist behind config but aren't
  verified end-to-end in a real multi-instance deployment.
- **Reason:** required for the hub to survive a process restart without losing live state /
  presence, and for horizontal scale-out.
- **Dependencies:** part of the production-readiness critical path.
- **Complexity:** Medium.
- **Status:** Scaffolded, not verified live.

### Cloud subscription sync + dealer portal
- **Description:** ADR 0014 explicitly notes cloud subscription sync and the dealer portal are
  scaffolded by the licensing provider model but not fully built.
- **Reason:** commercial model dependency — `cloud/dealer`/`cloud/subscription` need this to be
  usable by real installer organizations.
- **Dependencies:** `cloud/licensing`, `cloud/identity` (both further along).
- **Complexity:** Large.
- **Status:** Provider seam exists; sync/portal not implemented.

### Real CHIP/Thread Matter controller bring-up
- **Description:** Matter commissioning (setup-code parsing, commissioning seam, fabric manager,
  cloud multi-admin sync) is implemented in code, but the real `@matter/main` hardware
  controller bring-up is explicitly not runnable yet (ADR 0011).
- **Reason:** Matter support is a stated product feature ("optional and user-activatable").
- **Dependencies:** real Thread border-router hardware for testing.
- **Complexity:** Large.
- **Status:** Seam built, hardware integration outstanding.

### Real hap-nodejs HomeKit transport
- **Description:** the local HAP accessory bridge (`services/homekit`) has its mapping/bridge/
  routing logic done; the real `hap-nodejs` transport layer is the stated outstanding boundary
  (ADR 0012).
- **Reason:** Apple Home/Siri support is a stated product feature.
- **Dependencies:** none blocking, just unimplemented.
- **Complexity:** Medium.
- **Status:** Logic done, transport not wired.

---

## Low

### Additional AVR brand drivers
- **Description:** `docs/architecture/adding-avr-brands.md` explicitly lists brands with zero
  implementation: Onkyo/Pioneer (ISCP/eISCP), Sony, Arcam, Anthem (ARC), NAD, JBL Synthesis,
  StormAudio, Trinnov.
- **Reason:** broaden AVR hardware compatibility beyond the current Denon/Marantz/HEOS/Yamaha
  set.
- **Dependencies:** the Universal AVR Framework (ADR 0015) already provides the seam; each brand
  is an isolated driver addition.
- **Complexity:** Medium per brand (protocol research + codec + tests).
- **Status:** Not started, framework ready.

### Bluetooth pairing management for HEOS/Yamaha
- **Description:** explicitly called out as out of scope for the current AVR framework.
- **Reason:** completeness of the AVR control surface.
- **Dependencies:** AVR framework.
- **Complexity:** Small–Medium.
- **Status:** Not started.

### Local (non-cloud-to-cloud) Alexa/Google fulfillment
- **Description:** current voice integrations are cloud-to-cloud only; a local fulfillment path
  was explicitly deferred to a follow-up.
- **Reason:** reduce cloud dependency for voice control, consistent with local-first principles.
- **Dependencies:** `cloud/voice`, local intent-routing design.
- **Complexity:** Large.
- **Status:** Deferred, not designed.

---

## Future ideas

- HRoT/TPM-backed hub identity ("future-ready," not yet built per the blueprint's Phase 4 notes).
- Multi-region cloud deployment (cloud roadmap plane C4).
- AI assistant expansion — energy/EV/solar hooks (cloud roadmap plane C4).
- A `CHANGELOG.md`/`ROADMAP.md` at the repo root — currently neither exists; roadmap detail
  lives only inside the two architecture blueprints. Worth extracting into a lighter-weight,
  more discoverable root file if the roadmap keeps changing.

---

## Completed

> High-level milestones only — see `git log` for full commit-level history, and
> `PROJECT_CONTEXT.md` §6 for what each milestone actually delivers.

- Monorepo foundation: pnpm + Turborepo (TS/Python) + Melos (Flutter), domain-model, contracts,
  Aureon design tokens, hub Compose stack with hidden HA, SIL skeleton, Identity + Permissions,
  gateway (REST + WSS).
- Homeowner MVP: Dashboard, Rooms, Device Control, Scenes, Favorites, Notifications, user
  management/roles, local + remote access.
- Installer Portal, Driver Store, device discovery/commissioning (KNX/DALI/Casambi/Matter/MQTT/
  Modbus), diagnostics, backup/restore, licensing.
- KNX ETS import engine (full `.knxproj`/`.esf` parsing, device recognition, room assignment,
  learning engine, review-before-commit UI on web + mobile).
- Universal AVR/media framework — AVR (Denon/Marantz Telnet), HEOS, Yamaha MusicCast drivers;
  rich AVR console UI (album art, halo/particle ambient glow, volume knob, waveform) on web +
  Flutter; real SSDP/mDNS discovery.
- Design System phases 0–8: `@supreme/aureon-web` component library (Button, Card, Chip/Badge,
  Sheet, unified Icon registry, responsive breakpoints), migrated every existing device console
  onto it, Universal DeviceSheet 7-section architecture (Information/Diagnostics/Automations/
  History/Advanced Settings + capability-specific Overview/Controls).
- Responsive framework (frozen): density engine (compact/comfortable/expanded), fluid tokens,
  Grid/Container/Stack primitives.
- **Premium Device Experience Library — Media module:** feature-module architecture
  established; Television/Projector/AVR/Speaker with capability-driven classification and the
  "UI is the contract" gating principle.
- **Premium Device Experience Library — Security module:** Door Lock, Furniture Lock, SIP Video
  Door Phone, Camera, NVR, Alarm System — full premium pages, all wired into the Security tab.
- **UI/UX Design Polish phase (first pass):** shared Card/Button/QuickActions/CapabilityGrid
  primitives upgraded with real depth, motion, and a decluttered capability-gating presentation;
  complete SVG icon system (63 icons) replacing emoji across Security + Media; fixed an app-wide
  ultrawide-display layout bug.
- Project memory system established: `CLAUDE.md`, `PROJECT_CONTEXT.md`, `SESSION_HANDOFF.md`,
  `TODO.md` (this file).

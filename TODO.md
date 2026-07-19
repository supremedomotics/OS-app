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
- **Description:** The user-directed polish brief (Phase 2) is partially done — icon system and
  card/button/capability-chip polish shipped. Remaining: device-category ambient color identity
  (camera=blue-tech, media=cinematic, lighting=warm-gold, etc. — without conflicting with
  existing state-driven tinting), and layout-rhythm variation so each device category feels
  structurally distinct rather than reusing one hero→controls→more-controls shape everywhere.
- **Reason:** explicit, repeated user request — "not a CRUD app," compete visually with
  Control4/Savant/Crestron/Tesla/Sonos.
- **Dependencies:** none — builds on the now-complete icon/card/button work.
- **Complexity:** Large — touches every premium device page's composition, not just its colors.
- **Status:** Not started (blocked on user confirming direction before continuing, per the
  last session's handoff message).

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
- **Status:** Energy (device #1 of 8) built — see Completed. Solar, Battery Storage, EV Charger,
  Pool, Irrigation, Water Tank, Generator, Building Management, Vehicle not started; the new
  `features/infrastructure/<domain>/` pattern + `PowerRing` component are ready to extend.

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

### Live hardware verification of the Universal AV Driver SDK additions
- **Description:** Diagnostics Console, Room Assignment Engine, Automatic Zone Generation, and
  the Media Topology Engine (ADR 0015 addendum) were built and tested against in-process fake
  TCP/HTTP servers only — never against a real Denon/HEOS/Yamaha unit or a running `hub-compose`
  stack. The Topology UI has not been Playwright-verified at any responsive tier.
- **Reason:** this project's own testing standard ("new UI behavior should be Playwright-verified
  live... not just typechecked") wasn't met for this work — no backend/hardware was available in
  the session that built it.
- **Dependencies:** `hub-compose` running, ideally real AVR hardware.
- **Complexity:** Small (verification only, no new code expected unless something's found).
- **Status:** Not started.

### Wire more protocols into the generic Room Assignment Engine
- **Description:** `services/commissioning/src/room-assignment-engine.ts` is protocol-agnostic
  (takes a generic `LocationHint`) but only AVR/HEOS/Yamaha discovery currently emits one. Matter
  (Room/Location cluster), KNX live discovery, Zigbee/Z-Wave/BLE could all feed it the same way.
- **Reason:** explicit product ask — "every SupremeOS driver should provide location hints."
- **Dependencies:** none — the engine itself needs no changes, only each driver's `discover()`.
- **Complexity:** Small per protocol.
- **Status:** Not started; deliberately deferred to avoid touching the working KNX ETS import
  pipeline and other stable discovery paths in the same session that built the engine.

### Whole-home Media Dashboard topology graph view
- **Description:** the Media Topology Engine currently renders only a per-device connections list
  (in the AVR console's sidebar); a whole-home graph view (the brief's worked example — "Living
  Room AVR ├── HDMI1 → Apple TV …") for the Media dashboard was not built.
- **Reason:** explicit brief ask ("support Diagnostics, Media Dashboard, Activity Generation,
  Automation Relationships") — only the diagnostics-adjacent per-device view shipped.
- **Dependencies:** `MediaTopology` schema (`packages/domain-model/src/media-topology.ts`) already
  exists and is populated by the per-device editor; a dashboard view just needs to read it.
- **Complexity:** Medium.
- **Status:** Not started.

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

- **Universal AV Driver SDK completion** (ADR 0015 addendum) — Diagnostics Console
  (`services/protocols/src/driver-diagnostics.ts`, wired into AVR/HEOS/Yamaha drivers, exposed
  via a new `INativeProtocolDriver.getDiagnostics?()` seam and `GET /v1/devices/:id/diagnostics`);
  a generic, protocol-agnostic confidence-based Room Assignment Engine
  (`services/commissioning/src/room-assignment-engine.ts`, explicitly superseding ADR 0015 §2.3's
  narrower "installer always assigns the room" position); Automatic Zone Generation for Yamaha's
  real multi-zone units (`InstallerServices.autoCommissionMedia`, `POST /v1/commissioning/
  auto-media`); a Media Topology Engine (`packages/domain-model/src/media-topology.ts`,
  installer-declared HDMI/zone graph, editable in the AVR console). Also fixed a pre-existing gap
  where `RoutingBackendAdapter` never implemented `getCapabilityConfig`. See `SESSION_HANDOFF.md`
  and the ADR addendum for full detail; not yet live-verified against real hardware.
- Infrastructure module, Energy (device #1 of 8) — `features/infrastructure/energy/`
  (capability-mapper/card/detail) plus `infrastructure-energy.tsx` (whole-home dashboard),
  replacing the old plain-`.card.row` Energy tab. New shared `PowerRing` radial-gauge component
  in `@supreme/aureon-web`, 7 new icons (`plug`/`sun`/`ev`/`generator-unit`/`leaf`/`trend-up`/
  `flow`). Whole-home hero and per-device consumption sparkline both read real
  `client.energySummary()`/`/v1/energy/history` data — no fabricated live numbers; per-device
  page gates Schedule/Load Priority/Usage Alerts/Efficiency Insights honestly (no backing
  capability exists yet). `devices.tsx`'s `friendlyType()` updated to classify energy devices.
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

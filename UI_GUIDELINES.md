# UI Guidelines — "Aureon" Design System

Source of truth for tokens: [`packages/aureon-web/tokens/aureon.tokens.json`](packages/aureon-web/tokens/aureon.tokens.json)
(edit values **only** there — `aureon-flutter`'s `tokens.g.dart` and
`aureon-web`'s CSS/TS mirror are generated/derived from it). Component
reference implementations: [`packages/aureon-flutter/lib/src/widgets/`](packages/aureon-flutter/lib/src/widgets/)
and [`packages/aureon-web/src/`](packages/aureon-web/src/). Screenshots of the
live UI: [`docs/screenshots/`](docs/screenshots/). UX benchmark references
(usability only — visuals deliberately inverted): [`docs/reference/`](docs/reference/).

## Design philosophy

Dark, architectural, gold-accented, room-first, calm luxury — explicitly
differentiated from the light/cream/minimal UX benchmark ("Ovio") the team
studied for usability patterns only. Recent commits ("Project Aurelia",
"Project Monolith", "§ craftsmanship") push further toward an emotional,
typography-led, room-first identity: *"you enter your home"*, not *"you open a
system dashboard."*

## Colors

| Token | Value | Use |
|---|---|---|
| `color.base.void` | `#0A0908` | Deepest background |
| `color.base.surface` | `#141210` | Base surface |
| `color.base.surfaceRaised` | `#1C1A16` | Cards/panels |
| `color.base.surfaceOverlay` | `#242119` | Sheets/overlays |
| `color.base.hairline` | `#2D2A24` | Dividers/borders |
| `color.gold.50` → `700` | `#EFE9DF` → `#5C4E3B` | Accent ramp (50 lightest, 700 darkest); gold is the *only* saturated hue in the system |
| `color.text.primary` | `#F4F1EA` | Primary text on dark surfaces |
| `color.text.secondary` | `#B6B2A8` | Secondary text |
| `color.text.muted` | `#7E7B73` | Captions, disabled |
| `color.text.inverse` | `#0A0A0C` | Text on light/gold fills |
| `color.status.good` | `#6FBF8B` | Success/on/healthy |
| `color.status.info` | `#6FA8BF` | Informational |
| `color.status.warning` | `#D9A441` | Warning |
| `color.status.critical` | `#CF6B5A` | Error/critical/alarm |

Mode is fixed **dark** (`meta.mode: "dark"`) — there is no light theme in the
token file; do not introduce ad hoc light-mode overrides without adding a
`light` token set to the canonical JSON first.

## Typography

- **Display font**: `Aureon Display, Georgia, serif` — used for hero/headline
  moments (per git log, the "typography as hero" pass).
- **Body font**: `Inter, system-ui, sans-serif` — self-hosted (bundled on both
  mobile and web, per commits "Typography foundation: self-host Inter" and
  "bundle real Inter on mobile too") rather than loaded from a CDN, so it
  renders identically offline.
- **Scale** (`typography.scale`):

| Style | Size / Line height | Weight | Tracking |
|---|---|---|---|
| display | 40 / 44 | 600 | -0.5 |
| title | 28 / 34 | 600 | -0.25 |
| headline | 22 / 28 | 600 | 0 |
| body | 16 / 24 | 400 | 0 |
| label | 13 / 18 | 500 | 0.4 |
| caption | 11 / 14 | 500 | 0.6 |

## Spacing & grid

- `spacing.unit = 4` (4px base grid). Scale: `xs=4, sm=8, md=16, lg=24, xl=40, xxl=64`.
- `radius`: `sm=8, md=16, lg=24, pill=999` — cards/tiles use `md`/`lg`; pill
  radius is reserved for fully-rounded controls (chips, the floating nav bar).

## Elevation & motion

- `elevation.card`: `0 8px 24px rgba(0,0,0,0.45)` — soft depth via shadow/blur,
  not hard borders, to keep the dark surface feeling architectural rather than
  flat.
- `elevation.sheet`: `0 -12px 40px rgba(0,0,0,0.55)` with a `blurBackdrop: 24`
  scrim — used for pull-up sheets (room switcher, scene editor).
- `motion.durationFastMs/BaseMs/SlowMs = 140/260/420` with two named easing
  curves: `easeQuietOut [0.16,1,0.3,1]` (slow-in/quiet-out — the calm-luxury
  feel called for in the blueprint) and `easeSlowIn [0.4,0,0.2,1]`. Recent
  commits ("Motion: signature room-card entrance + tactile press") formalize
  entrance animations and press feedback using these curves — reuse them for
  any new interactive surface rather than picking arbitrary durations/curves.

## Core interaction grammar: tile-as-control

The signature Aureon component is **`FillTile`**
(`packages/aureon-flutter/lib/src/widgets/fill_tile.dart`): a category/device
tile whose background **fills proportionally to its value**. Tap toggles;
horizontal drag sets the value (0..1). This single component covers lights,
fans, awnings, and covers — new binary/continuous device controls should reuse
`FillTile` rather than building a bespoke slider+toggle pair.

## Domain-specific components (implemented — `packages/aureon-flutter/lib/src/widgets/`)

- **`CategoryTile`** — aggregate tile summarizing a category in a room
  ("Lights 7 on", "Covers 1 open") that drills down to a device list.
- **`DeviceControlTile`** — per-device control surface.
- **`FillTile`** — the tile-as-control primitive (see above).
- **`ColorWheel`** — RGBW color selection with a warm↔cool tunable-white mode
  (both color AND tunable white on the same wheel, per git log "Colour wheel:
  RGBW colour AND tunable white").
- **`MultiLightDisc`** — multi-light color/brightness control with draggable
  nodes per light on a shared field.
- **`ClimateCard`** — dual setpoints + fan + humidifier state display/control.
- **`MediaCard`** — album art, source badge, scrubber, transport controls,
  volume slider, queue count.
- **`RoomHero`** — full-bleed room photo hero with a dark-gradient scrim
  (photographic room heroes from Openverse/Unsplash — see
  `SUPREME_UNSPLASH_KEY` in `infra/hub-compose/.env.example`) so gold text/
  controls stay legible over any photo.
- **`SceneButton`** — quick-scene activation control (dashboard quick-scene row).
- **`SlideToConfirm`** — chevron "slide to unlock/arm/disarm" pattern for
  sensitive/irreversible actions (door unlock, alarm arm/disarm) — deliberately
  requires a deliberate drag gesture, not a tap, to prevent accidental
  activation.

## Navigation

- **Room-first IA**: Welcome/Home overview → room pager (swipe between rooms)
  → category → device/scene. A room switcher opens as a full-bleed photo-hero
  card stack in a pull-up sheet.
- **Floating icon-only bottom bar** (5-tab nav on mobile/web, per git log
  "Ovio-style floating icon-only bottom bar") rather than a traditional
  labeled tab bar — consistent with the minimal, uncluttered Aureon aesthetic.
- **Global search / command palette** exists for cross-cutting navigation
  (git log: "Global search / command palette").
- Persistent quick-scene row + Favorites access at the top of the dashboard.

## Cards, panels, sheets, dialogs

- Cards/panels use `surfaceRaised`/`surfaceOverlay` backgrounds with
  `elevation.card`/`sheet` shadows — never a hard 1px border as the primary
  separation cue; `color.base.hairline` is reserved for genuine dividers
  within a panel (list rows, settings groups).
- Sheets (pull-up room switcher, scene editor) use the blurred scrim +
  `elevation.sheet` shadow.
- Grouped settings use a leading-icon + chevron row list pattern (per
  blueprint §11.1's "Grouped settings list" and the "Settings: Ovio-minimal
  menu instead of one cluttered scroll" commit) rather than one long flat
  settings screen.

## Buttons

- "Base button styling — no plain button renders as a light default" (git
  log) — every button variant must resolve through the Aureon token theme;
  there is no unstyled/browser-default button state anywhere in the shipped UI.

## Icons

- Line icons throughout (git log: "Replace emoji glyphs with themed line
  icons (web)") — emoji glyphs were explicitly removed in favor of a
  consistent icon set; do not reintroduce emoji as UI iconography.
- "Glyph room summaries" use the same line-icon language for at-a-glance room
  state (git log: "Glyph room summaries + personal greeting").

## Charts

- **Energy**: a gold-accented cost card + energy chart (`@supreme/analytics`
  tariff engine feeding a home-wide hourly aggregation) — see
  `docs/production-readiness.md` §10 "Luxury experience features."
- No general-purpose charting library convention beyond this is established in
  the repo; follow the existing energy chart's visual treatment (dark surface,
  gold accent for the primary series) for any new chart rather than adopting a
  different chart library's default theme.

## Tables

- No dedicated "Aureon table" component was found in `aureon-flutter`/
  `aureon-web`; the Installer Portal's denser surfaces (Device Manager,
  Extension Center) use grouped list/row patterns rather than dense data
  tables. Follow the grouped-list convention for new installer-surface data
  views unless a genuine tabular/sortable dataset requires an actual table.

## States: empty / loading / error

- **Empty states are actionable**, not blank (git log: "Actionable empty
  states across the app (§ Empty States)") — every empty state should include
  a clear next action (e.g. "Add a room," "Discover devices"), not just an
  illustration/text.
- **Errors are homeowner-friendly**: never expose technical detail to the
  homeowner persona (git log: "Homeowner-friendly errors — never expose
  technical detail (§ Errors)"); the installer persona can see more technical
  detail (diagnostics, logs) since that's an expected part of their density.
- **Personalization**: "the dashboard learns from real use" — frequently-used
  rooms surface higher, the most-used room becomes a visual hero (git log:
  "Personalization," "Room-card rhythm: the most-used room is a hero"). New
  dashboard surfaces should consider this same real-usage-driven ordering
  rather than a fixed static layout.

## Accessibility

- Notification grouping ships with **accessibility toggles** (git log:
  "Notification grouping + accessibility toggles (§ Notification Center, §
  Accessibility)") — a specific, implemented accessibility feature; broader
  systematic accessibility work (screen-reader labeling, contrast audit,
  golden/a11y test coverage) is tracked as **not yet done** in
  `docs/production-readiness.md` §7 ("Golden tests for Aureon widgets;
  accessibility + i18n" — unchecked). Treat accessibility as partially
  implemented, not comprehensively covered.

## Responsive behavior

- Two personas share the design system with different information density:
  homeowner (calm, room-first, mobile-first) vs. installer (dense, technical).
  `apps/mobile` targets phone/tablet; `apps/web-homeowner` and
  `apps/web-installer` target desktop/tablet web. No explicit CSS breakpoint
  table was found documented in the repo — the web apps are React/Vite SPAs
  without a committed responsive-breakpoint spec; treat any new responsive
  work as needing its own breakpoint decisions rather than assuming an
  existing system to reuse.

## Domain-specific UI summary

| Domain | Implemented UI |
|---|---|
| Lighting | `FillTile`, `ColorWheel` (RGBW + tunable white), `MultiLightDisc`, circadian lighting one-tap control |
| Climate | `ClimateCard` (dual setpoints, fan, humidifier) |
| Security | `SlideToConfirm` (arm/disarm, door unlock), Security Center (active sessions, login history, computed security score), camera live view |
| Media | `MediaCard` (art, source badge, scrubber, transport, volume, queue), camera HLS/WebRTC player (WHEP preferred, HLS fallback) |
| Automation | Visual Automation Builder (Flutter), Automation Debugger (real execution timeline) |
| Energy | Gold-accented cost card, hourly aggregation chart, budget projection |

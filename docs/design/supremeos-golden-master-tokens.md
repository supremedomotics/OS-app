# SupremeOS-10 Golden Master — derived design tokens

Derived from the actual Golden Master (`SupremeOS-10.html`, its `src/ui/ui.css` and page modules),
not from the migration brief. Screenshots of the running Golden Master at four surfaces are in
`docs/design/golden-master/` (captured headless at the sizes in the file names; Home / Spaces /
Experiences). Flutter is compared against these for *experience identity*, not pixel identity.

Where a value is implemented, it lives in `apps/new/shared/lib/src/design/tokens.dart`
(raw values) and `apps/new/shared_ui/lib/src/theme/` (Flutter binding).
`test/golden_master_tokens_test.dart` and `test/golden_master_theme_test.dart` pin them.

## What the Golden Master actually is

* **Night, not gold-on-black.** A near-black canvas (`#08090A`), one warm ivory for all text at
  three opacities, and brass used sparingly for *state and emphasis only* (the "feels like" line,
  a pending/current control, a focus ring). The chrome is hairlines, not cards.
* **Photography carries the atmosphere; typography carries the meaning.** Home is a full-bleed
  photograph under a left-weighted dark gradient with the residence name set in a light serif and
  one sentence beneath it. There are no tiles, widgets or buttons on Home.
* **Photography is state.** Space imagery composes the room's *real* shade position over the photo
  (sheers drawn across the glazing), and tints with the active Experience and the residence's own
  time of day. Media artwork falls back to a composed cover (concentric rings on a hue derived from
  the album), never a broken image or a generic note icon.
* **Onboarding is ivory; the app is night.** The welcome/pairing surface (`SupremeOS_Onboarding_frozen.html`)
  is light ivory (`#F7F4EE`) with brass concentric "presence" rings and a letter-spaced wordmark.

## Palette (`:root`)

| Token | Value | Role |
|---|---|---|
| `night` | `#08090A` | canvas; pages sit on `rgba(8,9,10,.965)` |
| `ivory` | `#F7F4EE` | onboarding ground; primary action fill (ink `#15130F` on it) |
| `ink` | `#2D2A25` | text on ivory (onboarding) |
| `brass` | `#A78048` | selected/current borders, pending track |
| `brassLight` | `#C9A66B` | focus ring, active point, switch knob when on |
| `brassPale` | `#DCC49A` | kickers, "feels like", attention notes, pending values |
| `champagne` | `#EFE3CC` | text being pointed at / current (hover, selected chip) |
| `text` / `text2` / `text3` | `#F7F6F2` at 100 / 72 / 56 % | primary / secondary / tertiary text |
| `rule` | white at 9 % | hairlines between layers (rows use 8 %, chips 20 %) |
| `brassWash` | `rgba(180,138,79,.2)` | pressed/current chip and tab fill |

There is **no** green/amber/red status palette in the homeowner Golden Master: "needs a look" is
brass-pale and *words* ("The awning on the terrace isn't responding."). The legacy `status*` tokens
remain for Pro/diagnostic surfaces. All text roles clear WCAG AA on night (tested).

## Type

Embedded in the Golden Master as "SOS Serif" and "SOS Sans"; identified from the font name tables as
**Cormorant Garamond Light (300)** and **Jost Light (300) / Regular (400)** — both SIL OFL 1.1.
Bundled in `apps/new/shared_ui/assets/fonts/` as full static instances (the Golden Master carries
Latin subsets), with their OFL texts.

* Serif Light for *what a thing is*: residence/space/experience names, titles, the figure a control is
  about (a set temperature, tabular), floor headings. Tracking `-0.005em`.
* Sans for everything functional. Nothing is bold; the only weights are 300 and 400 (the wordmark
  is spaced, not heavy).
* **Kicker**: 11–12 px sans, `0.2em` tracking, upper-case, brass-pale, above a title.
* Scale in use (px, phone → large canvas): hero/state title `clamp(44, 6vw, 76)`; page title
  `clamp(36, 4.2vw, 52)`; panel title 40; floor/space name 22–28; sentence 17–18 (light, leading 1.55);
  body 14–15; labels 12–13; kicker 12.
* Legacy `headline`/`title`/`display` keep their earlier (smaller) sizes until the screens using them
  are rebuilt; new UI uses `name` / `pageTitle` / `hero`.

## Geometry

* Gutter `clamp(16px, 4vw, 56px)`; hero content max 620; page max 1180 (narrow 900).
* **Pills**: chip 42 min-height, tab 40, primary 46 (ivory fill), icon button 44 round. Radius 999.
* **Images**: 4 px radius (6–8 on large Experience heroes), 1 px `rgba(255,255,255,.06)` border.
  Asymmetric 8/4 and 5/7 grids on Spaces — composition, not a uniform tile grid.
* **Rows**: ≥ 48 px, hairline-separated, name left in serif, state right in sans.
* Touch targets ≥ 40 (44 preferred); TV 56; watch actions ≥ 48 (grammar §6).
* Focus: 2 px `brassLight`, offset 3; **remote/TV**: 3 px, offset 4, plus an 8 px 18 % brass halo.

## Controls (one language: switch · value · step · options · act)

* **Switch**: 60×44 hit area. Default: 32 px track + 22 px knob. Row/immediate variant: a 1 px
  hairline track with a 9 px hollow point that travels; *on* fills the point brass-pale.
  **Pending** = the point becomes dashed. The word (On/Off/Some on) is always written.
* **Value**: serif, tabular. **Step**: quiet − / + (48 px, hairline circle). **Options**: words,
  underlined when current; pending option is dotted-underlined brass-pale. **Act**: a named text action.
* **Sliders/lines**: a thin architectural line with a moving presence point (media timeline, volume).
* **Instruments** (Residence Control): a 64×40 line drawing of each system's *confirmed* state, with the
  *intended* state as a dashed ghost; the state colour is the light's actual colour temperature.
* Unsupported capability ⇒ the control is not drawn (decision, homeowner Flutter surface).

## Motion — pending travels, confirmation breathes, failure returns

| State | Golden Master | Token |
|---|---|---|
| pending | a 1 px hairline gradient (40 % wide) sweeps −40 % → 140 %, linear, infinite | `pendingTravelMs 1400` |
| confirmed | a brass ring expands 0 → 6 → 12 px and fades | `confirmBreatheMs 900` |
| failed | opacity 1 → .45 → 1 while the control returns to what the device reports; the failure is said in words | `failReturnMs 900` |
| content arriving | rise 10 px + fade | `riseMs 550` |
| fold / unfold, panel takes its role | cross-fade of the composition | `compositionMs 380` |
| imagery settling | scale 1.02 | `imageMs 700` |
| ambient hero | scale 1 → 1.012, tied to real state | `ambientBreatheMs 9000` |

Easing everywhere: `cubic-bezier(.2, .7, .2, 1)` (`SupremeMotionCurves.settle`). Reduced motion removes
all of it (cross-fade only). Material ink ripples are not part of the language and are disabled.

## Navigation composition (per surface)

* **Phone (focused)**: bottom bar, five items — Home · Spaces · **Control (centre, ringed)** · Experiences · Settings.
* **Tablet (spatial)**: left rail with the same five, active item on a filled rounded plate.
* **Desktop (expansive)**: top pill group (Home · Spaces · Experiences · Settings) plus an outlined
  "Residence control" pill — Control is a layer that is named for its scope ("Residence control",
  "Living Room control", "Relax control").
* **Watch (glance)**: state word (● Secure) → "Feels like …" → three full-width serif actions on hairlines.
* Control opens **in context** (residence / a space / an Experience) and is a layer over the page, not a destination.

## Language (homeowner)

State is said, not shown as a number: "Settled, except the awning." · "Feels like Relax" ·
"Becoming Relax…" · "Partially active · Curtains & shades unavailable" · "Last known state · 3 minutes ago" ·
"Not responding" · "Save this atmosphere? Keep this atmosphere for later." Curtains are said in words
("mostly drawn"), never percentages. Protocol terms never appear (that is Pro).

## Inspected / not yet inspected

Inspected: `ui.css`, `home.js`, `control.js`, `space.js`, `experiences.js`, `shape.js`, `media.js`, `sheet.js`
(first 60 lines), `grammar.js`, `surface.js`, `panel.js`, `engine.js`, `derive.js` (first 120 lines), the
responsive grammar, the surface/authority tests, and rendered captures of Home / Spaces / Experiences.

**Not yet inspected** (do before building the matching Flutter feature): `photos.js` (how shade position
and tone compose over photography), `tone.js`, `sky.js` (the sun-arc and the residence's clock),
`spaces.js`, `settings.js`, `devices.js`, `panelui.js` (commissioning UI), `formfactor.js` (TV focus),
`hubs.js`, the onboarding flow, and the **`SupremeGlyph` SVG icon set** (a custom line-icon family —
Home, Space, Control, Experiences, Settings, Light, Aperture, Atmosphere, Resonance, Threshold,
Transform — that must be extracted and ported; Material icons are not the Golden Master's icons).
Also not captured: TV, foldable and installed-panel renderings.

## What the Golden Master needs from production contracts (feeds the Phase 3 gate)

| Golden Master behaviour | Needs | Status (to confirm at the gate) |
|---|---|---|
| Experience "Active / Becoming / Partially active / Unavailable", per-system "Arrived · 2 of 3" | per-scene semantic targets per space/system | unknown — `/v1/scenes` mapper reads only id/name/roomIds |
| "Shape your own" / "Keep this atmosphere" | create a scene from captured confirmed state (semantic targets) | `POST /v1/scenes` exists; body shape unverified |
| "Last known state · n minutes ago" | authoritative per-device state timestamp | `DeviceStatus` only; no timestamp seen |
| Residence sentence, day arc, "Warm midday light" | residence clock / sun times | `PUT /v1/home/location` exists |
| Media: progress, artwork, queue, where-it-plays | position/duration/artwork; queue absent | `MediaState` has position/duration/artworkUrl; no queue |
| Surveillance journal with stills | event journal + snapshots | unverified |
| Installed-panel identity, commissioning, recovery | Hub panel API | none — new contract |

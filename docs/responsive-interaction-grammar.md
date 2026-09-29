# SupremeOS Responsive Interaction Grammar

One residence, one state, one design language — many physical surfaces.
The surface decides **presentation**. It never decides **truth**.

Source of truth in code: `src/ui/surface.js` (modes, roles, fold), `src/engine/panel.js` (panel identity),
`src/ui/panelui.js` (commissioning, binding, guard), `src/ui/grammar.js` (the one control language).
Tests: `tests/surfaces.js`, `tests/panels.js`, `tests/ff.js`, `tests/pages.js`.

---

## 1. Architecture

```
Residence state · Device registry · Capability model · Event bus · Derived layer      ← one, authoritative
                                   │
                  Surface (surface.js): mode · role · input · orientation · fold      ← presentation only
                                   │
      Content priority (P0–P4)  ·  Control grammar (grammar.js)  ·  Navigation guard  ← how it is expressed
```

No surface owns state. There is no `PhoneDeviceState`, `PanelDeviceState` or `TVDeviceState`: every surface reads
`engine` / `derive`, and every action goes through `engine.command` (requested → pending → confirmed | failed).

Panel identity is **device configuration**, not residence state, and lives apart from both (section 4).

## 2. Surface capability matrix

| Surface | Mode | Role | Input | Distance | Navigation | Media | Security |
|---|---|---|---|---|---|---|---|
| Watch | glance | personal | touch | wrist | none (glance + one list) | play/pause | alerts first |
| 3–5" panel | compact | room panel | touch | arm | its room | room music | local |
| 5–7" phone | focused | personal | touch | hand | tab bar | full stage | contextual |
| Foldable, cover | compact | personal | touch | hand | tab bar | quick | contextual |
| Foldable, open | spatial | personal | touch | hand | rail; room ◂hinge▸ Control | full stage | contextual |
| 8–13" tablet | spatial | personal | touch | hand | rail | full stage | contextual |
| 7–15" wall panel | spatial | room / residence panel | touch | arm | location-aware | room / residence | local + residence |
| 15–30" wall panel | expansive | residence panel | touch | arm–room | top, scaled | spatial | residence |
| TV | distance | personal | remote | far | directional focus | Now playing on Home | large status |
| Desktop / web | expansive | personal | pointer | hand | top | full stage | residence |

## 3. Density model

Modes are derived from **size + input + role + fold**, not width alone (`surface.js · derive`).
Every element that is not always essential declares a priority with `data-p`:

| Priority | Meaning | Examples |
|---|---|---|
| P0 | critical | residence state sentence, alerts, last-known notice, how a room feels |
| P1 | primary | residence name, signals, Feels like, room sentence, Change · Shape, Now playing (TV) |
| P2 | contextual | day line, "not responding" note, crumbs, Make it … (adjust), In the residence |
| P3 | secondary | "All n devices ›", Make your own |
| P4 | technical | never in the homeowner UI (SupremeOS Pro) |

| Mode | Shows | 
|---|---|
| glance | P0 |
| compact | P0–P1 |
| focused | P0–P2 |
| spatial / expansive | P0–P3 |
| distance | P0–P2 |

CSS enforces it (`html[data-maxp] [data-p]`). Hiding is a consequence of meaning, never of a breakpoint.

## 4. Panel identity and binding

```
PanelProfile { panelId, residenceId, bindingType: room|residence, boundSpaceId, boundSpaceName, role,
               permissions, defaultExperience, lastScreen, orientation, capabilities, firmwareVersion,
               commissionedAt, by }
```

- **Identity** — `panelId` is the panel's hardware serial, supplied by its firmware (the kiosk launches with
  `?panel=<serial>`). Personal devices have no serial and never get a profile.
- **Binding** — written three times: the Hub's record (authoritative), and two local copies on the panel
  (localStorage + IndexedDB).
- **Navigation** — `lastScreen` only; writing it never rewrites identity, and only on a record that still names the
  same place.
- **State** — never stored in the profile.

A room binding is never changed by anything except authenticated commissioning.

## 5. Navigation adaptation

| Surface | Model |
|---|---|
| Personal | Home · Spaces · Experiences · Settings (+ Control) — the conceptual hierarchy is unchanged |
| Room panel | its room *is* home: Home and Spaces lead to it, another room's page leads back to it, Experiences and Devices are scoped to it; Spaces is not shown; Home is labelled with the room |
| Residence panel | the full hierarchy |
| TV | same hierarchy, directional focus, Back closes the top layer |
| Watch | glance + one short list; no depth |

No surface gains navigation because it has space.

## 6. Control adaptation

One control language (`grammar.js`): **switch · value · step · options · act**, identical semantics everywhere,
identical pending (brass, dashed/dotted, travelling), identical failure (said in words; control returns to what the
device reports). Surfaces change the *expression*, not the meaning:

- compact / room panels: the room's **immediate** controls on the room page, one line per system;
- phone / tablet / desktop: Residence Control levels and the Device Sheet share the same renderers;
- watch: three deliberate, full-width actions ≥ 48 px;
- TV: the same acts, 56 px, with a strong focus ring.

Capabilities decide what exists; an unsupported control is never drawn.

## 7. Motion adaptation

One emotional language: pending travels, confirmation breathes, failure returns. Per surface: watch — none beyond
state; phone — short in-place; tablet/wall — relocation between rooms; fold/unfold — a 380 ms cross-fade of the
composition (a change of place, not a resize); TV — slow, distance-readable. Reduced motion: crossfades only.

## 8. TV remote navigation

- `data-input="remote"` enables spatial focus (`formfactor.js · move`): the nearest element in the pressed
  direction, weighted against lateral drift.
- Left/right stay with sliders and text fields; Back closes the top layer, then goes back.
- Focus is always visible (2 px brass outline, 6 px offset).
- Test: from the first control, a breadth-first walk with the four arrows must reach **every** Home control.

## 9. Foldables

- **Cover** — narrow and tall → `compact`: the room's state and immediate actions.
- **Open** — the Viewport Segments API (or `?fold=v|h` in tests) → `spatial`, hinge published as
  `--hinge-start / --hinge-end`.
  - Vertical hinge: the page on the first segment, Control docked on the second.
  - Horizontal (book) hinge: the page ends at the fold; Control on the lower segment.
- Nothing interactive or written may cross the hinge — tested by measuring what is actually visible (clipped by
  scrolling ancestors), not raw boxes.

## 10. Watch

Alerts first ("Front door — Opened — View"); otherwise ● protection, and "Feels like …". Three residence actions
(Relax, Good Night, Away) as deliberate full-width targets; Pause when something plays. No inventories, sheets,
photography or configuration.

## 11. Commissioning flow

First boot of an installed panel:

```
Welcome to SupremeOS → Where should this panel control? (A room | The residence)
  → Which room? → Installer code (verified by the Hub) → Confirm ("This panel will control the Living Room.")
  → binding written (Hub + panel + backup) → the panel opens in its room
```

Rebinding: Settings → This panel → Change what this panel controls → the same flow, code required,
"Keep it as it is" leaves everything untouched.

Lost space: "This panel's space is no longer available — Wine Cellar — Choose another space · Contact your
installer". The panel never moves to another room or to the residence by itself.

## 12. Persistence and recovery

| Event | Result |
|---|---|
| Reload, crash, app restart | panel copy → its room + last useful screen in it |
| Panel copy cleared | Hub record restores it; both local copies are rewritten |
| Panel copy and Hub record gone | IndexedDB backup restores it; the Hub record is healed |
| No network | panel copy; last-known state shown and labelled |
| Residence unreachable | identity unchanged; "Last known state" |
| All three gone | the panel asks to be commissioned — it never guesses |
| Bound space deleted | "no longer available" screen |

The setup screen is shown only after the backup copy has answered, so a panel never asks for its room too early.

**What this prototype cannot prove.** It is one HTML file in a browser. Power loss, OS updates and factory resets
are survived on a real installation because the Hub holds the record and the firmware supplies the serial. Here the
Hub's store is simulated in the same browser, so clearing *all* site data removes it too. The recovery order,
healing, guard and failure behaviour are real and tested; the physical durability belongs to the Hub and panel
firmware (Flutter/embedded layer).

## 13. Automated test matrix

`tests/surfaces.js` — 22 surfaces:

- sizes: watch · 3" · 4" · 5" · 6" (portrait and landscape) · fold cover · fold open (portrait and landscape) · 7" panel ·
  8" tablet · 10" wall (portrait and landscape) · 11" · 12.9" · 15" · 21" · 24" portrait · 27" · 30" · desktop · TV;
- checked per surface: mode and role · no overflow · no tiny targets for the input · nothing across the hinge ·
  TV remote reaches every Home control · no page errors — over six views each.

`tests/panels.js` — commissioning, wrong code, three-way write, no accidental room switching, restart + last screen,
foreign last screen ignored, each recovery path, offline, residence unreachable, rebinding needs the code, lost space,
recommissioning.

`tests/ff.js` (17 form factors), `tests/pages.js` (19 pages × 2 with ghost-glass and duplicate-number checks),
`tests/suite.js`, `tests/journeys.js`, `tests/sliders.js` keep the golden master from regressing.

---

## Invariant — one SurfaceProfile

`src/ui/surface.js` is the **only** code that reads raw surface inputs (viewport size, user agent, pointer/hover
media, viewport segments) and the panel's installed role. It produces one frozen profile:

```
SurfaceProfile { role, input, fold, formFactor, mode, distance, orient, skeleton, maxP, zoom, why }
```

Authority order: **installed role > input method > fold > dimensions.** So a 3" Room or Residence Controller is a
`panel` in `compact` mode (never a watch), a 5" Room Controller is not a phone, a 10" one is not a tablet, a 30" one is
not a desktop.

Everything downstream consumes it: the stylesheet (`data-mode`, `data-role`, `data-input`, `data-form`, `data-ff` =
the layout frame as a pure function of mode, `data-distance`, `data-maxp`), Home (glance only in glance mode),
Control (the swipe deck only in focused/compact — never on the wrist), the room page (immediate controls on room
panels and compact surfaces), remote focus navigation (only when `input` is `remote`), zoom for distance and large canvases.

`formfactor.js` no longer classifies anything; it is remote focus navigation only.
Size media queries in the stylesheet are allowed only to fit and reflow — never to hide or show content.

Enforced by `tests/authority.js`:
- **static:** no file but `surface.js` reads raw surface inputs; no size/pointer media query hides anything (a planted
  rogue classifier makes it fail);
- **dynamic:** 3" room panel, 3" residence panel, 3" personal device, 5" room panel, 5" personal phone. Each gets the
  right profile, and every subsystem is checked against it. A negative control proves a disagreeing subsystem is detected.

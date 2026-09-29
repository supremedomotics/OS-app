# Golden Master → Flutter implementation map

Result of the read-only inspection pass over the SupremeOS-10 Golden Master (its prototype source
archive, the built HTML, and rendered captures) against the Responsive Interaction Grammar and the
production repository. Nothing here changes behaviour: it records what the Golden Master does, where
that lands in Flutter, and what it depends on. Companion to `supremeos-golden-master-tokens.md`.

**Inspected in full:** `surface.js`, `panel.js`, `panelui.js`, `formfactor.js`, `home.js`, `spaces.js`,
`space.js`, `control.js`, `experiences.js`, `shape.js`, `media.js`, `sheet.js` (head), `devices.js`,
`settings.js`, `hubs.js`, `rules.js` (head), `runner.js`, `photos.js`, `tone.js`, `sky.js`, `grammar.js`,
`app.js`, `core.js` (routing, language), `shell.html`, `ui.css` (navigation, surface, fold, motion, control
rules), `engine.js`, `derive.js`, `model.js`, `capabilities.js`, the icon set (`build.py`), the onboarding
file and its arrival bridge, the grammar and the surface/authority tests. **Not read in full:** `rules.js` composer
body, `sheet.js` after line 60, `automations.js`, `integrations.js`, `bus.js`, the rest of `ui.css`.

## 1. The shell, as the Golden Master builds it

* **One set of five destinations, re-framed per surface by `SurfaceProfile.skeleton` — never re-authored.**
  Home · Spaces · **Control** · Experiences · Settings. Glyphs: `home`, `space`, `control`, `transform`,
  `calibration` (custom line set, below).

  | Skeleton | Frame | Control |
  |---|---|---|
  | phone (upright) | bottom bar (64 + safe area), five equal items; label under glyph 10.5 px | centre item, glyph in a 44×30 pill ringed in brass, label champagne |
  | phone (on its side) | the bar moves to a **76 px side rail**, header 48 px, glyph 20 / label 10 — "so the photo keeps its height" | same item, in the rail |
  | tablet | left rail 92 px, header offset by the rail, item plate 62 px min, 14 px radius | in the rail, glyph brass-light |
  | tv | same rail at 112 px, item min 74, focus ring 3 px + 8 px halo | in the rail |
  | desktop | top pill group (Home · Spaces · Experiences · Settings) + outlined **"Residence control"** button | the button; the Control *nav item* is `display:none` |
  | watch | no nav at all; header 30 px; Home's glance list carries the ways in | a link in the glance list |

* **Control is a layer, not a destination.** It opens over the current page in the scope of where it was
  called from (residence / a space / an Experience) and is named for that scope ("Residence control",
  "Living Room control", "Relax control"). Presentation: right drawer 520 px (desktop, tablet, tv); bottom sheet
  88 % high with a grab handle (phone portrait); on an unfolded foldable it **docks on the second hinge
  segment** and the page's padding stops at the hinge.
* **Routes:** `home`, `spaces`, `space/:id`, `experiences`, `devices`, `settings`. `space` keeps *Spaces*
  current. **`devices` is not a nav destination** — it is the "physical objects" layer reached from Control
  ("All n devices ›"), from Home's attention note (`devices?health=attention`), and from a space.
* **Layer stack** (top-most owns Back and remote focus): commissioning › colour wheel › device sheet › media
  stage › shape › control panel › page. Back closes the top layer, then goes back. Home closes every layer.
* **Header chrome on every surface:** wordmark (button → Home), the **presence mark** (five brass rings + a core;
  `reconnecting` = 45 % opacity and a hollow core), and the residence name — hidden on Home, where the name is the
  composition. A `#sos-connection` line ("Reconnecting to X. Showing the last known state.") appears while the
  residence link is down.
* **Room panel:** its room *is* Home. `Spaces` is hidden (`[data-role=room-panel] #nav-spaces`), the Home item is
  labelled with the room ("Living"), and a route guard rewrites Home / Spaces / another room's page to its own room,
  scopes Experiences and Devices to it, and hides the "‹ Spaces" crumb. Only `space`, `experiences`, `devices`
  are remembered as `lastScreen`.
* **Preferences are device-local** (motion: system|reduce; transparency: system|reduce; two notification switches)
  and "never hold residence or device state".

## 2. Implementation map

| Golden Master source | Behaviour | Flutter destination | Shared-architecture dependency | Surface modes affected |
|---|---|---|---|---|
| `shell.html` + `ui.css` nav rules + `core.js` router | five destinations, per-skeleton frames, Control as layer, header chrome | `shared`: pure `shellNavigationFor(SurfaceProfile, {roomBound})`; `shared_ui`: `SupremeShell` frames + `PresenceMark`; `mobile`: `RootShell` | `SurfaceProfile` only (no width checks); `PanelConfig` for room binding | all |
| `core.js` `layers`, `openPanel/closePanels`, `ui.css` panel/sheet/fold rules | layer stack, drawer/sheet/hinge-dock presentation, Back/Home semantics | `shared_ui`: `ShellLayerHost` + `showSupremeLayer` (drawer / sheet / hinge-docked); focus scope = top layer | `SurfaceProfile.fold`, `.skeleton` | phone, tablet, desktop, tv, fold |
| `home.js` | one sentence, signals, "Feels like", attention notes, last-known line; glance (watch); Now-playing (tv); residence map (expansive residence panel) | `mobile/features/home` | derived presentation sentences (`derive.home`) in core; Residence State read model (Phase 3) | glance, compact, focused, spatial, expansive, distance |
| `spaces.js` | floors → asymmetric photographic plates (8/4, 5/7, single pano); kicker = active Experience; "Occupied · Warm light · Music" | `mobile/features/spaces` | `Room.floor/sortOrder/heroImageUrl`; derived `condition()`; photography renderer | all but glance |
| `space.js` | "Feels like …" → **Change · Shape**; immediate controls on compact/room panel; Keep this | `mobile/features/spaces` (space page) | control renderers; derived Experience state; command tracker | compact, focused, spatial, expansive; room panel |
| `control.js` | scoped layer; systems grouped Environment / Media / Protection; instruments; intents ("Make it…"); Keep this; security; surveillance | `mobile/features/control` | capability-driven system resolution; control renderers; command tracker | phone deck (compact/focused) vs list (spatial/expansive) |
| `grammar.js` | switch · value · step · options · act; pending/confirmed/failed grammar | `shared_ui`: control renderers | `SupremeMotion`, command lifecycle state | all; 56 px on tv, ≥48 on watch |
| `sheet.js` | Device Sheet generated from capabilities, same renderers as Control | `mobile/features/device_sheet` | same renderers; no per-capability UI for unsupported | all |
| `devices.js` | canonical inventory: "In use now", "Needs attention", then *what the residence is made of* (by function → floor → room → device) | `mobile/features/devices` | device classification (production has `supremeType` + classification engine) | all but glance |
| `experiences.js` + `shape.js` + `runner.js` + `derive.activate` | one vocabulary; derived state (Active / Becoming / Partial / Unavailable) with per-system convergence; Shape (where → shape → keep) writes semantic per-space targets; **client-orchestrated phased activation** | `mobile/features/experiences` | production `Scene` (has steps); **contract gap — see §4** | all |
| `media.js` | space-first stage; interpolated progress; hand-off "Move here" only after the new room confirms; together = derived | `mobile/features/media` (a layer, not a nav item) | `MediaState` (position/duration/artwork exist; queue does not) | phone single column, tablet/desktop two column, watch minimal, tv large |
| `settings.js` (+ `rules.js`, `hubs.js`, `panelui.page`) | Home · Automations ("When things happen") · Experiences · Hubs · This panel · Connections · Notifications · Appearance · System · This device | `mobile/features/settings` | device-local preferences store; automation composer (homeowner language) | all but glance |
| `panelui.js` | commissioning overlay (welcome → room → installer code → confirm), *lost space* and *foreign residence* screens, `lastScreen`, guard, relabel | `touchpanel` + `mobile/features/panel` | Hub panel API (Phase 4); `SurfaceProfile.role` | room / residence / floor panel |
| `formfactor.js` | spatial focus; Left/Right stay with sliders and text; Home closes all layers; Back closes top layer; focus always visible; first-focus fallback = nav | `shared_ui`: `RemoteFocusScope` (Flutter `FocusTraversalPolicy`) | `SurfaceProfile.input == remote`; layer stack | tv (and D-pad panels) |
| `tone.js` | room photo takes the room's **confirmed** light: Kelvin→RGB matrix at 60 % strength, luminance-preserving; exposure `0.5+0.5·level^0.65`; lights off → 0.42 exposure, 0.72 saturation; eases 1100 ms; Experience images use the *intended* light | `shared_ui`: photography renderer using `ColorFilter.matrix` | Residence State (lights on/level/kelvin) | all with imagery |
| `sky.js` | residence's own clock + sun elevation from its location → sky veil on the glazing; day line; part-of-day words | `shared`: pure sun maths; `shared_ui`: day line + sky veil | **residence location & time zone** (see §4) | all with imagery |
| `photos.js` | glazing masks; sheer/curtain fabric drawn at the *confirmed* shade position; homeowner can replace a photo and mark windows (device-local, never residence state) | photography renderer; editor deferred | shade position state; `Room.heroImageUrl` | spaces, space, experiences |
| onboarding + arrival bridge | ivory presence animation → Welcome → Identity (passkey/password) → Residence (name, location, daylight) → Ready; Hub-not-found recovery with manual address; rings contract into the header mark (2.2 s) | `mobile/features/onboarding` (pairing) | production pairing (LAN discovery + code + Ed25519), identity service | all |
| icon set (`build.py`) | 19 hairline glyphs on a 24 grid, 1.4 stroke, round ends, one tonal plane | `shared_ui`: `SupremeGlyph` (data-driven painter) | none | all |
| `core.js` `describe/failText/say` | homeowner language for state and failure; **one voice per event** (toast only if the screen doesn't already say it) | `shared`: state-language derivation; `shared_ui`: quiet toast | command tracker outcomes | all |
| `surface.js` | one profile | **done (Phase 1A)** | — | all |

## 3. What can change, item by item

| Area | Finding |
|---|---|
| **Home** | Consistent with the plan. Adds: header name hidden on Home; last-known line is P0; glance/TV/residence-map are *compositions of the same Home* keyed by `SurfaceProfile`, not separate screens. |
| **Spaces** | Floors are shown as headings with an authored "character" line. Production has only `Room.floor` (int) — no floor name/character. Do not invent them (see §4). |
| **Control** | Layer, scoped, three entry contexts. Its "systems" resolve from capabilities/categories; **"Protection" needs alarm-arming and contact state that production capabilities do not clearly carry** (see §4). |
| **Experiences** | Larger than the plan: choreography (phases), per-system convergence, Shape/Keep, own-experience edit/rename/duplicate/delete, scopes of one / several spaces / residence. |
| **Settings** | Bigger than a list: hosts **Automations** and **Hubs** (homeowner-language) and, on panels, **This panel**. |
| **Phone nav** | Bottom bar with ringed centre Control when upright; a 76 px side rail on its side (found during implementation — the first draft of the plan missed it). Layer = bottom sheet upright, drawer on its side. |
| **Tablet nav** | Left rail with Control in it. Confirmed. |
| **Desktop nav** | Top pill group **without** a Control pill + a separate "Residence control" button. Confirmed (my earlier summary matched). |
| **Watch nav** | No nav. See ambiguity A2. |
| **Room-panel nav** | Spaces hidden; Home = its room; route guard. Consistent with the grammar. |
| **TV nav** | Same rail as tablet at 112 px; layer-scoped spatial focus; Home key closes all layers. |
| **Panel identity / binding** | Commissioning is an **overlay above everything**, the shell chrome is hidden while it shows; *lost* and *foreign-residence* are distinct states; `lastScreen` only for `space/experiences/devices`. Hub verifies the installer code. |
| **Surface classification** | Unchanged. New consumer: the shell reads `SurfaceProfile.skeleton/role/input/fold`. `zoom` must be applied *below* `SurfaceScope` (TV composes at 1440×810 and scales). |
| **Motion** | Ambient hero breathing (9 s), fabric travel 5.2 s / 1.2 s with `cubic-bezier(.45,0,.55,1)`, tone easing 1100 ms cubic-out, media artwork cross-fade, arrival 2.2 s. All obey device-local "Motion: reduced". |
| **State presentation** | Two independent inputs beyond device state: the **sun at the residence** and the **shade position drawn on the photograph**. "Reduced transparency" is a user preference that must disable blur. |

## 4. Findings against production (feeds the Phase 3 contract gate)

Verified this pass by reading `packages/domain-model`, `services/gateway/src/routes/scenes.ts`,
`services/scenes/src/scene-service.ts` and `packages/supreme-contracts/src/management.ts`.

**Correction to an earlier statement:** `GET /v1/scenes` **does** return full `Scene` entities including
`steps: [{deviceId, capability, values}]`. Scene targets exist; the Dart mapper simply does not read them.

| Golden Master need | Production today | Class |
|---|---|---|
| Experience target state per device | `Scene.steps` (deviceId, capability, target values) | **EXISTS** (unread by Flutter) |
| Own experiences kept by the Hub | `POST/PATCH/DELETE /v1/scenes`, `ownerUserId`, capture-current-state | **EXISTS** |
| Experience scope: one space / residence | `scope: room \| home`, `roomId` | **EXISTS** |
| Experience scope: *several spaces together* | not representable | **EXTEND** or drop that Shape option (decision D5) |
| Authored line / per-system effect words ("Soft, warm light and quiet music.") | none; custom ones would need generated words | **EXTEND** (optional description) — or derive; never invent |
| Choreography (`phases`: table first, then music) | none — `activate()` dispatches every step concurrently, best effort | **NEW** (Hub-side) |
| Per-step outcome & run progress ("Arrived 2 of 3", "didn't respond") | `activate` returns only a **count** of steps dispatched; run history exists in the automation debugger | **EXTEND** (run id + per-step result over `/v1/stream`) |
| Device-independent targets (replaced dimmer changes nothing) | steps are bound to `deviceId` | NOT REQUIRED now; note |
| Residence location + time zone (sky, residence clock) | `PUT /v1/home/location` exists; `Home` schema has no lat/lon/tz; read path unverified | **EXISTS / verify read** |
| Room photograph | `Room.heroImageUrl` (absolute or hub-relative `/v1/rooms/:id/hero-image`) | **EXISTS** |
| Glazing masks / curtain fabrics for a photo | none (Golden Master ships hand-drawn masks for its own images; editor for the rest, device-local) | **NEW**, deferred; without it the whole photo takes the room's light |
| Floor name and character | `Room.floor` int, `building`, `area` only | **EXTEND** or derive a plain label from the storey number ("Ground floor") and omit the character line |
| Presence ("Occupied") | no occupancy capability in `CapabilityKind` (`sensor` with a `measure` string) | verify; omit line if absent |
| Alarm arming state, door contact, lock | `lock` exists; **no arming capability**; contact would be `sensor` | **verify / EXTEND** — Home's "Protected/Secure", the watch's "● Secure" and Control › Protection depend on it |
| Per-device state timestamp; `assumed`; `feedback:none` | only `DeviceStatus` (online/offline/unavailable) | **EXTEND** (decided earlier) |
| Panel identity, commissioning, installer authentication | none | **NEW** (decided earlier) |
| Category from device | `supremeType` (`light`, `dimmer`, `color_light`, `thermostat`, `cover`, `media_player`, `lock`, …) + classification engine | **EXISTS** |
| Relative intents ("Warmer", "Quieter") | `domain-model/intents.ts` (Intent & Capability Engine) | **EXISTS — inspect before building** |
| Media queue / "Up next" | not in `MediaState` | omit until present |

## 5. Conflicts and ambiguities

**Conflicts (Golden Master vs. the brief / production):**

* **C1 — Experience orchestration and "running" state are client-side in the prototype.** `runner.js` keeps an
  `active` map per surface and `engine.pending` is local, so another surface would not know a run is in flight.
  That is a hidden per-surface state; the brief requires one residence state. Production activation is Hub-side.
  *Proposal:* Hub orchestrates (it survives the phone closing, and every surface sees the same run).
* **C2 — Watch depth.** The brief and grammar say the watch has no inventories, sheets, photography or
  configuration; the Golden Master's Home glance links to Spaces, Experiences, Settings and Control, and its own
  tests render Devices and Control under the watch profile. *Proposal:* follow the grammar; decision D2.
* **C3 — Multi-Home and Remote Access.** Production has paired Homes (add / rename / forget / switch) and a per-Home
  Remote Access switch. The Golden Master has one residence and no such screens. They must not disappear.
  *Proposal:* Settings › Home. Decision D3.
* **C4 — Onboarding vs. pairing.** The Golden Master asks the owner for name, email, passkey/password, residence name
  and location. Production pairs a device to a Hub by code and identity lives in the cloud identity service.
  The visual and arrival language should be kept; the *fields* follow production. Decision D4.
* **C5 — Homeowner "Hubs" page.** It adds, renames and removes Hubs; the brief says integration internals belong to
  Pro. The page avoids protocol terms but is still infrastructure. Keep as the Golden Master has it, or move
  add/remove to Pro? Decision D6.

**Ambiguities:**

* **A1 — Floor-scope panel.** No floor role in the grammar. Proposal: residence-panel navigation with Spaces limited
  to its floor; no new nav item. Decision D1.
* **A2 —** as C2.
* **A3 — Freshness.** "Last known state · 3 min ago" uses the time *this device* last heard from the residence
  (link-level, honest client knowledge). Per-device freshness must come from the Hub. Both are fine; do not merge them.
* **A4 — Incoming SIP calls.** Production has a call runtime; the Golden Master has no call UI. Proposal: a
  system-level layer above the page stack, not navigation. Decision D7.
* **A5 — Devices "what the residence is made of"** groups by function → floor → room; the brief's hierarchy is
  Space → Category → Device. Golden Master wins for expression; not a nav concern.

## 6. Verdict on the Phase 1C shell plan

The plan is **consistent** with the Golden Master and the grammar. Four additions are required before coding, none
changes the information architecture:

1. Control is a **layer host**, not a fifth page (drawer / sheet / hinge-docked), scoped by context.
2. **Header chrome** includes the presence mark and residence-name-hidden-on-Home.
3. The shell is a **pure function of `SurfaceProfile`** (+ room binding), so it needs no width checks — testable like
   the profile.
4. The layer stack defines **Back / Home / focus scope**, so TV works from the start.

`Now` and `More` are removed, with this classification: `NowScreen` (an empty placeholder) — nothing to preserve;
More › Devices → Control › devices (and Home's attention note); More › Automations → Settings › "When things happen";
More › Settings → Settings; More › Professional Mode → SupremeOS Pro (not in the homeowner shell);
`SettingsScreen` › Home (paired Homes, Remote Access) → Settings › Home (D3).

## Decisions needed from the owner (none blocks Phase 1C for phone, tablet, desktop)

| # | Decision | My recommendation |
|---|---|---|
| D1 | Floor-scope panel navigation | residence-panel navigation, Spaces limited to its floor |
| D2 | Watch: which destinations exist | Home glance + actions + Pause; links only to what the grammar allows |
| D3 | Where paired Homes and Remote Access live | Settings › Home |
| D4 | Onboarding fields in production | keep Golden Master look and arrival; fields follow Hub pairing |
| D5 | Shape "several spaces together" | drop until the Hub can represent it |
| D6 | Homeowner add/remove Hub | keep rename/status for the homeowner; move add/remove to Pro |
| D7 | Incoming calls | system layer above the stack |
| D8 | Who orchestrates Experiences | the Hub (phases, per-step results, one shared run) |

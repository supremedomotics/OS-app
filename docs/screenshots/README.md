# Supreme OS — UI Screenshots

Live screenshots of the homeowner apps, captured by driving the real, running software against the
mock demo home (no mockups). Commit these reflect: `2e2e140`.

## How they were captured
- **Gateway** booted with the offline mock backend (`SUPREME_BACKEND=mock`), which seeds a demo home
  (13 devices, 3 rooms, scenes) and the demo owner `owner@supreme.local`.
- **Web** (`web/`): the production build of `apps/web-homeowner`, served and driven by headless
  Chromium (Playwright) at a 1440×900 desktop/tablet viewport, logged in and navigated to every
  primary destination.
- **Mobile** (`mobile/`): the Flutter app compiled to web and driven at a 390×844 phone viewport
  (@3× retina). This is the identical widget tree that ships to iOS/Android — only the rendering
  surface differs.

## Contents

### `web/` — homeowner web (desktop/tablet rail layout)
`01-dashboard` · `02-discover-devices` · `03-devices` · `04-extension-center` · `05-automations` ·
`06-scenes` · `07-rooms` · `08-areas` · `09-media` · `10-security` · `11-energy` ·
`12-notifications` · `13-settings` · `14-room-detail`

### `mobile/` — iPhone/Android app (phone layout)
`00-login` · `01-dashboard` · `02-rooms` · `03-scenes` · `04-security` · `05-settings` ·
`06-more-sheet` · `07-media`

## Notes (sandbox-only artifacts, not shipped behaviour)
- **No weather chip / no room photos** in some shots: the capture sandbox blocks outbound calls to
  Open-Meteo (weather) and Openverse (room photos). On a real device these populate; the components
  render nothing on failure by design (never a broken state).
- **No Favourites / Recently-used rows**: the freshly-seeded demo home has no pins or usage history
  yet — both sections appear only once there's data (the "calm by default" rule).
- **Mobile fonts**: the licensed brand font (Inter / Aureon Display) isn't bundled in the repo yet,
  so the screenshot build substituted a metric-compatible font for legibility. Real builds use the
  intended typography.

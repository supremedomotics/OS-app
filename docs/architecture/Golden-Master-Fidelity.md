# Golden Master fidelity — the Flutter homeowner app

**Status: hard production requirement** (see `CLAUDE.md`, "Flutter homeowner app — Golden Master
fidelity"). This page records *how* it is verified and what is decided. The findings of the last
run live in `build/golden-master/` (not committed: `report.html`, `typography.md`) and are
summarised in `SESSION_HANDOFF.md`.

## The authority

`SupremeOS-10.html` — the Golden Master build. Its sources, where a behaviour is delegated:

| What | Where |
|---|---|
| Boot/arrival, onboarding screens, field panel | `SupremeOS_Onboarding_frozen.html` (embedded **byte for byte** in the build as `FROZEN_B64`) |
| Tokens, type, layout, per-form-factor rules | the build's `<style>` blocks (`:root`, `html[data-ff="…"]`, `#view-…`) |
| Behaviour | the build's scripts (`ui/formfactor.js`, `home.js`, `settings.js`, …) |
| Fonts | SOS Serif 300, SOS Sans 300 and 400 (embedded woff2 of Cormorant Garamond Light, Jost Light, Jost Regular) |
| Photography | `window.SUPREMEOS_ASSETS` — Living, Dining, Kitchen, Bathroom, Master Bedroom, Outdoor, Residential |

The rule: **value → behaviour → Flutter equivalent**. Read the real CSS/JS value, work out what it
does, then express exactly that in Flutter. Never a look-alike.

## What is ported, and how it is proved

| Surface | Flutter | Proof |
|---|---|---|
| Presence v11 (boot) | `features/onboarding/presence_engine.dart` — `frame(t)`, the phase timeline and the clock, value for value | `tools/golden-master-verify`: the original's engine is run on a **virtual clock** (16 ms frames, Hub answering at 3800 ms) and Flutter is painted at the same `t`; 11 frames across the whole choreography differ by **≤ 0.1 %** of pixels (anti-aliasing) on every profile |
| Field panel | `features/onboarding/field_panel.dart` — `drawPanel` + the critically-damped tween | pixel comparison of every onboarding screen |
| Onboarding screens | `onboarding_flow.dart` + `onboarding_tokens.dart` — the frozen CSS (type scale, `.btn`, `.link`, `.field`, `.meta`, `.eyebrow`, media queries, grid stretch) | pixel + text-run comparison |
| Room photography | `assets/golden_master/photography/` (extracted unchanged) → served by the **simulated** Hub's picture route → `HeroImageStore` → `ToneSurface(image:)` | visual + pixel comparison; a real Hub supplies its own |
| Home scrim | `home_screen.dart` — the original's `#view-home.sos-view--hero::before` gradients | pixel comparison |

Not duplicated: `ResidenceState`, `CommandTracker`, state provenance, `SurfaceProfile`/`SurfaceScope`,
the Hub contracts, the simulator transport and real pairing are unchanged and remain the sources of
truth. Nothing here is an HTML-specific domain model.

## Demo mode and Exit Demo Mode

* Demo is offered on **onboarding page 1 only** — the screen a person meets first once the Hub is
  found — and on that page's "not found yet" variant, so a LAN with no Hub can still reach it. It is
  not on Hub detection (Presence), identity, sign-in or ready, and not anywhere in the app. It exists
  only in a `SUPREME_SIMULATED_RESIDENCE=true` build.
* The `DEMO · SIMULATED RESIDENCE` indicator stays on every screen of such a build.
* Settings leads with **Exit Demo Mode** (the original's `.sos-danger` pill). It ends the simulator
  (`simulatedResidenceProvider` is invalidated; `ResidenceState`, the command tracker, the send path
  and the picture store are built on it and are released with it), clears `demoEntered`, sets the
  in-memory `arrivalRequested`, and the app shows page 1. It starts no pairing, makes no Hub
  connection and touches no paired Home or credential. A cold start decides from the stored Homes as
  it always did.

## Running the verification

```
tools/golden-master-verify/run.ps1                        # everything → build/golden-master
tools/golden-master-verify/run.ps1 -Profiles phone-portrait,desktop
```

Needs Node 22+, Chrome or Edge (`CHROME_PATH` to override) and Flutter. Nothing is installed; Chrome
runs with a private temporary profile.

| Step | Tool | Output |
|---|---|---|
| Capture the Golden Master | `capture-gm.mjs` (Chrome DevTools, no dependencies) | `gm/<profile>/<surface>.png` + `.json` text runs |
| Capture Flutter | `apps/new/mobile/test/golden_master/capture_test.dart` (real fonts loaded) | `flutter/<profile>/<surface>.png` + `.json` |
| Pixel comparison | `compare.mjs` | `diff/…`, `report.html`, `report.json` |
| Value comparison | `typography.mjs` | `typography.md` — *Golden Master value → Flutter value → mismatch* |
| Photography | `extract-photography.mjs` | `apps/new/mobile/assets/golden_master/photography/` |

Profiles and boot samples are defined once, in `profiles.json`. A profile is a `SurfaceProfile`
mode paired with the original's nearest form factor (`?ff=`):

| Profile | Size @dpr | Golden Master form factor |
|---|---|---|
| phone-portrait | 390×844 @2 | phone |
| phone-landscape | 844×390 @2 | phone (landscape) |
| tablet | 834×1194 @2 | tablet |
| desktop | 1440×900 @1 | desktop |
| ultrawide | 2560×1080 @1 | desktop (the original composes it at 1.2×) |
| room-panel | 1280×800 @1 | tablet (the original's 7–13″ wall panel: side rail) |

Surfaces: boot (11 samples), onboarding page 1 / identity / sign-in / ready / not-found, Home,
Spaces, Space, Control, Experiences, Settings, Devices, Device sheet.

### How the original is made deterministic

* **Boot** — a virtual clock (`vclock-shim.mjs`) replaces `setTimeout`/`setInterval`/`requestAnimationFrame`/
  `performance.now`/`Date.now` in every document, including the onboarding `srcdoc` iframe, and flushes
  promise reactions between frames (the original delivers the Hub's answer through a promise chain;
  without that, its response is placed late — this was a bug in the first version of the harness).
* **Onboarding screens** — captured under `prefers-reduced-motion` (the original's settled path).
* **App** — the original's own `?dev&skip-onboarding`, its development panel hidden, the sky pinned to
  the residence's local 15:00 with its own `ui.sky.setMoment`.

### What a number means

`% differ` is the share of pixels with any channel more than 24/255 away. It is a tripwire, not a
verdict: content that is data (a different residence, time-sensitive words) and the DEMO banner (which
every simulated surface carries) will always differ. Read the images and `typography.md`.

## Known, deliberate differences from the original

* **Account / passkey / email** — the original's "Identity" account step and its passkey sign-in are
  not drawn: Flutter has no such model, and the product's sign-in is the pairing-code ceremony. The
  Sign-in screen has the original's frame and a "Pairing code" field in place of its passkey/email
  form, and says what it is.
* **Location and daylight rows** on the residence step — no model for either.
* **Manual connect (IP/port)** on "not found" — no manual-address path in production.
* **Page 1 lede** — "Give it a name, and SupremeOS will know this residence as yours." replaces
  "Tell SupremeOS who you are, …", because there is no account step to tell.
* **Wordmark weight 600** — only 300/400 are bundled, as in the original, whose browser synthesises
  the bold; Flutter does the same.
* **DEMO banner** — Flutter-only; present on every screen of a simulation build.

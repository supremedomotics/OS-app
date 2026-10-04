// The surfaces, profiles and boot samples both sides capture — one definition (profiles.json), so
// the Golden Master and Flutter are always compared like for like.
//
// A "profile" is a SurfaceProfile mode. `ff` is the Golden Master's own form factor
// (`?ff=` in its `formfactor.js`), the closest thing it has to the same surface.
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync(new URL('./profiles.json', import.meta.url), 'utf8'));

export const PROFILES = cfg.profiles;

// Presence boot: the original's engine is stepped on a virtual clock in 16 ms frames, and the Hub
// answers at virtual 3800 ms (its own demo discovery: DEMO_HUB_DELAY). A frame is named by the
// virtual time it was captured at.
export const BOOT_STEP_MS = cfg.boot.stepMs;
export const HUB_ANSWER_MS = cfg.boot.hubAnswerMs;
export const BOOT_FRAMES = cfg.boot.frames;

// What both sides show for the app surfaces: the residence's local hour, and the space opened.
export const RESIDENCE_HOUR = cfg.residence.hour;
export const SPACE = { gm: cfg.residence.spaceId, flutterName: cfg.residence.spaceName };

// Surfaces, in the order the report lists them. `group` is how the report sections them.
export const SURFACES = [
  ...BOOT_FRAMES.map((t) => ({
    id: `boot-${String(t).padStart(5, '0')}`,
    group: t < 3900 ? 'boot / arrival' : t < 10000 ? 'hub found' : 'arrival rest',
    kind: 'boot',
    t,
  })),
  { id: 'onboarding-page-1', group: 'onboarding', kind: 'onboarding' },
  { id: 'onboarding-identity', group: 'onboarding', kind: 'onboarding' },
  { id: 'onboarding-signin', group: 'onboarding', kind: 'onboarding' },
  { id: 'onboarding-ready', group: 'onboarding', kind: 'onboarding' },
  { id: 'onboarding-not-found', group: 'onboarding', kind: 'onboarding' },
  { id: 'home', group: 'app', kind: 'app' },
  { id: 'spaces', group: 'app', kind: 'app' },
  { id: 'space', group: 'app', kind: 'app' },
  { id: 'control', group: 'app', kind: 'app' },
  { id: 'experiences', group: 'app', kind: 'app' },
  { id: 'settings', group: 'app', kind: 'app' },
  { id: 'devices', group: 'app', kind: 'app' },
  { id: 'device-sheet', group: 'app', kind: 'app' },
];

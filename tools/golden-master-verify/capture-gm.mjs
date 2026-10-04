#!/usr/bin/env node
// Captures the Golden Master (the HTML build) at every profile and surface in profiles.mjs.
//
//   node capture-gm.mjs --gm "G:/Downloads/SupremeOS-10.html" --out build/golden-master [--profiles a,b] [--only boot,app]
//
// - Presence boot is deterministic: the original's own engine is run on a virtual clock (16 ms frames,
//   the Hub answering at 3800 ms), so a frame at "t = 5504 ms" is the same frame every run.
// - Onboarding screens are captured under prefers-reduced-motion (the original's settled path), so
//   there is nothing mid-animation to compare.
// - App surfaces run the original with its own `?dev&skip-onboarding` switch, its development panel
//   hidden, and the sky pinned to the residence's local 15:00 (the hour the Flutter side uses).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { launchChrome, Page, sleep } from './cdp.mjs';
import { SHIM } from './vclock-shim.mjs';
import { PROBE_EXPR } from './probe.mjs';
import { PROFILES, SURFACES, BOOT_FRAMES, BOOT_STEP_MS, HUB_ANSWER_MS, RESIDENCE_HOUR, SPACE } from './profiles.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : a), []),
);
const GM_FILE = path.resolve(args.gm ?? 'G:/Downloads/SupremeOS-10.html');
const OUT = path.resolve(args.out ?? 'build/golden-master');
const only = new Set(String(args.only ?? 'boot,onboarding,app').split(','));
const wanted = String(args.profiles ?? Object.keys(PROFILES).join(',')).split(',');
const gmUrl = (q = '') => `${pathToFileURL(GM_FILE).href}?${q}`;

const HIDE_DEV = `document.addEventListener('DOMContentLoaded', () => {
  const s = document.createElement('style'); s.textContent = '#sos-dev{display:none!important}'; document.head.append(s);
});`;

const FRAME = `document.getElementById('sos-onboarding').contentWindow`;
// The onboarding app is showing screen `id` and Presence has handed over.
const appShown = (id) => `(() => { const D = ${FRAME}.document, a = D.querySelector('.screen.active'); return !!a && a.id === '${id}' && !D.getElementById('presenceLayer').classList.contains('on') && !D.getElementById('app').inert; })()`;
const inFrame = (page, expr) => page.eval(`(() => { const W = ${FRAME}; const D = W.document; return (${expr}); })()`);

async function waitFor(page, expr, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await page.eval(expr)) return; } catch {}
    await sleep(100);
  }
  throw new Error('timed out waiting for: ' + expr.slice(0, 120));
}

// Steps the original's virtual clock in slices (letting promises such as its font-ready start run in
// between) until `cond` holds, or `maxMs` of virtual time has passed.
async function advanceUntil(page, cond, maxMs = 20000, slice = 250) {
  for (let t = 0; t < maxMs; t += slice) {
    if (await page.eval(cond)) return;
    await inFrame(page, `W.__vt.advance(${slice}, ${BOOT_STEP_MS})`);
    await sleep(15);
  }
  if (!(await page.eval(cond))) throw new Error('virtual time ran out waiting for: ' + cond.slice(0, 120));
}

async function open(chrome, p, { shim = false, reduced = false } = {}) {
  const page = await Page.open(chrome.port);
  await page.viewport(p);
  if (reduced) {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  }
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: HIDE_DEV });
  if (shim) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SHIM });
  return page;
}

// Screenshot, and (unless it is a boot frame) the text runs on screen — in the onboarding iframe's
// document for the onboarding screens, in the page's own for the app.
async function shot(page, dir, name, { inFrame: frame = false, probe = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot(path.join(dir, `${name}.png`), fs);
  if (probe) {
    const runs = frame
      ? await page.eval(`(() => { const W = ${FRAME}; return W.eval(${JSON.stringify(PROBE_EXPR)}); })()`)
      : await page.eval(PROBE_EXPR);
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(runs, null, 1));
  }
  console.log('  ✓', path.relative(OUT, path.join(dir, `${name}.png`)));
}

// ── boot: Presence frames on the virtual clock ───────────────────────────────────────────────
async function bootFrames(chrome, pname, p) {
  const page = await open(chrome, p, { shim: true });
  await page.goto(gmUrl(`ff=${p.ff}`));
  await waitFor(page, `(() => { const f = document.getElementById('sos-onboarding'); return !!(f && f.contentWindow && f.contentWindow.SupremeOSPresence && f.contentWindow.__vt); })()`);
  await sleep(900); // fonts load in real time; the engine begins when they have
  await waitFor(page, `${FRAME}.__vt.pendingRaf() > 0`);
  let at = 0;
  for (const t of BOOT_FRAMES) {
    await inFrame(page, `W.__vt.advance(${t - at}, ${BOOT_STEP_MS})`);
    at = t;
    await sleep(120);
    await shot(page, path.join(OUT, 'gm', pname), `boot-${String(t).padStart(5, '0')}`, { probe: false });
  }
  page.close();
}

// ── onboarding screens (reduced motion = the settled path) ──────────────────────────────────
async function onboardingScreens(chrome, pname, p) {
  const page = await open(chrome, p, { shim: true, reduced: true });
  const dir = path.join(OUT, 'gm', pname);
  await page.goto(gmUrl(`ff=${p.ff}`));
  await waitFor(page, `(() => { const f = document.getElementById('sos-onboarding'); return !!(f && f.contentWindow && f.contentWindow.SupremeOSPresence && f.contentWindow.__vt); })()`);
  await sleep(900);
  await advanceUntil(page, appShown('s-welcome'));
  await sleep(250);
  const settle = async (name) => { await inFrame(page, `W.__vt.advance(100, ${BOOT_STEP_MS})`); await sleep(250); await shot(page, dir, name, { inFrame: true }); };

  await settle('onboarding-page-1');

  // Sign in (from page 1's inline link), and back.
  await inFrame(page, `D.querySelector('[data-go="login"]').click()`);
  await settle('onboarding-signin');
  await inFrame(page, `D.querySelector('#s-login [data-go="welcome"]').click()`);

  // Begin → Identity step (the original's account step is filled so the flow reaches the residence).
  await inFrame(page, `D.getElementById('w-primary').click()`);
  await inFrame(page, `(() => { D.getElementById('a-name').value = 'Test Owner'; D.getElementById('a-email').value = 'owner@example.com'; D.querySelector('[data-submit="f-account"]').click(); })()`);
  await settle('onboarding-identity');

  // Complete → Ready.
  await inFrame(page, `(() => { D.getElementById('r-name').value = 'Villa Son Vida'; D.getElementById('r-loc').value = 'Palma, Spain'; D.querySelector('[data-submit="f-residence"]').click(); })()`);
  await settle('onboarding-ready');
  page.close();

  // Hub not found: its own `?nohub` switch.
  const nf = await open(chrome, p, { shim: true, reduced: true });
  await nf.goto(gmUrl(`ff=${p.ff}&nohub`));
  await waitFor(nf, `(() => { const f = document.getElementById('sos-onboarding'); return !!(f && f.contentWindow && f.contentWindow.SupremeOSPresence && f.contentWindow.__vt); })()`);
  await sleep(900);
  // The original's own switch (Ctrl+Shift+H, "during the first seconds of Presence"): the Hub never answers.
  await inFrame(nf, `W.dispatchEvent(new KeyboardEvent('keydown', { key: 'H', shiftKey: true, ctrlKey: true }))`);
  await advanceUntil(nf, appShown('s-nohub'), 30000);
  await sleep(250);
  await shot(nf, dir, 'onboarding-not-found', { inFrame: true });
  nf.close();
}

// ── app surfaces ────────────────────────────────────────────────────────────────────────────
async function appSurfaces(chrome, pname, p) {
  const page = await open(chrome, p);
  const dir = path.join(OUT, 'gm', pname);
  await page.goto(gmUrl(`ff=${p.ff}&dev&skip-onboarding`));
  await sleep(3500);
  // Pin the sky to the residence's local hour, with the original's own development hook.
  await page.eval(`(() => { try {
    const S = window.SupremeOS, tz = S.model.RESIDENCE.location.timeZone, base = new Date();
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(base);
    let off = (+f.find(x => x.type === 'hour').value) * 60 + (+f.find(x => x.type === 'minute').value) - (base.getUTCHours() * 60 + base.getUTCMinutes());
    if (off > 720) off -= 1440; if (off < -720) off += 1440;
    S.ui.sky.setMoment(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 0, ${RESIDENCE_HOUR * 60} - off)));
  } catch (e) { console.error('sky', e); } })()`);
  const go = async (v, params = {}, wait = 1600) => { await page.eval(`SupremeOS.ui.go(${JSON.stringify(v)}, ${JSON.stringify(params)})`); await sleep(wait); };

  await go('home'); await shot(page, dir, 'home');
  await go('spaces'); await shot(page, dir, 'spaces');
  await go('space', { space: SPACE.gm }); await shot(page, dir, 'space');
  await go('experiences'); await shot(page, dir, 'experiences');
  await go('settings'); await shot(page, dir, 'settings');
  await go('home', {}, 900);
  await page.eval('SupremeOS.ui.openControl()'); await sleep(1100); await shot(page, dir, 'control');
  await go('devices'); await shot(page, dir, 'devices');
  await page.eval(`(() => { const b = document.querySelector('#view-devices [data-dev]') || document.querySelector('[data-dev]'); if (b) b.click(); })()`);
  await sleep(1100); await shot(page, dir, 'device-sheet');
  page.close();
}

const chrome = await launchChrome();
try {
  fs.mkdirSync(OUT, { recursive: true });
  const bytes = fs.readFileSync(GM_FILE);
  fs.writeFileSync(path.join(OUT, 'gm-meta.json'), JSON.stringify({
    file: GM_FILE, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    chrome: chrome.version.Browser, at: new Date().toISOString(), profiles: wanted,
  }, null, 2));
  for (const pname of wanted) {
    const p = PROFILES[pname];
    if (!p) throw new Error('unknown profile ' + pname);
    console.log(`\n${pname}  ${p.width}×${p.height} @${p.dpr}  (ff=${p.ff})`);
    if (only.has('boot')) await bootFrames(chrome, pname, p);
    if (only.has('onboarding')) await onboardingScreens(chrome, pname, p);
    if (only.has('app')) await appSurfaces(chrome, pname, p);
  }
} finally {
  await chrome.close();
}

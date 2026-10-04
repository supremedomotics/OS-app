#!/usr/bin/env node
// Extracts the Golden Master's room photography (window.SUPREMEOS_ASSETS in the HTML build) into
// apps/new/mobile/assets/golden_master/photography/, byte for byte — the Flutter simulator serves
// these, through the Hub's picture route, so a simulated residence looks as the original does.
//
//   node extract-photography.mjs --gm "G:/Downloads/SupremeOS-10.html" [--out apps/new/mobile/assets/golden_master/photography]
//
// The names are the original's: Living, Dining, Kitchen, Bathroom, Master Bedroom, Outdoor,
// Residential (the residence hero). Mapping to spaces lives in the Flutter app, not here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : a), []),
);
const gm = path.resolve(args.gm ?? 'G:/Downloads/SupremeOS-10.html');
const out = path.resolve(args.out ?? new URL('../../apps/new/mobile/assets/golden_master/photography', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const html = fs.readFileSync(gm, 'utf8');
const m = html.match(/window\.SUPREMEOS_ASSETS\s*=\s*(\{[\s\S]*?\});/);
if (!m) throw new Error('window.SUPREMEOS_ASSETS not found in ' + gm);
const assets = JSON.parse(m[1]);
fs.mkdirSync(out, { recursive: true });
const manifest = [];
for (const [name, uri] of Object.entries(assets)) {
  const mm = uri.match(/^data:(image\/[a-z+]+);base64,(.*)$/s);
  if (!mm) continue;
  const bytes = Buffer.from(mm[2], 'base64');
  const file = decodeURIComponent(name).toLowerCase().replace(/[^a-z0-9]+/g, '-') + (mm[1] === 'image/jpeg' ? '.jpg' : '.png');
  fs.writeFileSync(path.join(out, file), bytes);
  manifest.push({ name: decodeURIComponent(name), file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  console.log(`${decodeURIComponent(name).padEnd(16)} → ${file}  ${bytes.length} bytes`);
}
fs.writeFileSync(path.join(out, 'MANIFEST.json'), JSON.stringify({ source: path.basename(gm), assets: manifest }, null, 2));

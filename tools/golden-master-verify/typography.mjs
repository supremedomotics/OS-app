#!/usr/bin/env node
// Matches the Golden Master's text runs (gm/**.json) with Flutter's (flutter/**.json) by text and
// reports every difference as   Golden Master value → Flutter value → mismatch.
//
//   node typography.mjs --out build/golden-master [--profiles phone-portrait] [--only home,spaces]
//
// Writes typography.json and typography.md next to the report.
import fs from 'node:fs';
import path from 'node:path';
import { PROFILES, SURFACES } from './profiles.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : a), []),
);
const OUT = path.resolve(args.out ?? 'build/golden-master');
const profiles = String(args.profiles ?? Object.keys(PROFILES).join(',')).split(',');
const only = args.only ? new Set(String(args.only).split(',')) : null;

const TOL = { pos: 2, size: 3, font: 0.25, spacing: 0.25, color: 8, alpha: 0.05 };
const key = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
const hex = (c) => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}${c[3] < 0.995 ? ` @${(+c[3]).toFixed(2)}` : ''}`;
const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);

const report = [];
const missing = [];
for (const profile of profiles) {
  for (const s of SURFACES) {
    if (s.kind === 'boot' || (only && !only.has(s.id))) continue;
    const gm = read(path.join(OUT, 'gm', profile, `${s.id}.json`));
    const fl = read(path.join(OUT, 'flutter', profile, `${s.id}.json`));
    if (!gm || !fl) { if (gm && !fl) missing.push(`${profile}/${s.id}`); continue; }

    const byKey = (runs) => {
      const m = new Map();
      for (const r of [...runs].sort((a, b) => a.y - b.y || a.x - b.x)) m.set(key(r.text), [...(m.get(key(r.text)) ?? []), r]);
      return m;
    };
    const G = byKey(gm), F = byKey(fl);
    const rows = [];
    const onlyGm = [], onlyFl = [];
    for (const [k, gs] of G) {
      const fs_ = F.get(k) ?? [];
      gs.forEach((g, i) => {
        const f = fs_[i];
        if (!f) { onlyGm.push(g); return; }
        const d = (prop, gv, fv, note = '') => rows.push({ text: g.text, prop, gm: gv, fl: fv, note });
        if (Math.abs(g.x - f.x) > TOL.pos) d('x', g.x, f.x, `Δ ${(f.x - g.x).toFixed(1)}`);
        if (Math.abs(g.y - f.y) > TOL.pos) d('y', g.y, f.y, `Δ ${(f.y - g.y).toFixed(1)}`);
        if (Math.abs(g.w - f.w) > TOL.size) d('width', g.w, f.w, `Δ ${(f.w - g.w).toFixed(1)}`);
        if (Math.abs(g.h - f.h) > TOL.size) d('height', g.h, f.h, `Δ ${(f.h - g.h).toFixed(1)}`);
        if (Math.abs(g.fontSize - f.fontSize) > TOL.font) d('font-size', g.fontSize, f.fontSize);
        if (g.fontWeight !== f.fontWeight) d('font-weight', g.fontWeight, f.fontWeight);
        if (Math.abs(g.letterSpacing - f.letterSpacing) > TOL.spacing) d('letter-spacing', g.letterSpacing, f.letterSpacing);
        if (g.family !== f.family && !(g.family.startsWith('SOS') && f.family.includes(g.family.replace(' ', '')))) d('family', g.family, f.family);
        const dc = Math.max(...[0, 1, 2].map((j) => Math.abs(g.color[j] - f.color[j])));
        if (dc > TOL.color || Math.abs(g.color[3] - f.color[3]) > TOL.alpha) d('color', hex(g.color), hex(f.color));
      });
      (F.get(k) ?? []).slice(gs.length).forEach((f) => onlyFl.push(f));
    }
    for (const [k, fs_] of F) if (!G.has(k)) onlyFl.push(...fs_);
    report.push({ profile, surface: s.id, gmRuns: gm.length, flRuns: fl.length, matched: gm.length - onlyGm.length, rows, onlyGm, onlyFl });
  }
}

fs.writeFileSync(path.join(OUT, 'typography.json'), JSON.stringify({ tolerances: TOL, report, notCaptured: missing }, null, 2));

let md = `# Golden Master → Flutter: text, position and type\n\nTolerances: position ${TOL.pos}px, size ${TOL.size}px, font-size ${TOL.font}px, letter-spacing ${TOL.spacing}px, colour ${TOL.color}/255.\n`;
for (const r of report) {
  md += `\n## ${r.profile} · ${r.surface}\n${r.matched}/${r.gmRuns} Golden Master text runs found in Flutter; ${r.rows.length} differences; ${r.onlyGm.length} missing in Flutter; ${r.onlyFl.length} only in Flutter.\n`;
  if (r.rows.length) {
    md += `\n| text | property | Golden Master | Flutter | note |\n|---|---|---|---|---|\n`;
    for (const x of r.rows) md += `| ${x.text.slice(0, 48).replace(/\|/g, '\\|')} | ${x.prop} | ${x.gm} | ${x.fl} | ${x.note} |\n`;
  }
  if (r.onlyGm.length) md += `\n**Missing in Flutter:** ${r.onlyGm.map((t) => '“' + t.text.slice(0, 40) + '”').join(', ')}\n`;
  if (r.onlyFl.length) md += `\n**Only in Flutter:** ${r.onlyFl.map((t) => '“' + t.text.slice(0, 40) + '”').join(', ')}\n`;
}
fs.writeFileSync(path.join(OUT, 'typography.md'), md);
const total = report.reduce((n, r) => n + r.rows.length, 0);
console.log(`typography: ${report.length} surfaces, ${total} differences → ${path.join(OUT, 'typography.md')}`);

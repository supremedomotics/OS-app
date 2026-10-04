#!/usr/bin/env node
// Sets the Golden Master captures beside the Flutter captures: a pixel diff for every surface and
// profile, and an HTML report (GM | Flutter | difference) with the numbers.
//
//   node compare.mjs --out build/golden-master
//
// The diff runs in Chrome's canvas (no dependencies). A pixel "differs" when any channel is more
// than THRESHOLD/255 away; `meanΔ` is the mean absolute channel difference (0–255).
import fs from 'node:fs';
import path from 'node:path';
import { launchChrome, Page } from './cdp.mjs';
import { PROFILES, SURFACES } from './profiles.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : a), []),
);
const OUT = path.resolve(args.out ?? 'build/golden-master');
const THRESHOLD = 24;
const profiles = Object.keys(PROFILES).filter((p) => fs.existsSync(path.join(OUT, 'gm', p)));

const DIFF = `(async (aUrl, bUrl, threshold) => {
  const load = (u) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });
  const [a, b] = await Promise.all([load(aUrl), load(bUrl)]);
  const w = Math.max(a.width, b.width), h = Math.max(a.height, b.height);
  const draw = (img) => { const c = new OffscreenCanvas(w, h), x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#ff00ff'; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h); };
  const A = draw(a), B = draw(b);
  const out = new OffscreenCanvas(w, h), ox = out.getContext('2d'), O = ox.createImageData(w, h);
  let sum = 0, over = 0;
  for (let i = 0; i < A.data.length; i += 4) {
    const dr = Math.abs(A.data[i] - B.data[i]), dg = Math.abs(A.data[i + 1] - B.data[i + 1]), db = Math.abs(A.data[i + 2] - B.data[i + 2]);
    const m = Math.max(dr, dg, db);
    sum += (dr + dg + db) / 3;
    if (m > threshold) { over++; O.data[i] = 255; O.data[i + 1] = 40; O.data[i + 2] = 60; O.data[i + 3] = 255; }
    else { const g = 255 - Math.min(255, m * 4); const base = 245; O.data[i] = O.data[i + 1] = O.data[i + 2] = Math.min(base, g); O.data[i + 3] = 255; }
  }
  ox.putImageData(O, 0, 0);
  const blob = await out.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (const v of buf) s += String.fromCharCode(v);
  return { w, h, aw: a.width, ah: a.height, bw: b.width, bh: b.height, meanDelta: sum / (w * h), pctDiffer: 100 * over / (w * h), diff: btoa(s) };
})`;

const rows = [];
const chrome = await launchChrome();
try {
  const page = await Page.open(chrome.port);
  await page.goto('about:blank');
  for (const profile of profiles) {
    for (const s of SURFACES) {
      const gm = path.join(OUT, 'gm', profile, `${s.id}.png`);
      const fl = path.join(OUT, 'flutter', profile, `${s.id}.png`);
      const row = { profile, id: s.id, group: s.group };
      if (!fs.existsSync(gm)) { row.status = 'no-gm'; rows.push(row); continue; }
      if (!fs.existsSync(fl)) { row.status = 'no-flutter'; rows.push(row); continue; }
      const url = (f) => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
      const r = await page.eval(`${DIFF}(${JSON.stringify(url(gm))}, ${JSON.stringify(url(fl))}, ${THRESHOLD})`);
      const dp = path.join(OUT, 'diff', profile, `${s.id}.png`);
      fs.mkdirSync(path.dirname(dp), { recursive: true });
      fs.writeFileSync(dp, Buffer.from(r.diff, 'base64'));
      Object.assign(row, { status: 'ok', meanDelta: +r.meanDelta.toFixed(2), pctDiffer: +r.pctDiffer.toFixed(2), sizeMatch: r.aw === r.bw && r.ah === r.bh, gmSize: [r.aw, r.ah], flSize: [r.bw, r.bh] });
      rows.push(row);
      console.log(`${profile.padEnd(16)} ${s.id.padEnd(22)} meanΔ ${String(row.meanDelta).padStart(6)}  ${String(row.pctDiffer).padStart(6)}% differ${row.sizeMatch ? '' : '  SIZE MISMATCH ' + r.aw + '×' + r.ah + ' vs ' + r.bw + '×' + r.bh}`);
    }
  }
  page.close();
} finally {
  await chrome.close();
}

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ threshold: THRESHOLD, at: new Date().toISOString(), rows }, null, 2));

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const cell = (r) => {
  if (r.status === 'no-flutter') return `<td class="miss" colspan="3">Flutter surface not captured</td>`;
  if (r.status === 'no-gm') return `<td class="miss" colspan="3">Golden Master surface not captured</td>`;
  const rel = (k) => `${k}/${r.profile}/${r.id}.png`;
  const cls = r.pctDiffer < 2 ? 'good' : r.pctDiffer < 10 ? 'warn' : 'bad';
  return `<td><a href="${rel('gm')}"><img loading="lazy" src="${rel('gm')}"></a></td><td><a href="${rel('flutter')}"><img loading="lazy" src="${rel('flutter')}"></a></td><td><a href="${rel('diff')}"><img loading="lazy" src="${rel('diff')}"></a><div class="m ${cls}">meanΔ ${r.meanDelta} · ${r.pctDiffer}% differ${r.sizeMatch ? '' : ' · SIZE ' + r.gmSize.join('×') + ' vs ' + r.flSize.join('×')}</div></td>`;
};
let html = `<!doctype html><meta charset="utf-8"><title>Golden Master verification</title><style>
body{font:14px system-ui;margin:24px;background:#0e0f10;color:#eee}h1{font-weight:300}h2{margin-top:40px;font-weight:400;border-bottom:1px solid #333;padding-bottom:6px}
table{border-collapse:collapse;margin:12px 0}td{vertical-align:top;padding:6px;border:1px solid #2a2a2a}td img{max-width:360px;max-height:520px;display:block}
.m{font-size:12px;margin-top:4px}.good{color:#8fd19e}.warn{color:#e8c46a}.bad{color:#ff7a7a}.miss{color:#999;font-style:italic;padding:20px}
th{padding:6px;text-align:left;color:#aaa;font-weight:400}.s{font-weight:600}</style>
<h1>Golden Master verification</h1><p>Threshold ${THRESHOLD}/255 per channel. Columns: Golden Master · Flutter · difference (red = differs).</p>`;
for (const profile of profiles) {
  html += `<h2>${esc(profile)} — ${PROFILES[profile].width}×${PROFILES[profile].height} @${PROFILES[profile].dpr} <small style="color:#888">(${esc(PROFILES[profile].note)})</small></h2><table><tr><th>surface</th><th>Golden Master</th><th>Flutter</th><th>difference</th></tr>`;
  for (const r of rows.filter((x) => x.profile === profile)) html += `<tr><td class="s">${esc(r.id)}<div class="m">${esc(r.group)}</div></td>${cell(r)}</tr>`;
  html += `</table>`;
}
fs.writeFileSync(path.join(OUT, 'report.html'), html);
console.log('\nreport:', path.join(OUT, 'report.html'));

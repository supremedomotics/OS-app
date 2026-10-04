// Records every visible text run of a Golden Master document: where it is and how it is set. The
// Flutter side records the same fields from its render tree (capture_test.dart), and
// `typography.mjs` matches the two by text, so a mismatch is a number, not an impression.
//
// Positions are CSS px relative to the viewport; colours are [r,g,b,a]; `upper` means the original
// draws it in capitals through CSS `text-transform` (Flutter has to draw the capitals itself).

// Serialised into the page (Function.prototype.toString) — it must not capture anything.
export function probeDocument() {
  const out = [];
  const W = window.innerWidth, H = window.innerHeight;
  const rgba = (c) => {
    const m = c.match(/[\d.]+/g).map(Number);
    return [m[0], m[1], m[2], m.length > 3 ? m[3] : 1];
  };
  const hiddenChain = (el) => {
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0 || e.hidden) return true;
    }
    return false;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode()); ) {
    const text = n.nodeValue.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const el = n.parentElement;
    if (!el || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TITLE'].includes(el.tagName)) continue;
    if (hiddenChain(el)) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const b = range.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) continue;
    if (b.right <= 0 || b.bottom <= 0 || b.left >= W || b.top >= H) continue; // not on screen
    const cs = getComputedStyle(el);
    const ls = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing);
    out.push({
      text,
      x: +b.x.toFixed(2), y: +b.y.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2),
      fontSize: parseFloat(cs.fontSize),
      fontWeight: +cs.fontWeight,
      letterSpacing: +ls.toFixed(3),
      lineHeight: cs.lineHeight === 'normal' ? null : parseFloat(cs.lineHeight),
      color: rgba(cs.color),
      family: cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
      upper: cs.textTransform === 'uppercase',
    });
  }
  return out;
}

export const PROBE_EXPR = `(${probeDocument.toString()})()`;

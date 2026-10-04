// A virtual clock for the page (and, because it is registered for every new document, for the
// onboarding iframe): setTimeout / setInterval / requestAnimationFrame / performance.now / Date.now.
export const SHIM = `(() => {
  if (window.__vt) return;
  let now = 0, tid = 1, rid = 1;
  const timers = new Map(), rafs = new Map(), base = Date.now();
  performance.now = () => now;
  Date.now = () => base + now;
  window.requestAnimationFrame = (cb) => { const id = rid++; rafs.set(id, cb); return id; };
  window.cancelAnimationFrame = (id) => { rafs.delete(id); };
  window.setTimeout = (fn, ms, ...a) => { const id = tid++; timers.set(id, { at: now + (+ms || 0), fn: () => fn(...a) }); return id; };
  window.setInterval = (fn, ms, ...a) => { const id = tid++; timers.set(id, { at: now + (+ms || 1), every: +ms || 1, fn: () => fn(...a) }); return id; };
  window.clearTimeout = window.clearInterval = (id) => { timers.delete(id); };
  function runDue() {
    for (;;) {
      let best = null;
      for (const [id, t] of timers) if (t.at <= now && (!best || t.at < best[1].at)) best = [id, t];
      if (!best) return;
      const [id, t] = best;
      if (t.every) t.at += t.every; else timers.delete(id);
      try { t.fn(); } catch (e) { console.error(e); }
    }
  }
  window.__vt = {
    now: () => now,
    pendingRaf: () => rafs.size,
    // Async on purpose: after each frame the page's promise chains must run (the original's Hub
    // answer is delivered through one), exactly as they would between real frames.
    async advance(ms, step = 16) {
      const end = now + ms;
      while (now < end) {
        now = Math.min(end, now + step);
        runDue();
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        const cbs = [...rafs]; rafs.clear();
        for (const [, cb] of cbs) { try { cb(now); } catch (e) { console.error(e); } }
        await Promise.resolve();
      }
      return now;
    },
  };
})();`;

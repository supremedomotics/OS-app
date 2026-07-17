import { useEffect, useMemo, useRef, useState } from "react";
import { client, fetchAutomations } from "./api.js";
import type { Tab } from "./App.js";
import { useOpenDevice } from "./device-detail-router.js";

/**
 * Global search / command palette (§ Global Search). One place to jump to anything — devices, rooms,
 * scenes, automations, or a navigation destination — by fuzzy name. Opened with ⌘K / Ctrl-K or the
 * search button. Pure client-side over data the app already has; selecting a device hands off to the
 * Canonical Device Detail Router (§ Platform Architecture Rule) via openDevice() — search never
 * merely jumps to the Devices tab and makes the homeowner find it again.
 */
export type PaletteNav = { id: Tab; label: string };
type Item = { key: string; label: string; sub: string; tab: Tab; roomId?: string; deviceId?: string };

/** A light subsequence score: all query chars must appear in order; earlier + tighter matches rank higher. */
function score(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let first = -1;
  let last = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (first < 0) first = ti;
      last = ti;
      qi++;
    }
  }
  if (qi < q.length) return null;
  // Lower is better: prefer early start + compact span.
  return first + (last - first) * 0.5;
}

export function CommandPalette({ navItems, onNavigate, onSelectRoom, onClose }: {
  navItems: PaletteNav[]; onNavigate: (t: Tab) => void; onSelectRoom: (id: string) => void; onClose: () => void;
}) {
  const { openDevice } = useOpenDevice();
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    void (async () => {
      const base: Item[] = navItems.map((n) => ({ key: `nav:${n.id}`, label: n.label, sub: "Go to", tab: n.id }));
      try {
        const [home, scenes, autos] = await Promise.all([client.home(), client.scenes(), fetchAutomations()]);
        for (const r of home.rooms) base.push({ key: `room:${r.id}`, label: r.name, sub: "Room", tab: "rooms", roomId: r.id });
        // Devices carry their room for context; selecting jumps to the Devices page.
        const roomName = new Map<string, string>(home.rooms.map((r) => [r.id as string, r.name]));
        const devs = (await client.devices()).devices;
        for (const d of devs) base.push({ key: `device:${d.id}`, label: d.name, sub: `Device · ${roomName.get(d.roomId ?? "") ?? "Unassigned"}`, tab: "devices", deviceId: d.id });
        for (const s of scenes.scenes) base.push({ key: `scene:${s.id}`, label: s.name, sub: "Scene", tab: "scenes" });
        for (const a of autos) base.push({ key: `auto:${a.id}`, label: a.name, sub: "Automation", tab: "automations" });
      } catch { /* nav items still work offline */ }
      setItems(base);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const results = useMemo(() => {
    return items
      .map((it) => ({ it, s: score(q, `${it.label} ${it.sub}`) }))
      .filter((x) => x.s !== null)
      .sort((a, b) => (a.s! - b.s!))
      .slice(0, 30)
      .map((x) => x.it);
  }, [items, q]);

  useEffect(() => { setActive(0); }, [q]);

  function choose(it: Item | undefined) {
    if (!it) return;
    if (it.deviceId) { openDevice(it.deviceId); onClose(); return; }
    if (it.roomId) onSelectRoom(it.roomId);
    onNavigate(it.tab);
    onClose();
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(results.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); choose(results[active]); }
    else if (e.key === "Escape") { onClose(); }
  }

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Search devices, rooms, scenes, automations…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="palette-list">
          {results.length === 0 && <div className="palette-empty">No matches</div>}
          {results.map((it, i) => (
            <button
              key={it.key}
              className={`palette-row${i === active ? " active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(it)}
            >
              <span className="palette-label">{it.label}</span>
              <span className="palette-sub">{it.sub}</span>
            </button>
          ))}
        </div>
        <div className="palette-hint">↑↓ to move · ↵ to open · esc to close</div>
      </div>
    </div>
  );
}

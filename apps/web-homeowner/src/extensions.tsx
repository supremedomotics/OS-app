import { useEffect, useMemo, useState } from "react";
import { fetchDriverRegistry, type DriverEntry } from "./api.js";
import { DriverDetail, statusLabel } from "./drivers.js";

/**
 * Extension Center (§ Extension Center) — the central place for every integration and protocol
 * driver, populated entirely from the driver REGISTRY so any current or future extension appears
 * automatically. Browsable by category; each card expands to a schema-generated config page plus
 * install / enable / connect / health / logs (reused from the driver framework). Fully responsive.
 */

// The browsable categories map onto the registry's `channel` (source) and `category` (type) — a
// single extension can match several, so these are filters, not mutually-exclusive buckets.
type Cat = "all" | "official" | "community" | "protocol" | "device" | "ai" | "developer" | "experimental";
const CATS: { id: Cat; label: string }[] = [
  { id: "all", label: "All" },
  { id: "official", label: "Official Supreme" },
  { id: "community", label: "Community" },
  { id: "protocol", label: "Protocol" },
  { id: "device", label: "Device" },
  { id: "ai", label: "AI" },
  { id: "developer", label: "Developer" },
  { id: "experimental", label: "Experimental" },
];

const DEVICE_CATEGORIES = ["lighting", "climate", "shades", "media", "security", "energy"];

/**
 * A prominent certification badge derived from the driver's registry `channel` — so homeowners can
 * tell at a glance whether an extension is vetted by Supreme, made by the community, or still
 * experimental. Purely a presentation of existing registry data; no new trust concept is invented.
 */
function certBadge(channel: string): { label: string; cls: string; glyph: string } {
  switch (channel) {
    case "official":
    case "certified":
      return { label: "Official", cls: "cert-official", glyph: "✓" };
    case "community":
      return { label: "Community", cls: "cert-community", glyph: "◇" };
    case "beta":
      return { label: "Experimental", cls: "cert-experimental", glyph: "⚗" };
    default:
      return { label: channel, cls: "cert-other", glyph: "•" };
  }
}

function matches(d: DriverEntry, cat: Cat): boolean {
  switch (cat) {
    case "all": return true;
    case "official": return d.channel === "official" || d.channel === "certified";
    case "community": return d.channel === "community";
    case "protocol": return d.category === "protocol" || d.protocols.length > 0;
    case "device": return DEVICE_CATEGORIES.includes(d.category);
    case "ai": return /\bai\b|intelligence|assistant/i.test(`${d.name} ${d.description} ${d.category}`);
    case "developer": return d.channel === "beta" || /dev|sdk|debug/i.test(d.name);
    case "experimental": return d.channel === "beta" || d.shipsDisabled === true;
  }
}

// A tasteful motif per extension by category (icons inherit the accent via currentColor is overkill
// here — a small emoji keeps cards scannable and needs no asset).
const ICON: Record<string, string> = {
  protocol: "🔌", lighting: "💡", climate: "❄", shades: "🪟", media: "♪",
  security: "🛡", energy: "⚡", other: "◆",
};

export function ExtensionCenter() {
  const [exts, setExts] = useState<DriverEntry[] | null>(null);
  const [cat, setCat] = useState<Cat>("all");
  const [open, setOpen] = useState<string | null>(null);

  async function load() { setExts(await fetchDriverRegistry()); }
  useEffect(() => { void load(); }, []);

  const counts = useMemo(() => {
    const m = new Map<Cat, number>();
    for (const c of CATS) m.set(c.id, (exts ?? []).filter((d) => matches(d, c.id)).length);
    return m;
  }, [exts]);
  const shown = (exts ?? []).filter((d) => matches(d, cat));

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="title">Extension Center</h1>
        <p className="sub">Add, configure and monitor every integration and protocol driver.</p>
      </div>

      <div className="chip-row">
        {CATS.filter((c) => c.id === "all" || (counts.get(c.id) ?? 0) > 0).map((c) => (
          <button key={c.id} className={`chip${cat === c.id ? " active" : ""}`} onClick={() => setCat(c.id)}>
            {c.label}<span className="chip-n">{counts.get(c.id) ?? 0}</span>
          </button>
        ))}
      </div>

      {exts === null && <p className="muted">Loading…</p>}
      {exts && shown.length === 0 && <p className="muted">No extensions in this category.</p>}

      <div className="ext-grid">
        {shown.map((d) => {
          const s = statusLabel(d);
          const expanded = open === d.key;
          return (
            <div key={d.key} className={`ext-card${expanded ? " open" : ""}`}>
              <button className="ext-head" onClick={() => setOpen(expanded ? null : d.key)}>
                <span className="ext-ic">{ICON[d.category] ?? ICON.other}</span>
                <span className="ext-meta">
                  <span className="ext-name-row">
                    <span className="ext-name">{d.name}</span>
                    {(() => { const c = certBadge(d.channel); return <span className={`cert ${c.cls}`}><span className="cert-glyph">{c.glyph}</span>{c.label}</span>; })()}
                  </span>
                  <span className="ext-sub">v{d.version} · {d.category}{d.protocols.length ? ` · ${d.protocols.join("/")}` : ""}</span>
                  <span className="ext-sub ext-pub">by {d.publisher}</span>
                  {d.description && <span className="ext-desc">{d.description}</span>}
                  <span className="ext-tags">
                    {d.requiresSku && <span className="tag sku">{d.requiresSku}</span>}
                    {d.updateAvailable && <span className="tag ok">Update available</span>}
                    {d.hubMinVersion && <span className="tag compat">hub ≥ v{d.hubMinVersion}</span>}
                    {d.dependencies.length > 0 && <span className="tag">{d.dependencies.length} dependenc{d.dependencies.length === 1 ? "y" : "ies"}</span>}
                    {d.capabilities.length > 0 && <span className="tag soft">{d.capabilities.length} capabilit{d.capabilities.length === 1 ? "y" : "ies"}</span>}
                  </span>
                </span>
                <span className={`drv-badge ${s.cls}`}>{s.text}</span>
              </button>
              {expanded && <DriverDetail driver={d} onChanged={load} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

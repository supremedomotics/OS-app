import { useState, type ReactNode } from "react";
import { Badge } from "./Chip.js";

export interface CollapsibleSectionProps {
  title: string;
  /** A small count pill next to the title, e.g. "3" automations — omit when not meaningful. */
  badge?: string | number;
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * A collapsible block for a device detail page's secondary sections (§ Design System —
 * Universal Page Structure: Information / Diagnostics / Automations / History / Advanced
 * Settings) — closed by default so a device page stays calm, not a wall of data. Values
 * copied from drivers.tsx's `.drv-row`/`.drv-head`/`.drv-detail`, the app's existing
 * expand/collapse row, so this reads as the same interaction everywhere.
 */
export function CollapsibleSection({ title, badge, defaultOpen = false, children }: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`aureon-collapsible${open ? " aureon-collapsible--open" : ""}`}>
      <button type="button" className="aureon-collapsible-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="aureon-collapsible-title">{title}</span>
        {badge != null && <Badge>{badge}</Badge>}
        <span className="aureon-collapsible-chev" aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="aureon-collapsible-body">{children}</div>}
    </div>
  );
}

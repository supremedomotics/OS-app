import type { ReactNode } from "react";
import { Card } from "./Card.js";
import { Grid } from "./Grid.js";

export interface CapabilityGridItem {
  key: string;
  /** An {@link Icon} element (preferred) — never a raw emoji character (§ Premium Design
   * Polish — "replace every emoji with proper SVG illustrations"). */
  icon: ReactNode;
  label: string;
  available: boolean;
  onClick?: () => void;
  /** Never a made-up value — the real reason from the capability-availability engine. Only
   * shown on hover/focus (a `title`), never repeated as an on-page badge per item. */
  reason?: string;
}

export interface CapabilityGridProps {
  items: CapabilityGridItem[];
  minItemWidth?: number;
}

/**
 * A device page's "More controls" surface (§ Premium Device Experience Library — "remove
 * Driver Required clutter... one elegant capability section... explain once"). Real controls
 * render as normal interactive cards; everything not backed by a driver yet collapses into a
 * single quiet strip of compact chips under ONE explanation — never a "Driver required" badge
 * repeated once per tile.
 */
export function CapabilityGrid({ items, minItemWidth = 140 }: CapabilityGridProps) {
  const available = items.filter((i) => i.available);
  const unavailable = items.filter((i) => !i.available);
  const reasons = new Set(unavailable.map((i) => i.reason).filter(Boolean));
  const note = reasons.size === 1
    ? [...reasons][0]
    : "These features become available as compatible drivers are installed.";

  return (
    <>
      {available.length > 0 && (
        <Grid minItemWidth={minItemWidth} gap="sm">
          {available.map((i) => (
            <Card key={i.key} interactive onClick={i.onClick}>
              <span className="aureon-cap-item"><span className="aureon-cap-item-ic" aria-hidden>{i.icon}</span>{i.label}</span>
            </Card>
          ))}
        </Grid>
      )}
      {unavailable.length > 0 && (
        <div className="aureon-unavailable">
          <div className="aureon-unavailable-chips">
            {unavailable.map((i) => (
              <span key={i.key} className="aureon-unavailable-chip" title={i.reason}>
                <span className="aureon-unavailable-chip-ic" aria-hidden>{i.icon}</span>{i.label}
              </span>
            ))}
          </div>
          <p className="aureon-unavailable-note">{note}</p>
        </div>
      )}
    </>
  );
}

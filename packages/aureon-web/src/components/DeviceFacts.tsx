import type { StatusTone } from "./Chip.js";
import { StatusDot } from "./Chip.js";

export interface DeviceFactRow {
  label: string;
  value: string;
  /** An emoji glyph for the tile's icon badge — matches the emoji idiom every premium device
   * page already uses (hero icons, quick actions); omit for a plain text-only tile. */
  icon?: string;
  /** Renders a small status dot beside the value — e.g. "good" for an online driver, "warning"
   * for a stale heartbeat, "critical" for a fault. Omit when the row has no health signal. */
  tone?: StatusTone;
}

export interface DeviceFactsProps {
  rows: DeviceFactRow[];
}

/**
 * The "Information"/"Diagnostics" section of a device detail page (§ Design System — Universal
 * Page Structure): a grid of premium fact tiles — icon badge, label, value, optional status dot
 * — never a plain key/value table. Purely presentational — the caller decides which rows (and
 * which icons/tones) to pass, so "only show fields that exist" stays a per-page decision close
 * to the data instead of being baked in here.
 */
export function DeviceFacts({ rows }: DeviceFactsProps) {
  if (rows.length === 0) return null;
  return (
    <div className="aureon-facts">
      {rows.map((r) => (
        <div key={r.label} className="aureon-fact-tile">
          {r.icon && <span className="aureon-fact-ic" aria-hidden>{r.icon}</span>}
          <span className="aureon-fact-body">
            <span className="aureon-facts-k">{r.label}</span>
            <span className="aureon-facts-v">
              {r.value}
              {r.tone && <StatusDot tone={r.tone} />}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

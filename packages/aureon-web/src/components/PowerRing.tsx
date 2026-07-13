import type { CSSProperties } from "react";

export type PowerRingTone = "flow" | "good" | "warning" | "critical" | "idle";

export interface PowerRingProps {
  /** Current reading. When `max` is omitted the ring shows an indeterminate idle track only. */
  value?: number;
  max?: number;
  size?: number;
  strokeWidth?: number;
  tone?: PowerRingTone;
  /** Large text in the center (e.g. "1.2 kW"). */
  label: string;
  /** Small text under the label (e.g. "Live draw"). */
  sublabel?: string;
}

const TONE_VAR: Record<PowerRingTone, string> = {
  flow: "var(--aureon-color-gold-400)",
  good: "var(--aureon-color-status-good)",
  warning: "var(--aureon-color-status-warning)",
  critical: "var(--aureon-color-status-critical)",
  idle: "var(--aureon-color-text-muted)",
};

/**
 * A radial gauge — the Infrastructure module's answer to the Media/Security hero shape (§
 * Infrastructure Design Language). Reads a bounded value (power draw vs. rated max, battery %,
 * tank level, …) as a filled arc with a live numeric readout at its center. Deliberately generic
 * (no "power" in its name/props beyond the default tone) so Solar/Battery/EV/Generator pages can
 * reuse it for their own bounded readings rather than each hand-rolling an SVG gauge.
 */
export function PowerRing({ value, max, size = 168, strokeWidth = 12, tone = "flow", label, sublabel }: PowerRingProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = max && max > 0 && value !== undefined ? Math.max(0, Math.min(1, value / max)) : 0;
  const offset = circumference * (1 - pct);
  const color = TONE_VAR[tone];

  return (
    <div className="aureon-power-ring" style={{ width: size, height: size, "--power-ring-color": color } as CSSProperties}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden focusable={false}>
        <circle
          cx={size / 2} cy={size / 2} r={radius} fill="none"
          stroke="var(--aureon-color-base-hairline)" strokeWidth={strokeWidth}
        />
        <circle
          className="aureon-power-ring-arc"
          cx={size / 2} cy={size / 2} r={radius} fill="none"
          stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="aureon-power-ring-center">
        <span className="aureon-power-ring-value">{label}</span>
        {sublabel && <span className="aureon-power-ring-sub">{sublabel}</span>}
      </div>
    </div>
  );
}

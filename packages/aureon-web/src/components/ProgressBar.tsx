import type { HTMLAttributes } from "react";

export interface ProgressBarProps extends Omit<HTMLAttributes<HTMLDivElement>, "className"> {
  /** Real, honest progress — a fraction 0..1 of actual completed work (§ Never Fabricate:
   * this must reflect a genuine step/byte/device count, never a timer standing in for
   * unknown progress). Omit entirely (leave `undefined`) for an operation with no
   * measurable stages — that renders the indeterminate sweep below instead of a fake
   * percentage. */
  value?: number;
  /** Shown above the bar, e.g. "Removing devices & rooms… (2 of 6)". */
  label?: string;
}

/** The one shared progress indicator for any operation with real, observable stages
 * (system reset, device/driver scanning, …) — determinate when `value` is given, an
 * honest indeterminate sweep otherwise. Never pads a fast operation with a fake delay
 * to "look like work is happening" (§ Never Fabricate). */
export function ProgressBar({ value, label, ...rest }: ProgressBarProps) {
  const pct = value === undefined ? null : Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="aureon-progress" {...rest}>
      {label && <div className="aureon-progress-label">{label}</div>}
      <div
        className={`aureon-progress-track${pct === null ? " aureon-progress-track--indeterminate" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct === null ? undefined : Math.round(pct)}
      >
        <div className="aureon-progress-fill" style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
    </div>
  );
}

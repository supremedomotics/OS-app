import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  active?: boolean;
  children: ReactNode;
}

/** A tappable filter/selection pill (§ Design System — Status Chips, Tags). */
export function Chip({ active = false, children, ...rest }: ChipProps) {
  return (
    <button className={`aureon-chip${active ? " aureon-chip--active" : ""}`} {...rest}>
      {children}
    </button>
  );
}

export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "className"> {
  children: ReactNode;
}

/** A small count/label pill, e.g. a nav item's unread count (§ Design System — Badges). */
export function Badge({ children, ...rest }: BadgeProps) {
  return (
    <span className="aureon-badge" {...rest}>
      {children}
    </span>
  );
}

export type StatusTone = "neutral" | "good" | "warning" | "critical";

export interface StatusDotProps extends Omit<HTMLAttributes<HTMLSpanElement>, "className"> {
  tone: StatusTone;
  size?: "md" | "lg";
  /** Visually-hidden text for screen readers — a color-only status is never accessible alone
   * (§ Accessibility Rules). */
  label?: string;
}

/** The online/armed/battery-ok indicator dot used across device rows, security state, and
 * system health (§ Design System — Status Indicators). */
export function StatusDot({ tone, size = "md", label, ...rest }: StatusDotProps) {
  const cls = ["aureon-status-dot"];
  if (tone !== "neutral") cls.push(`aureon-status-dot--${tone}`);
  if (size === "lg") cls.push("aureon-status-dot--lg");
  return (
    <span className={cls.join(" ")} role={label ? "status" : undefined} aria-label={label} {...rest} />
  );
}

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: ReactNode;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  "aria-label": string;
}

/** A row of mutually-exclusive options (mode selectors, colour/white tabs, listening modes — §
 * Design System — Segmented Buttons). Keyboard-navigable via native radio semantics. */
export function SegmentedControl<T extends string>({ options, value, onChange, ...rest }: SegmentedControlProps<T>) {
  return (
    <div className="aureon-seg" role="radiogroup" {...rest}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={opt.value === value}
          className={`aureon-seg-btn${opt.value === value ? " aureon-seg-btn--on" : ""}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

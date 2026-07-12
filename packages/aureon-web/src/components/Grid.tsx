import type { HTMLAttributes, ReactNode } from "react";

export interface GridProps extends Omit<HTMLAttributes<HTMLDivElement>, "className"> {
  /** Cards wrap onto new rows automatically once they'd drop below this width — never a fixed
   * column count, so the same grid holds one column on a 4" panel and six on an ultrawide
   * monitor with no per-breakpoint markup. */
  minItemWidth?: number;
  gap?: "sm" | "md" | "lg";
  children: ReactNode;
}

/**
 * The one auto-wrapping card grid every SupremeOS list of rooms/devices/scenes/automations
 * should render through (§ Design System — Responsive Framework: Responsive Grid). Pure CSS
 * Grid `auto-fit` + `minmax()` — no JS breakpoint logic, no re-render on resize.
 */
export function Grid({ minItemWidth = 220, gap = "lg", children, ...rest }: GridProps) {
  return (
    <div
      className={`aureon-grid aureon-grid--gap-${gap}`}
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${minItemWidth}px), 1fr))` }}
      {...rest}
    >
      {children}
    </div>
  );
}

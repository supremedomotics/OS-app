import type { HTMLAttributes, ReactNode } from "react";

export interface ContainerProps extends Omit<HTMLAttributes<HTMLDivElement>, "className"> {
  /** The content column's resting width once there's room to spare — never a hard cutoff, the
   * column simply stops growing past this. */
  maxWidth?: number;
  children: ReactNode;
}

/**
 * The one page-content wrapper (§ Design System — Responsive Framework: Responsive Container) —
 * centers content and gives it fluid horizontal breathing room via the `--aureon-space-lg`
 * token, capped at `maxWidth` so a page never stretches into unreadable full-bleed text on an
 * ultrawide monitor. Every top-level screen should render its content through this instead of a
 * bespoke `max-width`/`margin: 0 auto` rule.
 */
export function Container({ maxWidth = 1100, children, ...rest }: ContainerProps) {
  return (
    <div className="aureon-container" style={{ maxWidth }} {...rest}>
      {children}
    </div>
  );
}

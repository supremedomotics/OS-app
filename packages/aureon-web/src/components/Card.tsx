import type { HTMLAttributes, ReactNode } from "react";

export type CardVariant = "compact" | "standard" | "expanded";

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "className"> {
  variant?: CardVariant;
  /** Interactive cards get hover elevation and a pointer cursor — use for anything clickable
   * (a device row, a room tile) that isn't already a `<button>`. */
  interactive?: boolean;
  selected?: boolean;
  children: ReactNode;
}

/**
 * The base surface for every grouped block of content in SupremeOS (§ Design System — Cards).
 * `standard` matches the app's existing `.card` rule exactly; `compact` is for dense list rows
 * (diagnostics fields, info rows), `expanded` for a page's single hero card (a device's main
 * control surface). Compose specific card *kinds* — DeviceCard, StatCard, DiagnosticCard, … —
 * on top of this rather than styling a `<div>` from scratch.
 */
export function Card({ variant = "standard", interactive = false, selected = false, children, ...rest }: CardProps) {
  const cls = ["aureon-card"];
  if (variant !== "standard") cls.push(`aureon-card--${variant}`);
  if (interactive) cls.push("aureon-card--interactive");
  if (selected) cls.push("aureon-card--selected");
  return (
    <div className={cls.join(" ")} {...rest}>
      {children}
    </div>
  );
}

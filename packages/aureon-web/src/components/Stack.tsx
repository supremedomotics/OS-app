import type { HTMLAttributes, ReactNode } from "react";

export type StackGap = "xs" | "sm" | "md" | "lg" | "xl";

export interface StackProps extends Omit<HTMLAttributes<HTMLDivElement>, "className"> {
  /** `row` on comfortable/expanded density, automatically becoming `column` on compact — pass
   * a fixed direction to opt out (e.g. a toolbar that must always stay a row). Default `column`
   * never needs to change with density, so it's the common case. */
  direction?: "row" | "column" | "responsive";
  gap?: StackGap;
  wrap?: boolean;
  align?: "start" | "center" | "end" | "stretch";
  justify?: "start" | "center" | "end" | "space-between";
  children: ReactNode;
}

/**
 * The one flex layout primitive (§ Design System — Responsive Framework: Responsive Stack) for
 * anything that isn't a card grid — toolbars, form rows, button groups, quick-action rows.
 * `direction="responsive"` is a row that folds into a column once it no longer fits (a settings
 * row's label + control, a device header's title + actions) — the single most common manual
 * "stack on mobile" pattern in the app, now one prop instead of a bespoke media query per file.
 */
export function Stack({ direction = "column", gap = "md", wrap = false, align, justify, children, ...rest }: StackProps) {
  const cls = ["aureon-stack", `aureon-stack--${direction}`, `aureon-stack--gap-${gap}`];
  if (wrap) cls.push("aureon-stack--wrap");
  if (align) cls.push(`aureon-stack--align-${align}`);
  if (justify) cls.push(`aureon-stack--justify-${justify}`);
  return (
    <div className={cls.join(" ")} {...rest}>
      {children}
    </div>
  );
}

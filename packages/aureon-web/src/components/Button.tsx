import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}

function variantClass(variant: ButtonVariant): string {
  switch (variant) {
    case "primary": return "aureon-btn--primary";
    case "danger": return "aureon-btn--danger";
    case "ghost": return "aureon-btn--ghost";
    case "secondary": return "aureon-btn--secondary";
  }
}

/**
 * The one button component every SupremeOS page should use (§ Design System — Buttons).
 * `secondary` is the plain outlined look most raw `<button>`s in the app already have —
 * it's the base `.aureon-btn` class with nothing added, so it's also the implicit default.
 */
export function Button({ variant = "secondary", size = "md", children, ...rest }: ButtonProps) {
  const cls = ["aureon-btn", variantClass(variant)];
  if (size === "sm") cls.push("aureon-btn--sm");
  if (size === "lg") cls.push("aureon-btn--lg");
  return (
    <button className={cls.join(" ")} {...rest}>
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  "aria-label": string;
  danger?: boolean;
  children: ReactNode;
}

/** A circular icon-only button (chevrons, overflow menus, remove actions, …). Always requires
 * an `aria-label` since it has no visible text (§ Accessibility Rules). */
export function IconButton({ danger = false, children, ...rest }: IconButtonProps) {
  const cls = ["aureon-icon-btn"];
  if (danger) cls.push("aureon-icon-btn--danger");
  return (
    <button className={cls.join(" ")} {...rest}>
      {children}
    </button>
  );
}

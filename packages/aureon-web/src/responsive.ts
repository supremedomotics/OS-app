import { useEffect, useState } from "react";

/**
 * Aureon responsive breakpoints (§ Design System — Responsive Breakpoints).
 *
 * The app's CSS previously hardcoded 7 different breakpoint values (560/640/700/780/900/
 * 1000/1200px) with no shared constant. These three replace them: `mobile` (single column, no
 * inspector, bottom sheets), `tablet` (two-column, slide-over inspector), `desktop` (multi-column,
 * a persistent right inspector panel). Chosen to match the two most-established existing values
 * (700 and 1200) rather than inventing new ones.
 */
export const AUREON_BREAKPOINT = {
  tablet: 700,
  desktop: 1200,
} as const;

export type AureonLayout = "mobile" | "tablet" | "desktop";

export function layoutForWidth(width: number): AureonLayout {
  if (width >= AUREON_BREAKPOINT.desktop) return "desktop";
  if (width >= AUREON_BREAKPOINT.tablet) return "tablet";
  return "mobile";
}

/** The live layout tier for the current viewport, updating on resize. Use this instead of a
 * one-off `window.innerWidth` check so every component agrees on where "tablet" starts. */
export function useAureonLayout(): AureonLayout {
  const [layout, setLayout] = useState<AureonLayout>(() =>
    typeof window === "undefined" ? "desktop" : layoutForWidth(window.innerWidth),
  );
  useEffect(() => {
    const onResize = () => setLayout(layoutForWidth(window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return layout;
}

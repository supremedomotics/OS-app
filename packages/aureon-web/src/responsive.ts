/**
 * Aureon responsive density engine (§ Design System — Responsive Framework).
 *
 * SupremeOS runs on one adaptive UI, not separate desktop/tablet/mobile implementations. Three
 * density modes — `compact`, `comfortable`, `expanded` — are derived automatically from the
 * viewport's own width (never a device/browser sniff, so any future display size just falls into
 * the right tier with no code change) and cover the platform's full device range:
 *
 *   compact     — 4"/5"/7" wall panels, small/large phones, iPhone SE, folded foldables.
 *                 Large touch targets, essential controls only, secondary info collapsed.
 *   comfortable — 8"/10" wall panels, iPad mini/iPad, Android tablets, unfolded foldables,
 *                 phones in landscape. Balanced information density.
 *   expanded    — desktop, laptop, ultrawide, 15" panels, iPad Pro landscape. Multi-column,
 *                 a persistent inspector panel, richer diagnostics.
 *
 * A landscape phone naturally reports a wider viewport than the same phone in portrait, so it
 * naturally graduates into `comfortable` — orientation support falls straight out of using real
 * viewport width rather than a fixed per-device rule.
 *
 * Density is exposed two ways:
 *  - `applyAureonDensity`/`initAureonDensity` stamp it onto `<html data-density>`, so any CSS
 *    can react to it directly (`:root[data-density="compact"] { ... }`) with zero React
 *    re-render — most of the system (spacing, type scale, touch targets — see the fluid
 *    `--aureon-*` tokens in `components.css`) needs nothing more than this.
 *  - `useAureonDensity()` gives components a live value for the rare case that needs real
 *    structural branching (Sheet choosing bottom-sheet vs. docked-panel presentation).
 *
 * No page ever picks a density mode itself — that would be exactly the per-screen patching this
 * framework replaces.
 */
import { useEffect, useState } from "react";

export type AureonDensity = "compact" | "comfortable" | "expanded";

/** Chosen to match the app's own established breakpoints (a small tablet/panel starts feeling
 * "comfortable" around 700px of layout width; a persistent multi-column desktop layout needs
 * 1200px to breathe) — not arbitrary new numbers. */
export const AUREON_BREAKPOINT = {
  comfortable: 700,
  expanded: 1200,
} as const;

export function densityForWidth(width: number): AureonDensity {
  if (width >= AUREON_BREAKPOINT.expanded) return "expanded";
  if (width >= AUREON_BREAKPOINT.comfortable) return "comfortable";
  return "compact";
}

// Minimal structural types so this stays DOM-lib-free, matching theme.ts.
interface RootLike {
  dataset: Record<string, string>;
}
const g = globalThis as unknown as {
  document?: { documentElement: RootLike };
  window?: { innerWidth: number; addEventListener(type: "resize", cb: () => void): void };
};

/** Reflect the current viewport's density onto the document root as `data-density`. Safe to call
 * repeatedly (e.g. on every resize). */
export function applyAureonDensity(width: number, root?: RootLike): void {
  const el = root ?? g.document?.documentElement;
  if (!el) return;
  el.dataset.density = densityForWidth(width);
}

/** Apply the current density immediately and keep it live on resize. Call once at app startup
 * alongside `initAureonTheme()`. */
export function initAureonDensity(): AureonDensity {
  const width = typeof window === "undefined" ? 1280 : window.innerWidth;
  applyAureonDensity(width);
  if (typeof window !== "undefined") {
    let raf = 0;
    window.addEventListener("resize", () => {
      // Coalesce rapid resize events (window drag, foldable hinge, orientation change) into one
      // DOM write per frame rather than one per pixel.
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => applyAureonDensity(window.innerWidth));
    });
  }
  return densityForWidth(width);
}

/** The live density tier for the current viewport, updating on resize — for the rare component
 * that needs real structural branching (not just styling) per density. */
export function useAureonDensity(): AureonDensity {
  const [density, setDensity] = useState<AureonDensity>(() =>
    typeof window === "undefined" ? "expanded" : densityForWidth(window.innerWidth),
  );
  useEffect(() => {
    const onResize = () => setDensity(densityForWidth(window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return density;
}

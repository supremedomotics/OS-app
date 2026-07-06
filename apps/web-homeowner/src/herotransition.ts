import { useLayoutEffect, useRef } from "react";

/**
 * Room hero transition (§ Animation) — a FLIP shared-element move. When a room opens, the detail's
 * hero photo animates FROM the tapped card's position/size TO its final header, so entering a room
 * feels like stepping into the space (Basalte-calm, Savant-photographic). Honours reduced-motion.
 *
 * Pass the tapped card's DOMRect as `origin`; attach the returned ref to the detail hero element.
 */
export function useHeroFlip<T extends HTMLElement>(origin: DOMRect | null) {
  const ref = useRef<T | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !origin) return;
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const final = el.getBoundingClientRect();
    if (!final.width || !final.height) return;
    const dx = origin.left - final.left;
    const dy = origin.top - final.top;
    const sx = origin.width / final.width;
    const sy = origin.height / final.height;

    // Invert: place the hero exactly over the card, no transition.
    el.style.transformOrigin = "top left";
    el.style.transition = "none";
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    el.style.willChange = "transform";
    el.getBoundingClientRect(); // force reflow so the next frame animates

    const raf = requestAnimationFrame(() => {
      el.style.transition = "transform 0.42s cubic-bezier(0.22, 1, 0.36, 1)";
      el.style.transform = "none";
    });
    const done = window.setTimeout(() => {
      el.style.transition = "";
      el.style.transform = "";
      el.style.transformOrigin = "";
      el.style.willChange = "";
    }, 520);
    return () => { cancelAnimationFrame(raf); clearTimeout(done); };
  }, [origin]);
  return ref;
}

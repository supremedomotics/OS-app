export type ShadingKind = "updown" | "openclose";

export interface ShadingIconProps {
  /** How this fixture physically moves — an installer-set fact (§ device.metadata.shading.kind),
   * never guessed from the DPT/capability alone: a roller blind/shutter genuinely moves
   * up/down, a drape/curtain genuinely slides open/closed, and nothing about the `position`
   * capability's 0..100 number tells you which. */
  kind: ShadingKind;
  /** The real `position` capability value: 0 = fully closed, 100 = fully open (§ KNX codec's
   * own convention — "% open" — shared by every protocol's position capability). */
  position: number;
  size?: number;
}

/**
 * A live, animated cover icon (§ Premium Device Experience) — reflects the device's ACTUAL
 * reported position, transitioning smoothly as new state arrives (a command's optimistic
 * update, or a real status telegram), never a static glyph. GPU-accelerated (`transform`
 * only) per the Motion standard; the CSS below disables the transition under
 * `prefers-reduced-motion` while still landing on the correct end state.
 */
export function ShadingIcon({ kind, position, size = 24 }: ShadingIconProps) {
  const openFraction = Math.max(0, Math.min(100, position)) / 100;
  const closedFraction = 1 - openFraction;

  return (
    <svg
      className="aureon-shading-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
    >
      {/* The window frame — static. */}
      <rect x="4" y="4" width="16" height="16" rx="1.2" />

      {kind === "updown" ? (
        <rect
          className="aureon-shading-icon-panel"
          x="4.85" y="4.85" width="14.3" height="14.3"
          fill="currentColor" stroke="none" opacity="0.55"
          style={{ transform: `scaleY(${closedFraction})`, transformOrigin: "12px 5px" }}
        />
      ) : (
        <>
          <rect
            className="aureon-shading-icon-panel"
            x="4.85" y="4.85" width="7.15" height="14.3"
            fill="currentColor" stroke="none" opacity="0.55"
            style={{ transform: `scaleX(${closedFraction})`, transformOrigin: "4.85px 12px" }}
          />
          <rect
            className="aureon-shading-icon-panel"
            x="11.85" y="4.85" width="7.15" height="14.3"
            fill="currentColor" stroke="none" opacity="0.55"
            style={{ transform: `scaleX(${closedFraction})`, transformOrigin: "19.15px 12px" }}
          />
        </>
      )}
    </svg>
  );
}

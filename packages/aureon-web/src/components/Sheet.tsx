import { useEffect, type ReactNode } from "react";
import { useAureonDensity } from "../responsive.js";
import { IconButton } from "./Button.js";

export type SheetPresentation = "bottom" | "panel" | "dialog";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Force a presentation regardless of viewport — a confirmation ("Remove device?") should
   * always be a centered `dialog` even on a phone, for example. Omit to let density decide:
   * `compact` → bottom sheet, `comfortable`/`expanded` → right-docked panel (the Inspector /
   * Drawer — the same surface serves both roles). */
  presentation?: SheetPresentation;
  "aria-label": string;
}

/**
 * The one overlay primitive for controls, quick settings, and confirmations (§ Design System —
 * Responsive Framework: Bottom Sheets, Drawer, Inspector Panel, Dialog). Replaces the app's three
 * previously independent overlay implementations (`DeviceSheet`'s bespoke sheet, `climate-
 * console`'s inline modal duplicated verbatim in `climate-scheduler-ui`, and `screens.tsx`'s own
 * sheet block) with one component whose *presentation* — not its API — changes with density: the
 * same `<Sheet>` call becomes a compact-density bottom sheet, a comfortable/expanded-density
 * right-docked Inspector panel, or (when forced) a centered dialog.
 */
export function Sheet({ open, onClose, children, presentation, "aria-label": ariaLabel }: SheetProps) {
  const density = useAureonDensity();
  const resolved: SheetPresentation = presentation ?? (density === "compact" ? "bottom" : "panel");

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="aureon-sheet-backdrop" onClick={onClose} />
      <div className={`aureon-sheet aureon-sheet--${resolved}`} role="dialog" aria-modal="true" aria-label={ariaLabel}>
        {resolved === "bottom" && <div className="aureon-sheet-grab" aria-hidden />}
        {/* Escape and backdrop-click already close this sheet, but neither is discoverable —
         * especially on touch, where there's no keyboard and a full-bleed bottom sheet leaves
         * little backdrop to tap. A visible close control is required on every presentation. */}
        <div className="aureon-sheet-close">
          <IconButton aria-label="Close" onClick={onClose}>✕</IconButton>
        </div>
        {children}
      </div>
    </>
  );
}

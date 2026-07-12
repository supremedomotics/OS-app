import { useEffect, type ReactNode } from "react";
import { useAureonLayout } from "../responsive.js";

export type SheetPresentation = "bottom" | "panel" | "dialog";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Force a presentation regardless of viewport — a confirmation ("Remove device?") should
   * always be a centered `dialog` even on mobile, for example. Omit to let viewport width
   * decide: `mobile` → bottom sheet, `tablet`/`desktop` → right-docked panel (the Inspector). */
  presentation?: SheetPresentation;
  "aria-label": string;
}

/**
 * The one overlay primitive for controls, quick settings, and confirmations (§ Design System —
 * Bottom Sheets, Drawer Styles, Inspector Panel Styles). Replaces the app's three previously
 * independent overlay implementations (`DeviceSheet`'s bespoke sheet, `climate-console`'s inline
 * modal duplicated verbatim in `climate-scheduler-ui`, and `screens.tsx`'s own sheet block) with
 * one component whose *presentation* — not its API — changes with viewport: the same `<Sheet>`
 * call becomes a mobile bottom sheet, a tablet/desktop right-docked Inspector panel, or (when
 * forced) a centered dialog, per §Responsive Breakpoints.
 */
export function Sheet({ open, onClose, children, presentation, "aria-label": ariaLabel }: SheetProps) {
  const layout = useAureonLayout();
  const resolved: SheetPresentation = presentation ?? (layout === "mobile" ? "bottom" : "panel");

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
        {children}
      </div>
    </>
  );
}

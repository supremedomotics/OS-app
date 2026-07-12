import { useEffect, useRef, useState } from "react";
import { IconButton } from "./Button.js";

export interface OverflowMenuAction {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

export interface OverflowMenuProps {
  actions: OverflowMenuAction[];
  "aria-label"?: string;
}

/**
 * The "⋮" overflow menu (Rename / Remove device, …) that a device detail page's header opens
 * (§ Design System — Context Menu). Replaces what were byte-for-byte identical, independently
 * maintained implementations in `avr-console.tsx` and `climate-console.tsx`; `lighting.tsx`
 * previously showed its one action (Remove) as an always-visible button instead of a menu —
 * migrated here too so every device detail page follows the same structure (§ Universal Page
 * Structure), not just two of the three.
 */
export function OverflowMenu({ actions, "aria-label": ariaLabel = "More" }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="aureon-overflow-wrap" ref={ref}>
      <IconButton aria-label={ariaLabel} onClick={() => setOpen((v) => !v)}>⋮</IconButton>
      {open && (
        <div className="aureon-overflow-menu" role="menu">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              className={a.danger ? "aureon-overflow-item--danger" : undefined}
              onClick={() => { setOpen(false); a.onClick(); }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

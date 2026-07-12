import type { ReactNode } from "react";

export interface QuickAction {
  key: string;
  icon: string;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}

export interface QuickActionsProps {
  actions: QuickAction[];
  /** Renders unavailable actions dimmed with a reason badge instead of omitting them —
   * pass a {@link CapabilityGate}-wrapped action via `render` when a specific action needs
   * that; this prop is for the common case of a plain disabled state. */
  children?: ReactNode;
}

/**
 * Context-aware quick actions (§ Premium Device Experience Library — "instead of generic
 * buttons, show actions relevant to each device"). A horizontal row of icon+label pills, each
 * device module supplies its OWN action list (Television: Watch Movie/Gaming/Music/Mute/Sleep
 * Timer; Lock: Unlock/Lock All/Guest PIN; …) — this component only renders the row, it never
 * invents what the actions are.
 */
export function QuickActions({ actions, children }: QuickActionsProps) {
  if (actions.length === 0 && !children) return null;
  return (
    <div className="aureon-quick-actions">
      {actions.map((a) => (
        <button
          key={a.key}
          className={`aureon-quick-action${a.active ? " aureon-quick-action--active" : ""}`}
          onClick={a.onClick}
          disabled={a.disabled}
        >
          <span className="aureon-quick-action-ic" aria-hidden>{a.icon}</span>
          <span>{a.label}</span>
        </button>
      ))}
      {children}
    </div>
  );
}

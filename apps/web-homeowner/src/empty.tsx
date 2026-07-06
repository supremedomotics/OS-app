/**
 * EmptyState (§ Empty States) — one calm, consistent way to present a page with nothing in it yet.
 * Never a blank screen: a quiet icon, a plain-language line about what would live here, and — when
 * there's a sensible next step — a single action to get there. One component so every empty page
 * across the app looks and behaves the same.
 */
export function EmptyState({ icon, title, hint, action }: {
  icon?: string;
  title: string;
  hint?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-ic" aria-hidden>{icon}</div>}
      <div className="empty-title">{title}</div>
      {hint && <p className="empty-hint">{hint}</p>}
      {action && <button className="primary empty-action" onClick={action.onClick}>{action.label}</button>}
    </div>
  );
}

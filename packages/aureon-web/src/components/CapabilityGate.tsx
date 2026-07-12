import type { ReactNode } from "react";

export interface CapabilityGateProps {
  /** Whether the real capability engine backs this control right now. */
  available: boolean;
  /** Shown when unavailable — "Driver required", "Not supported by current driver", etc. Never
   * a made-up value, always why the control is inert. */
  reason?: string;
  children: ReactNode;
}

/**
 * The Premium Device Experience Library's capability gate (§ Design System — "the UI is the
 * contract; the capability engine and drivers satisfy it over time"). A premium device page can
 * show its FULL intended control set from day one — Apps, Picture Mode, Channel, whatever a
 * future driver will eventually report — without inventing data: whatever isn't backed by a
 * real capability today renders inert and clearly labeled instead of being hidden or faked.
 * Never decides availability itself — callers pass the real yes/no from the capability engine
 * (see apps/web-homeowner's capability-availability.ts); this component only ever renders the
 * result consistently.
 */
export function CapabilityGate({ available, reason, children }: CapabilityGateProps) {
  if (available) return <>{children}</>;
  return (
    <div className="aureon-cap-gate" aria-disabled="true">
      <div className="aureon-cap-gate-content">{children}</div>
      {reason && <span className="aureon-cap-gate-badge">{reason}</span>}
    </div>
  );
}

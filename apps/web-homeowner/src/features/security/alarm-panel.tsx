import type { CSSProperties } from "react";
import type { SecurityStateResponse } from "@supreme/contracts";
import { Card, CapabilityGrid, QuickActions } from "@supreme/aureon-web";

const NOT_YET = { available: false as const, reason: "Driver required" };

function label(mode: string): string {
  return mode === "armed_home"
    ? "Armed · Home"
    : mode === "armed_away"
      ? "Armed · Away"
      : mode === "armed_night"
        ? "Armed · Night"
        : "Disarmed";
}

/**
 * Alarm System premium panel (§ Premium Device Experience Library). Home-wide, not
 * per-device (`services/security`) — mode/triggered/arm/disarm are real, driving a genuine
 * shield hero (armed = calm glow, triggered = urgent pulse); a premium alarm panel's other
 * expected surfaces (Entry Delay countdown, Zones & Sensors, Siren, Panic Button, recent
 * events) have no backend representation at all yet, so they render as honest capability-
 * gated placeholders, same as every other module (§ "the UI is the contract").
 */
export function AlarmPanel({ state, onArm, onDisarm }: {
  state: SecurityStateResponse | null;
  onArm: (mode: "armed_home" | "armed_away" | "armed_night") => void;
  onDisarm: () => void;
}) {
  const triggered = state?.triggered ?? false;
  const armed = state?.mode !== "disarmed";
  const heroTint = triggered
    ? "var(--aureon-color-status-critical)"
    : armed
      ? "var(--aureon-color-status-good)"
      : "var(--aureon-color-gold-400)";

  return (
    <div className="aureon-detail-grid">
      <div className="aureon-detail-main">
        <div className={`avr-now avr-now--wash${triggered ? " alarm-triggered" : ""}`} style={{ "--hero-wash-tint": heroTint } as CSSProperties}>
          <div className="avr-art-wrap" style={{ width: 160, height: 160 }}>
            <div className={`avr-halo${armed ? " on" : ""}`} style={{ "--avr-halo-tint": heroTint } as CSSProperties} />
            <div className={`avr-art-float${armed ? " on" : ""}`}>
              <div className="avr-art avr-art-placeholder" style={{ width: 160, height: 160, fontSize: 58, color: heroTint }}>
                {triggered ? "⚠️" : "🛡️"}
              </div>
            </div>
          </div>
          <div className="avr-now-meta">
            <span className="avr-now-label">{triggered ? "ALARM TRIGGERED" : label(state?.mode ?? "disarmed")}</span>
            <h3>Alarm System</h3>
            <p className="avr-now-album">Home security</p>
            <div style={{ marginTop: 14 }}>
              <CapabilityGrid
                minItemWidth={130}
                items={[
                  { key: "zones", icon: "📡", label: "Active zones", available: false, reason: NOT_YET.reason },
                  { key: "entry-delay", icon: "⏱️", label: "Entry delay", available: false, reason: NOT_YET.reason },
                  { key: "recent-events", icon: "📋", label: "Recent events", available: false, reason: NOT_YET.reason },
                ]}
              />
            </div>
          </div>
        </div>

        <QuickActions
          actions={[
            { key: "home", icon: "🏠", label: "Home", onClick: () => onArm("armed_home"), active: state?.mode === "armed_home" },
            { key: "away", icon: "🚪", label: "Away", onClick: () => onArm("armed_away"), active: state?.mode === "armed_away" },
            { key: "night", icon: "🌙", label: "Night", onClick: () => onArm("armed_night"), active: state?.mode === "armed_night" },
            ...(armed ? [{ key: "disarm", icon: "🔓", label: "Disarm", onClick: onDisarm }] : []),
          ]}
        />

        <h2 className="section">More controls</h2>
        <CapabilityGrid
          minItemWidth={150}
          items={[
            { key: "zones-sensors", icon: "📡", label: "Zones & Sensors", available: false, reason: NOT_YET.reason },
            { key: "siren", icon: "🔊", label: "Siren", available: false, reason: NOT_YET.reason },
            { key: "panic", icon: "🆘", label: "Panic Button", available: false, reason: NOT_YET.reason },
          ]}
        />
      </div>

      <div className="aureon-detail-side">
        <h2 className="section" style={{ marginTop: 0 }}>Information</h2>
        <Card>
          <div className="sheet-row"><span className="muted">Mode</span><strong>{label(state?.mode ?? "disarmed")}</strong></div>
          <div className="sheet-row"><span className="muted">Triggered</span><strong>{triggered ? "Yes" : "No"}</strong></div>
          {state?.lastChangedAt && (
            <div className="sheet-row"><span className="muted">Last changed</span><strong>{new Date(state.lastChangedAt).toLocaleString()}</strong></div>
          )}
        </Card>
      </div>
    </div>
  );
}

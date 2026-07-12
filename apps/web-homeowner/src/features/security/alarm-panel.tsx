import type { CSSProperties } from "react";
import type { SecurityStateResponse } from "@supreme/contracts";
import { Card, CapabilityGate, Grid, QuickActions } from "@supreme/aureon-web";

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
        <div className={`avr-now${triggered ? " alarm-triggered" : ""}`}>
          <div className="avr-art-wrap" style={{ width: 130, height: 130 }}>
            <div className={`avr-halo${armed ? " on" : ""}`} style={{ "--avr-halo-tint": heroTint } as CSSProperties} />
            <div className={`avr-art-float${armed ? " on" : ""}`}>
              <div className="avr-art avr-art-placeholder" style={{ width: 130, height: 130, fontSize: 52, color: heroTint }}>
                {triggered ? "⚠️" : "🛡️"}
              </div>
            </div>
          </div>
          <div className="avr-now-meta">
            <span className="avr-now-label">{triggered ? "ALARM TRIGGERED" : label(state?.mode ?? "disarmed")}</span>
            <h3>Alarm System</h3>
            <p className="avr-now-album">Home security</p>
            <Grid minItemWidth={130} gap="sm" style={{ marginTop: 14 }}>
              <CapabilityGate available={NOT_YET.available} reason={NOT_YET.reason}><Card>📡 Active zones</Card></CapabilityGate>
              <CapabilityGate available={NOT_YET.available} reason={NOT_YET.reason}><Card>⏱️ Entry delay</Card></CapabilityGate>
              <CapabilityGate available={NOT_YET.available} reason={NOT_YET.reason}><Card>📋 Recent events</Card></CapabilityGate>
            </Grid>
          </div>
        </div>

        <QuickActions
          actions={[
            { key: "home", icon: "🏠", label: "Home", onClick: () => onArm("armed_home"), active: state?.mode === "armed_home" },
            { key: "away", icon: "🚪", label: "Away", onClick: () => onArm("armed_away"), active: state?.mode === "armed_away" },
            { key: "night", icon: "🌙", label: "Night", onClick: () => onArm("armed_night"), active: state?.mode === "armed_night" },
            ...(armed ? [{ key: "disarm", icon: "🔓", label: "Disarm", onClick: onDisarm }] : []),
          ]}
        >
          <CapabilityGate available={false} reason={NOT_YET.reason}><button className="aureon-quick-action" disabled>🆘 Panic</button></CapabilityGate>
        </QuickActions>

        <h2 className="section">More controls</h2>
        <Grid minItemWidth={150} gap="sm">
          <CapabilityGate available={NOT_YET.available} reason={NOT_YET.reason}>
            <Card interactive>📡 Zones &amp; Sensors</Card>
          </CapabilityGate>
          <CapabilityGate available={NOT_YET.available} reason={NOT_YET.reason}>
            <Card interactive>🔊 Siren</Card>
          </CapabilityGate>
        </Grid>
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

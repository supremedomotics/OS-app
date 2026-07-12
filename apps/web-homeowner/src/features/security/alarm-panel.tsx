import type { SecurityStateResponse } from "@supreme/contracts";
import { Card, CapabilityGate, Grid } from "@supreme/aureon-web";

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
 * per-device (`services/security`) — mode/triggered/arm/disarm are real; a premium alarm
 * panel's other expected surfaces (Entry Delay countdown, Zones & Sensors, Siren, Panic
 * Button) have no backend representation at all yet, so they render as honest capability-
 * gated placeholders, same as every other module (§ "the UI is the contract").
 */
export function AlarmPanel({ state, onArm, onDisarm }: {
  state: SecurityStateResponse | null;
  onArm: (mode: "armed_home" | "armed_away" | "armed_night") => void;
  onDisarm: () => void;
}) {
  const triggered = state?.triggered ?? false;
  return (
    <>
      <div className="avr-head-card">
        <div className="avr-head-ic">{triggered ? "⚠️" : "🛡️"}</div>
        <div className="avr-head-meta">
          <h2>Alarm System</h2>
          <p>Home security</p>
          <span className={`avr-status${!triggered && state?.mode !== "disarmed" ? " good" : ""}`}>
            <i /> {triggered ? "ALARM TRIGGERED" : label(state?.mode ?? "disarmed")}
          </span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
        {(["armed_home", "armed_away", "armed_night"] as const).map((m) => (
          <button key={m} className={`chip${state?.mode === m ? " active" : ""}`} onClick={() => onArm(m)}>
            {label(m)}
          </button>
        ))}
        {state && state.mode !== "disarmed" && (
          <button className="chip" onClick={onDisarm}>Disarm</button>
        )}
      </div>

      <h2 className="section">More controls</h2>
      <Grid minItemWidth={150} gap="sm">
        <CapabilityGate available={NOT_YET.available} reason={NOT_YET.reason}>
          <Card interactive>⏱️ Entry Delay</Card>
        </CapabilityGate>
        <CapabilityGate available={NOT_YET.available} reason={NOT_YET.reason}>
          <Card interactive>📡 Zones &amp; Sensors</Card>
        </CapabilityGate>
        <CapabilityGate available={NOT_YET.available} reason={NOT_YET.reason}>
          <Card interactive>🔊 Siren</Card>
        </CapabilityGate>
        <CapabilityGate available={NOT_YET.available} reason={NOT_YET.reason}>
          <Card interactive>🆘 Panic Button</Card>
        </CapabilityGate>
      </Grid>

      <h2 className="section">Information</h2>
      <Card>
        <div className="sheet-row"><span className="muted">Mode</span><strong>{label(state?.mode ?? "disarmed")}</strong></div>
        <div className="sheet-row"><span className="muted">Triggered</span><strong>{triggered ? "Yes" : "No"}</strong></div>
        {state?.lastChangedAt && (
          <div className="sheet-row"><span className="muted">Last changed</span><strong>{new Date(state.lastChangedAt).toLocaleString()}</strong></div>
        )}
      </Card>
    </>
  );
}

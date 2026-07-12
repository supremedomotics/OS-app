import type { CameraList } from "@supreme/contracts";
import { Card, CapabilityGate, Grid } from "@supreme/aureon-web";

type CameraView = CameraList["cameras"][number];

const NOT_YET = { available: false as const, reason: "Driver required" };

/**
 * NVR premium detail page (§ Premium Device Experience Library). Supreme has no NVR concept
 * at all today — no capability, no device type, no channel grouping
 * (`services/gateway/src/camera-service.ts` only knows individual cameras) — so unlike Camera
 * or Lock, nothing on this page can be a real per-channel control yet. The channel grid below
 * IS real data (this home's actual registered cameras, shown as what an NVR would call its
 * channels); the recorder-specific management surface — storage, schedules, channel health,
 * export — is honestly "Driver required" throughout, exactly as the pivot's own worked
 * examples describe for a device type with zero backend implementation. Nothing here is
 * reachable per-device (there is no NVR device to open); it hangs off the Security tab as a
 * home-level system, the same way Alarm does.
 */
export function NvrDetail({ cameras, onBack }: { cameras: CameraView[]; onBack: () => void }) {
  return (
    <div className="page">
      <div className="avr-head-card">
        <button className="avr-back" onClick={onBack} aria-label="Back">←</button>
        <div className="avr-head-ic">🖥️</div>
        <div className="avr-head-meta">
          <h2>NVR</h2>
          <p>Network Video Recorder</p>
          <span className="avr-status"><i /> Driver required</span>
        </div>
      </div>

      <h2 className="section">Channels</h2>
      {cameras.length === 0 ? (
        <Card><p className="muted">No cameras registered yet — channels will appear here once cameras are added.</p></Card>
      ) : (
        <Grid>
          {cameras.map((c) => (
            <div key={c.id} className="tile" style={{ minHeight: 110 }}>
              {c.snapshotUrl && (
                <img
                  src={c.snapshotUrl}
                  alt={c.name}
                  style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.7 }}
                />
              )}
              <div className="label" style={{ position: "relative" }}>{c.name}</div>
            </div>
          ))}
        </Grid>
      )}

      <h2 className="section">More controls</h2>
      <Grid minItemWidth={150} gap="sm">
        <CapabilityGate available={NOT_YET.available} reason={NOT_YET.reason}>
          <Card interactive>💾 Storage</Card>
        </CapabilityGate>
        <CapabilityGate available={NOT_YET.available} reason={NOT_YET.reason}>
          <Card interactive>🗓️ Recording Schedule</Card>
        </CapabilityGate>
        <CapabilityGate available={NOT_YET.available} reason={NOT_YET.reason}>
          <Card interactive>🎯 Motion-Triggered Recording</Card>
        </CapabilityGate>
        <CapabilityGate available={NOT_YET.available} reason={NOT_YET.reason}>
          <Card interactive>❤️ Channel Health</Card>
        </CapabilityGate>
        <CapabilityGate available={NOT_YET.available} reason={NOT_YET.reason}>
          <Card interactive>⬇️ Export</Card>
        </CapabilityGate>
      </Grid>
    </div>
  );
}

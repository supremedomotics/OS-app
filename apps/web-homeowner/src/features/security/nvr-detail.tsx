import type { CSSProperties } from "react";
import type { CameraList } from "@supreme/contracts";
import { Card, CapabilityGrid, Grid, Icon } from "@supreme/aureon-web";

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
  const live = cameras.filter((c) => c.streamUrl).length;

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <button className="avr-back" onClick={onBack} aria-label="Back">←</button>
        <span className="muted">Network Video Recorder</span>
      </div>

      <div className="aureon-detail-grid">
        <div className="aureon-detail-main">
          <div className="avr-now avr-now--wash offline" style={{ "--hero-wash-tint": "var(--aureon-color-category-security)" } as CSSProperties}>
            <div className="avr-art-wrap" style={{ width: 160, height: 160 }}>
              <div className="avr-halo" style={{ "--avr-halo-tint": "var(--aureon-color-category-security)" } as CSSProperties} />
              <div className="avr-art-float">
                <div className="avr-art avr-art-placeholder" style={{ width: 160, height: 160, color: "var(--aureon-color-category-security)" }}><Icon name="monitor" size={72} /></div>
              </div>
            </div>
            <div className="avr-now-meta">
              <span className="avr-now-label">NETWORK VIDEO RECORDER</span>
              <h3>NVR</h3>
              <p className="avr-now-album">{cameras.length} channel{cameras.length === 1 ? "" : "s"} · {live} live</p>
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
          <CapabilityGrid
            minItemWidth={150}
            items={[
              { key: "storage", icon: <Icon name="database" size={16} />, label: "Storage", available: false, reason: NOT_YET.reason },
              { key: "recording-schedule", icon: <Icon name="calendar" size={16} />, label: "Recording Schedule", available: false, reason: NOT_YET.reason },
              { key: "motion-recording", icon: <Icon name="target" size={16} />, label: "Motion-Triggered Recording", available: false, reason: NOT_YET.reason },
              { key: "channel-health", icon: <Icon name="heart" size={16} />, label: "Channel Health", available: false, reason: NOT_YET.reason },
              { key: "export", icon: <Icon name="download" size={16} />, label: "Export", available: false, reason: NOT_YET.reason },
            ]}
          />
        </div>

        <div className="aureon-detail-side">
          <h2 className="section" style={{ marginTop: 0 }}>Information</h2>
          <Card>
            <div className="sheet-row"><span className="muted">Channels</span><strong>{cameras.length}</strong></div>
            <div className="sheet-row"><span className="muted">Live streams configured</span><strong>{live}</strong></div>
            <div className="sheet-row"><span className="muted">Snapshot only</span><strong>{cameras.length - live}</strong></div>
          </Card>
        </div>
      </div>
    </div>
  );
}

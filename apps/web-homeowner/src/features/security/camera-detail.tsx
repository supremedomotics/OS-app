import { useEffect, useRef, useState } from "react";
import type { CameraList, CameraStreamResponse } from "@supreme/contracts";
import { Card, CapabilityGrid, Icon, QuickActions } from "@supreme/aureon-web";
import { client } from "../../api.js";
import { HlsPlayer, WebRtcPlayer } from "../../players.js";

type CameraView = CameraList["cameras"][number];

const NOT_YET = { available: false as const, reason: "Driver required" };

/** Genuine client-side action — downloads whatever the camera's own registered snapshotUrl
 * currently returns; never synthesizes an image. */
function downloadSnapshot(camera: CameraView): void {
  if (!camera.snapshotUrl) return;
  const a = document.createElement("a");
  a.href = camera.snapshotUrl;
  a.download = `${camera.name.replace(/\s+/g, "-").toLowerCase()}-snapshot.jpg`;
  a.target = "_blank";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Camera premium detail page (§ Premium Device Experience Library). A Supreme camera today is
 * honestly just a registered stream source (`services/gateway/src/camera-service.ts`) — no PTZ,
 * no two-way audio, no motion zones, no recording, no capability model at all (it sits parallel
 * to the `CapabilityKind` system, not inside it). The real live view/snapshot render as real
 * controls, including genuine browser-native actions (fullscreen, snapshot download); the rest
 * of a premium camera's expected control set renders as capability-gated placeholders, same as
 * every other module (§ "the UI is the contract").
 */
export function CameraDetail({ camera, roomName, onBack }: {
  camera: CameraView;
  roomName: string;
  onBack: () => void;
}) {
  const [active, setActive] = useState<{ webrtc: string | null; hls: string | null; mode: "webrtc" | "hls" } | null>(null);
  const [failed, setFailed] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActive(null);
    setFailed(false);
    if (!camera.streamUrl) return;
    let cancelled = false;
    void (async () => {
      try {
        const { streams } = (await client.cameraStream(camera.id)) as CameraStreamResponse;
        if (cancelled) return;
        const webrtc = streams.find((s) => s.kind === "webrtc")?.url ?? null;
        const hls = streams.find((s) => s.kind === "hls")?.url ?? null;
        if (webrtc || hls) setActive({ webrtc, hls, mode: webrtc ? "webrtc" : "hls" });
        else setFailed(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [camera.id, camera.streamUrl]);

  const isLive = Boolean(active?.webrtc || active?.hls);

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <button className="avr-back" onClick={onBack} aria-label="Back">←</button>
        <span className="muted">{roomName}</span>
      </div>

      <div className="aureon-detail-grid">
        <div className="aureon-detail-main">
          <div className="camera-hero">
            <div ref={previewRef} className="camera-hero-preview">
              {active?.mode === "webrtc" && active.webrtc ? (
                <WebRtcPlayer url={active.webrtc} onError={() => setActive((a) => (a ? { ...a, mode: "hls" } : a))} />
              ) : active?.hls ? (
                <HlsPlayer url={active.hls} />
              ) : camera.snapshotUrl ? (
                <img src={camera.snapshotUrl} alt={camera.name} />
              ) : (
                <span className="muted">{failed ? "No playable stream." : camera.streamUrl ? "Connecting…" : "No live feed configured for this camera."}</span>
              )}
              <div className="camera-hero-overlay-top">
                <span className={`avr-badge${isLive ? " live" : ""}`}>
                  {isLive && <span className="camera-live-dot" aria-hidden />}
                  {isLive ? "LIVE" : camera.streamUrl ? "CONNECTING" : "OFFLINE"}
                </span>
              </div>
            </div>
            <div className="camera-hero-meta">
              <span className="avr-now-label">{camera.name}</span>
              <p className="avr-now-album">{roomName}</p>
            </div>
          </div>

          <QuickActions
            actions={[
              { key: "snapshot", icon: <Icon name="camera" size={16} />, label: "Snapshot", onClick: () => downloadSnapshot(camera), disabled: !camera.snapshotUrl },
              { key: "fullscreen", icon: <Icon name="expand" size={16} />, label: "Fullscreen", onClick: () => void previewRef.current?.requestFullscreen?.(), disabled: !isLive && !camera.snapshotUrl },
            ]}
          />

          <h2 className="section">More controls</h2>
          <CapabilityGrid
            minItemWidth={150}
            items={[
              { key: "record", icon: <Icon name="record" size={16} />, label: "Record", available: false, reason: NOT_YET.reason },
              { key: "talk", icon: <Icon name="mic" size={16} />, label: "Talk", available: false, reason: NOT_YET.reason },
              { key: "ai-detections", icon: <Icon name="sparkle" size={16} />, label: "AI Detections", available: false, reason: NOT_YET.reason },
              { key: "stream-quality", icon: <Icon name="wifi" size={16} />, label: "Stream Quality", available: false, reason: NOT_YET.reason },
              { key: "ptz", icon: <Icon name="joystick" size={16} />, label: "Pan / Tilt / Zoom", available: false, reason: NOT_YET.reason },
              { key: "motion-zones", icon: <Icon name="grid" size={16} />, label: "Motion Zones", available: false, reason: NOT_YET.reason },
              { key: "recording-schedule", icon: <Icon name="calendar" size={16} />, label: "Recording Schedule", available: false, reason: NOT_YET.reason },
              { key: "night-vision", icon: <Icon name="moon" size={16} />, label: "Night Vision", available: false, reason: NOT_YET.reason },
            ]}
          />
        </div>

        <div className="aureon-detail-side sheet-sections">
          <h2 className="section" style={{ marginTop: 0 }}>Information</h2>
          <Card>
            <div className="sheet-row"><span className="muted">Room</span><strong>{roomName}</strong></div>
            <div className="sheet-row"><span className="muted">Live stream</span><strong>{camera.streamUrl ? "Configured" : "Not configured"}</strong></div>
            <div className="sheet-row"><span className="muted">Snapshot</span><strong>{camera.snapshotUrl ? "Configured" : "Not configured"}</strong></div>
          </Card>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import type { CameraList, CameraStreamResponse } from "@supreme/contracts";
import { Card, CapabilityGate, Grid, Stack } from "@supreme/aureon-web";
import { client } from "../../api.js";
import { HlsPlayer, WebRtcPlayer } from "../../players.js";

type CameraView = CameraList["cameras"][number];

/**
 * Camera premium detail page (§ Premium Device Experience Library). A Supreme camera today is
 * honestly just a registered stream source (`services/gateway/src/camera-service.ts`) — no PTZ,
 * no two-way audio, no motion zones, no recording, no capability model at all (it sits parallel
 * to the `CapabilityKind` system, not inside it). The real live view/snapshot render as real
 * controls; the rest of a premium camera's expected control set renders as capability-gated
 * placeholders, same as every other module (§ "the UI is the contract").
 */
export function CameraDetail({ camera, roomName, onBack }: {
  camera: CameraView;
  roomName: string;
  onBack: () => void;
}) {
  const [active, setActive] = useState<{ webrtc: string | null; hls: string | null; mode: "webrtc" | "hls" } | null>(null);
  const [failed, setFailed] = useState(false);

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

  const NO_DRIVER = { available: false as const, reason: "Driver required" };

  return (
    <div className="page">
      <div className="avr-head-card">
        <button className="avr-back" onClick={onBack} aria-label="Back">←</button>
        <div className="avr-head-ic">📷</div>
        <div className="avr-head-meta">
          <h2>{camera.name}</h2>
          <p>{roomName}</p>
          <span className={`avr-status${camera.streamUrl ? " good" : ""}`}>
            <i /> {camera.streamUrl ? "Live" : "No stream configured"}
          </span>
        </div>
      </div>

      <Stack gap="lg" style={{ marginTop: 20 }}>
        <Card style={{ minHeight: 220, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", padding: 0 }}>
          {active?.mode === "webrtc" && active.webrtc ? (
            <WebRtcPlayer url={active.webrtc} onError={() => setActive((a) => (a ? { ...a, mode: "hls" } : a))} />
          ) : active?.hls ? (
            <HlsPlayer url={active.hls} />
          ) : camera.snapshotUrl ? (
            <img src={camera.snapshotUrl} alt={camera.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <span className="muted">{failed ? "No playable stream." : camera.streamUrl ? "Connecting…" : "No live feed configured for this camera."}</span>
          )}
        </Card>
      </Stack>

      <h2 className="section">More controls</h2>
      <Grid minItemWidth={150} gap="sm">
        <CapabilityGate available={false} reason={NO_DRIVER.reason}>
          <Card interactive>🕹️ Pan / Tilt / Zoom</Card>
        </CapabilityGate>
        <CapabilityGate available={false} reason={NO_DRIVER.reason}>
          <Card interactive>🎙️ Two-Way Talk</Card>
        </CapabilityGate>
        <CapabilityGate available={false} reason={NO_DRIVER.reason}>
          <Card interactive>▦ Motion Zones</Card>
        </CapabilityGate>
        <CapabilityGate available={false} reason={NO_DRIVER.reason}>
          <Card interactive>⏺️ Recording</Card>
        </CapabilityGate>
        <CapabilityGate available={false} reason={NO_DRIVER.reason}>
          <Card interactive>🌙 Night Vision</Card>
        </CapabilityGate>
      </Grid>

      <h2 className="section">Information</h2>
      <Card>
        <div className="sheet-row"><span className="muted">Room</span><strong>{roomName}</strong></div>
        <div className="sheet-row"><span className="muted">Live stream</span><strong>{camera.streamUrl ? "Configured" : "Not configured"}</strong></div>
        <div className="sheet-row"><span className="muted">Snapshot</span><strong>{camera.snapshotUrl ? "Configured" : "Not configured"}</strong></div>
      </Card>
    </div>
  );
}

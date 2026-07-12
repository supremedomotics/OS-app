import type { CameraList } from "@supreme/contracts";
import { Icon } from "@supreme/aureon-web";

type CameraView = CameraList["cameras"][number];

/**
 * The Security module's Camera Standard Card — reuses the app's existing snapshot-thumbnail
 * `.tile` visual language byte-for-byte (§ "maintain the existing visual identity, do not
 * redesign"); only now it opens the Camera Premium Detail Page instead of mounting a player
 * inline on the Security list.
 */
export function CameraCard({ camera, onOpen }: { camera: CameraView; onOpen: () => void }) {
  return (
    <div className="tile" onClick={onOpen} style={{ minHeight: 110 }}>
      {camera.snapshotUrl && (
        <img
          src={camera.snapshotUrl}
          alt={camera.name}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.7 }}
        />
      )}
      <div className="label" style={{ position: "relative", display: "flex", alignItems: "center", gap: 6 }}>
        <Icon name="play" size={13} /> {camera.name}
      </div>
    </div>
  );
}

import type { Device } from "@supreme/domain-model";
import type { ReactNode } from "react";
import { mediaDeviceKind, mediaKindMeta } from "./capability-mapper.js";

export interface MediaDeviceCardProps {
  device: Device;
  /** A short live status line — "Playing", "Nocturne in Blue · Aureon Session", "Idle", … */
  status: string;
  /** Pass the resolved driver protocol when it's already in hand (e.g. from a registry fetch
   * the caller did anyway) for the most accurate icon; omit it and installer-classified
   * devices still render correctly, just without the "avr" protocol inference. */
  driverProtocol?: string | null;
  onOpen: () => void;
  trailing?: ReactNode;
}

/**
 * The Media feature module's Standard Card (§ Premium Device Experience Library) — one
 * capability-driven card for every media device, whichever of the four premium presentations
 * (Television/Speaker/AVR/Projector) it resolves to. Reuses the app's existing `.media-card`
 * visual language byte-for-byte (§ "maintain the existing visual identity, do not redesign") —
 * the only thing capability/classification-driven here is which icon renders.
 */
export function MediaDeviceCard({ device, status, driverProtocol, onOpen, trailing }: MediaDeviceCardProps) {
  const meta = mediaKindMeta(mediaDeviceKind(device, driverProtocol));
  return (
    <button className="media-card" onClick={onOpen}>
      <span className="media-ic">{meta.icon}</span>
      <span className="media-meta">
        <span className="media-name">{device.name}</span>
        <span className="media-now">{status}</span>
      </span>
      {trailing}
    </button>
  );
}

import type { Device } from "@supreme/domain-model";
import type { ReactNode } from "react";
import { securityLockKind, securityLockKindMeta } from "./capability-mapper.js";

export interface LockCardProps {
  device: Device;
  /** A short live status line — "Locked", "Unlocked", "Jammed", … */
  status: string;
  driverProtocol?: string | null;
  onOpen: () => void;
  trailing?: ReactNode;
}

/**
 * The Security module's Standard Card (§ Premium Device Experience Library) — Door Lock,
 * Furniture Lock, and SIP Video Door Phone all share it. Reuses the app's existing
 * `.media-card` visual language byte-for-byte, exactly as the Media module's own Standard
 * Card does (§ "maintain the existing visual identity, do not redesign") — only the icon is
 * capability/classification-driven.
 */
export function LockCard({ device, status, driverProtocol, onOpen, trailing }: LockCardProps) {
  const meta = securityLockKindMeta(securityLockKind(device, driverProtocol));
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

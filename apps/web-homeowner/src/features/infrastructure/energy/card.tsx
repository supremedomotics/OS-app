import type { Device } from "@supreme/domain-model";
import { Icon, PowerRing } from "@supreme/aureon-web";
import { energyDeviceKind, energyKindMeta, energyReading } from "./capability-mapper.js";

export interface EnergyDeviceCardProps {
  device: Device;
  liveState?: unknown;
  onOpen: () => void;
  trailing?: React.ReactNode;
}

/** Standard Card for the Energy module (§ Infrastructure Design Language). Structurally the
 * same interactive surface as Media/Security's cards (`.media-card`) so the devices list reads
 * as one family, but leads with a small live `PowerRing` instead of a static icon plate — the
 * one place in the list view that hints at the richer per-device page behind it. */
export function EnergyDeviceCard({ device, liveState, onOpen, trailing }: EnergyDeviceCardProps) {
  const meta = energyKindMeta(energyDeviceKind(device));
  const reading = energyReading(liveState ?? device.state);
  const status = reading ? `${reading.value.toFixed(reading.value < 10 ? 1 : 0)} ${reading.unit}` : "No live reading";

  return (
    <button className="media-card" onClick={onOpen}>
      <span className="media-ic" style={{ display: "inline-flex" }}>
        {reading ? (
          <PowerRing size={30} strokeWidth={4} value={reading.value} max={Math.max(reading.value, 1)} tone="flow" label="" />
        ) : (
          <Icon name={meta.iconName} size={22} />
        )}
      </span>
      <span className="media-meta">
        <span className="media-name">{device.name}</span>
        <span className="media-now">{status} · {meta.label}</span>
      </span>
      {trailing}
    </button>
  );
}

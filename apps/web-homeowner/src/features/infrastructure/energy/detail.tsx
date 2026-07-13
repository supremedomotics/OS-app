import { useEffect, useState } from "react";
import type { Device, DeviceId } from "@supreme/domain-model";
import { Button, CapabilityGate, CapabilityGrid, Card, Icon, PowerRing } from "@supreme/aureon-web";
import { client, fetchEnergyHistory, type EnergyHistoryPoint } from "../../../api.js";
import { useLive } from "../../../live.js";
import {
  AdvancedSettingsSection,
  AutomationsSection,
  DiagnosticsSection,
  HistorySection,
  InformationSection,
} from "../../../device-detail-sections.js";
import { capabilityAvailability } from "../../_shared/capability-availability.js";
import { ENERGY_KIND_OPTIONS, energyDeviceKind, energyKindMeta, energyReading, type EnergyDeviceKind } from "./capability-mapper.js";

/** Tiny inline consumption sparkline off real `/v1/energy/history` data (§ "never fabricate" —
 * an empty/zero series just renders a flat baseline, never invented numbers). Not promoted to a
 * shared component yet: nothing else in the app needs a bucketed bar-sparkline today: [[ponytail:
 * promote to aureon-web if a second Infrastructure page needs the same shape]]. */
function ConsumptionSpark({ points }: { points: EnergyHistoryPoint[] }) {
  if (points.length === 0) {
    return <p className="muted" style={{ fontSize: 12.5 }}>No metered history yet.</p>;
  }
  const max = Math.max(...points.map((p) => p.kwh), 0.001);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 56 }}>
      {points.slice(-14).map((p) => (
        <div
          key={p.period}
          title={`${p.period}: ${p.kwh.toFixed(2)} kWh`}
          style={{
            flex: 1, minWidth: 4, height: `${Math.max(6, (p.kwh / max) * 100)}%`,
            borderRadius: 3, background: "var(--aureon-color-gold-400)", opacity: 0.85,
          }}
        />
      ))}
    </div>
  );
}

/**
 * Energy device premium detail page (§ Infrastructure Design Language, first module). Follows
 * the same skeleton `SimpleMediaDetail`/`LockDetail` established (hero → real controls →
 * QuickActions → CapabilityGrid → Universal Page Structure side column) but the hero is a live
 * `PowerRing` reading instead of an icon-plate hero, since that *is* the honest "now" state for
 * a metered device — there's no equivalent to "now playing"/"armed" here, just a number.
 */
export function EnergyDeviceDetail({
  device, roomName, onBack, onRemoved, onDeviceUpdated, devMode = false,
}: {
  device: Device;
  roomName: string;
  onBack: () => void;
  onRemoved: () => void;
  onDeviceUpdated?: (d: Device) => void;
  devMode?: boolean;
}) {
  const { states, apply } = useLive();
  const kind = energyDeviceKind(device);
  const kindMeta = energyKindMeta(kind);

  const liveState = states[device.id] ?? device.state;
  const reading = energyReading(liveState);
  const power = (liveState as Record<string, { on?: boolean }> | undefined)?.onoff;
  const on = power?.on ?? false;

  const [history, setHistory] = useState<EnergyHistoryPoint[]>([]);
  useEffect(() => {
    let live = true;
    void fetchEnergyHistory(device.id).then((r) => { if (live) setHistory(r.points); });
    return () => { live = false; };
  }, [device.id]);

  const powerAvail = capabilityAvailability(device, "onoff");
  const scheduleAvail = { available: false as const, reason: "Driver required" };
  const alertsAvail = { available: false as const, reason: "Driver required" };
  const loadPriorityAvail = { available: false as const, reason: "Driver required" };

  const setPower = (next: boolean) => {
    apply(device.id, "onoff", { kind: "onoff", on: next });
    void client.command(device.id as DeviceId, { capability: "onoff", action: next ? "on" : "off" });
  };
  const setKind = async (next: EnergyDeviceKind) => {
    const res = await client.updateDevice(device.id as DeviceId, { metadata: { ...device.metadata, energy: { kind: next } } });
    onDeviceUpdated?.(res.device);
  };

  // ponytail: ring's `max` is a display-only scaling heuristic (no rated-wattage config exists
  // yet), not a fabricated reading — the reading itself is always the real live value.
  const ringMax = reading ? Math.max(reading.value * 1.4, 100) : undefined;

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <button className="avr-back" onClick={onBack} aria-label="Back">←</button>
        <span className="muted">{roomName}</span>
      </div>

      <div className="aureon-detail-grid">
        <div className="aureon-detail-main">
          <div className="avr-now avr-now--wash" style={{ "--hero-wash-tint": "var(--aureon-color-status-good)" } as React.CSSProperties}>
            <PowerRing
              size={168}
              value={reading?.value}
              max={ringMax}
              tone={reading ? "good" : "idle"}
              label={reading ? `${reading.value.toFixed(reading.value < 10 ? 1 : 0)} ${reading.unit}` : "—"}
              sublabel={reading ? reading.measure === "power" ? "Live draw" : "Cumulative" : "No live reading"}
            />
            <div className="avr-now-meta">
              <span className="avr-now-label">{kindMeta.label.toUpperCase()}</span>
              <h3>{device.name}</h3>
              <p className="avr-now-album">{roomName}</p>
              <div className="avr-badges">
                <span className="avr-badge"><Icon name={kindMeta.iconName} size={13} /> {kindMeta.label}</span>
                {device.status === "online" && <span className="avr-badge">Online</span>}
              </div>
            </div>
          </div>

          <CapabilityGate available={powerAvail.available} reason={powerAvail.available ? undefined : powerAvail.reason}>
            <Button variant={on ? "primary" : "secondary"} size="lg" onClick={() => setPower(!on)}>
              <Icon name="power" size={17} /> {on ? "On" : "Off"}
            </Button>
          </CapabilityGate>

          <Card>
            <span className="avr-field-label">Consumption — last 14 days</span>
            <div style={{ marginTop: 10 }}>
              <ConsumptionSpark points={history} />
            </div>
          </Card>

          <h2 className="section">More controls</h2>
          <CapabilityGrid
            minItemWidth={130}
            items={[
              { key: "schedule", icon: <Icon name="clock" size={16} />, label: "Schedule", available: scheduleAvail.available, reason: scheduleAvail.reason },
              { key: "load-priority", icon: <Icon name="trend-up" size={16} />, label: "Load Priority", available: loadPriorityAvail.available, reason: loadPriorityAvail.reason },
              { key: "alerts", icon: <Icon name="alert-triangle" size={16} />, label: "Usage Alerts", available: alertsAvail.available, reason: alertsAvail.reason },
              { key: "efficiency", icon: <Icon name="leaf" size={16} />, label: "Efficiency Insights", available: false, reason: "Driver required" },
            ]}
          />
        </div>

        <div className="aureon-detail-side sheet-sections">
          <InformationSection device={device} roomName={roomName} />
          {devMode && <DiagnosticsSection device={device} />}
          <AutomationsSection device={device} />
          <HistorySection device={device} />
          <AdvancedSettingsSection device={device} onRemoved={onRemoved}>
            <label className="drv-field" style={{ marginBottom: 10 }}>
              <span className="lbl">Device type</span>
              <select value={kind} onChange={(e) => void setKind(e.target.value as EnergyDeviceKind)}>
                {ENERGY_KIND_OPTIONS.map((o) => <option key={o.kind} value={o.kind}>{o.icon} {o.label}</option>)}
              </select>
            </label>
          </AdvancedSettingsSection>
        </div>
      </div>
    </div>
  );
}

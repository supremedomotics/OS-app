import type { Device, DeviceId } from "@supreme/domain-model";
import { Button, Card, CapabilityGate, Grid, Stack } from "@supreme/aureon-web";
import { client, fetchDriverRegistry } from "../../api.js";
import { useLive } from "../../live.js";
import {
  AdvancedSettingsSection,
  AutomationsSection,
  DiagnosticsSection,
  HistorySection,
  InformationSection,
} from "../../device-detail-sections.js";
import { useAsync } from "../../use-async.js";
import { SlideUnlock } from "../../device-sheets.js";
import { capabilityAvailability } from "../_shared/capability-availability.js";
import { SECURITY_LOCK_KIND_OPTIONS, securityLockKind, securityLockKindMeta, type SecurityLockKind } from "./capability-mapper.js";

interface LockState {
  locked?: boolean;
  jammed?: boolean;
}

/**
 * Door Lock / Furniture Lock premium detail page (§ Premium Device Experience Library). The
 * real `lock` capability today is just locked/jammed — this page shows that honestly (a live
 * slide-to-unlock, real jam indicator) plus the rest of a premium smart-lock's expected
 * control set (Access Codes, Auto-Lock Timer, Battery Level, Door Sensor, Guest Access) as
 * capability-gated placeholders, exactly as Television/Projector did for media (§ "the UI is
 * the contract"). SIP Video Door Phone reuses this same page shape — its `lock` capability
 * really is a door-release relay (`services/protocols/src/sip-driver.ts`) — with a Live Video
 * placeholder up top, since the SIP driver carries no video capability yet.
 */
export function LockDetail({
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
  const [registry] = useAsync(() => fetchDriverRegistry());
  const driver = device.driverId ? registry?.find((r) => r.installedId === device.driverId || r.key === device.driverId) ?? null : null;
  const kind = securityLockKind(device, driver?.protocols[0] ?? null);
  const kindMeta = securityLockKindMeta(kind);
  const isDoorPhone = kind === "sip_door_phone";

  const live = (states[device.id]?.lock ?? (device.state as Record<string, LockState>).lock ?? {}) as LockState;
  const locked = live.locked ?? true;
  const jammed = live.jammed ?? false;

  const videoAvail = capabilityAvailability(device, "media");
  const ringAvail = capabilityAvailability(device, "sensor");
  const accessCodesAvail = capabilityAvailability(device, "lock", "accessCodes");
  const autoLockAvail = capabilityAvailability(device, "lock", "autoLockSeconds");
  const batteryAvail = capabilityAvailability(device, "sensor");
  const doorSensorAvail = capabilityAvailability(device, "sensor");
  const guestAccessAvail = capabilityAvailability(device, "lock", "guestCodes");

  const setLock = (next: boolean) => {
    apply(device.id, "lock", { kind: "lock", locked: next, jammed: false });
    void client.command(device.id as DeviceId, { capability: "lock", action: next ? "lock" : "unlock" });
  };
  const setKind = async (next: SecurityLockKind) => {
    const res = await client.updateDevice(device.id as DeviceId, { metadata: { ...device.metadata, security: { kind: next } } });
    onDeviceUpdated?.(res.device);
  };

  return (
    <div className="page">
      <div className="avr-head-card">
        <button className="avr-back" onClick={onBack} aria-label="Back">←</button>
        <div className="avr-head-ic">{kindMeta.icon}</div>
        <div className="avr-head-meta">
          <h2>{device.name}</h2>
          <p>{roomName}</p>
          <span className={`avr-status${device.status === "online" ? " good" : ""}`}>
            <i /> {device.status === "online" ? "Online" : device.status === "offline" ? "Offline" : "Unavailable"}
          </span>
          {jammed && <span className="avr-status" style={{ color: "var(--aureon-danger, #e5484d)" }}><i /> Jammed</span>}
        </div>
      </div>

      <Stack gap="lg" style={{ marginTop: 20 }}>
        {isDoorPhone && (
          <CapabilityGate available={videoAvail.available} reason={videoAvail.available ? undefined : videoAvail.reason}>
            <Card style={{ minHeight: 160, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span className="muted">Live video</span>
            </Card>
          </CapabilityGate>
        )}
        {isDoorPhone && (
          <CapabilityGate available={ringAvail.available} reason={ringAvail.available ? undefined : ringAvail.reason}>
            <Card>
              <span className="avr-field-label">Doorbell</span>
              <p className="muted" style={{ marginTop: 6 }}>No ring events yet.</p>
            </Card>
          </CapabilityGate>
        )}

        <Card>
          <span className="avr-field-label">{isDoorPhone ? "Door release" : "Lock"}</span>
          <div style={{ marginTop: 12 }}>
            <div className="lock-actions">
              <button className="lock-secondary" onClick={() => setLock(false)}>Unlatch</button>
              <SlideUnlock locked={locked} onUnlock={() => setLock(false)} relock={() => setLock(true)} />
            </div>
          </div>
        </Card>
      </Stack>

      <h2 className="section">More controls</h2>
      <Grid minItemWidth={150} gap="sm">
        <CapabilityGate available={accessCodesAvail.available} reason={accessCodesAvail.available ? undefined : accessCodesAvail.reason}>
          <Card interactive>🔢 Access Codes</Card>
        </CapabilityGate>
        <CapabilityGate available={autoLockAvail.available} reason={autoLockAvail.available ? undefined : autoLockAvail.reason}>
          <Card interactive>⏱️ Auto-Lock Timer</Card>
        </CapabilityGate>
        <CapabilityGate available={batteryAvail.available} reason={batteryAvail.available ? undefined : batteryAvail.reason}>
          <Card interactive>🔋 Battery Level</Card>
        </CapabilityGate>
        <CapabilityGate available={doorSensorAvail.available} reason={doorSensorAvail.available ? undefined : doorSensorAvail.reason}>
          <Card interactive>🚪 Door Sensor</Card>
        </CapabilityGate>
        <CapabilityGate available={guestAccessAvail.available} reason={guestAccessAvail.available ? undefined : guestAccessAvail.reason}>
          <Card interactive>👤 Guest Access</Card>
        </CapabilityGate>
      </Grid>

      {/* § Design System — Universal Page Structure: same sections every device detail page
          shows, capability- and data-driven, never protocol-driven. */}
      <div className="sheet-sections">
        <InformationSection device={device} roomName={roomName} />
        {devMode && <DiagnosticsSection device={device} />}
        <AutomationsSection device={device} />
        <HistorySection device={device} />
        <AdvancedSettingsSection device={device} onRemoved={onRemoved}>
          <label className="drv-field" style={{ marginBottom: 10 }}>
            <span className="lbl">Device type</span>
            <select value={kind} onChange={(e) => void setKind(e.target.value as SecurityLockKind)}>
              {SECURITY_LOCK_KIND_OPTIONS.map((o) => <option key={o.kind} value={o.kind}>{o.icon} {o.label}</option>)}
            </select>
          </label>
        </AdvancedSettingsSection>
      </div>
    </div>
  );
}

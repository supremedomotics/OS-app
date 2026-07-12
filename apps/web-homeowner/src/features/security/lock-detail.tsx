import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Device, DeviceId } from "@supreme/domain-model";
import { Card, CapabilityGate, CapabilityGrid, QuickActions } from "@supreme/aureon-web";
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

const NOT_YET = { available: false as const, reason: "Driver required" };

/**
 * Door Lock / Furniture Lock premium detail page (§ Premium Device Experience Library). The
 * real `lock` capability today is just locked/jammed — the hero shows that honestly (a live
 * illustration that glows when unlocked, a genuine jam state, a slide-to-unlock gesture) plus
 * the rest of a premium smart-lock's expected surface (Battery, Last User, Last Unlock,
 * Connection Quality, Access Codes, Auto-Lock Timer, Door Sensor, Guest Access) as capability-
 * gated placeholders — exactly as Television/Projector did for media (§ "the UI is the
 * contract"). SIP Video Door Phone reuses this same page shape — its `lock` capability really
 * is a door-release relay (`services/protocols/src/sip-driver.ts`) — with a Live Video
 * placeholder up top, since the SIP driver carries no video capability yet.
 */
export function LockDetail({
  device, roomName, onBack, onRemoved, onDeviceUpdated, allLocks = [], devMode = false,
}: {
  device: Device;
  roomName: string;
  onBack: () => void;
  onRemoved: () => void;
  onDeviceUpdated?: (d: Device) => void;
  /** Every other lock-capable device in the home, for the real "Lock All" quick action. */
  allLocks?: Device[];
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

  // A brief pulse on the hero icon while a lock/unlock command is genuinely in flight — not a
  // fake "loading" state, just visual follow-through on the real command that was just sent.
  const [busy, setBusy] = useState(false);
  const busyTimer = useRef<number | undefined>(undefined);

  const videoAvail = capabilityAvailability(device, "media");
  const ringAvail = capabilityAvailability(device, "sensor");
  const accessCodesAvail = capabilityAvailability(device, "lock", "accessCodes");
  const autoLockAvail = capabilityAvailability(device, "lock", "autoLockSeconds");
  const doorSensorAvail = capabilityAvailability(device, "sensor");
  const guestAccessAvail = capabilityAvailability(device, "lock", "guestCodes");

  const setLock = (next: boolean) => {
    apply(device.id, "lock", { kind: "lock", locked: next, jammed: false });
    void client.command(device.id as DeviceId, { capability: "lock", action: next ? "lock" : "unlock" });
    setBusy(true);
    window.clearTimeout(busyTimer.current);
    busyTimer.current = window.setTimeout(() => setBusy(false), 600);
  };
  useEffect(() => () => window.clearTimeout(busyTimer.current), []);

  const lockAll = () => {
    for (const d of allLocks) {
      apply(d.id, "lock", { kind: "lock", locked: true, jammed: false });
      void client.command(d.id as DeviceId, { capability: "lock", action: "lock" });
    }
    setLock(true);
  };

  const setKind = async (next: SecurityLockKind) => {
    const res = await client.updateDevice(device.id as DeviceId, { metadata: { ...device.metadata, security: { kind: next } } });
    onDeviceUpdated?.(res.device);
  };

  const heroTint = jammed
    ? "var(--aureon-color-status-critical)"
    : !locked
      ? "var(--aureon-color-status-good)"
      : "var(--aureon-color-gold-400)";
  const heroLabel = jammed ? "JAMMED" : locked ? "SECURED" : "UNLOCKED";

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <button className="avr-back" onClick={onBack} aria-label="Back">←</button>
        <span className="muted">{roomName}</span>
      </div>

      <div className="aureon-detail-grid">
        <div className="aureon-detail-main">
          <div className={`avr-now avr-now--wash${jammed ? " offline" : ""}`} style={{ "--hero-wash-tint": heroTint } as CSSProperties}>
            <div className="avr-art-wrap" style={{ width: 176, height: 176 }}>
              <div className={`avr-halo${!locked ? " on" : ""}`} style={{ "--avr-halo-tint": heroTint } as CSSProperties} />
              <div className={`avr-art-float${!locked ? " on" : ""}`}>
                <div
                  className={`avr-art avr-art-placeholder hero-ic-plate${busy ? " busy" : ""}`}
                  style={{ width: 176, height: 176, fontSize: 62, color: heroTint }}
                >
                  {jammed ? "⚠️" : locked ? "🔒" : "🔓"}
                </div>
              </div>
            </div>
            <div className="avr-now-meta">
              <span className="avr-now-label">{heroLabel}</span>
              <h3>{device.name}</h3>
              <p className="avr-now-album">{kindMeta.label} · {device.status === "online" ? "Online" : device.status === "offline" ? "Offline" : "Unavailable"}</p>
              <div className="avr-badges">
                <span className="avr-badge">{kindMeta.icon} {kindMeta.label}</span>
                {jammed && <span className="avr-badge" style={{ color: "var(--aureon-color-status-critical)" }}>Jammed</span>}
              </div>
              <div style={{ marginTop: 14 }}>
                <CapabilityGrid
                  minItemWidth={110}
                  items={[
                    { key: "battery", icon: "🔋", label: "Battery", available: false, reason: NOT_YET.reason },
                    { key: "last-user", icon: "👤", label: "Last user", available: false, reason: NOT_YET.reason },
                    { key: "last-unlock", icon: "🕐", label: "Last unlock", available: false, reason: NOT_YET.reason },
                    { key: "connection", icon: "📶", label: "Connection", available: false, reason: NOT_YET.reason },
                  ]}
                />
              </div>
            </div>
          </div>

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

          <QuickActions
            actions={[
              { key: "unlock", icon: "🔓", label: "Unlock", onClick: () => setLock(false), active: !locked, disabled: !locked },
              { key: "lock-all", icon: "🔒", label: "Lock All", onClick: lockAll },
            ]}
          />

          <h2 className="section">More controls</h2>
          <CapabilityGrid
            minItemWidth={150}
            items={[
              { key: "access-codes", icon: "🔢", label: "Access Codes", available: accessCodesAvail.available, reason: accessCodesAvail.available ? undefined : accessCodesAvail.reason },
              { key: "auto-lock", icon: "⏱️", label: "Auto-Lock Timer", available: autoLockAvail.available, reason: autoLockAvail.available ? undefined : autoLockAvail.reason },
              { key: "door-sensor", icon: "🚪", label: "Door Sensor", available: doorSensorAvail.available, reason: doorSensorAvail.available ? undefined : doorSensorAvail.reason },
              { key: "guest-access", icon: "👤", label: "Guest Access", available: guestAccessAvail.available, reason: guestAccessAvail.available ? undefined : guestAccessAvail.reason },
              { key: "temporary-access", icon: "🕓", label: "Temporary Access", available: false, reason: NOT_YET.reason },
              { key: "vacation-mode", icon: "🏖️", label: "Vacation Mode", available: false, reason: NOT_YET.reason },
            ]}
          />
        </div>

        {/* § Design System — Universal Page Structure: same sections every device detail page
            shows, capability- and data-driven, never protocol-driven. Beside the hero/controls
            on wide displays instead of stacking below them (§ "eliminate empty space"). */}
        <div className="aureon-detail-side sheet-sections">
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
    </div>
  );
}

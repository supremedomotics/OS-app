import { useState, type ReactNode } from "react";
import type { Device, DeviceId } from "@supreme/domain-model";
import { CollapsibleSection, DeviceFacts, type DeviceFactRow } from "@supreme/aureon-web";
import {
  automationsForDevice,
  client,
  fetchAutomations,
  fetchDriverRegistry,
  fetchEnergyHistory,
  fetchIntelligenceHistory,
} from "./api.js";
import { friendlyType } from "./devices.js";
import { useAsync } from "./use-async.js";

/**
 * The SupremeOS Universal Page Structure (§ Design System) — Information, Diagnostics,
 * Automations, History and Advanced Settings, shared by EVERY device detail page (the generic
 * DeviceSheet, LightingDetail, AvrConsole, ClimateConsole, and every future console). One
 * implementation per section, capability- and data-driven, never protocol-driven: a section or
 * field with nothing real behind it simply doesn't render, rather than a page taking a different
 * shape per device type. Overview + Controls stay page-specific (a climate dial, a colour wheel,
 * an AVR transport, …) since that's genuinely where devices differ; everything from Information
 * down is identical everywhere.
 */

// ── Information — only fields the platform actually has for this device, same "don't fake it"
// policy as the Devices list. ─────────────────────────────────────────────────────────────────
export function InformationSection({ device, roomName }: { device: Device; roomName?: string }) {
  const rows: DeviceFactRow[] = [{ label: "Type", value: friendlyType(device) }];
  if (device.manufacturer) rows.push({ label: "Manufacturer", value: device.manufacturer });
  if (device.model) rows.push({ label: "Model", value: device.model });
  if (roomName) rows.push({ label: "Room", value: roomName });
  rows.push({ label: "Status", value: device.status === "online" ? "Online" : device.status === "offline" ? "Offline" : "Unavailable" });
  return (
    <CollapsibleSection title="Information">
      <DeviceFacts rows={rows} />
    </CollapsibleSection>
  );
}

// ── Diagnostics (§ Integrator/Developer Mode) — driver/protocol/network plus each protocol
// binding's own address (KNX group address, Matter node/endpoint, Zigbee IEEE, DALI short
// address, Casambi fixture, MQTT topic, Modbus register, …). Rendered generically off whatever
// protocolBindings() returns for this device — ONE code path for every integration, nothing
// here branches per protocol. Only ever mount this when the caller has already gated on
// devMode — it is never reachable by a homeowner account. ───────────────────────────────────────
export function DiagnosticsSection({ device }: { device: Device }) {
  const [registry] = useAsync(() => fetchDriverRegistry());
  const [bindings] = useAsync(() => client.protocolBindings());
  const driver = device.driverId
    ? registry?.find((r) => r.installedId === device.driverId || r.key === device.driverId) ?? null
    : null;
  const net = (device.metadata as { network?: { ip?: string; mac?: string; host?: string } } | undefined)?.network;
  const myBindings = (bindings?.bindings ?? []).filter((b) => b.deviceId === device.id);

  const rows: DeviceFactRow[] = [];
  if (driver) rows.push({ label: "Driver", value: driver.name });
  if (driver?.protocols[0]) rows.push({ label: "Protocol", value: driver.protocols[0].toUpperCase() });
  if (net?.ip) rows.push({ label: "IP address", value: net.ip });
  if (net?.mac) rows.push({ label: "MAC", value: net.mac });
  rows.push({ label: "Capabilities", value: device.capabilities.map((c) => c.kind).join(", ") });
  for (const b of myBindings) rows.push({ label: `${b.protocol.toUpperCase()} · ${b.capability}`, value: b.address });

  return (
    <CollapsibleSection title="Diagnostics">
      <DeviceFacts rows={rows} />
    </CollapsibleSection>
  );
}

// ── Automations — every automation or scene that references this device, found by fetching the
// home's automations/scenes and filtering client-side (there's no server-side "automations for
// device X" index). Hidden entirely until both have loaded, then hidden for good if neither
// references this device. ─────────────────────────────────────────────────────────────────────
export function AutomationsSection({ device }: { device: Device }) {
  const [automations] = useAsync(() => fetchAutomations());
  const [scenesRes] = useAsync(() => client.scenes());
  if (automations === null || scenesRes === null) return null;
  const matchingAutomations = automationsForDevice(automations, device.id);
  const matchingScenes = scenesRes.scenes.filter((s) => s.steps.some((st) => st.deviceId === device.id));
  const total = matchingAutomations.length + matchingScenes.length;
  if (total === 0) return null;
  return (
    <CollapsibleSection title="Automations" badge={total}>
      {matchingAutomations.map((a) => (
        <div key={a.id} className="sheet-list-row">
          <span>{a.name}</span>
          <span className="sheet-list-sub">{a.enabled ? "Enabled" : "Disabled"}</span>
        </div>
      ))}
      {matchingScenes.map((s) => (
        <div key={s.id} className="sheet-list-row">
          <span>{s.name}</span>
          <span className="sheet-list-sub">Scene</span>
        </div>
      ))}
    </CollapsibleSection>
  );
}

// ── History — the Supreme Intelligence Engine's own decision log for this device (why it turned
// something on/off automatically) plus its metered energy cost, when the home has one
// configured. Two independently-optional sources; hidden entirely until both resolve, then
// hidden for good if neither has anything to show. ───────────────────────────────────────────────
export function HistorySection({ device }: { device: Device }) {
  const [intel] = useAsync(() => fetchIntelligenceHistory(device.id), [device.id]);
  const [energy] = useAsync(() => fetchEnergyHistory(device.id), [device.id]);
  if (intel === null || energy === null) return null;
  const totalKwh = energy.points.reduce((s, p) => s + p.kwh, 0);
  const totalCost = energy.points.reduce((s, p) => s + p.cost, 0);
  if (intel.length === 0 && totalKwh <= 0) return null;
  return (
    <CollapsibleSection title="History">
      {intel.map((h) => (
        <div key={h.id} className="sheet-list-row">
          <span>{h.reason ?? h.action}</span>
          <span className="sheet-list-sub">{new Date(h.ts).toLocaleString()}</span>
        </div>
      ))}
      {totalKwh > 0 && (
        <div className="sheet-list-row">
          <span>Energy, last {energy.points.length} day{energy.points.length === 1 ? "" : "s"}</span>
          <span className="sheet-list-sub">{totalKwh.toFixed(1)} kWh · {energy.currency}{totalCost.toFixed(2)}</span>
        </div>
      )}
    </CollapsibleSection>
  );
}

// ── Advanced Settings — rename / remove, the one device-management action set every device
// detail page offers. `DeviceManageActions` is the bare button pair + busy/error state, usable
// on its own inside a page that already has its own "Advanced Settings" surface (ClimateConsole's
// existing modal); `AdvancedSettingsSection` wraps it in the shared collapsible for pages that
// don't. ───────────────────────────────────────────────────────────────────────────────────────
export function DeviceManageActions({ device, onRemoved, onRenamed }: { device: Device; onRemoved?: () => void; onRenamed?: (device: Device) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function rename() {
    const name = window.prompt("Rename device", device.name);
    if (!name || !name.trim() || name === device.name) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await client.updateDevice(device.id as DeviceId, { name: name.trim() });
      onRenamed?.(res.device);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not rename this device.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove "${device.name}"? This can't be undone.`)) return;
    setBusy(true);
    setErr(null);
    try {
      await client.deleteDevice(device.id as DeviceId);
      onRemoved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not remove this device.");
      setBusy(false);
    }
  }

  return (
    <>
      <div className="drv-actions">
        <button disabled={busy} onClick={() => void rename()}>Rename</button>
        <button className="danger" disabled={busy} onClick={() => void remove()}>Remove device</button>
      </div>
      {err && <p className="err">{err}</p>}
    </>
  );
}

export function AdvancedSettingsSection({ device, onRemoved, children }: { device: Device; onRemoved?: () => void; children?: ReactNode }) {
  return (
    <CollapsibleSection title="Advanced Settings">
      {children}
      <DeviceManageActions device={device} onRemoved={onRemoved} />
    </CollapsibleSection>
  );
}

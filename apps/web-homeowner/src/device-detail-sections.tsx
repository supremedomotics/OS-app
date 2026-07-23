import { useState, type ReactNode } from "react";
import type { Device, DeviceId } from "@supreme/domain-model";
import { Badge, CollapsibleSection, DeviceFacts, StatusDot, Timeline, type DeviceFactRow, type TimelineEntry } from "@supreme/aureon-web";
import {
  automationsForDevice,
  client,
  fetchAutomations,
  fetchDeviceDiagnostics,
  fetchDeviceTrace,
  fetchDriverRegistry,
  fetchEnergyHistory,
  fetchIntelligenceHistory,
  refreshDeviceCapabilities,
  sendRawDeviceCommand,
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

/** Same capability→glyph priority as the Room→Category grammar (§11.1 CATEGORY_DEFS) — one
 * icon vocabulary for "what kind of thing is this" everywhere in the app. */
function deviceGlyph(device: Device): string {
  const caps = device.capabilities.map((c) => c.kind);
  if (caps.includes("brightness") || caps.includes("color")) return "☀";
  if (caps.includes("temperature")) return "❄";
  if (caps.includes("media")) return "♫";
  if (caps.includes("position")) return "▤";
  if (caps.includes("lock")) return "🔒";
  if (caps.includes("fan")) return "≋";
  if (caps.includes("vacuum")) return "◌";
  return "•";
}

function statusTone(status: Device["status"]): "good" | "neutral" | "warning" {
  return status === "online" ? "good" : status === "offline" ? "neutral" : "warning";
}
function statusLabel(status: Device["status"]): string {
  return status === "online" ? "Online" : status === "offline" ? "Offline" : "Unavailable";
}

/** The live per-driver connection signal (real socket/link state), distinct from `device.status`
 * (the device-registry record's own field, set at commission time — it doesn't track whether the
 * underlying connection is actually up right now). Diagnostics should show the truth about the
 * wire, not a copy of the same "Status" row Information already shows. */
function connectionTone(status: "connected" | "connecting" | "disconnected"): "good" | "neutral" | "warning" {
  return status === "connected" ? "good" : status === "connecting" ? "neutral" : "warning";
}
function connectionLabel(status: "connected" | "connecting" | "disconnected"): string {
  return status === "connected" ? "Connected" : status === "connecting" ? "Connecting…" : "Disconnected";
}

// ── Information — only fields the platform actually has for this device, same "don't fake it"
// policy as the Devices list. Premium fact tiles, not a table (§ Premium Device Experience
// Library — "rich Information cards"). ───────────────────────────────────────────────────────
export function InformationSection({ device, roomName }: { device: Device; roomName?: string }) {
  const rows: DeviceFactRow[] = [{ label: "Type", value: friendlyType(device), icon: deviceGlyph(device) }];
  if (device.manufacturer) rows.push({ label: "Manufacturer", value: device.manufacturer, icon: "🏷️" });
  if (device.model) rows.push({ label: "Model", value: device.model, icon: "🔧" });
  if (roomName) rows.push({ label: "Room", value: roomName, icon: "🏠" });
  rows.push({ label: "Status", value: statusLabel(device.status), icon: "📶", tone: statusTone(device.status) });
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
/** A protocol badge glyph — every real protocol Supreme speaks gets a distinct icon so the
 * installer/developer diagnostics list reads at a glance, matched to the driver names actually
 * registered by services/protocols; unknown/future protocols fall back to a generic plug. */
function protocolGlyph(protocol: string): string {
  const p = protocol.toLowerCase();
  if (p === "knx") return "🏗️";
  if (p === "matter") return "⬡";
  if (p === "zigbee") return "🐝";
  if (p === "dali") return "💡";
  if (p === "casambi") return "📱";
  if (p === "modbus" || p === "coolmaster") return "🌡️";
  if (p === "mqtt") return "📨";
  if (p === "sip") return "☎️";
  if (p === "rti" || p === "avr" || p === "heos" || p === "yamaha" || p === "sonos" || p === "wiim" || p === "devialet" || p === "airplay" || p === "appletv") return "🎚️";
  if (p === "lutron" || p === "tuya" || p === "shelly") return "🔌";
  return "🔗";
}

// ── Diagnostics (§ Integrator/Developer Mode) — driver/protocol/network plus each protocol
// binding's own address (KNX group address, Matter node/endpoint, Zigbee IEEE, DALI short
// address, Casambi fixture, MQTT topic, Modbus register, …). Rendered generically off whatever
// protocolBindings() returns for this device — ONE code path for every integration, nothing
// here branches per protocol. Only ever mount this when the caller has already gated on
// devMode — it is never reachable by a homeowner account. Premium fact tiles, same as
// Information (§ "diagnostics should feel like a professional installer page"). ────────────────
/** ms → a short human duration ("120ms", "1.4s") — used only for response time, which
 * is always a small number; never a fabricated reading when the underlying value is null. */
function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function DiagnosticsSection({ device }: { device: Device }) {
  const [registry] = useAsync(() => fetchDriverRegistry());
  const [bindings] = useAsync(() => client.protocolBindings());
  const [driverDiagnostics] = useAsync(() => fetchDeviceDiagnostics(device.id), [device.id]);
  const driver = device.driverId
    ? registry?.find((r) => r.installedId === device.driverId || r.key === device.driverId) ?? null
    : null;
  const net = (device.metadata as { network?: { ip?: string; mac?: string; host?: string } } | undefined)?.network;
  const myBindings = (bindings?.bindings ?? []).filter((b) => b.deviceId === device.id);
  const dd = driverDiagnostics;

  // Prefer the driver's real, live connectionStatus (a real socket/link signal) over
  // device.status (a commission-time registry field) — this section exists specifically to
  // show what's actually happening on the wire, not repeat Information's "Status" row.
  const rows: DeviceFactRow[] = [
    dd
      ? { label: "Connection", value: connectionLabel(dd.connectionStatus), icon: "📶", tone: connectionTone(dd.connectionStatus) }
      : { label: "Connection", value: statusLabel(device.status), icon: "📶", tone: statusTone(device.status) },
  ];
  if (driver) rows.push({ label: "Driver", value: driver.name, icon: "🧩" });
  if (driver?.protocols[0]) rows.push({ label: "Protocol", value: driver.protocols[0].toUpperCase(), icon: protocolGlyph(driver.protocols[0]) });
  // Driver Diagnostics Console (§ Universal AV Driver SDK) — real per-connection fields
  // from the owning driver's tracker. Absent entirely (not shown as "—") for any device
  // whose driver doesn't report this (HA-backed devices, protocols with no tracker).
  if (dd) {
    rows.push({ label: "Driver version", value: dd.driverVersion, icon: "🏷️" });
    if (dd.model) rows.push({ label: "Model", value: dd.model, icon: "🔧" });
    if (dd.firmware) rows.push({ label: "Firmware", value: dd.firmware, icon: "💾" });
    if (dd.serial) rows.push({ label: "Serial", value: dd.serial, icon: "🔖" });
  }
  if (net?.ip ?? dd?.ip) rows.push({ label: "IP address", value: net?.ip ?? dd!.ip!, icon: "🌐" });
  if (net?.mac ?? dd?.mac) rows.push({ label: "MAC", value: net?.mac ?? dd!.mac!, icon: "🔗" });
  rows.push({ label: "Capabilities", value: device.capabilities.map((c) => c.kind).join(", "), icon: "⚙️" });
  for (const b of myBindings) rows.push({ label: `${b.protocol.toUpperCase()} · ${b.capability}`, value: b.address, icon: protocolGlyph(b.protocol) });
  if (dd) {
    if (dd.lastCommand) rows.push({ label: "Last command", value: dd.lastCommandAt ? `${dd.lastCommand} · ${formatTimestamp(dd.lastCommandAt)}` : dd.lastCommand, icon: "📤" });
    if (dd.lastResponse) rows.push({ label: "Last response", value: dd.lastResponseAt ? `${dd.lastResponse} · ${formatTimestamp(dd.lastResponseAt)}` : dd.lastResponse, icon: "📥" });
    if (dd.responseTimeMs !== null) rows.push({ label: "Response time", value: formatMs(dd.responseTimeMs), icon: "⏱️" });
    // § Universal AVR SDK — a real rolling average, distinct from the single
    // most-recent `responseTimeMs` sample above; absent until at least one round trip
    // has actually been measured (never a fabricated starting value).
    if (dd.averageLatencyMs !== null) rows.push({ label: "Avg. latency", value: formatMs(dd.averageLatencyMs), icon: "📊" });
    rows.push({ label: "Packets sent / received", value: `${dd.packetsSent} / ${dd.packetsReceived}`, icon: "📶" });
    rows.push({ label: "Reconnect count", value: String(dd.reconnectCount), icon: "🔁" });
    if (dd.lastError) rows.push({ label: "Last error", value: dd.lastError, icon: "⚠️", tone: "warning" });
  }

  return (
    <CollapsibleSection title="Diagnostics">
      <DeviceFacts rows={rows} />
    </CollapsibleSection>
  );
}

// ── Protocol Trace (§ Universal AVR SDK — "capture and log the raw protocol responses
// for every discovery, capability, command, and event operation") — the raw send/
// receive log a driver's `DriverDiagnosticsTracker` automatically captures, surfaced
// here as the concrete "protocol trace" / "realtime event log" developer diagnostic.
// Absent entirely for a device whose driver doesn't support this, or that has never
// exchanged a single command/response yet — never a fabricated "no data" placeholder
// row inside an otherwise-empty panel. devMode-gated by the caller, same as
// Diagnostics. ─────────────────────────────────────────────────────────────────────
export function ProtocolTraceSection({ device }: { device: Device }) {
  const [trace, refresh] = useAsync(() => fetchDeviceTrace(device.id), [device.id]);
  if (!trace || trace.length === 0) return null;
  return (
    <CollapsibleSection title="Protocol Trace" badge={trace.length}>
      <div className="trace-toolbar">
        <button className="trace-refresh" onClick={refresh}>Refresh</button>
      </div>
      <div className="trace-log">
        {trace.map((t, i) => (
          <div key={i} className={`trace-line${t.line.startsWith("->") ? " out" : t.line.startsWith("<-") ? " in" : ""}`}>
            <span className="trace-at">{new Date(t.at).toLocaleTimeString()}</span>
            <span className="trace-text">{t.line}</span>
          </div>
        ))}
      </div>
    </CollapsibleSection>
  );
}

// ── Raw Command (§ RTI Capability Audit, Category C.4) — devMode-only escape hatch:
// writes a token verbatim to the device's owning driver, bypassing the typed capability
// command dispatch entirely. Only ever surfaced behind the same devMode gate as
// Diagnostics/Protocol Trace — never reachable by a homeowner account. A driver that
// doesn't support this (most protocols don't opt in) fails the request with a real
// error message rather than the control silently doing nothing. ─────────────────────
export function RawCommandSection({ device }: { device: Device }) {
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  const [sending, setSending] = useState(false);

  async function send() {
    const trimmed = token.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setStatus(null);
    try {
      await sendRawDeviceCommand(device.id, trimmed);
      setStatus({ kind: "ok", message: `Sent "${trimmed}".` });
      setToken("");
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Raw command failed." });
    } finally {
      setSending(false);
    }
  }

  return (
    <CollapsibleSection title="Raw Command">
      <div className="raw-cmd-row">
        <input
          className="raw-cmd-input"
          type="text"
          value={token}
          placeholder="e.g. PSCINEMA EQ.ON"
          spellCheck={false}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }}
        />
        <button className="raw-cmd-send" onClick={send} disabled={sending || !token.trim()}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
      {status && <div className={`raw-cmd-status ${status.kind}`}>{status.message}</div>}
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
          <StatusDot tone={a.enabled ? "good" : "neutral"} />
          <span>{a.name}</span>
          <Badge>{a.enabled ? "Enabled" : "Disabled"}</Badge>
        </div>
      ))}
      {matchingScenes.map((s) => (
        <div key={s.id} className="sheet-list-row">
          <StatusDot tone="neutral" />
          <span>{s.name}</span>
          <Badge>Scene</Badge>
        </div>
      ))}
    </CollapsibleSection>
  );
}

// ── History — the Supreme Intelligence Engine's own decision log for this device (why it turned
// something on/off automatically) plus its metered energy cost, when the home has one
// configured. Two independently-optional sources; hidden entirely until both resolve, then
// hidden for good if neither has anything to show. ───────────────────────────────────────────────
/** A real, minimal energy trend — bar height from each day's actual metered kWh, nothing
 * interpolated or invented (§ Premium Device Experience Library — "better history: mini
 * charts, energy trend"). Pure CSS bars, no charting dependency for five numbers. */
function EnergySparkline({ points }: { points: { period: string; kwh: number }[] }) {
  const max = Math.max(...points.map((p) => p.kwh), 0.001);
  return (
    <div className="aureon-sparkline" role="img" aria-label="Daily energy use trend">
      {points.map((p) => (
        <span key={p.period} className="aureon-sparkline-bar" style={{ height: `${Math.max(6, (p.kwh / max) * 100)}%` }} title={`${p.period}: ${p.kwh.toFixed(2)} kWh`} />
      ))}
    </div>
  );
}

export function HistorySection({ device }: { device: Device }) {
  const [intel] = useAsync(() => fetchIntelligenceHistory(device.id), [device.id]);
  const [energy] = useAsync(() => fetchEnergyHistory(device.id), [device.id]);
  if (intel === null || energy === null) return null;
  const totalKwh = energy.points.reduce((s, p) => s + p.kwh, 0);
  const totalCost = energy.points.reduce((s, p) => s + p.cost, 0);
  if (intel.length === 0 && totalKwh <= 0) return null;

  const entries: TimelineEntry[] = intel.map((h) => ({
    key: h.id,
    icon: "🤖",
    title: h.reason ?? h.action,
    meta: new Date(h.ts).toLocaleString(),
    tone: "good",
  }));

  return (
    <CollapsibleSection title="History">
      {totalKwh > 0 && (
        <div className="aureon-fact-tile" style={{ marginBottom: 14, alignItems: "center" }}>
          <span className="aureon-fact-ic" aria-hidden>⚡</span>
          <span className="aureon-fact-body" style={{ flex: 1 }}>
            <span className="aureon-facts-k">Energy, last {energy.points.length} day{energy.points.length === 1 ? "" : "s"}</span>
            <span className="aureon-facts-v">{totalKwh.toFixed(1)} kWh · {energy.currency}{totalCost.toFixed(2)}</span>
          </span>
          <EnergySparkline points={energy.points} />
        </div>
      )}
      <Timeline entries={entries} />
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

/** § Capability Refresh — reconnects to this device's owning driver and re-reads
 * whatever real capabilities it can genuinely re-discover (inputs, friendly names,
 * sound/zone lists, …), in place: never recreates the device, never touches its room
 * assignment, automations, or history — only `POST .../capabilities/refresh`, which
 * persists via the exact same `setCapabilityConfig` call commissioning itself uses.
 * Shown for any device with at least one already-populated capability config — the
 * real signal that SOME driver backs this device (`device.driverId` is a DIFFERENT,
 * Driver-Manager-install concept and stays `null` for the `bindProtocol()` native-
 * binding path every AVR/HEOS/Yamaha device actually commissions through — verified
 * live, not assumed, gating on it would have hidden this action for every one of
 * them). Harmless, honest "Nothing new found" for a protocol with no live capability
 * query (e.g. classic Denon/Marantz Telnet), never fabricated. */
function RefreshCapabilitiesAction({ device, onDeviceUpdated }: { device: Device; onDeviceUpdated?: (d: Device) => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    setResult(null);
    try {
      const res = await refreshDeviceCapabilities(device.id);
      if (res.device) onDeviceUpdated?.(res.device);
      setResult(res.refreshed ? "Capabilities refreshed." : "Reconnected — nothing new to report from this device's protocol.");
    } catch (e) {
      setResult(e instanceof Error ? e.message : "Could not refresh capabilities.");
    } finally {
      setBusy(false);
    }
  }

  const hasDriverBackedConfig = device.capabilities.some((c) => Object.keys(c.config ?? {}).length > 0);
  if (!hasDriverBackedConfig) return null;
  return (
    <div className="drv-actions">
      <button disabled={busy} aria-busy={busy} onClick={() => void refresh()}>Refresh Capabilities</button>
      {result && <p className="hint">{result}</p>}
    </div>
  );
}

export function AdvancedSettingsSection({
  device, onRemoved, onDeviceUpdated, children,
}: { device: Device; onRemoved?: () => void; onDeviceUpdated?: (d: Device) => void; children?: ReactNode }) {
  return (
    <CollapsibleSection title="Advanced Settings">
      {children}
      <RefreshCapabilitiesAction device={device} onDeviceUpdated={onDeviceUpdated} />
      <DeviceManageActions device={device} onRemoved={onRemoved} />
    </CollapsibleSection>
  );
}

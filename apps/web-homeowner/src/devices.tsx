import { useEffect, useMemo, useState } from "react";
import type { Device, DeviceId } from "@supreme/domain-model";
import { Button, DeviceFacts, StatusDot, type DeviceFactRow } from "@supreme/aureon-web";
import type { Tab } from "./App.js";
import { client, fetchDriverRegistry, type DriverEntry } from "./api.js";
import { PendingApproval } from "./pending.js";
import { FavHeart, useFavorites } from "./favorites.js";
import { EmptyState } from "./empty.js";
import { friendlyError } from "./errors.js";
import { mediaDeviceKind, mediaKindMeta } from "./features/media/capability-mapper.js";
import { securityLockKind, securityLockKindMeta } from "./features/security/capability-mapper.js";
import { energyDeviceKind, energyKindMeta, isEnergyDevice } from "./features/infrastructure/energy/capability-mapper.js";
import { useOpenDevice } from "./device-detail-router.js";

/**
 * Device Manager (§ Device Manager) — every device the home knows about, grouped by room, with the
 * real per-device data the platform actually has (manufacturer, model, driver, protocol, type,
 * capabilities, live state, room, scene usage) and the actions the backend supports today (rename,
 * move room, remove). Reuses the SDK's devices()/updateDevice()/deleteDevice() — no duplicate device
 * system. Fields with no backend source (firmware, signal, battery, IP/MAC) are omitted, not faked.
 * Fully responsive.
 */
type Room = { id: string; name: string };
/** The driver that backs a device + its protocol, resolved from the registry (never hardcoded). */
type DriverInfo = { name: string; protocol: string | null };

/** A homeowner-friendly name for what a device IS — never its type slug or capability kinds. */
export function friendlyType(d: Device): string {
  const t = d.supremeType.toLowerCase();
  const caps = d.capabilities.map((c) => c.kind);
  if (t.includes("dimmer") || (caps.includes("brightness"))) return caps.includes("color") ? "Colour light" : "Dimmable light";
  if (t.includes("light") || caps.includes("onoff") && !caps.includes("position")) {
    if (t.includes("light") || caps.length === 1) return "Light";
  }
  if (t.includes("thermostat") || caps.includes("temperature")) return "Climate";
  if (t.includes("cover") || caps.includes("position")) return "Blinds";
  if (t.includes("lock") || caps.includes("lock")) return securityLockKindMeta(securityLockKind(d)).label;
  if (t.includes("fan") || caps.includes("fan")) return "Fan";
  if (t.includes("vacuum") || caps.includes("vacuum")) return "Vacuum";
  if (t.includes("media") || caps.includes("media")) return mediaKindMeta(mediaDeviceKind(d)).label;
  if (isEnergyDevice(d)) return energyKindMeta(energyDeviceKind(d)).label;
  if (t.includes("sensor") || caps.includes("sensor")) return "Sensor";
  if (t.includes("camera")) return "Camera";
  if (caps.includes("onoff")) return "Switch";
  return "Device";
}

/** The Information rows for a device's expanded row (§ Design System — Information section).
 * Technical plumbing (driver / protocol / network) is for Installer & Developer mode only —
 * a homeowner never needs to see it (§ Homeowner Experience). */
function deviceFactRows({ device, devMode, driver, net, roomName, sceneCount }: {
  device: Device; devMode: boolean; driver: DriverInfo | null; net: { ip?: string; mac?: string } | undefined;
  roomName: string; sceneCount: number;
}): DeviceFactRow[] {
  const rows: DeviceFactRow[] = [{ label: "Type", value: devMode ? device.supremeType : friendlyType(device) }];
  if (device.manufacturer) rows.push({ label: "Manufacturer", value: device.manufacturer });
  if (device.model) rows.push({ label: "Model", value: device.model });
  if (devMode && driver) rows.push({ label: "Driver", value: driver.name });
  if (devMode && driver?.protocol) rows.push({ label: "Protocol", value: driver.protocol.toUpperCase() });
  if (devMode && net?.ip) rows.push({ label: "IP address", value: net.ip });
  if (devMode && net?.mac) rows.push({ label: "MAC", value: net.mac });
  rows.push({ label: "Room", value: roomName });
  rows.push({ label: "Status", value: `${device.status}${online(device) ? " · live" : ""}` });
  if (devMode) rows.push({ label: "Capabilities", value: device.capabilities.map((c) => c.kind).join(", ") });
  rows.push({ label: "In scenes", value: String(sceneCount) });
  return rows;
}

function online(d: Device): boolean {
  // A device is "online" when we hold live state for any capability.
  return d.state != null && Object.keys(d.state).length > 0;
}
function stateSummary(d: Device): string {
  const caps = d.capabilities.map((c) => c.kind);
  const s = d.state as Record<string, Record<string, unknown>> | undefined;
  if (!s) return "—";
  if (caps.includes("brightness")) { const b = s.brightness; return b?.on ? `On · ${Math.round(((b.level as number) ?? 0))}%` : "Off"; }
  if (caps.includes("onoff")) return (s.onoff?.on ? "On" : "Off");
  if (caps.includes("temperature")) return `${(s.temperature?.ambientC as number) ?? "—"}°`;
  if (caps.includes("position")) return `${(s.position?.position as number) ?? 0}%`;
  if (caps.includes("lock")) return s.lock?.locked ? "Locked" : "Unlocked";
  if (caps.includes("fan")) return s.fan?.on ? "On" : "Off";
  if (caps.includes("vacuum")) {
    const status = (s.vacuum?.status as string) ?? "idle";
    return status.length > 0 ? status[0]!.toUpperCase() + status.slice(1) : status;
  }
  if (caps.includes("sensor")) return `${(s.sensor?.value as number) ?? "—"} ${(s.sensor?.unit as string) ?? ""}`.trim();
  return online(d) ? "Online" : "—";
}

export function DeviceManager({ onNavigate, devMode = false }: { onNavigate?: (t: Tab) => void; devMode?: boolean }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [registry, setRegistry] = useState<DriverEntry[]>([]);
  const [sceneUse, setSceneUse] = useState<Record<string, number>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  // Bulk-edit selection (§ Device Platform).
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRoom, setBulkRoom] = useState("");
  const [busy, setBusy] = useState(false);
  const fav = useFavorites();
  const { refreshToken } = useOpenDevice();

  const toggleSelect = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function load() {
    const [devs, home, reg, scenes] = await Promise.all([
      client.devices(), client.home(), fetchDriverRegistry(), client.scenes(),
    ]);
    setDevices(devs.devices);
    setRooms(home.rooms.map((r) => ({ id: r.id, name: r.name })));
    setRegistry(reg);
    // Real scene-usage count per device: how many scenes drive it (§ Device Manager scene count).
    const use: Record<string, number> = {};
    for (const sc of scenes.scenes) {
      const ids = new Set((sc.steps ?? []).map((st) => st.deviceId));
      for (const id of ids) use[id] = (use[id] ?? 0) + 1;
    }
    setSceneUse(use);
  }
  useEffect(() => { void load(); }, [refreshToken]);

  // Resolve a device's driver → its display name + primary protocol, from the registry.
  const driverInfo = (driverId: string | null | undefined): DriverInfo | null => {
    if (!driverId) return null;
    const d = registry.find((r) => r.installedId === driverId || r.key === driverId);
    if (!d) return null;
    return { name: d.name, protocol: d.protocols[0] ?? null };
  };
  const roomName = (id: string | null | undefined) => rooms.find((r) => r.id === id)?.name ?? "Unassigned";
  const filtered = (devices ?? []).filter((d) => d.name.toLowerCase().includes(q.toLowerCase()));
  const byRoom = useMemo(() => {
    const m = new Map<string, Device[]>();
    for (const d of filtered) { const k = roomName(d.roomId); (m.get(k) ?? m.set(k, []).get(k)!).push(d); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, rooms]);

  const onlineCount = filtered.filter(online).length;

  async function applyBulk(action: "move" | "remove") {
    if (selected.size === 0) return;
    if (action === "remove" && !window.confirm(`Remove ${selected.size} device${selected.size === 1 ? "" : "s"}?`)) return;
    if (action === "move" && !bulkRoom) return;
    setBusy(true);
    try {
      await client.bulkDevices({ ids: [...selected], action, ...(action === "move" ? { roomId: bulkRoom } : {}) });
      setSelected(new Set()); setSelectMode(false); await load();
    } finally { setBusy(false); }
  }

  return (
    <div className="page">
      <div className="page-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 className="title">Devices</h1>
          <p className="sub">{devices ? `${filtered.length} devices · ${onlineCount} online` : "Loading…"}</p>
        </div>
        {(devices?.length ?? 0) > 0 && (
          <Button onClick={() => { setSelectMode((v) => !v); setSelected(new Set()); }}>{selectMode ? "Done" : "Select"}</Button>
        )}
      </div>
      <PendingApproval rooms={rooms} onChanged={load} />

      {selectMode && (
        <div className="bulk-bar">
          <span className="muted">{selected.size} selected</span>
          <Button onClick={() => setSelected(new Set(filtered.map((d) => d.id)))}>Select all</Button>
          <Button onClick={() => setSelected(new Set())}>Deselect all</Button>
          <select value={bulkRoom} onChange={(e) => setBulkRoom(e.target.value)}>
            <option value="">Move to room…</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <Button disabled={busy || selected.size === 0 || !bulkRoom} onClick={() => applyBulk("move")}>Move</Button>
          <Button variant="danger" disabled={busy || selected.size === 0} onClick={() => applyBulk("remove")}>Remove</Button>
        </div>
      )}

      <input className="search" placeholder="Search devices…" value={q} onChange={(e) => setQ(e.target.value)} />

      {byRoom.map(([room, list]) => (
        <div key={room} className="dev-group">
          <h2 className="section">{room} <span className="chip-n">{list.length}</span></h2>
          <div className="grid">
            {list.map((d) => (
              <DeviceRow key={d.id} device={d} rooms={rooms} expanded={open === d.id}
                onToggle={() => setOpen(open === d.id ? null : d.id)} onChanged={load} roomName={roomName}
                driver={driverInfo(d.driverId)} sceneCount={sceneUse[d.id] ?? 0}
                selectMode={selectMode} selected={selected.has(d.id)} onSelect={() => toggleSelect(d.id)}
                isFav={fav.isFav({ type: "device", deviceId: d.id })} onFav={() => fav.toggle({ type: "device", deviceId: d.id })}
                devMode={devMode} />
            ))}
          </div>
        </div>
      ))}
      {devices && filtered.length === 0 && (
        q
          ? <EmptyState icon="⌕" title={`No devices match “${q}”`} hint="Try a different name, or clear the search." />
          : <EmptyState icon="◎" title="No devices yet"
              hint="Supreme finds your lights, blinds, climate and more automatically — start a scan to bring your home online."
              action={onNavigate ? { label: "Discover Devices", onClick: () => onNavigate("discover") } : undefined} />
      )}
    </div>
  );
}

function DeviceRow({ device, rooms, expanded, onToggle, onChanged, roomName, driver, sceneCount, selectMode, selected, onSelect, isFav, onFav, devMode }: {
  device: Device; rooms: Room[]; expanded: boolean; onToggle: () => void; onChanged: () => void;
  roomName: (id: string | null | undefined) => string; driver: DriverInfo | null; sceneCount: number;
  selectMode: boolean; selected: boolean; onSelect: () => void; isFav: boolean; onFav: () => void;
  devMode: boolean;
}) {
  const [name, setName] = useState(device.name);
  const [roomId, setRoomId] = useState(device.roomId ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const isOnline = online(device);
  const { openDevice } = useOpenDevice();
  // Real network coordinates captured at discovery (present only for IP-bus devices).
  const net = (device.metadata as { network?: { ip?: string; mac?: string; host?: string } } | undefined)?.network;

  async function save() {
    setBusy(true); setErr(null); setMsg(null);
    try {
      await client.updateDevice(device.id as DeviceId, { name: name.trim(), roomId });
      setMsg("Saved."); onChanged();
    } catch (e) { setErr(friendlyError(e, "Couldn't save your changes. Please try again.")); } finally { setBusy(false); }
  }
  async function remove() {
    if (!window.confirm(`Remove ${device.name}? This also drops its bindings.`)) return;
    setBusy(true); setErr(null);
    try { await client.deleteDevice(device.id as DeviceId); onChanged(); }
    catch (e) { setErr(friendlyError(e, "Couldn't remove this device. Please try again.")); setBusy(false); }
  }
  async function clone() {
    setBusy(true); setErr(null);
    try { await client.cloneDevice(device.id as DeviceId); setMsg("Cloned."); onChanged(); }
    catch (e) { setErr(friendlyError(e, "Couldn't duplicate this device. Please try again.")); } finally { setBusy(false); }
  }

  return (
    <div className={`ext-card${expanded ? " open" : ""}${selected ? " selected" : ""}`}>
      <button className="ext-head" onClick={selectMode ? onSelect : onToggle}>
        {selectMode && <input type="checkbox" checked={selected} readOnly style={{ marginRight: 4 }} />}
        <StatusDot tone={isOnline ? "good" : "neutral"} label={isOnline ? "Online" : "Offline"} />
        <span className="ext-meta">
          <span className="ext-name">{device.name}</span>
          <span className="ext-sub">{friendlyType(device)}{devMode ? ` · ${device.supremeType} · ${device.capabilities.map((c) => c.kind).join(", ")}` : ""}</span>
        </span>
        <span className="drv-badge ok">{stateSummary(device)}</span>
        {!selectMode && <FavHeart fav={{ type: "device", deviceId: device.id }} active={isFav} onToggle={onFav} />}
      </button>
      {expanded && (
        <div className="drv-detail">
          <DeviceFacts rows={deviceFactRows({ device, devMode, driver, net, roomName: roomName(device.roomId), sceneCount })} />
          <label className="drv-field"><span className="lbl">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="drv-field"><span className="lbl">Room</span>
            <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <div className="drv-actions">
            <Button onClick={() => openDevice(device.id)}>Open controls</Button>
            <Button variant="primary" disabled={busy} onClick={save}>Save</Button>
            <Button disabled={busy} onClick={clone}>Clone</Button>
            <Button variant="danger" disabled={busy} onClick={remove}>Remove device</Button>
          </div>
          {msg && <p className="muted">{msg}</p>}
          {err && <p className="err">{err}</p>}
        </div>
      )}
    </div>
  );
}

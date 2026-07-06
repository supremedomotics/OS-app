import { useEffect, useMemo, useState } from "react";
import type { Device, DeviceId } from "@supreme/domain-model";
import { client, fetchDriverRegistry, type DriverEntry } from "./api.js";
import { PendingApproval } from "./pending.js";
import { FavHeart, useFavorites } from "./favorites.js";

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
  if (caps.includes("sensor")) return `${(s.sensor?.value as number) ?? "—"} ${(s.sensor?.unit as string) ?? ""}`.trim();
  return online(d) ? "Online" : "—";
}

export function DeviceManager() {
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
  useEffect(() => { void load(); }, []);

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
          <button onClick={() => { setSelectMode((v) => !v); setSelected(new Set()); }}>{selectMode ? "Done" : "Select"}</button>
        )}
      </div>
      <PendingApproval rooms={rooms} onChanged={load} />

      {selectMode && (
        <div className="bulk-bar">
          <span className="muted">{selected.size} selected</span>
          <select value={bulkRoom} onChange={(e) => setBulkRoom(e.target.value)}>
            <option value="">Move to room…</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <button disabled={busy || selected.size === 0 || !bulkRoom} onClick={() => applyBulk("move")}>Move</button>
          <button className="danger" disabled={busy || selected.size === 0} onClick={() => applyBulk("remove")}>Remove</button>
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
                isFav={fav.isFav({ type: "device", deviceId: d.id })} onFav={() => fav.toggle({ type: "device", deviceId: d.id })} />
            ))}
          </div>
        </div>
      ))}
      {devices && filtered.length === 0 && <p className="muted">No devices yet — use Discover Devices to add some.</p>}
    </div>
  );
}

function DeviceRow({ device, rooms, expanded, onToggle, onChanged, roomName, driver, sceneCount, selectMode, selected, onSelect, isFav, onFav }: {
  device: Device; rooms: Room[]; expanded: boolean; onToggle: () => void; onChanged: () => void;
  roomName: (id: string | null | undefined) => string; driver: DriverInfo | null; sceneCount: number;
  selectMode: boolean; selected: boolean; onSelect: () => void; isFav: boolean; onFav: () => void;
}) {
  const [name, setName] = useState(device.name);
  const [roomId, setRoomId] = useState(device.roomId ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const isOnline = online(device);
  // Real network coordinates captured at discovery (present only for IP-bus devices).
  const net = (device.metadata as { network?: { ip?: string; mac?: string; host?: string } } | undefined)?.network;

  async function save() {
    setBusy(true); setErr(null); setMsg(null);
    try {
      await client.updateDevice(device.id as DeviceId, { name: name.trim(), roomId });
      setMsg("Saved."); onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "Save failed."); } finally { setBusy(false); }
  }
  async function remove() {
    if (!window.confirm(`Remove ${device.name}? This also drops its bindings.`)) return;
    setBusy(true); setErr(null);
    try { await client.deleteDevice(device.id as DeviceId); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Remove failed."); setBusy(false); }
  }
  async function clone() {
    setBusy(true); setErr(null);
    try { await client.cloneDevice(device.id as DeviceId); setMsg("Cloned."); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Clone failed."); } finally { setBusy(false); }
  }

  return (
    <div className={`ext-card${expanded ? " open" : ""}${selected ? " selected" : ""}`}>
      <button className="ext-head" onClick={selectMode ? onSelect : onToggle}>
        {selectMode && <input type="checkbox" checked={selected} readOnly style={{ marginRight: 4 }} />}
        <span className={`dev-dot${isOnline ? " on" : ""}`} />
        <span className="ext-meta">
          <span className="ext-name">{device.name}</span>
          <span className="ext-sub">{device.supremeType} · {device.capabilities.map((c) => c.kind).join(", ")}</span>
        </span>
        <span className="drv-badge ok">{stateSummary(device)}</span>
        {!selectMode && <FavHeart fav={{ type: "device", deviceId: device.id }} active={isFav} onToggle={onFav} />}
      </button>
      {expanded && (
        <div className="drv-detail">
          <div className="dev-facts">
            <div><span className="k">Type</span><span className="v">{device.supremeType}</span></div>
            {device.manufacturer && <div><span className="k">Manufacturer</span><span className="v">{device.manufacturer}</span></div>}
            {device.model && <div><span className="k">Model</span><span className="v">{device.model}</span></div>}
            {driver && <div><span className="k">Driver</span><span className="v">{driver.name}</span></div>}
            {driver?.protocol && <div><span className="k">Protocol</span><span className="v">{driver.protocol.toUpperCase()}</span></div>}
            {net?.ip && <div><span className="k">IP address</span><span className="v">{net.ip}</span></div>}
            {net?.mac && <div><span className="k">MAC</span><span className="v">{net.mac}</span></div>}
            <div><span className="k">Room</span><span className="v">{roomName(device.roomId)}</span></div>
            <div><span className="k">Status</span><span className="v">{device.status}{isOnline ? " · live" : ""}</span></div>
            <div><span className="k">Capabilities</span><span className="v">{device.capabilities.map((c) => c.kind).join(", ")}</span></div>
            <div><span className="k">In scenes</span><span className="v">{sceneCount}</span></div>
          </div>
          <label className="drv-field"><span className="lbl">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="drv-field"><span className="lbl">Room</span>
            <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <div className="drv-actions">
            <button className="primary" disabled={busy} onClick={save}>Save</button>
            <button disabled={busy} onClick={clone}>Clone</button>
            <button className="danger" disabled={busy} onClick={remove}>Remove device</button>
          </div>
          {msg && <p className="muted">{msg}</p>}
          {err && <p className="err">{err}</p>}
        </div>
      )}
    </div>
  );
}

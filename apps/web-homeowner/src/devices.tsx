import { useEffect, useMemo, useState } from "react";
import type { Device, DeviceId } from "@supreme/domain-model";
import { client } from "./api.js";

/**
 * Device Manager (§ Device Manager) — every device the home knows about, grouped by room, with the
 * real per-device data the platform actually has (type, capabilities, live state, room) and the
 * actions the backend supports today (rename, move room, remove). Reuses the SDK's
 * devices()/updateDevice()/deleteDevice() — no duplicate device system. Fully responsive.
 */
type Room = { id: string; name: string };

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
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");

  async function load() {
    const [devs, home] = await Promise.all([client.devices(), client.home()]);
    setDevices(devs);
    setRooms(home.rooms.map((r) => ({ id: r.id, name: r.name })));
  }
  useEffect(() => { void load(); }, []);

  const roomName = (id: string | null | undefined) => rooms.find((r) => r.id === id)?.name ?? "Unassigned";
  const filtered = (devices ?? []).filter((d) => d.name.toLowerCase().includes(q.toLowerCase()));
  const byRoom = useMemo(() => {
    const m = new Map<string, Device[]>();
    for (const d of filtered) { const k = roomName(d.roomId); (m.get(k) ?? m.set(k, []).get(k)!).push(d); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, rooms]);

  const onlineCount = filtered.filter(online).length;

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="title">Devices</h1>
        <p className="sub">{devices ? `${filtered.length} devices · ${onlineCount} online` : "Loading…"}</p>
      </div>
      <input className="search" placeholder="Search devices…" value={q} onChange={(e) => setQ(e.target.value)} />

      {byRoom.map(([room, list]) => (
        <div key={room} className="dev-group">
          <h2 className="section">{room} <span className="chip-n">{list.length}</span></h2>
          <div className="grid">
            {list.map((d) => (
              <DeviceRow key={d.id} device={d} rooms={rooms} expanded={open === d.id}
                onToggle={() => setOpen(open === d.id ? null : d.id)} onChanged={load} roomName={roomName} />
            ))}
          </div>
        </div>
      ))}
      {devices && filtered.length === 0 && <p className="muted">No devices yet — use Discover Devices to add some.</p>}
    </div>
  );
}

function DeviceRow({ device, rooms, expanded, onToggle, onChanged, roomName }: {
  device: Device; rooms: Room[]; expanded: boolean; onToggle: () => void; onChanged: () => void; roomName: (id: string | null | undefined) => string;
}) {
  const [name, setName] = useState(device.name);
  const [roomId, setRoomId] = useState(device.roomId ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const isOnline = online(device);

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

  return (
    <div className={`ext-card${expanded ? " open" : ""}`}>
      <button className="ext-head" onClick={onToggle}>
        <span className={`dev-dot${isOnline ? " on" : ""}`} />
        <span className="ext-meta">
          <span className="ext-name">{device.name}</span>
          <span className="ext-sub">{device.supremeType} · {device.capabilities.map((c) => c.kind).join(", ")}</span>
        </span>
        <span className="drv-badge ok">{stateSummary(device)}</span>
      </button>
      {expanded && (
        <div className="drv-detail">
          <div className="dev-facts">
            <div><span className="k">Type</span><span className="v">{device.supremeType}</span></div>
            <div><span className="k">Room</span><span className="v">{roomName(device.roomId)}</span></div>
            <div><span className="k">Status</span><span className="v">{isOnline ? "Online" : "Unknown"}</span></div>
            <div><span className="k">Capabilities</span><span className="v">{device.capabilities.map((c) => c.kind).join(", ")}</span></div>
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
            <button className="danger" disabled={busy} onClick={remove}>Remove device</button>
          </div>
          {msg && <p className="muted">{msg}</p>}
          {err && <p className="err">{err}</p>}
        </div>
      )}
    </div>
  );
}

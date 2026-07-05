import { useEffect, useState } from "react";
import type { RoomId } from "@supreme/domain-model";
import { client } from "./api.js";
import type { Tab } from "./App.js";

/**
 * Areas (§ Navigation — device-centric). The home's spatial map: rooms grouped by their location
 * hierarchy — Building › Floor › Area — with live device counts. A homeowner thinks in places, never
 * protocols, so this is where the whole estate is organised. Location labels are editable inline,
 * which is the only surface that exposes the room-relocation capability (§ Discoverability — every
 * backend capability has a UI).
 */
type Room = { id: string; name: string; building: string | null; floor: number; area: string | null; areaType: string };

const AREA_TYPES = ["living", "bedroom", "kitchen", "bathroom", "office", "outdoor", "utility", "hallway", "other"];

export function AreasScreen({ onNavigate }: { onNavigate?: (t: Tab) => void }) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const [home, devs] = await Promise.all([client.home(), client.devices()]);
    setRooms(home.rooms.map((r) => ({ id: r.id, name: r.name, building: r.building ?? null, floor: r.floor ?? 0, area: r.area ?? null, areaType: r.areaType })));
    const c: Record<string, number> = {};
    for (const d of devs.devices) if (d.roomId) c[d.roomId] = (c[d.roomId] ?? 0) + 1;
    setCounts(c);
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  // Group by Building → Floor. Rooms with no building fall under a single "Home" section; floors sort
  // numerically. Within a floor, rooms are further tagged by Area.
  const buildings = new Map<string, Room[]>();
  for (const r of rooms) {
    const key = r.building ?? "Home";
    (buildings.get(key) ?? buildings.set(key, []).get(key)!).push(r);
  }
  const buildingNames = Array.from(buildings.keys()).sort((a, b) => (a === "Home" ? -1 : b === "Home" ? 1 : a.localeCompare(b)));

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="title">Areas</h1>
        <p className="sub">Your home organised by building, floor and area — where every device lives.</p>
      </div>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : rooms.length === 0 ? (
        <div className="empty">
          <p className="muted">No rooms yet. Discover a device to create your first room and area.</p>
          {onNavigate && <button className="primary" onClick={() => onNavigate("discover")}>Discover Devices</button>}
        </div>
      ) : (
        buildingNames.map((bName) => {
          const inBuilding = buildings.get(bName)!;
          const floors = Array.from(new Set(inBuilding.map((r) => r.floor))).sort((a, b) => a - b);
          const devCount = inBuilding.reduce((n, r) => n + (counts[r.id] ?? 0), 0);
          return (
            <section key={bName} className="area-building">
              <div className="area-bhead">
                <h2 className="area-bname">{bName}</h2>
                <span className="muted">{inBuilding.length} room{inBuilding.length === 1 ? "" : "s"} · {devCount} device{devCount === 1 ? "" : "s"}</span>
              </div>
              {floors.map((f) => {
                const onFloor = inBuilding.filter((r) => r.floor === f);
                return (
                  <div key={f} className="area-floor">
                    <div className="area-fhead">Floor {f}</div>
                    <div className="grid">
                      {onFloor.map((r) =>
                        editing === r.id ? (
                          <RoomLocationEditor
                            key={r.id}
                            room={r}
                            buildings={buildingNames.filter((n) => n !== "Home")}
                            areas={Array.from(new Set(rooms.map((x) => x.area).filter(Boolean))) as string[]}
                            onCancel={() => setEditing(null)}
                            onSaved={async () => { setEditing(null); await load(); }}
                          />
                        ) : (
                          <button key={r.id} className="area-room" onClick={() => setEditing(r.id)}>
                            <span className="area-rname">{r.name}</span>
                            <span className="area-rmeta">
                              {r.area && <span className="tag">{r.area}</span>}
                              <span className="tag soft">{r.areaType}</span>
                            </span>
                            <span className="area-rcount">{counts[r.id] ?? 0} device{(counts[r.id] ?? 0) === 1 ? "" : "s"}</span>
                          </button>
                        ),
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          );
        })
      )}
    </div>
  );
}

function RoomLocationEditor({
  room,
  buildings,
  areas,
  onCancel,
  onSaved,
}: {
  room: Room;
  buildings: string[];
  areas: string[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(room.name);
  const [building, setBuilding] = useState(room.building ?? "");
  const [floor, setFloor] = useState(String(room.floor));
  const [area, setArea] = useState(room.area ?? "");
  const [areaType, setAreaType] = useState(room.areaType);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true); setErr(null);
    try {
      await client.updateRoom(room.id as RoomId, {
        name: name.trim() || room.name,
        building: building.trim() || null,
        floor: Number.parseInt(floor, 10) || 0,
        area: area.trim() || null,
        areaType,
      });
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save.");
      setBusy(false);
    }
  }

  return (
    <div className="ext-card open area-editor">
      <div className="drv-detail">
        <label className="drv-field"><span className="lbl">Room</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="drv-field"><span className="lbl">Building</span>
          <input value={building} onChange={(e) => setBuilding(e.target.value)} placeholder="Main House (optional)" list={`ab-${room.id}`} />
          <datalist id={`ab-${room.id}`}>{buildings.map((b) => <option key={b} value={b} />)}</datalist>
        </label>
        <label className="drv-field"><span className="lbl">Floor</span>
          <input type="number" value={floor} onChange={(e) => setFloor(e.target.value)} />
        </label>
        <label className="drv-field"><span className="lbl">Area</span>
          <input value={area} onChange={(e) => setArea(e.target.value)} placeholder="e.g. East Wing (optional)" list={`aa-${room.id}`} />
          <datalist id={`aa-${room.id}`}>{areas.map((a) => <option key={a} value={a} />)}</datalist>
        </label>
        <label className="drv-field"><span className="lbl">Type</span>
          <select value={areaType} onChange={(e) => setAreaType(e.target.value)}>
            {AREA_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <div className="drv-actions">
          <button className="primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save location"}</button>
          <button disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
        {err && <p className="err">{err}</p>}
      </div>
    </div>
  );
}

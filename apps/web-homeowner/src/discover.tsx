import { useEffect, useState } from "react";
import type { RoomId } from "@supreme/domain-model";
import { client, fetchDriverRegistry, installDriverByKey, type DriverEntry } from "./api.js";

/**
 * Discover Devices (§ Automatic Device Discovery + § Unified Onboarding). One click scans every
 * supported technology at once — the protocol list is derived from the driver REGISTRY (never
 * hardcoded), so any current or future protocol driver is included automatically. Each found device
 * is matched to the extension that drives it; pairing installs that extension automatically (no
 * manual driver install first), then walks the installer through the location cascade —
 * Building › Floor › Room › Area › Name › Done — in one guided flow. The installer assigns a
 * *place*, never a protocol.
 */
type Discovered = { backendId: string; suggestedName: string; capabilities: string[]; source: string; protocol?: string; network?: { ip?: string; mac?: string; host?: string } };
type Room = { id: string; name: string; building: string | null; floor: number; area: string | null };

/** The extension that drives a given protocol, from registry metadata. */
function recommend(registry: DriverEntry[], protocol?: string): DriverEntry | undefined {
  if (!protocol) return undefined;
  return registry.find((d) => d.protocols.includes(protocol as never));
}

/** Human label for a room in the picker: "Kitchen · Main House · Floor 1 · East Wing". */
function roomLabel(r: Room): string {
  const parts = [r.name];
  if (r.building) parts.push(r.building);
  parts.push(`Floor ${r.floor}`);
  if (r.area) parts.push(r.area);
  return parts.join(" · ");
}

/**
 * Guess the room a discovered device belongs in from its own name (e.g. "Pantry DL-1" →
 * the "Pantry" room) instead of making the installer pick every single time. Still just a
 * default — the room picker stays fully editable, so a wrong or absent guess costs nothing.
 * Prefers the longest (most specific) matching room name, e.g. "Master Bedroom" over "Bedroom".
 */
function matchRoomByName(deviceName: string, rooms: Room[]): Room | undefined {
  const dn = deviceName.toLowerCase();
  const matches = rooms.filter((r) => r.name.trim().length > 0 && dn.includes(r.name.trim().toLowerCase()));
  return matches.sort((a, b) => b.name.length - a.name.length)[0];
}

export function DiscoverDevices() {
  const [registry, setRegistry] = useState<DriverEntry[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [phase, setPhase] = useState<"idle" | "scanning" | "results">("idle");
  const [found, setFound] = useState<Discovered[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadRooms = () =>
    client.home().then((h) =>
      setRooms(h.rooms.map((r) => ({ id: r.id, name: r.name, building: r.building ?? null, floor: r.floor ?? 0, area: r.area ?? null }))),
    );

  useEffect(() => {
    void fetchDriverRegistry().then(setRegistry);
    void loadRooms();
  }, []);

  // The technologies a scan covers — every protocol any registered driver declares.
  const protocols = Array.from(new Set(registry.flatMap((d) => d.protocols))).sort();
  const activeProtocols = new Set(registry.filter((d) => d.installed && d.enabled).flatMap((d) => d.protocols));

  async function scan() {
    setPhase("scanning");
    setError(null);
    try {
      const res = await client.discover();
      setFound(res.discovered as Discovered[]);
      setPhase("results");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed.");
      setPhase("idle");
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="title">Discover Devices</h1>
        <p className="sub">One tap scans every supported technology and pairs what it finds — no manual setup.</p>
      </div>

      {protocols.length > 0 && (
        <div className="disc-protos">
          {protocols.map((p) => (
            <span key={p} className={`tag proto${activeProtocols.has(p) ? " on" : ""}`}>{p.toUpperCase()}</span>
          ))}
        </div>
      )}

      {phase !== "results" && (
        <div className="disc-hero">
          <div className={`disc-radar${phase === "scanning" ? " spin" : ""}`}>◎</div>
          <button className="primary lg" disabled={phase === "scanning"} onClick={scan}>
            {phase === "scanning" ? "Scanning all technologies…" : "Discover Devices"}
          </button>
          {error && <p className="err">{error}</p>}
        </div>
      )}

      {phase === "results" && (
        <>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", margin: "6px 0 12px" }}>
            <span className="muted">{found.length} device{found.length === 1 ? "" : "s"} found</span>
            <button onClick={scan}>Rescan</button>
          </div>
          {found.length === 0 && <p className="muted">No new devices found. Ensure devices are powered and on the network, then rescan.</p>}
          <div className="grid">
            {found.map((d) => (
              <FoundDevice
                key={d.backendId}
                device={d}
                driver={recommend(registry, d.protocol)}
                rooms={rooms}
                onRoomCreated={loadRooms}
                onPaired={() => setFound((f) => f.filter((x) => x.backendId !== d.backendId))}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function FoundDevice({
  device,
  driver,
  rooms,
  onRoomCreated,
  onPaired,
}: {
  device: Discovered;
  driver?: DriverEntry;
  rooms: Room[];
  onRoomCreated: () => Promise<void>;
  onPaired: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(device.suggestedName);
  // Assign directly to the room its own name points at (e.g. "Pantry DL-1" → Pantry) instead of
  // defaulting to the first room in the list and making the installer pick every time — still
  // just a pre-selection, changeable below like any other field.
  const matchedRoom = matchRoomByName(device.suggestedName, rooms);
  // Location cascade. `mode` toggles between placing into an existing room and creating a new one
  // (Building → Floor → Room → Area) inline, so a device can be commissioned even in an empty home.
  const [mode, setMode] = useState<"existing" | "new">(rooms.length ? "existing" : "new");
  const [roomId, setRoomId] = useState(matchedRoom?.id ?? rooms[0]?.id ?? "");
  const [building, setBuilding] = useState(rooms[0]?.building ?? "");
  const [floor, setFloor] = useState(String(rooms[0]?.floor ?? 0));
  const [area, setArea] = useState("");
  const [roomName, setRoomName] = useState("");
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [placedIn, setPlacedIn] = useState("");

  async function pair() {
    setBusy(true); setErr(null);
    try {
      // 1) Resolve the target room — existing selection or a freshly-created one from the cascade.
      let targetRoomId = roomId;
      let placedLabel = rooms.find((r) => r.id === roomId)?.name ?? "";
      if (mode === "new") {
        if (!roomName.trim()) { setErr("Name the room."); setBusy(false); return; }
        setStep("Creating room…");
        const created = await client.createRoom({
          name: roomName.trim(),
          building: building.trim() || null,
          floor: Number.parseInt(floor, 10) || 0,
          area: area.trim() || null,
        });
        targetRoomId = created.room.id;
        placedLabel = created.room.name;
        await onRoomCreated();
      }
      if (!targetRoomId) { setErr("Pick or create a room."); setBusy(false); return; }

      // 2) Auto-install the required extension if it isn't installed yet — never a manual step.
      if (driver && !driver.installed) {
        setStep(`Installing ${driver.name}…`);
        await installDriverByKey(driver.key);
      }

      // 3) Commission the device into its place.
      setStep("Pairing device…");
      await client.commission({
        backendId: device.backendId,
        name: name.trim() || device.suggestedName,
        roomId: targetRoomId,
        capabilities: device.capabilities as never,
        ...(device.protocol ? { protocol: device.protocol } : {}),
        ...(device.network ? { network: device.network } : {}),
      });
      setStep("Ready");
      setPlacedIn(placedLabel);
      setDone(true);
      setTimeout(onPaired, 900);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Pairing failed.");
      setStep(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`ext-card disc-card${open ? " open" : ""}`}>
      <button className="ext-head" onClick={() => setOpen((v) => !v)}>
        <span className="ext-ic">📡</span>
        <span className="ext-meta">
          <span className="ext-name">{device.suggestedName}</span>
          <span className="ext-sub">
            {device.protocol ? device.protocol.toUpperCase() : device.source} · {device.capabilities.join(", ")}
            {device.network?.ip ? ` · ${device.network.ip}` : ""}
          </span>
          <span className="ext-tags">
            {driver ? <span className="tag ok">Extension: {driver.name}{driver.installed ? "" : " (auto-install)"}</span> : <span className="tag">No matching extension</span>}
          </span>
        </span>
        <span className="drv-badge ok">Found</span>
      </button>
      {open && (
        <div className="drv-detail">
          {done ? (
            <p className="muted">✓ {name} added to {placedIn}.</p>
          ) : (
            <>
              <label className="drv-field"><span className="lbl">Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder={device.suggestedName} />
              </label>

              {rooms.length > 0 && (
                <div className="seg">
                  <button className={mode === "existing" ? "on" : ""} onClick={() => setMode("existing")}>Existing room</button>
                  <button className={mode === "new" ? "on" : ""} onClick={() => setMode("new")}>New room</button>
                </div>
              )}

              {mode === "existing" ? (
                <label className="drv-field"><span className="lbl">Room</span>
                  <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
                    {rooms.map((r) => <option key={r.id} value={r.id}>{roomLabel(r)}</option>)}
                  </select>
                  {matchedRoom && matchedRoom.id === roomId && (
                    <span className="help">Matched from the device's name — change it above if that's wrong.</span>
                  )}
                </label>
              ) : (
                // The location cascade — Building › Floor › Room › Area. Building/Area are optional
                // labels; a single-building home simply leaves Building blank.
                <>
                  <label className="drv-field"><span className="lbl">Building</span>
                    <input value={building} onChange={(e) => setBuilding(e.target.value)} placeholder="Main House (optional)" list={`bld-${device.backendId}`} />
                    <datalist id={`bld-${device.backendId}`}>
                      {Array.from(new Set(rooms.map((r) => r.building).filter(Boolean))).map((b) => <option key={b} value={b as string} />)}
                    </datalist>
                  </label>
                  <label className="drv-field"><span className="lbl">Floor</span>
                    <input type="number" value={floor} onChange={(e) => setFloor(e.target.value)} />
                  </label>
                  <label className="drv-field"><span className="lbl">Room</span>
                    <input value={roomName} onChange={(e) => setRoomName(e.target.value)} placeholder="e.g. Primary Bedroom" />
                  </label>
                  <label className="drv-field"><span className="lbl">Area</span>
                    <input value={area} onChange={(e) => setArea(e.target.value)} placeholder="e.g. East Wing (optional)" list={`area-${device.backendId}`} />
                    <datalist id={`area-${device.backendId}`}>
                      {Array.from(new Set(rooms.map((r) => r.area).filter(Boolean))).map((a) => <option key={a} value={a as string} />)}
                    </datalist>
                  </label>
                </>
              )}

              <div className="drv-actions">
                <button className="primary" disabled={busy} onClick={pair}>{busy ? (step ?? "Pairing…") : "Pair device"}</button>
                <button disabled={busy} onClick={onPaired}>Ignore</button>
              </div>
              {step && !err && <p className="muted">{step}</p>}
              {err && <p className="err">{err}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Kept for type reuse elsewhere.
export type { Room, RoomId };

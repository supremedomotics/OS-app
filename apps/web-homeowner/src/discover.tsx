import { useEffect, useState } from "react";
import type { RoomId } from "@supreme/domain-model";
import { client, fetchDriverRegistry, installDriverByKey, type DriverEntry } from "./api.js";

/**
 * Discover Devices (§ Automatic Device Discovery). One click scans every supported technology at
 * once — the protocol list is derived from the driver REGISTRY (never hardcoded), so any current or
 * future protocol driver is included automatically. Each found device is matched to the extension
 * that drives it; pairing installs that extension automatically (no manual driver install first),
 * then walks the installer through room assignment + naming in one guided flow.
 */
type Discovered = { backendId: string; suggestedName: string; capabilities: string[]; source: string; protocol?: string };
type Room = { id: string; name: string };

/** The extension that drives a given protocol, from registry metadata. */
function recommend(registry: DriverEntry[], protocol?: string): DriverEntry | undefined {
  if (!protocol) return undefined;
  return registry.find((d) => d.protocols.includes(protocol as never));
}

export function DiscoverDevices() {
  const [registry, setRegistry] = useState<DriverEntry[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [phase, setPhase] = useState<"idle" | "scanning" | "results">("idle");
  const [found, setFound] = useState<Discovered[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchDriverRegistry().then(setRegistry);
    void client.home().then((h) => setRooms(h.rooms.map((r) => ({ id: r.id, name: r.name }))));
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
                onPaired={() => setFound((f) => f.filter((x) => x.backendId !== d.backendId))}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function FoundDevice({ device, driver, rooms, onPaired }: { device: Discovered; driver?: DriverEntry; rooms: Room[]; onPaired: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(device.suggestedName);
  const [roomId, setRoomId] = useState(rooms[0]?.id ?? "");
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function pair() {
    if (!roomId) { setErr("Pick a room."); return; }
    setBusy(true); setErr(null);
    try {
      // Auto-install the required extension if it isn't installed yet.
      if (driver && !driver.installed) {
        setStep(`Installing ${driver.name}…`);
        await installDriverByKey(driver.key);
      }
      setStep("Pairing device…");
      await client.commission({
        backendId: device.backendId,
        name: name.trim() || device.suggestedName,
        roomId,
        capabilities: device.capabilities as never,
        ...(device.protocol ? { protocol: device.protocol } : {}),
      });
      setStep("Ready");
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
            <p className="muted">✓ {name} added to {rooms.find((r) => r.id === roomId)?.name}.</p>
          ) : (
            <>
              <label className="drv-field"><span className="lbl">Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="drv-field"><span className="lbl">Room</span>
                <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
                  {rooms.length === 0 && <option value="">Create a room first</option>}
                  {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>
              <div className="drv-actions">
                <button className="primary" disabled={busy || rooms.length === 0} onClick={pair}>{busy ? (step ?? "Pairing…") : "Pair device"}</button>
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

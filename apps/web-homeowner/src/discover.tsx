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

/**
 * Protocols whose devices are added one at a time by IP address rather than found by a
 * broadcast scan — either because the technology has no discovery protocol at all (AVR/HEOS/
 * Yamaha are Telnet/CLI/HTTP-only), or because a scan can't reach it (SSDP/mDNS don't cross
 * the hub's network boundary on every deployment). Manual entry uses the exact same
 * commission-with-protocol-binding call a scan hit would, so it's a first-class path, not a
 * fallback. KNX/Modbus/MQTT devices are usually better added via the ETS import / Bus Binding
 * power-user tools, but a single manual bind works the same way here too.
 */
const MANUAL_PROTOCOLS = ["avr", "heos", "yamaha", "knx", "modbus", "mqtt"] as const;
const MANUAL_ADDRESS_HINT: Record<(typeof MANUAL_PROTOCOLS)[number], string> = {
  avr: "Receiver IP e.g. 192.168.1.50 (Telnet, port 23)",
  heos: "Any one HEOS player's IP e.g. 192.168.1.51 (port 1255)",
  yamaha: "Unit IP e.g. 192.168.1.52 (HTTP, port 80)",
  knx: "Group address e.g. 1/2/0",
  modbus: "Register e.g. 100",
  mqtt: "Base topic e.g. z2m/lamp",
};
// AVR/Yamaha zones default to "main" if omitted; HEOS's player id (pid) is required — get it
// from the HEOS app's "About This Device" screen for that player.
const MANUAL_CONFIG_HINT: Record<(typeof MANUAL_PROTOCOLS)[number], string | null> = {
  avr: '{"zone":"main"}',
  heos: '{"pid":"<player id>"}',
  yamaha: '{"zone":"main"}',
  knx: null,
  modbus: '{"type":"holding","scale":0.1,"unit":"kWh","measure":"energy"}',
  mqtt: '{"field":"temperature","unit":"°C","measure":"temperature"}',
};

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

      <ManualAddDevice registry={registry} rooms={rooms} onRoomCreated={loadRooms} />

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

/**
 * "Add device manually" (§ Automatic Device Discovery — the manual counterpart): for a device
 * whose technology can't be broadcast-scanned (AVR/HEOS/Yamaha are Telnet/CLI/HTTP-only) or
 * that a scan simply didn't reach, the installer types in the protocol + address themselves.
 * Uses the exact same commission-with-protocol-binding call a scan hit's "Pair device" button
 * does — this is the *answer* to "where do I enter the IP and pick a room", not a separate
 * lesser tool.
 */
function ManualAddDevice({ registry, rooms, onRoomCreated }: { registry: DriverEntry[]; rooms: Room[]; onRoomCreated: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [protocol, setProtocol] = useState<(typeof MANUAL_PROTOCOLS)[number]>("avr");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [configText, setConfigText] = useState("");
  const [mode, setMode] = useState<"existing" | "new">(rooms.length ? "existing" : "new");
  const [roomId, setRoomId] = useState(rooms[0]?.id ?? "");
  const [building, setBuilding] = useState("");
  const [floor, setFloor] = useState("0");
  const [area, setArea] = useState("");
  const [roomName, setRoomName] = useState("");
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const driver = registry.find((d) => d.protocols.includes(protocol as never));
  const capabilities = driver?.capabilities ?? [];

  function reset() {
    setName("");
    setAddress("");
    setConfigText("");
    setDone(false);
    setStep(null);
    setErr(null);
  }

  async function submit() {
    setErr(null);
    if (!address.trim()) { setErr("Enter the device's address."); return; }
    if (capabilities.length === 0) { setErr(`No installed extension declares capabilities for ${protocol.toUpperCase()} yet.`); return; }
    setBusy(true);
    try {
      let targetRoomId = roomId;
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
        await onRoomCreated();
      }
      if (!targetRoomId) { setErr("Pick or create a room."); setBusy(false); return; }

      if (driver && !driver.installed) {
        setStep(`Installing ${driver.name}…`);
        await installDriverByKey(driver.key);
      }

      let config: Record<string, unknown> | undefined;
      if (configText.trim()) {
        try { config = JSON.parse(configText) as Record<string, unknown>; }
        catch { setErr("Config must be valid JSON."); setBusy(false); return; }
      }

      setStep("Adding device…");
      await client.commission({
        backendId: `manual:${protocol}:${address.trim()}`,
        name: name.trim() || `${driver?.name ?? protocol.toUpperCase()} — ${address.trim()}`,
        roomId: targetRoomId,
        capabilities: capabilities as never,
        protocol,
        address: address.trim(),
        ...(config ? { config } : {}),
      });
      setDone(true);
      setStep(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Adding the device failed.");
      setStep(null);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <p className="muted" style={{ margin: "16px 0" }}>
        Can't find your device? <button className="link" onClick={() => setOpen(true)}>Add it manually by IP address</button>.
      </p>
    );
  }

  return (
    <div className="ext-card disc-card open" style={{ margin: "16px 0" }}>
      <div className="drv-detail">
        <h3 style={{ marginTop: 0 }}>Add device manually</h3>
        <p className="muted">
          For devices with no broadcast discovery (AVR/HEOS/Yamaha receivers) — or a scan that
          hasn't reached them yet — enter the protocol and address directly.
        </p>

        {done ? (
          <>
            <p className="muted">✓ Device added.</p>
            <button onClick={() => { reset(); }}>Add another</button>
          </>
        ) : (
          <>
            <label className="drv-field"><span className="lbl">Protocol</span>
              <select value={protocol} onChange={(e) => setProtocol(e.target.value as (typeof MANUAL_PROTOCOLS)[number])}>
                {MANUAL_PROTOCOLS.map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}
              </select>
              {!driver && <span className="help">No installed extension covers {protocol.toUpperCase()} yet — install it from the Extension Center first.</span>}
              {driver && capabilities.length > 0 && <span className="help">Will add with capabilities: {capabilities.join(", ")}</span>}
            </label>

            <label className="drv-field"><span className="lbl">Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={driver ? `${driver.name} — ${address || "…"}` : "Device name"} />
            </label>

            <label className="drv-field"><span className="lbl">Address</span>
              <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={MANUAL_ADDRESS_HINT[protocol]} />
            </label>

            {MANUAL_CONFIG_HINT[protocol] && (
              <label className="drv-field"><span className="lbl">Config (optional)</span>
                <input value={configText} onChange={(e) => setConfigText(e.target.value)} placeholder={`e.g. ${MANUAL_CONFIG_HINT[protocol]}`} />
              </label>
            )}

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
              </label>
            ) : (
              <>
                <label className="drv-field"><span className="lbl">Building</span>
                  <input value={building} onChange={(e) => setBuilding(e.target.value)} placeholder="Main House (optional)" />
                </label>
                <label className="drv-field"><span className="lbl">Floor</span>
                  <input type="number" value={floor} onChange={(e) => setFloor(e.target.value)} />
                </label>
                <label className="drv-field"><span className="lbl">Room</span>
                  <input value={roomName} onChange={(e) => setRoomName(e.target.value)} placeholder="e.g. Media Room" />
                </label>
                <label className="drv-field"><span className="lbl">Area</span>
                  <input value={area} onChange={(e) => setArea(e.target.value)} placeholder="e.g. East Wing (optional)" />
                </label>
              </>
            )}

            <div className="drv-actions">
              <button className="primary" disabled={busy} onClick={submit}>{busy ? (step ?? "Adding…") : "Add device"}</button>
              <button disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
            </div>
            {err && <p className="err">{err}</p>}
          </>
        )}
      </div>
    </div>
  );
}

// Kept for type reuse elsewhere.
export type { Room, RoomId };

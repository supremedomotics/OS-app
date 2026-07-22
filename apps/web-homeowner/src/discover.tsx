import { useEffect, useRef, useState } from "react";
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
type Discovered = { backendId: string; suggestedName: string; capabilities: string[]; source: string; protocol?: string; network?: { ip?: string; mac?: string; host?: string }; roomHint?: string | null; driverName?: string | null; capabilityConfig?: Record<string, Record<string, unknown>> };
type Room = { id: string; name: string; building: string | null; floor: number; area: string | null };
type DriverStatus = "pending" | "scanning" | "complete" | "failed" | "not_selected";
type DriverResult = { protocol: string; driverName: string; status: "complete" | "failed"; count: number; error?: string };

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

/** Matches the gateway's `normalizeRoomName` (§ Universal Room Intelligence) — strips
 * punctuation/whitespace so "R&D"/"r&d"/"R & D" compare equal without merging genuinely
 * different room names. */
function normalizeRoomName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** The driver's own reported room (a Casambi Group, an ETS Function/Space, …) is a far
 * more reliable signal than guessing from the device's name — prefer it, matched against
 * existing rooms the SAME way the backend's resolveOrCreateRoom does, before falling back
 * to the name-substring heuristic. */
function matchRoom(device: Discovered, rooms: Room[]): Room | undefined {
  if (device.roomHint) {
    const target = normalizeRoomName(device.roomHint);
    const hinted = rooms.find((r) => normalizeRoomName(r.name) === target);
    if (hinted) return hinted;
  }
  return matchRoomByName(device.suggestedName, rooms);
}

export function DiscoverDevices() {
  const [registry, setRegistry] = useState<DriverEntry[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [phase, setPhase] = useState<"idle" | "scanning" | "results">("idle");
  const [found, setFound] = useState<Discovered[]>([]);
  const [driverResults, setDriverResults] = useState<DriverResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Installed Driver Selector (§ Priority 4 Part 2) — which installed drivers actually
  // execute on the next scan. Selection state, not a result filter: it never touches `found`.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  const loadRooms = () =>
    client
      .home()
      .then((h) =>
        setRooms(h.rooms.map((r) => ({ id: r.id, name: r.name, building: r.building ?? null, floor: r.floor ?? 0, area: r.area ?? null }))),
      )
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load rooms."));

  useEffect(() => {
    void fetchDriverRegistry().then((reg) => {
      setRegistry(reg);
      // Select All by default — a scan with nobody in the selector yet would silently
      // find nothing, which reads as "discovery is broken," not "nothing is selected."
      setSelectedIds(new Set(discoverableDrivers(reg).map((d) => d.installedId as string)));
    });
    void loadRooms();
  }, []);

  // The technologies a scan actually covers — only an INSTALLED+enabled driver with a real
  // installedId can be selected/executed. Uninstalled drivers never appear here at all
  // (Extension Center's installed-driver state is the only source of truth — no second registry).
  const drivers = discoverableDrivers(registry);

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function scan() {
    setPhase("scanning");
    setError(null);
    // New-scan reset (§ Discovery Device List Reset): clear the previous temporary result
    // list and per-driver status BEFORE the new scan populates them — never leaves stale
    // results from a differently-selected previous scan on screen while the new one runs.
    setFound([]);
    setDriverResults([]);
    setSourceFilter("all");
    try {
      const res = await client.discover(undefined, Array.from(selectedIds));
      setFound(res.discovered as Discovered[]);
      setDriverResults((res.driverResults ?? []) as DriverResult[]);
      setPhase("results");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed.");
      setPhase("idle");
    }
  }

  // Post-scan Source Filter (§ Priority 4): a display filter over the CURRENT result set —
  // separate from the pre-scan Driver Selector above, which controls execution, not display.
  const sourceCounts = new Map<string, number>();
  for (const d of found) sourceCounts.set(d.driverName ?? d.protocol ?? d.source, (sourceCounts.get(d.driverName ?? d.protocol ?? d.source) ?? 0) + 1);
  const visible = sourceFilter === "all" ? found : found.filter((d) => (d.driverName ?? d.protocol ?? d.source) === sourceFilter);

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="title">Discover Devices</h1>
        <p className="sub">Pick which extensions to scan with, then find and pair what they see — no manual setup.</p>
      </div>

      <DriverSelector drivers={drivers} selectedIds={selectedIds} onToggle={toggle} onSetAll={setSelectedIds} disabled={phase === "scanning"} />

      {phase !== "results" && (
        <div className="disc-hero">
          <div className={`disc-radar${phase === "scanning" ? " spin" : ""}`}>◎</div>
          <button className="primary lg" disabled={phase === "scanning" || selectedIds.size === 0} onClick={scan}>
            {phase === "scanning" ? "Scanning selected extensions…" : "Discover Devices"}
          </button>
          {selectedIds.size === 0 && <p className="muted">Select at least one extension above to scan.</p>}
          {error && <p className="err">{error}</p>}
        </div>
      )}

      {phase === "scanning" && <DriverStatusList drivers={drivers} selectedIds={selectedIds} results={driverResults} scanning />}
      {phase === "results" && <DriverStatusList drivers={drivers} selectedIds={selectedIds} results={driverResults} scanning={false} />}

      <ManualAddDevice registry={registry} rooms={rooms} onRoomCreated={loadRooms} />

      {phase === "results" && (
        <>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", margin: "6px 0 12px", flexWrap: "wrap", gap: 8 }}>
            <SourceFilterChips counts={sourceCounts} total={found.length} active={sourceFilter} onSelect={setSourceFilter} />
            <button onClick={scan}>Rescan</button>
          </div>
          {found.length === 0 && <p className="muted">No new devices found. Ensure devices are powered and on the network, then rescan.</p>}
          <div className="grid">
            {visible.map((d) => (
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

/** Installed, enabled drivers with a real installedId — the only ones selectable for discovery. */
function discoverableDrivers(registry: DriverEntry[]): DriverEntry[] {
  return registry.filter((d) => d.installed && d.enabled && d.installedId && d.protocols.length > 0);
}

function DriverSelector({
  drivers,
  selectedIds,
  onToggle,
  onSetAll,
  disabled,
}: {
  drivers: DriverEntry[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onSetAll: (ids: Set<string>) => void;
  disabled: boolean;
}) {
  if (drivers.length === 0) {
    return <p className="muted" style={{ margin: "16px 0" }}>No extensions installed yet — install one from the Extension Center to discover devices.</p>;
  }
  const allSelected = drivers.every((d) => selectedIds.has(d.installedId as string));
  return (
    <div className="disc-selector">
      <div className="disc-selector-head">
        <span className="lbl">Discover using</span>
        <div className="disc-selector-actions">
          <button className="link" disabled={disabled || allSelected} onClick={() => onSetAll(new Set(drivers.map((d) => d.installedId as string)))}>Select All</button>
          <button className="link" disabled={disabled || selectedIds.size === 0} onClick={() => onSetAll(new Set())}>Deselect All</button>
        </div>
      </div>
      <div className="disc-selector-grid">
        {drivers.map((d) => {
          const id = d.installedId as string;
          const checked = selectedIds.has(id);
          return (
            <label key={id} className={`disc-driver-chip${checked ? " on" : ""}`}>
              <input type="checkbox" checked={checked} disabled={disabled} onChange={() => onToggle(id)} />
              <span>{d.name}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<DriverStatus, string> = {
  pending: "Pending",
  scanning: "Scanning…",
  complete: "Complete",
  failed: "Failed",
  not_selected: "Not selected",
};

/**
 * Truthful per-driver status (§ Per-Driver Discovery Status). The backend returns results only
 * after the whole scan finishes — it does not stream progress — so "Scanning…" is shown for every
 * selected driver for the scan's duration rather than faking incremental live progress, and the
 * real Pending/Complete/Failed breakdown replaces it the instant the real response lands.
 */
function DriverStatusList({
  drivers,
  selectedIds,
  results,
  scanning,
}: {
  drivers: DriverEntry[];
  selectedIds: Set<string>;
  results: DriverResult[];
  scanning: boolean;
}) {
  if (drivers.length === 0) return null;
  const byProtocol = new Map(results.map((r) => [r.protocol, r]));
  return (
    <div className="disc-status-list">
      {drivers.map((d) => {
        const id = d.installedId as string;
        const selected = selectedIds.has(id);
        const result = d.protocols.map((p) => byProtocol.get(p)).find(Boolean);
        const status: DriverStatus = !selected ? "not_selected" : scanning ? "scanning" : result ? result.status : "pending";
        return (
          <div key={id} className={`disc-status-row status-${status}`}>
            <span className="disc-status-name">{d.name}</span>
            <span className="disc-status-value">
              {STATUS_LABEL[status]}
              {status === "complete" && result ? ` · ${result.count} device${result.count === 1 ? "" : "s"}` : ""}
              {status === "failed" && result?.error ? ` · ${result.error}` : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Post-scan Source Filter — separate concept from the pre-scan Driver Selector above: this
 * only changes which already-found devices are displayed, never which drivers execute. */
function SourceFilterChips({ counts, total, active, onSelect }: { counts: Map<string, number>; total: number; active: string; onSelect: (s: string) => void }) {
  if (total === 0) return <span className="muted">0 devices found</span>;
  const sources = Array.from(counts.keys()).sort();
  return (
    <div className="disc-source-filter">
      <button className={`tag proto${active === "all" ? " on" : ""}`} onClick={() => onSelect("all")}>All · {total}</button>
      {sources.map((s) => (
        <button key={s} className={`tag proto${active === s ? " on" : ""}`} onClick={() => onSelect(s)}>{s} · {counts.get(s)}</button>
      ))}
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
  // Assign directly to the room the driver itself reported (a Casambi Group, an ETS
  // Function/Space, …) or, failing that, the room its own name points at (e.g. "Pantry
  // DL-1" → Pantry) — never defaulting to "pick a room" when a reliable signal exists
  // (§ Universal Room Intelligence). Still just a pre-selection, changeable below.
  const matchedRoom = matchRoom(device, rooms);
  // A reliable room hint with NO existing SupremeOS match means "create this room
  // automatically," not "make the installer figure it out" — pre-fill the existing
  // create-room cascade rather than forcing a blank picker.
  const needsNewRoom = !matchedRoom && Boolean(device.roomHint);
  // Location cascade. `mode` toggles between placing into an existing room and creating a new one
  // (Building → Floor → Room → Area) inline, so a device can be commissioned even in an empty home.
  const [mode, setMode] = useState<"existing" | "new">(needsNewRoom ? "new" : rooms.length ? "existing" : "new");
  const [roomId, setRoomId] = useState(matchedRoom?.id ?? (needsNewRoom ? "" : rooms[0]?.id ?? ""));
  const [building, setBuilding] = useState(rooms[0]?.building ?? "");
  const [floor, setFloor] = useState(String(rooms[0]?.floor ?? 0));
  const [area, setArea] = useState("");
  const [roomName, setRoomName] = useState(needsNewRoom ? (device.roomHint ?? "") : "");
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [placedIn, setPlacedIn] = useState("");
  // `rooms` loads asynchronously and can go from empty to populated after this card has already
  // mounted — the useState() initializers above only run once, so without this sync the <select>
  // visually falls back to showing the first room (a bare browser default for a value that no
  // longer matches any <option>) while `roomId` state silently stays "", and "Add device" fails
  // with "Pick or create a room." even though a room is clearly shown as selected.
  const touchedRoom = useRef(false);
  useEffect(() => {
    if (touchedRoom.current || rooms.length === 0 || roomId || needsNewRoom) return;
    setMode("existing");
    setRoomId(matchedRoom?.id ?? rooms[0]!.id);
  }, [rooms, roomId, matchedRoom, needsNewRoom]);

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
        // § ADR 0017/0018 Capability Normalization — carry the driver's own structural
        // capability config through manual pairing too, so it produces the identical
        // persisted device the auto-commit fast path would have.
        ...(device.capabilityConfig ? { capabilityConfig: device.capabilityConfig } : {}),
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
            {device.driverName ?? (device.protocol ? device.protocol.toUpperCase() : device.source)} · {device.capabilities.join(", ")}
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
                  <button className={mode === "existing" ? "on" : ""} onClick={() => { touchedRoom.current = true; setMode("existing"); }}>Existing room</button>
                  <button className={mode === "new" ? "on" : ""} onClick={() => { touchedRoom.current = true; setMode("new"); }}>New room</button>
                </div>
              )}

              {mode === "existing" ? (
                <label className="drv-field"><span className="lbl">Room</span>
                  <select value={roomId} onChange={(e) => { touchedRoom.current = true; setRoomId(e.target.value); }}>
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
  // Same async-rooms-load race as FoundDevice above: without this, opening this form before the
  // room list has finished loading leaves mode="new"/roomId="" stuck forever even once rooms
  // arrive, while the <select> visually (but not in state) shows the first room selected.
  const touchedRoom = useRef(false);
  useEffect(() => {
    if (touchedRoom.current || rooms.length === 0 || roomId) return;
    setMode("existing");
    setRoomId(rooms[0]!.id);
  }, [rooms, roomId]);

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
                <button className={mode === "existing" ? "on" : ""} onClick={() => { touchedRoom.current = true; setMode("existing"); }}>Existing room</button>
                <button className={mode === "new" ? "on" : ""} onClick={() => { touchedRoom.current = true; setMode("new"); }}>New room</button>
              </div>
            )}

            {mode === "existing" ? (
              <label className="drv-field"><span className="lbl">Room</span>
                <select value={roomId} onChange={(e) => { touchedRoom.current = true; setRoomId(e.target.value); }}>
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

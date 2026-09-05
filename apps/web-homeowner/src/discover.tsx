import { useEffect, useRef, useState } from "react";
import type { RoomId } from "@supreme/domain-model";
import { Icon, ProgressBar, SegmentedControl, type ShadingKind } from "@supreme/aureon-web";
import {
  type CasambiGroupPairResult,
  type CasambiGroupView,
  client,
  fetchDriverRegistry,
  installDriverByKey,
  listCasambiGroups,
  pairCasambiGroup,
  type DriverEntry,
} from "./api.js";

/**
 * Discover Devices (§ Automatic Device Discovery + § Unified Onboarding). One click scans every
 * supported technology at once — the protocol list is derived from the driver REGISTRY (never
 * hardcoded), so any current or future protocol driver is included automatically. Each found device
 * is matched to the extension that drives it; pairing installs that extension automatically (no
 * manual driver install first), then walks the installer through the location cascade —
 * Building › Floor › Room › Area › Name › Done — in one guided flow. The installer assigns a
 * *place*, never a protocol.
 */
type Discovered = {
  backendId: string;
  suggestedName: string;
  capabilities: string[];
  source: string;
  protocol?: string;
  network?: { ip?: string; mac?: string; host?: string };
  roomHint?: string | null;
  driverName?: string | null;
  capabilityConfig?: Record<string, Record<string, unknown>>;
  /** Extra logical zones this one physical unit exposes (§ Discover Devices enrichment) —
   * a real wire query (Yamaha's getFeatures), never present for a protocol that can't
   * report it (e.g. AVR's Telnet-only discover()). */
  zones?: { id: string; label: string }[];
  /** A real, wire-reported brand string (e.g. Yamaha's UPnP `<manufacturer>`) — absent,
   * never guessed, for sources that don't report one. */
  manufacturer?: string;
  bindConfig?: Record<string, unknown>;
  /** § Casambi Local Gateway — Cloud device discovery: known only from the Cloud API, not yet
   * confirmed by a real local signal (e.g. Casambi Local mode's first UDP packet). */
  awaitingLocalSignal?: boolean;
};
/** Source-filter value for the Groups chip. Deliberately not a real source name — groups are a
 * different kind of result, and a driver could legitimately be called "Groups". */
const GROUPS_FILTER = "__groups__";

type Room = { id: string; name: string; building: string | null; floor: number; area: string | null };
type DriverStatus = "pending" | "scanning" | "complete" | "failed" | "not_selected";
type DriverResult = { protocol: string; driverName: string; status: "complete" | "failed"; count: number; error?: string };
/** A real, targeted reachability + best-effort zone probe result (§ AVR Intelligent Manual
 * Add) — `zones` is only populated when `reachable`. `detected` is authoritative for Yamaha
 * (a genuine `/system/getFeatures` wire query) but only a best-effort heuristic for AVR
 * (Denon/Marantz Telnet has no capability-query command) — the wizard never treats either as
 * more certain than it really is; both stay editable. */
type AvrProbeZone = { id: string; label: string; detected: boolean };
type AvrProbeResult = { reachable: boolean; error: string | null; mac: string | null; zones: AvrProbeZone[] };

/** The two AV receiver brands with a real protocol adapter in this fleet today. Every other
 * brand named in the picker (Onkyo/Pioneer/Sony/Arcam/Anthem/NAD) has zero protocol
 * implementation anywhere in this codebase — building "support" for them without a real,
 * verified wire protocol behind it would mean fabricating a control surface that doesn't
 * work, so they're listed but disabled, never silently attempted. */
const AV_RECEIVER_BRANDS = [
  { id: "auto", label: "Auto Detect (Recommended)", protocol: null as "avr" | "yamaha" | null },
  { id: "denon", label: "Denon", protocol: "avr" as const },
  { id: "marantz", label: "Marantz", protocol: "avr" as const },
  { id: "yamaha", label: "Yamaha", protocol: "yamaha" as const },
  { id: "onkyo", label: "Onkyo", protocol: null },
  { id: "pioneer", label: "Pioneer", protocol: null },
  { id: "sony", label: "Sony", protocol: null },
  { id: "arcam", label: "Arcam", protocol: null },
  { id: "anthem", label: "Anthem", protocol: null },
  { id: "nad", label: "NAD", protocol: null },
  { id: "other", label: "Other", protocol: null },
] as const;
type AvBrandId = (typeof AV_RECEIVER_BRANDS)[number]["id"];
const brandLabel = (id: string): string => AV_RECEIVER_BRANDS.find((b) => b.id === id)?.label ?? id;
const PROTOCOL_BRAND_LABEL: Record<"avr" | "yamaha", string> = { avr: "Denon/Marantz", yamaha: "Yamaha" };

/**
 * Protocols whose devices are added one at a time by IP address rather than found by a
 * broadcast scan — either because the technology has no discovery protocol at all, or
 * because a scan can't reach it (SSDP/mDNS don't cross the hub's network boundary on every
 * deployment). Manual entry uses the exact same commission-with-protocol-binding call a scan
 * hit would, so it's a first-class path, not a fallback. "avr-receiver" is a UI-only grouping
 * (§ AVR Intelligent Manual Add) — not a real ProtocolKind — covering both real AV-receiver
 * protocol adapters (avr, yamaha) behind one brand-aware wizard, per "don't expose separate
 * AVR brands as separate extensions." HEOS stays its own entry (standalone HEOS products, no
 * zone concept). KNX/Modbus/MQTT devices are usually better added via the ETS import / Bus
 * Binding power-user tools, but a single manual bind works the same way here too.
 */
const MANUAL_PROTOCOLS = ["avr-receiver", "heos", "knx", "modbus", "mqtt"] as const;
const MANUAL_ADDRESS_HINT: Record<(typeof MANUAL_PROTOCOLS)[number], string> = {
  "avr-receiver": "Receiver IP e.g. 192.168.1.50",
  heos: "Any one HEOS player's IP e.g. 192.168.1.51 (port 1255)",
  knx: "Group address e.g. 1/2/0",
  modbus: "Register e.g. 100",
  mqtt: "Base topic e.g. z2m/lamp",
};
// HEOS's player id (pid) is required — get it from the HEOS app's "About This Device" screen.
const MANUAL_CONFIG_HINT: Record<(typeof MANUAL_PROTOCOLS)[number], string | null> = {
  "avr-receiver": null,
  heos: '{"pid":"<player id>"}',
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
  // § Casambi Group → Supreme Room. A group is NOT a DiscoveredDevice (no capabilities of its
  // own, not commissionable as one), so it is fetched separately from its own endpoint and
  // rendered as its own kind of card rather than being forced into the protocol-agnostic
  // discovery contract every other driver flows through.
  const [casambiGroups, setCasambiGroups] = useState<CasambiGroupView[] | null>(null);
  const [groupsError, setGroupsError] = useState<string | null>(null);

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
    setCasambiGroups(null);
    setGroupsError(null);
    setSourceFilter("all");
    try {
      const res = await client.discover(undefined, Array.from(selectedIds));
      setFound(res.discovered as Discovered[]);
      setDriverResults((res.driverResults ?? []) as DriverResult[]);
      setPhase("results");
      void loadCasambiGroups();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed.");
      setPhase("idle");
    }
  }

  /** Non-blocking: a failure here never fails a scan that otherwise succeeded. But it is NOT
   * silent — an empty or failed group fetch is reported with its real reason (see the section's
   * own empty state), because "no groups" and "groups couldn't be loaded" are different facts and
   * showing nothing at all reads as "this feature doesn't exist." */
  async function loadCasambiGroups() {
    const id = casambiDriverId(registry, selectedIds);
    if (!id) return;
    setGroupsError(null);
    try {
      setCasambiGroups(await listCasambiGroups(id));
    } catch (e) {
      setCasambiGroups([]);
      setGroupsError(e instanceof Error ? e.message : "Could not load Casambi groups.");
    }
  }

  // Post-scan Source Filter (§ Priority 4): a display filter over the CURRENT result set —
  // separate from the pre-scan Driver Selector above, which controls execution, not display.
  const sourceCounts = new Map<string, number>();
  for (const d of found) sourceCounts.set(d.driverName ?? d.protocol ?? d.source, (sourceCounts.get(d.driverName ?? d.protocol ?? d.source) ?? 0) + 1);
  const visible = sourceFilter === "all" ? found : found.filter((d) => (d.driverName ?? d.protocol ?? d.source) === sourceFilter);
  // § Casambi Group → Supreme Room — the Groups chip is a filter over the RESULT KIND, not over
  // discovery sources: picking it shows only group cards, and picking any device source hides
  // them, so "only groups" and "only this driver's fixtures" both mean exactly what they say.
  const showGroups = sourceFilter === "all" || sourceFilter === GROUPS_FILTER;
  const showDevices = sourceFilter !== GROUPS_FILTER;

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
          {phase === "scanning" && (
            // § live-confirmed fix — a single batched client.discover() call across every
            // selected driver, no per-driver completion signal arrives until the whole
            // scan resolves, so an honest indeterminate sweep is the real state here —
            // never a fabricated per-driver fraction the client can't actually observe.
            <ProgressBar style={{ marginTop: 12, maxWidth: 360, marginInline: "auto" }} label="Scanning selected extensions…" />
          )}
        </div>
      )}

      {phase === "scanning" && <DriverStatusList drivers={drivers} selectedIds={selectedIds} results={driverResults} scanning />}
      {phase === "results" && <DriverStatusList drivers={drivers} selectedIds={selectedIds} results={driverResults} scanning={false} />}

      <ManualAddDevice registry={registry} rooms={rooms} onRoomCreated={loadRooms} />

      {phase === "results" && (
        <>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", margin: "6px 0 12px", flexWrap: "wrap", gap: 8 }}>
            <SourceFilterChips counts={sourceCounts} total={found.length} groupCount={casambiGroups?.length ?? 0} active={sourceFilter} onSelect={setSourceFilter} />
            <button onClick={scan}>Rescan</button>
          </div>
          {showGroups && casambiGroups !== null && casambiDriverId(registry, selectedIds) && (
            <CasambiGroupSection
              driverId={casambiDriverId(registry, selectedIds) ?? ""}
              groups={casambiGroups}
              loadError={groupsError}
              onPaired={(backendIds) => {
                // Paired members are no longer "new finds" — drop them from the device list the
                // same way pairing one device does, so the two views can never disagree.
                setFound((f) => f.filter((x) => !backendIds.includes(x.backendId)));
                void loadCasambiGroups();
                void loadRooms();
              }}
            />
          )}
          {showDevices && found.length === 0 && (
            <p className="muted">No new devices found. Ensure devices are powered and on the network, then rescan.</p>
          )}
          {showDevices && (
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
          )}
        </>
      )}
    </div>
  );
}

/** The installed Casambi driver's id, but only when it was actually part of this scan — a group
 * section for a driver the installer deselected would be claiming a result the scan never ran. */
function casambiDriverId(registry: DriverEntry[], selectedIds: Set<string>): string | null {
  const entry = discoverableDrivers(registry).find(
    (d) => d.protocols?.includes("casambi") && d.installedId && selectedIds.has(d.installedId),
  );
  return entry?.installedId ?? null;
}

/**
 * § Casambi Group → Supreme Room — group cards in the discovery results.
 *
 * A Casambi group is how this job's rooms were already laid out in the Casambi app, so it's the
 * one real location signal this protocol carries. Pairing a group commissions each of its
 * still-unpaired fixtures with the group's name as the room hint, so the SAME shared
 * `resolveOrCreateRoom()` every protocol uses matches an existing Supreme room of that name or
 * creates it. Rendered as its own card kind, never as a `FoundDevice`: a group has no
 * capabilities and isn't commissionable as a single device.
 */
function CasambiGroupSection({
  driverId,
  groups,
  loadError,
  onPaired,
}: {
  driverId: string;
  groups: CasambiGroupView[];
  /** A real failure from the groups endpoint (e.g. the driver isn't running), surfaced instead of
   * being swallowed — "couldn't load" and "there are none" are different facts. */
  loadError: string | null;
  onPaired: (backendIds: string[]) => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<CasambiGroupPairResult | null>(null);

  async function pair(groupId: number) {
    setBusy(groupId);
    setErr(null);
    setDone(null);
    try {
      const res = await pairCasambiGroup(driverId, groupId);
      setDone(res);
      onPaired(res.devices.map((d) => d.backendId));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Pairing the group failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="disc-groups">
      <h2 className="section-title">Groups from Casambi</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Pairing a group adds its fixtures to the room of the same name — matching an existing room,
        or creating it.
      </p>
      {err && <p className="err">{err}</p>}
      {loadError && <p className="err">{loadError}</p>}
      {!loadError && groups.length === 0 && (
        // § Capability gating — an empty list is explained, never rendered as silence. Group
        // names live only in the Casambi Cloud account (Local UDP carries none), and the driver
        // holds them in memory, so a gateway restart — including every update — clears them
        // until the next Cloud sync. That is the real and only reason this is usually empty.
        <p className="muted">
          No Casambi groups loaded yet. Group names come from your Casambi Cloud account — run
          "Discover devices from Cloud" in Extension Center → Supreme Casambi, then rescan here.
          (The gateway holds them in memory, so they clear on every restart or update.)
        </p>
      )}
      {done && (
        <p className="muted">
          Paired {done.paired} fixture{done.paired === 1 ? "" : "s"} from "{done.groupName}"
          {done.roomName ? ` into room "${done.roomName}"` : ""}.
          {done.alreadyPaired > 0 && ` ${done.alreadyPaired} were already paired.`}
          {done.failures.length > 0 && ` ${done.failures.length} failed: ${done.failures[0]!.error}`}
        </p>
      )}
      <div className="grid">
        {groups.map((g) => (
          <div className="ext-card disc-card open" key={g.groupId}>
            <div className="ext-head" style={{ cursor: "default" }}>
              <span className="ext-ic"><Icon name="rooms" /></span>
              <span className="ext-meta">
                <span className="ext-name">{g.name}</span>
                <span className="ext-sub">
                  Casambi group · {g.memberCount} fixture{g.memberCount === 1 ? "" : "s"}
                  {g.unpairedCount > 0 ? ` · ${g.unpairedCount} not yet paired` : ""}
                </span>
                <span className="ext-tags">
                  <span className="tag ok">Room: {g.name}</span>
                </span>
              </span>
              <span className={`drv-badge ${g.unpairedCount > 0 ? "ok" : "off"}`}>
                {g.unpairedCount > 0 ? "Group" : "All paired"}
              </span>
            </div>
            <div className="drv-detail">
              <button
                className="primary"
                disabled={busy !== null || g.unpairedCount === 0}
                onClick={() => void pair(g.groupId)}
              >
                {busy === g.groupId
                  ? "Pairing…"
                  : g.unpairedCount === 0
                    ? "All paired"
                    : `Add ${g.unpairedCount} to "${g.name}"`}
              </button>
            </div>
          </div>
        ))}
      </div>
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
function SourceFilterChips({
  counts,
  total,
  groupCount,
  active,
  onSelect,
}: {
  counts: Map<string, number>;
  total: number;
  /** § Casambi Group → Supreme Room — groups are a different KIND of result, not another
   * discovery source, so they get their own chip rather than being counted among the sources. */
  groupCount: number;
  active: string;
  onSelect: (s: string) => void;
}) {
  if (total === 0 && groupCount === 0) return <span className="muted">0 devices found</span>;
  const sources = Array.from(counts.keys()).sort();
  return (
    <div className="disc-source-filter">
      <button className={`tag proto${active === "all" ? " on" : ""}`} onClick={() => onSelect("all")}>All · {total}</button>
      {groupCount > 0 && (
        <button className={`tag proto${active === GROUPS_FILTER ? " on" : ""}`} onClick={() => onSelect(GROUPS_FILTER)}>
          Groups · {groupCount}
        </button>
      )}
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
  // § live-confirmed fix — how this device physically moves is a real fact only the
  // installer knows (a roller blind's `position` capability looks byte-for-byte
  // identical to a sliding curtain's — the same DPT/wire shape, same 0..100 command),
  // asked once at add time regardless of which protocol/driver found it.
  const isCover = (device.capabilities as string[]).includes("position");
  const [shadingKind, setShadingKind] = useState<ShadingKind>("updown");
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
        // persisted device the auto-commit fast path would have. `shadingKind` merges
        // onto `position` the SAME way — installer-known fact, never guessed.
        ...(device.capabilityConfig || isCover
          ? {
              capabilityConfig: {
                ...device.capabilityConfig,
                ...(isCover ? { position: { ...device.capabilityConfig?.position, shadingKind } } : {}),
              },
            }
          : {}),
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
            {/* Prefer the installed driver's own user-facing name (tells the installer which
                extension will handle it); then a real wire-reported manufacturer string
                (Yamaha's UPnP description); then the protocol's known real brand for avr; else
                the protocol/source label — never a guessed brand. */}
            {device.driverName ?? device.manufacturer ?? (device.protocol === "avr" ? "Denon/Marantz" : device.protocol ? device.protocol.toUpperCase() : device.source)}
            {" · "}{device.capabilities.join(", ")}
            {device.network?.ip ? ` · ${device.network.ip}` : ""}
            {device.zones && device.zones.length > 0 ? ` · ${device.zones.length} zone${device.zones.length === 1 ? "" : "s"}` : ""}
          </span>
          <span className="ext-tags">
            {driver ? <span className="tag ok">Extension: {driver.name}{driver.installed ? "" : " (auto-install)"}</span> : <span className="tag">No matching extension</span>}
          </span>
        </span>
        {device.awaitingLocalSignal ? (
          <span className="drv-badge warning" title="Known from the Casambi Cloud account; hasn't sent a packet on this LAN yet — trigger it once (e.g. toggle the fixture) to confirm it.">
            Awaiting local signal
          </span>
        ) : (
          <span className="drv-badge ok">Found</span>
        )}
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

              {isCover && (
                <label className="drv-field">
                  <span className="lbl">How does this move?</span>
                  <SegmentedControl
                    aria-label="Shading movement"
                    value={shadingKind}
                    onChange={setShadingKind}
                    options={[
                      { value: "updown", label: "Up / Down" },
                      { value: "openclose", label: "Open / Close" },
                    ]}
                  />
                </label>
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
/**
 * Guided AV Receiver add (§ AVR Intelligent Manual Add) — one brand-aware wizard instead of
 * free-form JSON zone config. Pick a brand (or Auto Detect), enter an IP, get a real
 * connection result, review what was actually found, then name and room-assign each real
 * zone independently. Reuses the exact commissioning call every other add path uses — one
 * call per selected zone, each with its own `config: { zone }` binding, so Zone 1 and Zone 2
 * become fully independent devices (separate entity, state, automations, room) exactly like
 * two different receivers — and routes to whichever real protocol adapter (avr or yamaha)
 * actually answered, so the installer never has to know which one powers which brand.
 */
function AvReceiverGuidedAdd({ registry, rooms, onRoomCreated }: { registry: DriverEntry[]; rooms: Room[]; onRoomCreated: () => Promise<void> }) {
  const [step, setStep] = useState<"setup" | "connecting" | "mismatch" | "detected" | "zones" | "creating" | "done">("setup");
  const [brand, setBrand] = useState<AvBrandId>("auto");
  const [ip, setIp] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [protocol, setProtocol] = useState<"avr" | "yamaha" | null>(null);
  const [mismatchProtocol, setMismatchProtocol] = useState<"avr" | "yamaha" | null>(null);
  const [probe, setProbe] = useState<AvrProbeResult | null>(null);
  const [zoneRows, setZoneRows] = useState<Record<string, { checked: boolean; name: string; roomId: string }>>({});
  const [newRoomOpen, setNewRoomOpen] = useState(false);
  const [building, setBuilding] = useState("");
  const [floor, setFloor] = useState("0");
  const [roomName, setRoomName] = useState("");
  const [area, setArea] = useState("");
  const [summary, setSummary] = useState<{ zone: string; name: string; room: string }[] | null>(null);

  function reset() {
    setStep("setup"); setIp(""); setErr(null); setProtocol(null); setMismatchProtocol(null);
    setProbe(null); setZoneRows({}); setSummary(null);
  }

  async function tryProtocol(p: "avr" | "yamaha", address: string): Promise<AvrProbeResult> {
    return (await client.probe({ protocol: p, address })) as AvrProbeResult;
  }

  async function connect() {
    setErr(null);
    const address = ip.trim();
    if (!address) { setErr("Enter the receiver's IP address."); return; }
    const selected = AV_RECEIVER_BRANDS.find((b) => b.id === brand);
    if (brand !== "auto" && !selected?.protocol) {
      setErr(`${brandLabel(brand)} isn't supported yet — there's no protocol adapter for it in this build.`);
      return;
    }
    setStep("connecting");
    try {
      if (brand === "auto") {
        const avrResult = await tryProtocol("avr", address);
        if (avrResult.reachable) { setProtocol("avr"); setProbe(avrResult); setStep("detected"); return; }
        const yamahaResult = await tryProtocol("yamaha", address);
        if (yamahaResult.reachable) { setProtocol("yamaha"); setProbe(yamahaResult); setStep("detected"); return; }
        setErr(yamahaResult.error ?? avrResult.error ?? "Could not reach this address on either supported protocol.");
        setStep("setup");
        return;
      }
      const wanted = selected!.protocol!;
      const result = await tryProtocol(wanted, address);
      if (result.reachable) { setProtocol(wanted); setProbe(result); setStep("detected"); return; }
      // Courtesy fallback: try the other real protocol before giving up, so picking the
      // wrong brand surfaces as "here's what we actually found," never a silent continue.
      const other = wanted === "avr" ? "yamaha" : "avr";
      const otherResult = await tryProtocol(other, address);
      if (otherResult.reachable) {
        setMismatchProtocol(other);
        setProbe(otherResult);
        setStep("mismatch");
        return;
      }
      setErr(result.error ?? "Could not reach this address.");
      setStep("setup");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Connection failed.");
      setStep("setup");
    }
  }

  function useDetected() {
    if (!mismatchProtocol) return;
    setProtocol(mismatchProtocol);
    setMismatchProtocol(null);
    setStep("detected");
  }

  function proceedToZones() {
    if (!probe) return;
    const rows: typeof zoneRows = {};
    for (const z of probe.zones) rows[z.id] = { checked: z.detected, name: "", roomId: rooms[0]?.id ?? "" };
    setZoneRows(rows);
    setStep("zones");
  }

  async function createRoom() {
    if (!roomName.trim()) { setErr("Name the room."); return; }
    setErr(null);
    await client.createRoom({ name: roomName.trim(), building: building.trim() || null, floor: Number.parseInt(floor, 10) || 0, area: area.trim() || null });
    await onRoomCreated();
    setNewRoomOpen(false);
    setBuilding(""); setFloor("0"); setRoomName(""); setArea("");
  }

  async function commit() {
    if (!probe || !protocol) return;
    setErr(null);
    const checked = probe.zones.filter((z) => zoneRows[z.id]?.checked);
    if (checked.length === 0) { setErr("Select at least one zone."); return; }
    for (const z of checked) if (!zoneRows[z.id]!.roomId) { setErr(`Pick a room for ${z.label}.`); return; }
    setStep("creating");
    try {
      const driver = registry.find((d) => d.protocols.includes(protocol as never));
      if (driver && !driver.installed) await installDriverByKey(driver.key);
      const capabilities = (driver?.capabilities ?? ["onoff", "media"]) as never;
      const brandName = PROTOCOL_BRAND_LABEL[protocol];
      const created: { zone: string; name: string; room: string }[] = [];
      for (const z of checked) {
        const row = zoneRows[z.id]!;
        const deviceName = row.name.trim() || `${brandName} — ${z.label}`;
        await client.commission({
          backendId: `manual:${protocol}:${ip.trim()}:${z.id}`,
          name: deviceName,
          roomId: row.roomId,
          capabilities,
          protocol,
          address: ip.trim(),
          config: { zone: z.id },
        });
        created.push({ zone: z.label, name: deviceName, room: rooms.find((r) => r.id === row.roomId)?.name ?? row.roomId });
      }
      setSummary(created);
      setStep("done");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Adding a device failed partway through — zones already created stay created; fix the issue and add the rest separately.");
      setStep("zones");
    }
  }

  if (step === "done" && summary) {
    return (
      <>
        <p className="muted">✓ {summary.length} device{summary.length === 1 ? "" : "s"} added.</p>
        <ul className="muted" style={{ margin: "0 0 12px", paddingLeft: 18 }}>
          {summary.map((s) => <li key={s.zone}>{s.name} — {s.zone} — {s.room}</li>)}
        </ul>
        <button onClick={reset}>Add another</button>
      </>
    );
  }

  return (
    <>
      {(step === "setup" || step === "connecting") && (
        <>
          <label className="drv-field"><span className="lbl">Brand</span>
            <select value={brand} onChange={(e) => setBrand(e.target.value as AvBrandId)} disabled={step === "connecting"}>
              {AV_RECEIVER_BRANDS.map((b) => <option key={b.id} value={b.id} disabled={b.id !== "auto" && !b.protocol}>{b.label}{b.id !== "auto" && !b.protocol ? " — not yet supported" : ""}</option>)}
            </select>
            {brand !== "auto" && !AV_RECEIVER_BRANDS.find((b) => b.id === brand)?.protocol && (
              <span className="help">No protocol adapter exists for {brandLabel(brand)} yet — pick Auto Detect, Denon/Marantz, or Yamaha, or add it manually via a KNX/Modbus/MQTT bridge if one exists for this unit.</span>
            )}
          </label>
          <label className="drv-field"><span className="lbl">Receiver IP address</span>
            <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.50" disabled={step === "connecting"} />
          </label>
          {step === "setup" && (
            <div className="drv-actions">
              <button className="primary" onClick={connect}>Connect</button>
            </div>
          )}
          {step === "connecting" && (
            <p className="muted">
              Connecting to {ip}…{" "}
              {brand === "auto" ? "trying Denon/Marantz, then Yamaha" : `trying ${brandLabel(brand)}`} (a few seconds)
            </p>
          )}
        </>
      )}

      {step === "mismatch" && mismatchProtocol && (
        <div className="drv-field" style={{ border: "1px solid var(--aureon-color-status-warning, #a66)", borderRadius: 8, padding: 12, marginBottom: 8 }}>
          <p><strong>Selected brand:</strong> {brandLabel(brand)}</p>
          <p><strong>Detected device:</strong> {PROTOCOL_BRAND_LABEL[mismatchProtocol]} AV Receiver at {ip}</p>
          <p className="muted">This doesn't match what you picked. Use what was actually found, or cancel and check the IP.</p>
          <div className="drv-actions">
            <button className="primary" onClick={useDetected}>Use Detected Device</button>
            <button onClick={reset}>Cancel</button>
          </div>
        </div>
      )}

      {step === "detected" && probe && protocol && (
        <div className="drv-field" style={{ border: "1px solid var(--aureon-color-base-hairline, #333)", borderRadius: 8, padding: 12, marginBottom: 8 }}>
          <h4 style={{ marginTop: 0 }}>Detected device</h4>
          <p><strong>Brand:</strong> {PROTOCOL_BRAND_LABEL[protocol]}</p>
          <p><strong>Model:</strong> — <span className="muted">(not reported over this protocol without a broadcast scan)</span></p>
          <p><strong>Firmware:</strong> — <span className="muted">(not exposed by this protocol)</span></p>
          <p><strong>IP address:</strong> {ip}</p>
          <p><strong>MAC address:</strong> {probe.mac ?? "— (not resolvable on this network)"}</p>
          <p><strong>Available zones:</strong> {probe.zones.map((z) => z.label).join(", ") || "none reported"}</p>
          <p><strong>Connection status:</strong> <span style={{ color: "var(--aureon-color-status-good, #6a6)" }}>Connected ✓</span></p>
          <div className="drv-actions">
            <button className="primary" onClick={proceedToZones}>Continue</button>
            <button onClick={reset}>Cancel</button>
          </div>
        </div>
      )}

      {(step === "zones" || step === "creating") && probe && protocol && (
        <>
          <p className="muted">
            {protocol === "yamaha"
              ? `${probe.zones.length} zone(s) reported directly by the unit — a real query, not a guess.`
              : `${probe.zones.filter((z) => z.detected).length} of ${probe.zones.length} zone(s) answered within the check window — detection is best-effort, so every zone stays selectable either way.`}
          </p>
          {probe.zones.map((z) => {
            const row = zoneRows[z.id];
            if (!row) return null;
            return (
              <div key={z.id} className="drv-field" style={{ border: "1px solid var(--aureon-color-base-hairline, #333)", borderRadius: 8, padding: 12, marginBottom: 8 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={row.checked}
                    disabled={step === "creating"}
                    onChange={(e) => setZoneRows((prev) => ({ ...prev, [z.id]: { ...prev[z.id]!, checked: e.target.checked } }))}
                  />
                  <strong>{z.label}</strong>
                  <span className="muted">{z.detected ? "detected" : "not detected — enable if you know it exists"}</span>
                </label>
                {row.checked && (
                  <>
                    <label className="drv-field"><span className="lbl">Friendly name</span>
                      <input
                        value={row.name}
                        disabled={step === "creating"}
                        onChange={(e) => setZoneRows((prev) => ({ ...prev, [z.id]: { ...prev[z.id]!, name: e.target.value } }))}
                        placeholder={`${PROTOCOL_BRAND_LABEL[protocol]} — ${z.label}`}
                      />
                    </label>
                    <label className="drv-field"><span className="lbl">Room</span>
                      <select
                        value={row.roomId}
                        disabled={step === "creating"}
                        onChange={(e) => setZoneRows((prev) => ({ ...prev, [z.id]: { ...prev[z.id]!, roomId: e.target.value } }))}
                      >
                        {rooms.map((r) => <option key={r.id} value={r.id}>{roomLabel(r)}</option>)}
                      </select>
                    </label>
                  </>
                )}
              </div>
            );
          })}

          {!newRoomOpen ? (
            <p className="muted"><button className="link" onClick={() => setNewRoomOpen(true)} disabled={step === "creating"}>+ Add a new room</button></p>
          ) : (
            <div className="drv-field" style={{ border: "1px solid var(--aureon-color-base-hairline, #333)", borderRadius: 8, padding: 12, marginBottom: 8 }}>
              <label className="drv-field"><span className="lbl">Room name</span>
                <input value={roomName} onChange={(e) => setRoomName(e.target.value)} placeholder="e.g. Conference Room" />
              </label>
              <label className="drv-field"><span className="lbl">Building</span>
                <input value={building} onChange={(e) => setBuilding(e.target.value)} placeholder="optional" />
              </label>
              <label className="drv-field"><span className="lbl">Floor</span>
                <input type="number" value={floor} onChange={(e) => setFloor(e.target.value)} />
              </label>
              <label className="drv-field"><span className="lbl">Area</span>
                <input value={area} onChange={(e) => setArea(e.target.value)} placeholder="optional" />
              </label>
              <div className="drv-actions">
                <button className="primary" onClick={createRoom}>Create room</button>
                <button onClick={() => setNewRoomOpen(false)}>Cancel</button>
              </div>
            </div>
          )}

          <div className="drv-actions">
            <button className="primary" disabled={step === "creating"} onClick={commit}>
              {step === "creating" ? "Adding…" : "Create device(s)"}
            </button>
            <button disabled={step === "creating"} onClick={reset}>Use a different IP</button>
          </div>
        </>
      )}

      {err && <p className="err">{err}</p>}
    </>
  );
}

function ManualAddDevice({ registry, rooms, onRoomCreated }: { registry: DriverEntry[]; rooms: Room[]; onRoomCreated: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [protocol, setProtocol] = useState<(typeof MANUAL_PROTOCOLS)[number]>("avr-receiver");
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
  const [shadingKind, setShadingKind] = useState<ShadingKind>("updown");
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
        ...(capabilities.includes("position") ? { capabilityConfig: { position: { shadingKind } } } : {}),
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
                {MANUAL_PROTOCOLS.map((p) => <option key={p} value={p}>{p === "avr-receiver" ? "AV RECEIVER" : p.toUpperCase()}</option>)}
              </select>
              {protocol !== "avr-receiver" && !driver && <span className="help">No installed extension covers {protocol.toUpperCase()} yet — install it from the Extension Center first.</span>}
              {protocol !== "avr-receiver" && driver && capabilities.length > 0 && <span className="help">Will add with capabilities: {capabilities.join(", ")}</span>}
            </label>

            {protocol === "avr-receiver" ? (
              <>
                <AvReceiverGuidedAdd registry={registry} rooms={rooms} onRoomCreated={onRoomCreated} />
                <div className="drv-actions"><button onClick={() => setOpen(false)}>Close</button></div>
              </>
            ) : <>

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

            {capabilities.includes("position") && (
              <label className="drv-field">
                <span className="lbl">How does this move?</span>
                <SegmentedControl
                  aria-label="Shading movement"
                  value={shadingKind}
                  onChange={setShadingKind}
                  options={[
                    { value: "updown", label: "Up / Down" },
                    { value: "openclose", label: "Open / Close" },
                  ]}
                />
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
            </>}
          </>
        )}
      </div>
    </div>
  );
}

// Kept for type reuse elsewhere.
export type { Room, RoomId };

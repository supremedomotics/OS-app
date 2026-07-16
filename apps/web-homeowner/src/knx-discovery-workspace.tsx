import { useEffect, useMemo, useState } from "react";
import {
  approveKnxDevice,
  client,
  knxDiscoveryQueue,
  type KnxApprovalResult,
  type KnxInstallerQueueItem,
  type KnxQueueSection,
} from "./api.js";

/**
 * KNX Discovery Summary + Device Review Workspace (§ Discovery Workflow, § Final
 * Production Workflow & Installer Completion).
 *
 * Exposes the EXISTING Unified Device Intelligence pipeline
 * (discoverUnified -> Confidence Engine -> Room Assignment -> Duplicate Detection ->
 * Binding Engine, all in `knxDiscoveryQueue()`) — no discovery/grouping/confidence
 * logic lives in this file, only the presentation of what the backend already computed,
 * plus purely client-side review affordances (search/filter/sort/bulk select/reject)
 * over that same data. Reject never calls the backend — nothing is actually created
 * until Approve runs, so "rejecting" a queue item is just removing it from view.
 */

type Filter = KnxQueueSection | "unsupported" | "already_installed" | "rejected";
const FILTER_LABEL: Record<Filter, string> = {
  ready: "Ready",
  needs_review: "Needs Review",
  duplicates: "Duplicates",
  conflicts: "Conflicts",
  unsupported: "Unsupported",
  already_installed: "Already Installed",
  rejected: "Rejected",
};
const FILTER_ORDER: Filter[] = ["ready", "needs_review", "duplicates", "conflicts", "unsupported", "already_installed", "rejected"];

type SortKey = "confidence" | "room" | "device_type" | "discovery_order" | "alphabetical";
const SORT_LABEL: Record<SortKey, string> = {
  discovery_order: "Discovery order",
  alphabetical: "Alphabetical",
  confidence: "Confidence",
  room: "Room",
  device_type: "Device type",
};

function itemFilters(item: KnxInstallerQueueItem, rejected: boolean): Filter[] {
  const f: Filter[] = [item.section];
  if (item.device.capabilities.length === 0 || item.device.raw.deviceKind === "unknown") f.push("unsupported");
  if (item.duplicate.decision === "update" || item.duplicate.decision === "merge") f.push("already_installed");
  if (rejected) f.push("rejected");
  return f;
}

export function KnxDiscoveryWorkspace() {
  const [phase, setPhase] = useState<"idle" | "scanning" | "done" | "error">("idle");
  const [result, setResult] = useState<Awaited<ReturnType<typeof knxDiscoveryQueue>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<{ id: string; name: string }[]>([]);
  const [approved, setApproved] = useState<Record<string, KnxApprovalResult>>({});
  const [approving, setApproving] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, { name: string; roomId: string }>>({});

  // Review workspace: search / filter / sort / bulk selection / reject (§ Device Review
  // Workspace — all purely client-side over the one queue the backend already returned).
  const [query, setQuery] = useState("");
  const [activeFilters, setActiveFilters] = useState<Set<Filter>>(new Set(["ready", "needs_review", "duplicates", "conflicts"]));
  const [sortKey, setSortKey] = useState<SortKey>("discovery_order");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  // ETS Project Import (§ Unify ETS Import & Discovery Pipeline) — an ETS export is just
  // another SIGNAL SOURCE into the same discoverUnified() pipeline live scanning uses, so
  // it's staged here rather than as a separate import panel/workflow. No parsing or
  // commissioning logic lives in this file — `content`/`knxproj` are handed to the
  // backend as-is, which parses (never commissions) and merges them into the same queue.
  const [etsText, setEtsText] = useState("");
  const [etsProject, setEtsProject] = useState<string | null>(null);
  const [etsPassword, setEtsPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);

  useEffect(() => {
    void client.home().then((h) => setRooms(h.rooms.map((r) => ({ id: r.id, name: r.name }))));
  }, []);

  async function onFile(file: File) {
    setNeedsPassword(false);
    setEtsPassword("");
    if (file.name.toLowerCase().endsWith(".knxproj")) {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]!);
      setEtsProject(btoa(bin));
      setEtsText("");
    } else {
      setEtsText(await file.text());
      setEtsProject(null);
    }
  }

  async function scan() {
    setPhase("scanning");
    setError(null);
    setApproved({});
    setSelected(new Set());
    setRejected(new Set());
    try {
      const ets = etsProject
        ? { knxproj: etsProject, password: etsPassword || undefined }
        : etsText.trim()
          ? { content: etsText }
          : undefined;
      const out = await knxDiscoveryQueue(ets);
      setResult(out);
      // Pre-fill each device's editable name/room from the backend's own recommendation —
      // the installer only overrides what they disagree with (§ Editing).
      const initial: Record<string, { name: string; roomId: string }> = {};
      for (const item of out.queue) {
        const matchedRoom = rooms.find((r) => r.name.toLowerCase() === (item.room.room ?? "").toLowerCase());
        initial[item.device.backendId] = { name: item.device.suggestedName, roomId: matchedRoom?.id ?? rooms[0]?.id ?? "" };
      }
      setEdits(initial);
      setPhase("done");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Discovery failed.";
      if (etsProject && /password/i.test(message)) setNeedsPassword(true);
      setError(message);
      setPhase("error");
    }
  }

  async function approve(item: KnxInstallerQueueItem) {
    const edit = edits[item.device.backendId];
    if (!edit?.roomId) {
      // Never leave this silent — a no-op approve looks identical to a hung request
      // otherwise, and the installer has no way to tell why nothing happened.
      setApproved((cur) => ({ ...cur, [item.device.backendId]: { device: { id: "", name: edit?.name ?? item.device.suggestedName }, status: "error", reason: "No room to assign — create a room first." } }));
      return;
    }
    setApproving(item.device.backendId);
    try {
      const res = await approveKnxDevice({ device: item.device, name: edit.name, roomId: edit.roomId, plans: item.plans });
      setApproved((cur) => ({ ...cur, [item.device.backendId]: res }));
    } catch (e) {
      setApproved((cur) => ({ ...cur, [item.device.backendId]: { device: { id: "", name: edit.name }, status: "error", reason: e instanceof Error ? e.message : "Approval failed." } }));
    } finally {
      setApproving(null);
    }
  }

  async function approveMany(items: KnxInstallerQueueItem[]) {
    setBulkBusy(true);
    try {
      // Sequential, not Promise.all: each approval commissions + binds real hardware
      // addresses — running them concurrently risks racing the SAME duplicate-detection
      // state the backend just read for the previous item in this batch.
      for (const item of items) await approve(item);
    } finally {
      setBulkBusy(false);
    }
  }

  const queue = result?.queue ?? [];
  const bindableOf = (item: KnxInstallerQueueItem) => item.plans.length > 0 && item.plans.every((p) => p.bindable);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = queue.filter((item) => {
      const isRejected = rejected.has(item.device.backendId);
      const filters = itemFilters(item, isRejected);
      if (isRejected && !activeFilters.has("rejected")) return false;
      if (!isRejected && !filters.some((f) => f !== "rejected" && activeFilters.has(f))) return false;
      if (!q) return true;
      const edit = edits[item.device.backendId];
      const haystack = [
        edit?.name ?? item.device.suggestedName,
        item.room.room ?? "",
        item.device.raw.deviceKind,
        item.device.capabilities.join(" "),
        ...item.device.raw.communicationObjects.map((c) => c.id),
      ].join(" ").toLowerCase();
      return haystack.includes(q);
    });
    const sorted = [...filtered];
    switch (sortKey) {
      case "confidence":
        sorted.sort((a, b) => b.confidence.overall - a.confidence.overall);
        break;
      case "room":
        sorted.sort((a, b) => (a.room.room ?? "").localeCompare(b.room.room ?? ""));
        break;
      case "device_type":
        sorted.sort((a, b) => a.device.raw.deviceKind.localeCompare(b.device.raw.deviceKind));
        break;
      case "alphabetical":
        sorted.sort((a, b) => (edits[a.device.backendId]?.name ?? a.device.suggestedName).localeCompare(edits[b.device.backendId]?.name ?? b.device.suggestedName));
        break;
      case "discovery_order":
      default:
        break;
    }
    return sorted;
  }, [queue, query, activeFilters, rejected, sortKey, edits]);

  function toggleFilter(f: Filter) {
    setActiveFilters((cur) => {
      const next = new Set(cur);
      if (next.has(f)) next.delete(f); else next.add(f);
      return next;
    });
  }

  const selectableIds = visible.filter((i) => !approved[i.device.backendId] && !rejected.has(i.device.backendId)).map((i) => i.device.backendId);
  const selectedItems = visible.filter((i) => selected.has(i.device.backendId));

  return (
    <div className="drv-config">
      <h4>Discover devices</h4>
      <p className="muted">
        Scans the connected gateway and KNX IoT network, and/or an ETS project you provide below —
        the same Unified Device Intelligence pipeline either way: grouping, capability detection,
        room assignment, duplicate detection, and binding plans, using the schema selected above.
      </p>
      <label className="drv-field" style={{ marginTop: 4 }}>
        <span className="lbl">ETS project (optional)</span>
        <input
          type="file"
          accept=".knxproj,.csv,.xml,text/xml,text/csv"
          disabled={phase === "scanning"}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }}
        />
        <span className="help">
          Upload a .knxproj, or paste a group-address export (CSV/XML) below. Imported devices go
          through this same review workspace — approve them exactly like a live-discovered device.
        </span>
      </label>
      <textarea
        value={etsText}
        onChange={(e) => { setEtsText(e.target.value); setEtsProject(null); }}
        placeholder='e.g. <GroupAddress Name="Living Room - Ceiling - Switch" Address="1/1/1" DPTs="DPST-1-1" />'
        rows={4}
        style={{ width: "100%", fontFamily: "monospace", fontSize: 12, marginTop: 8 }}
      />
      {needsPassword && etsProject && (
        <label className="drv-field" style={{ marginTop: 8 }}>
          <span className="lbl">Project password</span>
          <input type="password" value={etsPassword} onChange={(e) => setEtsPassword(e.target.value)} placeholder="ETS project password" />
        </label>
      )}
      <div className="drv-actions" style={{ marginTop: 8 }}>
        <button className="primary" disabled={phase === "scanning"} onClick={() => void scan()}>
          {phase === "scanning" ? "Scanning…" : result ? "Scan again" : "Discover devices"}
        </button>
      </div>
      {phase === "error" && <p className="err">{error}</p>}

      {result && (
        <>
          <DiscoverySummary summary={result.summary} />

          <div className="knx-toolbar">
            <input
              className="knx-search"
              type="search"
              placeholder="Search by name, room, group address, device type…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
              {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => <option key={k} value={k}>Sort: {SORT_LABEL[k]}</option>)}
            </select>
          </div>
          <div className="knx-filters">
            {FILTER_ORDER.map((f) => (
              <button
                key={f}
                type="button"
                className={`knx-filter-chip ${activeFilters.has(f) ? "active" : ""}`}
                onClick={() => toggleFilter(f)}
              >
                {FILTER_LABEL[f]}
              </button>
            ))}
          </div>

          <div className="knx-bulk-bar">
            <button type="button" className="link" onClick={() => setSelected(new Set(selectableIds))}>Select all</button>
            <button type="button" className="link" onClick={() => setSelected(new Set())}>Clear selection</button>
            <button type="button" className="link" onClick={() => setSelected(new Set(visible.filter((i) => i.section === "ready" && selectableIds.includes(i.device.backendId)).map((i) => i.device.backendId)))}>Select ready</button>
            <button type="button" className="link" onClick={() => setSelected(new Set(visible.filter((i) => i.section === "needs_review" && selectableIds.includes(i.device.backendId)).map((i) => i.device.backendId)))}>Select needs review</button>
            <button type="button" className="link" onClick={() => setSelected(new Set(visible.filter((i) => i.section === "duplicates" && selectableIds.includes(i.device.backendId)).map((i) => i.device.backendId)))}>Select duplicates</button>
            <span className="muted">{selected.size} selected</span>
            <button
              type="button"
              className="primary"
              disabled={bulkBusy || selectedItems.length === 0}
              onClick={() => void approveMany(selectedItems.filter(bindableOf))}
            >
              {bulkBusy ? "Approving…" : "Approve selected"}
            </button>
            <button
              type="button"
              disabled={bulkBusy || selectedItems.length === 0}
              onClick={() => { setRejected((cur) => new Set([...cur, ...selectedItems.map((i) => i.device.backendId)])); setSelected(new Set()); }}
            >
              Reject selected
            </button>
            <button
              type="button"
              className="primary"
              disabled={bulkBusy}
              onClick={() => void approveMany(visible.filter((i) => i.section === "ready" && bindableOf(i) && !approved[i.device.backendId] && !rejected.has(i.device.backendId)))}
            >
              Approve all ready
            </button>
          </div>

          <div className="knx-device-list">
            {visible.map((item) => (
              <DeviceCard
                key={item.device.backendId}
                item={item}
                rooms={rooms}
                edit={edits[item.device.backendId] ?? { name: item.device.suggestedName, roomId: rooms[0]?.id ?? "" }}
                onEdit={(patch) => setEdits((cur) => ({ ...cur, [item.device.backendId]: { ...cur[item.device.backendId]!, ...patch } }))}
                approval={approved[item.device.backendId]}
                busy={approving === item.device.backendId}
                onApprove={() => approve(item)}
                selected={selected.has(item.device.backendId)}
                onToggleSelect={() => setSelected((cur) => { const next = new Set(cur); if (next.has(item.device.backendId)) next.delete(item.device.backendId); else next.add(item.device.backendId); return next; })}
                rejected={rejected.has(item.device.backendId)}
                onReject={() => setRejected((cur) => new Set([...cur, item.device.backendId]))}
                onUnreject={() => setRejected((cur) => { const next = new Set(cur); next.delete(item.device.backendId); return next; })}
                schemaUsed={result.summary.groupAddressSchema}
              />
            ))}
          </div>
          {visible.length === 0 && <p className="muted">No devices match the current search/filters.</p>}
          {result.queue.length === 0 && <p className="muted">No devices discovered — check the gateway connection or import an ETS project above first.</p>}
        </>
      )}
    </div>
  );
}

function DiscoverySummary({ summary }: { summary: NonNullable<Awaited<ReturnType<typeof knxDiscoveryQueue>>["summary"]> }) {
  const stats: [string, string | number][] = [
    ["Total group addresses", summary.totalGroupAddresses],
    ["Communication objects", summary.communicationObjects],
    ["Circuits created", summary.circuitsCreated],
    ["Devices generated", summary.devicesCreated],
    ["Ready to approve", summary.readyCount],
    ["Needs review", summary.needsReviewCount],
    ["Duplicate circuits", summary.duplicateCircuits],
    ["Unsupported objects", summary.unsupportedObjects],
    ["Discovery duration", `${summary.discoveryDurationMs} ms`],
    ["Group Address Schema", summary.groupAddressSchema],
  ];
  return (
    <div className="knx-summary">
      {stats.map(([label, value]) => (
        <div key={label} className="knx-summary-stat">
          <div className="knx-summary-value">{value}</div>
          <div className="knx-summary-label">{label}</div>
        </div>
      ))}
    </div>
  );
}

function DeviceCard({
  item, rooms, edit, onEdit, approval, busy, onApprove, selected, onToggleSelect, rejected, onReject, onUnreject, schemaUsed,
}: {
  item: KnxInstallerQueueItem;
  rooms: { id: string; name: string }[];
  edit: { name: string; roomId: string };
  onEdit: (patch: Partial<{ name: string; roomId: string }>) => void;
  approval?: KnxApprovalResult;
  busy: boolean;
  onApprove: () => void;
  selected: boolean;
  onToggleSelect: () => void;
  rejected: boolean;
  onReject: () => void;
  onUnreject: () => void;
  schemaUsed: string;
}) {
  const [showWhy, setShowWhy] = useState(false);
  const bindable = item.plans.length > 0 && item.plans.every((p) => p.bindable);

  return (
    <div className={`knx-device-card ${rejected ? "rejected" : ""}`}>
      <div className="knx-device-head">
        {!approval && !rejected && (
          <input type="checkbox" checked={selected} onChange={onToggleSelect} aria-label={`Select ${edit.name}`} />
        )}
        <input className="knx-device-name" value={edit.name} onChange={(e) => onEdit({ name: e.target.value })} disabled={!!approval || rejected} />
        <span className={`drv-badge ${item.confidence.overall >= 85 ? "ok" : item.confidence.overall >= 70 ? "" : "err"}`}>{item.confidence.overall}% confidence</span>
      </div>
      <div className="knx-device-meta">
        {item.device.raw.deviceKind} · {item.device.capabilities.join(", ") || "no capability detected"} · {item.device.raw.communicationObjects.length} communication object{item.device.raw.communicationObjects.length === 1 ? "" : "s"} · {item.duplicate.decision}
      </div>
      <label className="knx-device-room">
        Room
        <select value={edit.roomId} onChange={(e) => onEdit({ roomId: e.target.value })} disabled={!!approval || rejected}>
          {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>

      <button type="button" className="link" onClick={() => setShowWhy((s) => !s)}>{showWhy ? "Hide explanation" : "Why was this device created?"}</button>
      {showWhy && (
        <div className="knx-explain">
          <div><strong>Circuit:</strong> {item.device.raw.groupingKey}</div>
          <div><strong>Grouping/schema used:</strong> {schemaUsed}</div>
          <div><strong>Merge decisions:</strong> {item.device.raw.mergeExplanation.join("; ") || "none recorded"}</div>
          <div><strong>Capability reasoning:</strong> {item.device.capabilities.length > 0 ? `${item.device.capabilities.join(", ")} detected from communication object datapoint types` : "no communication object mapped to a known capability"}</div>
          <div><strong>Room:</strong> {item.room.room ?? "unassigned"} — {item.room.reason}</div>
          <div><strong>Confidence breakdown:</strong> name {item.confidence.name}% · room {item.confidence.room}% · capability {item.confidence.capability}% · grouping {item.confidence.grouping}% · manufacturer {item.confidence.manufacturer}% · model {item.confidence.model}%</div>
          <div><strong>Duplicate reasoning:</strong> {item.duplicate.reason}{item.duplicate.matchedOn ? ` (matched on ${item.duplicate.matchedOn})` : ""}</div>
          {!bindable && <div className="err"><strong>Binding:</strong> {item.plans.map((p) => p.reason).join("; ") || "no communication objects to bind"}</div>}
        </div>
      )}

      <div className="drv-actions" style={{ marginTop: 8 }}>
        {rejected ? (
          <>
            <span className="drv-badge err">Rejected</span>
            <button type="button" className="link" onClick={onUnreject}>Undo</button>
          </>
        ) : !approval ? (
          <>
            <button className="primary" disabled={busy || !bindable} onClick={onApprove}>
              {busy ? "Approving…" : bindable ? "Approve" : "Not bindable"}
            </button>
            <button type="button" onClick={onReject}>Reject</button>
          </>
        ) : (
          <span className={`drv-badge ${approval.status === "ready" ? "ok" : approval.status === "warning" ? "" : "err"}`}>
            {approval.status === "ready" ? "Commissioned" : approval.status === "warning" ? "Commissioned (unverified)" : "Failed"}
            {approval.reason ? ` — ${approval.reason}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}

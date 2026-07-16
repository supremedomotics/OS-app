import { useEffect, useState } from "react";
import {
  approveKnxDevice,
  client,
  knxDiscoveryQueue,
  type KnxApprovalResult,
  type KnxInstallerQueueItem,
  type KnxQueueSection,
} from "./api.js";

/**
 * KNX Discovery Summary + Device Review Workspace (§ Discovery Workflow).
 *
 * Exposes the EXISTING Unified Device Intelligence pipeline
 * (discoverUnified -> Confidence Engine -> Room Assignment -> Duplicate Detection ->
 * Binding Engine, all in `knxDiscoveryQueue()`) — no discovery/grouping/confidence
 * logic lives in this file, only the presentation of what the backend already computed.
 * Lives directly under the KNX driver's own settings (§ "Import ETS -> Scan ->
 * Discovery Summary -> Device Review Workspace -> Approve"), reusing the same
 * `.drv-*` card/badge/button classes every other driver panel already uses.
 */

const SECTION_LABEL: Record<KnxQueueSection, string> = {
  ready: "Ready to Approve",
  needs_review: "Needs Review",
  duplicates: "Duplicates",
  conflicts: "Conflicts",
};
const SECTION_ORDER: KnxQueueSection[] = ["ready", "needs_review", "duplicates", "conflicts"];

export function KnxDiscoveryWorkspace() {
  const [phase, setPhase] = useState<"idle" | "scanning" | "done" | "error">("idle");
  const [result, setResult] = useState<Awaited<ReturnType<typeof knxDiscoveryQueue>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<{ id: string; name: string }[]>([]);
  const [approved, setApproved] = useState<Record<string, KnxApprovalResult>>({});
  const [approving, setApproving] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<KnxQueueSection, boolean>>({ ready: false, needs_review: false, duplicates: true, conflicts: true });
  const [edits, setEdits] = useState<Record<string, { name: string; roomId: string }>>({});

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
    if (!edit?.roomId) return;
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

  const bySection: Record<KnxQueueSection, KnxInstallerQueueItem[]> = { ready: [], needs_review: [], duplicates: [], conflicts: [] };
  for (const item of result?.queue ?? []) bySection[item.section].push(item);

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
          {SECTION_ORDER.map((section) =>
            bySection[section].length > 0 ? (
              <SectionGroup
                key={section}
                section={section}
                items={bySection[section]}
                collapsed={collapsed[section]}
                onToggle={() => setCollapsed((c) => ({ ...c, [section]: !c[section] }))}
                rooms={rooms}
                edits={edits}
                setEdits={setEdits}
                approved={approved}
                approving={approving}
                onApprove={approve}
              />
            ) : null,
          )}
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

function SectionGroup({
  section, items, collapsed, onToggle, rooms, edits, setEdits, approved, approving, onApprove,
}: {
  section: KnxQueueSection;
  items: KnxInstallerQueueItem[];
  collapsed: boolean;
  onToggle: () => void;
  rooms: { id: string; name: string }[];
  edits: Record<string, { name: string; roomId: string }>;
  setEdits: (fn: (cur: Record<string, { name: string; roomId: string }>) => Record<string, { name: string; roomId: string }>) => void;
  approved: Record<string, KnxApprovalResult>;
  approving: string | null;
  onApprove: (item: KnxInstallerQueueItem) => void;
}) {
  return (
    <div className="knx-section">
      <button type="button" className="knx-section-head" onClick={onToggle}>
        <span>{SECTION_LABEL[section]} ({items.length})</span>
        <span className="drv-chev">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <div className="knx-device-list">
          {items.map((item) => (
            <DeviceCard
              key={item.device.backendId}
              item={item}
              rooms={rooms}
              edit={edits[item.device.backendId] ?? { name: item.device.suggestedName, roomId: rooms[0]?.id ?? "" }}
              onEdit={(patch) => setEdits((cur) => ({ ...cur, [item.device.backendId]: { ...cur[item.device.backendId]!, ...patch } }))}
              approval={approved[item.device.backendId]}
              busy={approving === item.device.backendId}
              onApprove={() => onApprove(item)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DeviceCard({
  item, rooms, edit, onEdit, approval, busy, onApprove,
}: {
  item: KnxInstallerQueueItem;
  rooms: { id: string; name: string }[];
  edit: { name: string; roomId: string };
  onEdit: (patch: Partial<{ name: string; roomId: string }>) => void;
  approval?: KnxApprovalResult;
  busy: boolean;
  onApprove: () => void;
}) {
  const [showWhy, setShowWhy] = useState(false);
  const bindable = item.plans.length > 0 && item.plans.every((p) => p.bindable);

  return (
    <div className="knx-device-card">
      <div className="knx-device-head">
        <input className="knx-device-name" value={edit.name} onChange={(e) => onEdit({ name: e.target.value })} disabled={!!approval} />
        <span className={`drv-badge ${item.confidence.overall >= 85 ? "ok" : item.confidence.overall >= 70 ? "" : "err"}`}>{item.confidence.overall}% confidence</span>
      </div>
      <div className="knx-device-meta">
        {item.device.capabilities.join(", ") || "no capability detected"} · {item.device.raw.communicationObjects.length} communication object{item.device.raw.communicationObjects.length === 1 ? "" : "s"} · {item.duplicate.decision}
      </div>
      <label className="knx-device-room">
        Room
        <select value={edit.roomId} onChange={(e) => onEdit({ roomId: e.target.value })} disabled={!!approval}>
          {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>

      <button type="button" className="link" onClick={() => setShowWhy((s) => !s)}>{showWhy ? "Hide explanation" : "Why was this device created?"}</button>
      {showWhy && (
        <div className="knx-explain">
          <div><strong>Circuit:</strong> {item.device.raw.groupingKey}</div>
          <div><strong>Merge decisions:</strong> {item.device.raw.mergeExplanation.join("; ") || "none recorded"}</div>
          <div><strong>Room:</strong> {item.room.room ?? "unassigned"} — {item.room.reason}</div>
          <div><strong>Duplicate check:</strong> {item.duplicate.reason}</div>
          {!bindable && <div className="err"><strong>Binding:</strong> {item.plans.map((p) => p.reason).join("; ") || "no communication objects to bind"}</div>}
        </div>
      )}

      <div className="drv-actions" style={{ marginTop: 8 }}>
        {!approval ? (
          <button className="primary" disabled={busy || !bindable} onClick={onApprove}>
            {busy ? "Approving…" : bindable ? "Approve" : "Not bindable"}
          </button>
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

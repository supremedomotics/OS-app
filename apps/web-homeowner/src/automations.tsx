import { useEffect, useState } from "react";
import type { Device, Scene } from "@supreme/domain-model";
import {
  client,
  createAutomation,
  fetchAutomations,
  fetchAutomationRuns,
  runAutomation,
  setAutomationEnabled,
  type AutomationView,
} from "./api.js";
import { EmptyState } from "./empty.js";

/**
 * Automations section (§10) — the Ovio "at a glance" list, and a node canvas that shows
 * an automation as a When → If → Then flow of trigger / condition / action cards on a
 * dotted grid. (Display + run/enable here; full drag-and-drop editing is a follow-up.)
 */
export function Automations() {
  const [items, setItems] = useState<AutomationView[]>([]);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<AutomationView | null>(null);
  const [editing, setEditing] = useState(false);

  const reload = () => void fetchAutomations().then(setItems);
  useEffect(reload, []);

  if (editing) return <Editor onClose={() => { setEditing(false); reload(); }} />;
  if (open) return <Canvas automation={open} onBack={() => setOpen(null)} />;

  const shown = items.filter((a) => a.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="autos">
      <h1 className="greet">Automations</h1>
      <p className="sub">Your automations at a glance</p>
      <input className="auto-search" placeholder="Search automations" value={q} onChange={(e) => setQ(e.target.value)} />

      <div className="auto-list">
        {shown.map((a) => (
          <button key={a.id} className="auto-row" onClick={() => setOpen(a)}>
            <span className="auto-ic">{nodeGlyph(a.actions[0]?.type ?? "device_command")}</span>
            <span className="auto-meta">
              <span className="nm">{a.name}</span>
              <span className="sum">
                {actionLabel(a.actions[0]?.type)} {a.actions.length > 1 && <span className="badge">+{a.actions.length - 1}</span>}
              </span>
            </span>
            <span className={`auto-state${a.enabled ? " on" : ""}`}>{a.enabled ? "Enabled" : "Off"}</span>
          </button>
        ))}
        {shown.length === 0 && (
          q
            ? <EmptyState icon="⌕" title={`No automations match “${q}”`} hint="Try a different name, or clear the search." />
            : <EmptyState icon="⟳" title="No automations yet"
                hint="Let your home run itself — lights at sunset, doors locked at night, a scene when you arrive."
                action={{ label: "Create automation", onClick: () => setEditing(true) }} />
        )}
      </div>
      <button className="auto-fab" onClick={() => setEditing(true)} aria-label="New automation">＋</button>
    </div>
  );
}

// ── Drag-and-drop editor ─────────────────────────────────────────────────────────
type Node = Record<string, unknown> & { type: string };
const PALETTE: { section: "triggers" | "conditions" | "actions"; type: string; label: string }[] = [
  { section: "triggers", type: "time", label: "Time" },
  { section: "triggers", type: "device_state", label: "Device" },
  { section: "conditions", type: "device_state", label: "Device is" },
  { section: "actions", type: "device_command", label: "Adjust Device" },
  { section: "actions", type: "scene_activate", label: "Run Scene" },
  { section: "actions", type: "notify", label: "Notify" },
  { section: "actions", type: "delay", label: "Delay" },
];
function defaultNode(type: string): Node {
  switch (type) {
    case "time": return { type, at: "07:00", days: [] };
    case "device_state": return { type, deviceId: null, capability: "onoff", field: "on", op: "eq", value: true };
    case "device_command": return { type, deviceId: null, command: { capability: "onoff", action: "on" } };
    case "scene_activate": return { type, sceneId: null };
    case "notify": return { type, level: "info", title: "Alert", body: "" };
    case "delay": return { type, ms: 5000 };
    default: return { type };
  }
}

function Editor({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("New automation");
  const [nodes, setNodes] = useState<{ triggers: Node[]; conditions: Node[]; actions: Node[] }>({ triggers: [], conditions: [], actions: [] });
  const [sel, setSel] = useState<{ section: keyof typeof nodes; index: number } | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [scenes, setScenes] = useState<Scene[]>([]);

  useEffect(() => {
    void client.home().then(async (h) => {
      const all: Device[] = [];
      for (const r of h.rooms) all.push(...(await client.devicesInRoom(r.id)).devices);
      setDevices(all);
    });
    void client.scenes().then((s) => setScenes(s.scenes));
  }, []);

  const add = (section: keyof typeof nodes, type: string) =>
    setNodes((n) => ({ ...n, [section]: [...n[section], defaultNode(type)] }));
  const update = (patch: Node) => {
    if (!sel) return;
    setNodes((n) => ({ ...n, [sel.section]: n[sel.section].map((x, i) => (i === sel.index ? patch : x)) }));
  };
  const remove = (section: keyof typeof nodes, index: number) =>
    setNodes((n) => ({ ...n, [section]: n[section].filter((_, i) => i !== index) }));

  async function save() {
    if (nodes.triggers.length === 0 || nodes.actions.length === 0) return;
    if (await createAutomation({ name: name.trim() || "New automation", triggers: nodes.triggers, conditions: nodes.conditions, actions: nodes.actions })) onClose();
  }

  const zone = (label: string, key: keyof typeof nodes) => (
    <DropZone label={label} onDrop={(t) => add(key, t)} accept={key}>
      {nodes[key].map((nd, i) => (
        <div key={i} className={`node ${key === "actions" ? "action" : key === "conditions" ? "condition" : "trigger"} t-${nd.type}${sel?.section === key && sel.index === i ? " sel" : ""}`} onClick={() => setSel({ section: key, index: i })}>
          <span className="node-ic">{nodeGlyph(nd.type)}</span>
          <span className="node-title">{nodeSummary(nd, devices, scenes)}</span>
          <span className="node-x" onClick={(e) => { e.stopPropagation(); remove(key, i); if (sel?.section === key) setSel(null); }}>×</span>
        </div>
      ))}
    </DropZone>
  );

  return (
    <div className="auto-canvas-wrap">
      <div className="screen-head">
        <button className="back" onClick={onClose}>‹ Cancel</button>
        <button className="edit-btn on" onClick={save}>Save</button>
      </div>
      <input className="auto-search" value={name} onChange={(e) => setName(e.target.value)} placeholder="Automation name" />
      <div className="canvas">
        <Section label="When">{zone("When", "triggers")}</Section>
        <Section label="If">{zone("If", "conditions")}</Section>
        <Section label="Then">{zone("Then", "actions")}</Section>
      </div>

      {sel && nodes[sel.section][sel.index] && <NodeConfig node={nodes[sel.section][sel.index]!} devices={devices} scenes={scenes} onChange={update} onDone={() => setSel(null)} />}

      <p className="palette-hint">Drag a block onto a zone (or tap to add)</p>
      <div className="palette">
        {PALETTE.map((b) => (
          <div
            key={b.section + b.type}
            className="palette-chip"
            draggable
            onDragStart={(e) => e.dataTransfer.setData("text/plain", `${b.section}:${b.type}`)}
            onClick={() => add(b.section, b.type)}
          >
            {nodeGlyph(b.type)} {b.label}
          </div>
        ))}
      </div>
    </div>
  );
}

function DropZone({ label, accept, onDrop, children }: { label: string; accept: string; onDrop: (type: string) => void; children: React.ReactNode }) {
  const [hot, setHot] = useState(false);
  return (
    <div
      className={`drop-zone${hot ? " hot" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setHot(true); }}
      onDragLeave={() => setHot(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHot(false);
        const [section, type] = (e.dataTransfer.getData("text/plain") || "").split(":");
        if (section === accept && type) onDrop(type);
      }}
    >
      {children}
      <span className="drop-hint">Drop {label === "When" ? "a trigger" : label === "If" ? "a condition" : "an action"} here</span>
    </div>
  );
}

function NodeConfig({ node, devices, scenes, onChange, onDone }: { node: Node; devices: Device[]; scenes: Scene[]; onChange: (n: Node) => void; onDone: () => void }) {
  const t = node.type;
  return (
    <div className="node-config">
      <strong>{actionLabel(t)}</strong>
      {t === "time" && (
        <input type="time" value={String(node.at ?? "07:00")} onChange={(e) => onChange({ ...node, at: e.target.value })} />
      )}
      {t === "delay" && (
        <label>Delay (s) <input type="number" min={1} max={60} value={Math.round(Number(node.ms ?? 5000) / 1000)} onChange={(e) => onChange({ ...node, ms: Number(e.target.value) * 1000 })} /></label>
      )}
      {t === "notify" && (
        <>
          <input placeholder="Title" value={String(node.title ?? "")} onChange={(e) => onChange({ ...node, title: e.target.value })} />
          <input placeholder="Message" value={String(node.body ?? "")} onChange={(e) => onChange({ ...node, body: e.target.value })} />
        </>
      )}
      {t === "scene_activate" && (
        <select value={String(node.sceneId ?? "")} onChange={(e) => onChange({ ...node, sceneId: e.target.value })}>
          <option value="">Choose scene…</option>
          {scenes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}
      {(t === "device_command" || t === "device_state") && (
        <>
          <select value={String(node.deviceId ?? "")} onChange={(e) => onChange({ ...node, deviceId: e.target.value })}>
            <option value="">Choose device…</option>
            {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <label className="onoff">
            <input
              type="checkbox"
              checked={t === "device_command" ? (node.command as { action?: string })?.action === "on" : node.value === true}
              onChange={(e) =>
                onChange(t === "device_command" ? { ...node, command: { capability: "onoff", action: e.target.checked ? "on" : "off" } } : { ...node, value: e.target.checked })
              }
            />
            {t === "device_command" ? "Turn on" : "Is on"}
          </label>
        </>
      )}
      <button className="edit-btn" onClick={onDone}>Done</button>
    </div>
  );
}

function nodeSummary(n: Node, devices: Device[], scenes: Scene[]): string {
  const dev = (id: unknown) => devices.find((d) => d.id === id)?.name ?? "device";
  switch (n.type) {
    case "time": return `Time · ${n.at}`;
    case "delay": return `Delay · ${Math.round(Number(n.ms) / 1000)}s`;
    case "notify": return `Notify · ${n.title}`;
    case "scene_activate": return `Scene · ${scenes.find((s) => s.id === n.sceneId)?.name ?? "…"}`;
    case "device_command": return `${dev(n.deviceId)} → ${(n.command as { action?: string })?.action ?? ""}`;
    case "device_state": return `${dev(n.deviceId)} is ${n.value ? "on" : "off"}`;
    default: return n.type;
  }
}

function Canvas({ automation, onBack }: { automation: AutomationView; onBack: () => void }) {
  const [enabled, setEnabled] = useState(automation.enabled);
  return (
    <div className="auto-canvas-wrap">
      <div className="screen-head">
        <button className="back" onClick={onBack}>‹ Automations</button>
        <button
          className={`edit-btn${enabled ? " on" : ""}`}
          onClick={() => { const n = !enabled; setEnabled(n); void setAutomationEnabled(automation.id, n); }}
        >
          {enabled ? "Enabled" : "Off"}
        </button>
      </div>
      <h1 className="title">{automation.name}</h1>

      <div className="canvas">
        <Section label="When">
          {automation.triggers.map((t, i) => (
            <Node key={i} kind="trigger" type={t.type} title={triggerTitle(t)} />
          ))}
          <AddBtn label="Add Trigger" />
        </Section>
        <Section label="If">
          {automation.conditions.map((c, i) => (
            <Node key={i} kind="condition" type={c.type} title={condTitle(c.type)} />
          ))}
          <AddBtn label="Add Condition" />
        </Section>
        <Section label="Then">
          {automation.actions.map((a, i) => (
            <Node key={i} kind="action" type={a.type} title={actionLabel(a.type)} />
          ))}
          <AddBtn label="Add Action" />
        </Section>
      </div>

      <button className="big-action canvas-run" onClick={() => void runAutomation(automation.id)}>▷ Run now</button>

      <ActivityLog automationId={automation.id} />
    </div>
  );
}

/**
 * Automation Debugger (§ Automation Debugger) — the recent execution timeline for one automation:
 * what triggered it, whether conditions passed (and which failed), each action's outcome + timing,
 * and failure reasons. Populated from the engine's real run history.
 */
function ActivityLog({ automationId }: { automationId: string }) {
  const [runs, setRuns] = useState<import("./api.js").AutomationRunView[] | null>(null);
  const load = () => void fetchAutomationRuns(automationId).then(setRuns);
  useEffect(load, [automationId]);

  const fmt = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "medium" });
  return (
    <div className="activity">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h3 className="section" style={{ margin: 0 }}>Recent activity</h3>
        <button onClick={load}>Refresh</button>
      </div>
      {runs === null && <p className="muted">Loading…</p>}
      {runs && runs.length === 0 && <p className="muted">No runs yet. Trigger it or press “Run now”.</p>}
      <div className="run-list">
        {(runs ?? []).map((r) => (
          <div key={r.id} className={`run-row ${r.ok ? "ok" : r.conditionsPassed ? "err" : "skip"}`}>
            <span className="run-dot" />
            <div className="run-meta">
              <span className="run-head">
                {r.ok ? "Ran" : r.conditionsPassed ? "Failed" : "Skipped"} · {r.trigger} · {fmt(r.startedAt)} · {r.durationMs}ms
              </span>
              {!r.conditionsPassed && r.failedCondition && <span className="run-sub">Condition not met: {r.failedCondition}</span>}
              {r.actions.map((a, i) => (
                <span key={i} className={`run-action${a.ok ? "" : " bad"}`}>
                  {a.ok ? "✓" : "✕"} {a.summary} · {a.durationMs}ms{a.error ? ` — ${a.error}` : ""}
                </span>
              ))}
              {r.error && r.actions.length === 0 && <span className="run-sub err">{r.error}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="canvas-section">
      <span className="canvas-label">{label}</span>
      <div className="canvas-flow">{children}</div>
    </div>
  );
}

function Node({ kind, type, title }: { kind: "trigger" | "condition" | "action"; type: string; title: string }) {
  return (
    <div className={`node ${kind} t-${type}`}>
      <span className="node-ic">{nodeGlyph(type)}</span>
      <span className="node-title">{title}</span>
    </div>
  );
}

function AddBtn({ label }: { label: string }) {
  return <button className="node-add">＋ {label}</button>;
}

function nodeGlyph(type: string): string {
  return {
    device_state: "⊙",
    time: "◷",
    interval: "↻",
    time_window: "▭",
    device_command: "⤳",
    scene_activate: "✦",
    notify: "🔔",
    delay: "⏱",
  }[type] ?? "•";
}
function actionLabel(type?: string): string {
  return {
    device_command: "Adjust Device",
    scene_activate: "Run Scene",
    notify: "Notify",
    delay: "Delay",
  }[type ?? ""] ?? "Action";
}
function condTitle(type: string): string {
  return type === "time_window" ? "Time window" : "Device state";
}
function triggerTitle(t: AutomationView["triggers"][number]): string {
  if (t.type === "time") return `Time · ${t.at ?? ""}`;
  if (t.type === "interval") return `Every ${t.everyMinutes}m`;
  return `Sensor · ${t.capability ?? ""} ${t.field ?? ""}`.trim();
}

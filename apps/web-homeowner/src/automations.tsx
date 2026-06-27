import { useEffect, useState } from "react";
import {
  fetchAutomations,
  runAutomation,
  setAutomationEnabled,
  type AutomationView,
} from "./api.js";

/**
 * Automations section (§10) — the Ovio "at a glance" list, and a node canvas that shows
 * an automation as a When → If → Then flow of trigger / condition / action cards on a
 * dotted grid. (Display + run/enable here; full drag-and-drop editing is a follow-up.)
 */
export function Automations() {
  const [items, setItems] = useState<AutomationView[]>([]);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<AutomationView | null>(null);

  useEffect(() => {
    void fetchAutomations().then(setItems);
  }, []);

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
        {shown.length === 0 && <p className="muted">No automations yet.</p>}
      </div>
    </div>
  );
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

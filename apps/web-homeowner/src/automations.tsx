import { useEffect, useMemo, useRef, useState } from "react";
import type { CapabilityKind, Device, Scene } from "@supreme/domain-model";
import {
  client,
  createAutomation,
  deleteAutomation,
  dryRunAutomation,
  duplicateAutomationAs,
  fetchAutomationHealth,
  fetchAutomations,
  fetchAutomationRuns,
  renameAutomation,
  runAutomation,
  setAutomationEnabled,
  setAutomationTags,
  simulateDeviceEvent,
  type AutomationHealth,
  type AutomationRunView,
  type AutomationView,
} from "./api.js";
import { EmptyState } from "./empty.js";
import {
  CAPABILITY_LABELS,
  COMMAND_DEFINITIONS,
  STATE_FIELDS,
  commandableCapabilities,
  resolveCommandDefinitions,
  resolveStateFields,
  type CommandDefinition,
  type FieldDef,
  type NarrowingContext,
} from "./automation-capability-fields.js";
import { getDeviceUiCapabilities } from "./device-ui-capabilities.js";
import type { ColorLike } from "./colormode.js";

/**
 * § ADR 0017 — resolves tiers 2–3 of the field-resolution chain (see the chain's full writeup in
 * `automation-capability-fields.ts`) for one (device, capability) pair in a SINGLE
 * `device.capabilities.find()` pass, bundled with the raw config tier 1 needs — so every call
 * site that renders a capability's controls does exactly one lookup, not up to three. RGB/CCT
 * narrowing reuses `getDeviceUiCapabilities()`, the SAME resolver every other page in this app
 * uses (prefer the driver's structural config, fall back to live-state nullability inference) —
 * never derived ad hoc, or a device whose driver hasn't adopted structural reporting would
 * wrongly show both RGB and CCT forever. A no-op (just the raw config) for every capability
 * other than color, since only `color` has a structural config shape today.
 */
function resolveNarrowingContext(device: Device, kind: CapabilityKind): NarrowingContext {
  const cap = device.capabilities.find((c) => c.kind === kind);
  if (kind !== "color") return { config: cap?.config };
  const ui = getDeviceUiCapabilities(device.capabilities, device.state.color as ColorLike | undefined);
  return {
    modes: { rgb: ui.showRGB, cct: ui.showCCT },
    kelvinRange: cap?.config?.kelvinRange as NarrowingContext["kelvinRange"],
    config: cap?.config,
  };
}

// § ADR 0100 Management — resolve "Bedroom Lights" → "Bedroom Lights Copy" → "…Copy 2" → …
function nextCopyName(base: string, existing: Set<string>): string {
  if (!existing.has(`${base} Copy`)) return `${base} Copy`;
  let n = 2;
  while (existing.has(`${base} Copy ${n}`)) n++;
  return `${base} Copy ${n}`;
}

// Deterministic color per tag string — no server-side color storage needed.
const TAG_HUES = [4, 28, 48, 96, 160, 190, 220, 260, 300, 330];
function tagHue(tag: string): number {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return TAG_HUES[h % TAG_HUES.length]!;
}

const SUPREMEAUTO_VERSION = 1;
interface SupremeautoFile {
  schemaVersion: number;
  exportedAt: string;
  automations: {
    name: string;
    triggers: unknown[];
    conditions: unknown[];
    actions: unknown[];
    tags: string[];
    engine: string;
    /** Denormalized so the import Mapping Wizard can offer a name-based remap when the
     * original Runtime Object id doesn't exist on the target hub. */
    deviceNames: Record<string, string>;
  }[];
}

function toExportRecord(a: AutomationView, devices: Device[]): SupremeautoFile["automations"][number] {
  const ids = new Set<string>([
    ...a.triggers.map((t) => t.deviceId).filter((x): x is string => Boolean(x)),
    ...a.conditions.map((c) => c.deviceId).filter((x): x is string => Boolean(x)),
    ...a.actions.map((ac) => ac.deviceId).filter((x): x is string => Boolean(x)),
  ]);
  const deviceNames: Record<string, string> = {};
  for (const id of ids) deviceNames[id] = devices.find((d) => d.id === id)?.name ?? id;
  return {
    name: a.name, triggers: a.triggers, conditions: a.conditions, actions: a.actions,
    tags: a.tags, engine: "supreme", deviceNames,
  };
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/**
 * Automations section (§10) — the Ovio "at a glance" list, and a node canvas that shows
 * an automation as a When → If → Then flow of trigger / condition / action cards on a
 * dotted grid. (Display + run/enable here; full drag-and-drop editing is a follow-up.)
 */
export function Automations({ devMode = false }: { devMode?: boolean } = {}) {
  const [items, setItems] = useState<AutomationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [devices, setDevices] = useState<Device[]>([]);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<AutomationView | null>(null);
  const [editing, setEditing] = useState(false);
  const [testPanel, setTestPanel] = useState(false);
  const [importWizard, setImportWizard] = useState<SupremeautoFile | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // § ADR 0100 Management — multi-select (mirrors devices.tsx's selectMode/selected pattern).
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastClicked, setLastClicked] = useState<number | null>(null);

  // Search & filter (§ Feature 4) — all client-side over the already-loaded list.
  const [filterTag, setFilterTag] = useState("");
  const [filterTrigger, setFilterTrigger] = useState("");
  const [filterAction, setFilterAction] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "enabled" | "disabled">("all");

  // Inline rename — one row editable at a time.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [tagEditFor, setTagEditFor] = useState<string | null>(null);

  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [confirm, setConfirm] = useState<{ ids: string[] } | null>(null);
  const [bulkTag, setBulkTag] = useState<"assign" | "remove" | null>(null);
  const [bulkThreshold, setBulkThreshold] = useState<{ enabled: boolean; count: number } | null>(null);

  // Client-side delayed-delete + Undo (§ no new persistence architecture): optimistically hide,
  // fire the real DELETE only once the countdown elapses unvisited.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [undo, setUndo] = useState<{ ids: string[]; names: string[]; deadline: number } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = () => void fetchAutomations().then((xs) => { setItems(xs); setLoading(false); });
  useEffect(reload, []);
  useEffect(() => { void client.devices().then((r) => setDevices(r.devices)); }, []);
  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current); }, []);

  const allTags = useMemo(() => [...new Set(items.flatMap((a) => a.tags))].sort(), [items]);
  const triggerTypes = useMemo(() => [...new Set(items.flatMap((a) => a.triggers.map((t) => t.type)))].sort(), [items]);
  const actionTypes = useMemo(() => [...new Set(items.flatMap((a) => a.actions.map((ac) => ac.type)))].sort(), [items]);

  const shown = items.filter((a) =>
    a.name.toLowerCase().includes(q.toLowerCase()) &&
    !hidden.has(a.id) &&
    (!filterTag || a.tags.includes(filterTag)) &&
    (!filterTrigger || a.triggers.some((t) => t.type === filterTrigger)) &&
    (!filterAction || a.actions.some((ac) => ac.type === filterAction)) &&
    (filterStatus === "all" || (filterStatus === "enabled") === a.enabled),
  );

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  function clickRow(a: AutomationView, idx: number, e: React.MouseEvent) {
    if (!selectMode) { setOpen(a); return; }
    if (e.shiftKey && lastClicked !== null) {
      const [lo, hi] = lastClicked < idx ? [lastClicked, idx] : [idx, lastClicked];
      setSelected((s) => { const n = new Set(s); for (let i = lo; i <= hi; i++) n.add(shown[i]!.id); return n; });
    } else if (e.ctrlKey || e.metaKey) {
      toggle(a.id);
      setLastClicked(idx);
    } else {
      setSelected(new Set([a.id]));
      setLastClicked(idx);
    }
  }

  // § Feature 1 — Bulk Enable/Disable, confirming only above a threshold (same modal style as
  // every other confirmation in this module — never a native window.confirm).
  const BULK_CONFIRM_THRESHOLD = 25;
  async function doSetEnabledSelected(enabled: boolean) {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (ids.length > BULK_CONFIRM_THRESHOLD) { setBulkThreshold({ enabled, count: ids.length }); return; }
    await applySetEnabled(ids, enabled);
  }
  async function applySetEnabled(ids: string[], enabled: boolean) {
    setBulkThreshold(null);
    setItems((xs) => xs.map((x) => (ids.includes(x.id) ? { ...x, enabled } : x)));
    await Promise.all(ids.map((id) => setAutomationEnabled(id, enabled)));
    reload();
  }

  // § Feature 2 — Bulk Duplicate with sequential name-conflict resolution.
  async function doDuplicateSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    const existing = new Set(items.map((x) => x.name));
    for (const id of ids) {
      const src = items.find((x) => x.id === id);
      if (!src) continue;
      const name = nextCopyName(src.name, existing);
      existing.add(name);
      await duplicateAutomationAs(id, name);
    }
    setSelected(new Set());
    setSelectMode(false);
    reload();
  }

  // § Feature 3 — Bulk tag assign/remove.
  async function applyBulkTag(tag: string, mode: "assign" | "remove") {
    const ids = [...selected];
    setBulkTag(null);
    setItems((xs) => xs.map((x) => (ids.includes(x.id)
      ? { ...x, tags: mode === "assign" ? [...new Set([...x.tags, tag])] : x.tags.filter((t) => t !== tag) }
      : x)));
    await Promise.all(ids.map((id) => {
      const a = items.find((x) => x.id === id);
      if (!a) return Promise.resolve();
      const next = mode === "assign" ? [...new Set([...a.tags, tag])] : a.tags.filter((t) => t !== tag);
      return setAutomationTags(id, next);
    }));
    reload();
  }

  async function saveTags(id: string, tags: string[]) {
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, tags } : x)));
    await setAutomationTags(id, tags);
  }

  // § Feature 6 — Export.
  function doExport(list: AutomationView[]) {
    const file: SupremeautoFile = {
      schemaVersion: SUPREMEAUTO_VERSION,
      exportedAt: new Date().toISOString(),
      automations: list.map((a) => toExportRecord(a, devices)),
    };
    downloadJson(list.length === 1 ? `${list[0]!.name}.supremeauto` : `automations-${list.length}.supremeauto`, file);
  }

  // § Feature 7/8 — Import: parse, then hand to the Mapping Wizard for validation + remap.
  async function onImportFile(f: File) {
    const text = await f.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { window.alert("This file isn't valid JSON."); return; }
    const p = parsed as Partial<SupremeautoFile>;
    if (!p || !Array.isArray(p.automations)) { window.alert("This doesn't look like a .supremeauto file."); return; }
    setImportWizard({ schemaVersion: p.schemaVersion ?? 0, exportedAt: p.exportedAt ?? "", automations: p.automations as SupremeautoFile["automations"] });
  }

  // § Feature 5 — Keyboard shortcuts.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const typing = (e.target as HTMLElement | null)?.tagName === "INPUT" || (e.target as HTMLElement | null)?.tagName === "TEXTAREA";
      if (e.key === "Escape") {
        // Closest overlay first — Escape always closes exactly one thing, never more.
        if (menu) { setMenu(null); return; }
        if (renamingId) { setRenamingId(null); return; }
        if (confirm) { setConfirm(null); return; }
        if (tagEditFor) { setTagEditFor(null); return; }
        if (bulkTag) { setBulkTag(null); return; }
        if (importWizard) { setImportWizard(null); return; }
        if (bulkThreshold) { setBulkThreshold(null); return; }
        if (selectMode) { setSelectMode(false); setSelected(new Set()); return; }
        return;
      }
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); searchRef.current?.focus(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); setSelectMode(true); setSelected(new Set(shown.map((a) => a.id))); return; }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "e") { e.preventDefault(); void doSetEnabledSelected(false); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e") { e.preventDefault(); void doSetEnabledSelected(true); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") { e.preventDefault(); void doDuplicateSelected(); return; }
      if (e.key === "Delete" && selectMode && selected.size > 0) { setConfirm({ ids: [...selected] }); return; }
      if (e.key === "F2" && selected.size === 1) { const a = items.find((x) => x.id === [...selected][0]); if (a) startRename(a); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectMode, selected, renamingId, shown, items, menu, confirm, tagEditFor, bulkTag, importWizard, bulkThreshold]);

  if (editing) return <Editor onClose={() => { setEditing(false); reload(); }} />;
  if (testPanel) return <TestPanel onClose={() => setTestPanel(false)} />;
  // Canvas's own confirm dialog already asked; from here it's exactly the list's delayed-delete
  // + Undo flow, so a delete from Details behaves identically to one from the list.
  function deleteFromCanvas(id: string) {
    setOpen(null);
    void confirmDelete([id]);
  }
  function duplicateFromCanvas(id: string, currentName: string) {
    return duplicateAutomationAs(id, nextCopyName(currentName, new Set(items.map((x) => x.name))));
  }

  if (open) return <Canvas automation={open} onBack={() => { setOpen(null); reload(); }} onRequestDelete={deleteFromCanvas} onDuplicate={duplicateFromCanvas} />;

  function startRename(a: AutomationView) {
    setMenu(null);
    setRenamingId(a.id);
    setRenameValue(a.name);
  }
  async function commitRename(id: string) {
    const trimmed = renameValue.trim();
    setRenamingId(null);
    const original = items.find((x) => x.id === id)?.name ?? "";
    if (!trimmed || trimmed === original) return;
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, name: trimmed } : x)));
    if (!(await renameAutomation(id, trimmed))) reload();
  }
  // Blur autosaves (Enter does the same; Escape is the one explicit discard path) — one fewer
  // dialog to dismiss on every rename, consistent with how every other inline edit here behaves.
  function blurRename(id: string) {
    if (renamingId === id) void commitRename(id);
  }

  // § ADR 0100 Dependency check — the real AutomationAction DSL has no automation-to-automation
  // reference type, so "referenced by" can only honestly mean shared Runtime Objects (devices),
  // never a fabricated automation-chaining relationship.
  function deviceNames(a: AutomationView): string[] {
    const ids = new Set<string>([
      ...a.triggers.map((t) => (t as { deviceId?: string }).deviceId).filter((x): x is string => Boolean(x)),
      ...a.conditions.map((c) => (c as { deviceId?: string }).deviceId).filter((x): x is string => Boolean(x)),
      ...a.actions.map((ac) => (ac as { deviceId?: string }).deviceId).filter((x): x is string => Boolean(x)),
    ]);
    return [...ids].map((id) => devices.find((d) => d.id === id)?.name ?? id);
  }

  function doDeleteSelected() {
    setConfirm({ ids: [...selected] });
  }

  async function confirmDelete(ids: string[]) {
    setConfirm(null);
    const names = ids.map((id) => items.find((x) => x.id === id)?.name ?? id);
    setHidden((h) => new Set([...h, ...ids]));
    setSelected(new Set());
    setSelectMode(false);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    const deadline = Date.now() + 10000;
    setUndo({ ids, names, deadline });
    undoTimer.current = setTimeout(async () => {
      await Promise.all(ids.map((id) => deleteAutomation(id)));
      setUndo(null);
      reload();
    }, 10000);
  }

  function undoDelete() {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    if (undo) setHidden((h) => { const n = new Set(h); for (const id of undo.ids) n.delete(id); return n; });
    setUndo(null);
  }

  return (
    <div className="autos">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 className="greet">Automations</h1>
          <p className="sub">{loading ? "Loading…" : `${items.length} automation${items.length === 1 ? "" : "s"}`}</p>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {devMode && <button onClick={() => setTestPanel(true)}>Test Panel</button>}
          <button onClick={() => fileInputRef.current?.click()}>Import</button>
          <input ref={fileInputRef} type="file" accept=".supremeauto,application/json" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportFile(f); e.target.value = ""; }} />
          {items.length > 0 && <button onClick={() => doExport(shown)}>Export {q || filterTag || filterTrigger || filterAction || filterStatus !== "all" ? "filtered" : "all"}</button>}
          {items.length > 0 && (
            <button onClick={() => { setSelectMode((v) => !v); setSelected(new Set()); }}>{selectMode ? "Done" : "Select"}</button>
          )}
        </div>
      </div>
      <input ref={searchRef} className="auto-search" placeholder="Search automations (Ctrl+F)" value={q} onChange={(e) => setQ(e.target.value)} />

      {items.length > 0 && (
        <div className="row auto-filters" style={{ gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <select value={filterTag} onChange={(e) => setFilterTag(e.target.value)}>
            <option value="">All tags</option>
            {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={filterTrigger} onChange={(e) => setFilterTrigger(e.target.value)}>
            <option value="">Any trigger</option>
            {triggerTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={filterAction} onChange={(e) => setFilterAction(e.target.value)}>
            <option value="">Any action</option>
            {actionTypes.map((t) => <option key={t} value={t}>{actionLabel(t)}</option>)}
          </select>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as typeof filterStatus)}>
            <option value="all">Enabled + disabled</option>
            <option value="enabled">Enabled only</option>
            <option value="disabled">Disabled only</option>
          </select>
          {(filterTag || filterTrigger || filterAction || filterStatus !== "all") && (
            <button onClick={() => { setFilterTag(""); setFilterTrigger(""); setFilterAction(""); setFilterStatus("all"); }}>Clear filters</button>
          )}
        </div>
      )}

      {selectMode && (
        <div className="bulk-bar">
          <span className="muted">{selected.size} selected</span>
          <button onClick={() => setSelected(new Set(shown.map((a) => a.id)))}>Select all</button>
          <button onClick={() => setSelected(new Set())}>Deselect all</button>
          <button disabled={selected.size === 0} onClick={() => void doSetEnabledSelected(true)}>Enable</button>
          <button disabled={selected.size === 0} onClick={() => void doSetEnabledSelected(false)}>Disable</button>
          <button disabled={selected.size === 0} onClick={() => void doDuplicateSelected()}>Duplicate</button>
          <button disabled={selected.size === 0} onClick={() => setBulkTag("assign")}>Add tag…</button>
          <button disabled={selected.size === 0} onClick={() => setBulkTag("remove")}>Remove tag…</button>
          <button disabled={selected.size === 0} onClick={() => doExport(items.filter((a) => selected.has(a.id)))}>Export selected</button>
          <button className="danger" disabled={selected.size === 0} onClick={doDeleteSelected}>Delete selected</button>
        </div>
      )}

      <div className="auto-list">
        {shown.map((a, idx) => (
          <div
            key={a.id}
            className={`auto-row${selected.has(a.id) && selectMode ? " selected" : ""}`}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ id: a.id, x: e.clientX, y: e.clientY }); }}
          >
            <button className="auto-row-hit" onClick={(e) => clickRow(a, idx, e)}>
              {selectMode && <input type="checkbox" checked={selected.has(a.id)} readOnly aria-label={`Select ${a.name}`} style={{ marginRight: 4 }} />}
              <span className="auto-ic">{nodeGlyph(a.actions[0]?.type ?? "device_command")}</span>
              <span className="auto-meta">
                {renamingId === a.id ? (
                  <input
                    autoFocus
                    className="auto-rename-input"
                    value={renameValue}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void commitRename(a.id); if (e.key === "Escape") { e.stopPropagation(); setRenamingId(null); } }}
                    onBlur={() => blurRename(a.id)}
                  />
                ) : (
                  <span className="nm" title={a.name} onDoubleClick={(e) => { e.stopPropagation(); startRename(a); }}>{a.name}</span>
                )}
                <span className="sum">
                  {actionLabel(a.actions[0]?.type)} {a.actions.length > 1 && <span className="badge">+{a.actions.length - 1}</span>}
                </span>
                {a.tags.length > 0 && (
                  <span className="tag-chips" onClick={(e) => e.stopPropagation()}>
                    {a.tags.slice(0, 3).map((t) => <span key={t} className="tag-chip" style={{ "--tag-hue": tagHue(t) } as React.CSSProperties}>{t}</span>)}
                    {a.tags.length > 3 && <span className="badge">+{a.tags.length - 3}</span>}
                  </span>
                )}
              </span>
              <span className={`auto-state${a.enabled ? " on" : ""}`}>{a.enabled ? "Enabled" : "Off"}</span>
            </button>
            {/* Visible on touch/hover — the context menu's actions (rename, tags, duplicate,
                export, delete) otherwise only reachable via right-click or double-click. */}
            <button className="auto-kebab" aria-label={`More actions for ${a.name}`}
              onClick={(e) => { e.stopPropagation(); setMenu({ id: a.id, x: e.clientX, y: e.clientY }); }}>⋯</button>
          </div>
        ))}
        {loading && (
          <div className="auto-skeleton">
            {[0, 1, 2, 3].map((i) => <div key={i} className="auto-row-skel" />)}
          </div>
        )}
        {!loading && shown.length === 0 && (
          q || filterTag || filterTrigger || filterAction || filterStatus !== "all"
            ? <EmptyState icon="⌕" title="No automations match your search/filters" hint="Try a different name, or clear the search and filters." />
            : <EmptyState icon="⟳" title="No automations yet"
                hint="Let your home run itself — lights at sunset, doors locked at night, a scene when you arrive."
                action={{ label: "Create automation", onClick: () => setEditing(true) }} />
        )}
      </div>
      <button className="auto-fab" onClick={() => setEditing(true)} aria-label="New automation">＋</button>

      {menu && (
        <AutoContextMenu
          x={menu.x} y={menu.y}
          onClose={() => setMenu(null)}
          onRename={() => { const a = items.find((x) => x.id === menu.id); if (a) startRename(a); }}
          onEditTags={() => { setTagEditFor(menu.id); setMenu(null); }}
          onDuplicate={() => { const a = items.find((x) => x.id === menu.id); if (a) void duplicateAutomationAs(a.id, nextCopyName(a.name, new Set(items.map((x) => x.name)))).then(reload); setMenu(null); }}
          onExport={() => { const a = items.find((x) => x.id === menu.id); if (a) doExport([a]); setMenu(null); }}
          onDelete={() => { setConfirm({ ids: [menu.id] }); setMenu(null); }}
        />
      )}

      {tagEditFor && (
        <TagEditor
          tags={items.find((x) => x.id === tagEditFor)?.tags ?? []}
          allTags={allTags}
          onClose={() => setTagEditFor(null)}
          onSave={(tags) => { void saveTags(tagEditFor, tags); setTagEditFor(null); }}
        />
      )}

      {bulkTag && (
        <BulkTagPicker
          mode={bulkTag}
          allTags={allTags}
          onClose={() => setBulkTag(null)}
          onPick={(tag) => void applyBulkTag(tag, bulkTag)}
        />
      )}

      {confirm && (
        <DeleteConfirm
          automations={confirm.ids.map((id) => items.find((x) => x.id === id)!).filter(Boolean)}
          deviceNames={deviceNames}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void confirmDelete(confirm.ids)}
        />
      )}

      {bulkThreshold && (
        <Confirm
          title={`${bulkThreshold.enabled ? "Enable" : "Disable"} ${bulkThreshold.count} automations?`}
          body="That's a large selection — double-checking before it applies everywhere."
          confirmLabel={bulkThreshold.enabled ? "Enable" : "Disable"}
          onCancel={() => setBulkThreshold(null)}
          onConfirm={() => void applySetEnabled([...selected], bulkThreshold.enabled)}
        />
      )}

      {undo && <UndoSnackbar names={undo.names} deadline={undo.deadline} onUndo={undoDelete} />}

      {importWizard && (
        <ImportWizard
          file={importWizard}
          devices={devices}
          existingNames={new Set(items.map((x) => x.name))}
          onClose={() => setImportWizard(null)}
          onImported={() => { setImportWizard(null); reload(); }}
        />
      )}
    </div>
  );
}

function AutoContextMenu({ x, y, onClose, onRename, onEditTags, onDuplicate, onExport, onDelete }: {
  x: number; y: number; onClose: () => void; onRename: () => void; onEditTags: () => void;
  onDuplicate: () => void; onExport: () => void; onDelete: () => void;
}) {
  useEffect(() => {
    const onDoc = () => onClose();
    window.addEventListener("click", onDoc);
    return () => window.removeEventListener("click", onDoc);
  }, [onClose]);
  return (
    <div className="ctx-menu" style={{ left: x, top: y }} onClick={(e) => e.stopPropagation()}>
      <button onClick={onRename}>Rename</button>
      <button onClick={onEditTags}>Edit tags…</button>
      <button onClick={onDuplicate}>Duplicate</button>
      <button onClick={onExport}>Export</button>
      <button className="danger" onClick={onDelete}>Delete</button>
    </div>
  );
}

// § Feature 3 — assign/remove tags on one automation, with create-new + autocomplete.
function TagEditor({ tags, allTags, onClose, onSave }: { tags: string[]; allTags: string[]; onClose: () => void; onSave: (tags: string[]) => void }) {
  const [current, setCurrent] = useState<string[]>(tags);
  const [input, setInput] = useState("");
  const suggestions = allTags.filter((t) => !current.includes(t) && t.toLowerCase().includes(input.toLowerCase()));
  function add(tag: string) {
    const t = tag.trim();
    if (!t || current.includes(t)) return;
    setCurrent((c) => [...c, t]);
    setInput("");
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Tags</h3>
        <div className="tag-chips" style={{ marginBottom: 10 }}>
          {current.map((t) => (
            <span key={t} className="tag-chip removable" style={{ "--tag-hue": tagHue(t) } as React.CSSProperties}>
              {t} <button onClick={() => setCurrent((c) => c.filter((x) => x !== t))} aria-label={`Remove ${t}`}>×</button>
            </span>
          ))}
          {current.length === 0 && <span className="muted">No tags yet.</span>}
        </div>
        <input
          autoFocus
          placeholder="Add a tag… (Enter to create)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(input); } }}
        />
        {suggestions.length > 0 && (
          <div className="tag-suggest">
            {suggestions.slice(0, 8).map((t) => <button key={t} onClick={() => add(t)}>{t}</button>)}
          </div>
        )}
        <div className="row" style={{ gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button onClick={onClose}>Cancel</button>
          <button className="edit-btn on" onClick={() => onSave(current)}>Save</button>
        </div>
      </div>
    </div>
  );
}

// § Feature 3 — bulk assign/remove a single tag across the current selection.
function BulkTagPicker({ mode, allTags, onClose, onPick }: { mode: "assign" | "remove"; allTags: string[]; onClose: () => void; onPick: (tag: string) => void }) {
  const [input, setInput] = useState("");
  const suggestions = allTags.filter((t) => t.toLowerCase().includes(input.toLowerCase()));
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{mode === "assign" ? "Add tag to selected" : "Remove tag from selected"}</h3>
        <input autoFocus placeholder="Tag name…" value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && input.trim()) onPick(input.trim()); }} />
        {suggestions.length > 0 && (
          <div className="tag-suggest">
            {suggestions.slice(0, 8).map((t) => <button key={t} onClick={() => onPick(t)}>{t}</button>)}
          </div>
        )}
        <div className="row" style={{ gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button onClick={onClose}>Cancel</button>
          <button className="edit-btn on" disabled={!input.trim()} onClick={() => onPick(input.trim())}>
            {mode === "assign" ? "Add" : "Remove"}
          </button>
        </div>
      </div>
    </div>
  );
}

// § Feature 7/8 — Import Mapping Wizard: detect missing Runtime Objects by id, let the
// installer remap each one to a real device on this hub, preview name-conflict resolution,
// then create the automations for real via the existing create route.
function ImportWizard({ file, devices, existingNames, onClose, onImported }: {
  file: SupremeautoFile; devices: Device[]; existingNames: Set<string>; onClose: () => void; onImported: () => void;
}) {
  const versionMismatch = file.schemaVersion !== SUPREMEAUTO_VERSION;
  const missingIds = useMemo(() => {
    const ids = new Set<string>();
    for (const a of file.automations) {
      for (const id of Object.keys(a.deviceNames ?? {})) {
        if (!devices.some((d) => d.id === id)) ids.add(id);
      }
    }
    return [...ids];
  }, [file, devices]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  function remap<T extends { deviceId?: string }>(node: T): T {
    if (!node.deviceId) return node;
    const target = mapping[node.deviceId];
    return target ? { ...node, deviceId: target } : node;
  }

  const resolvedNames = useMemo(() => {
    const used = new Set(existingNames);
    return file.automations.map((a) => {
      let name = a.name;
      if (used.has(name)) name = nextCopyName(name, used);
      used.add(name);
      return name;
    });
  }, [file, existingNames]);

  const unresolvable = missingIds.some((id) => !mapping[id]);

  async function doImport() {
    setBusy(true);
    for (let i = 0; i < file.automations.length; i++) {
      const a = file.automations[i]!;
      await createAutomation({
        name: resolvedNames[i]!,
        triggers: a.triggers.map((t) => remap(t as { deviceId?: string })),
        conditions: a.conditions.map((c) => remap(c as { deviceId?: string })),
        actions: a.actions.map((ac) => remap(ac as { deviceId?: string })),
        tags: a.tags ?? [],
      });
    }
    setBusy(false);
    onImported();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <h3>Import {file.automations.length} automation{file.automations.length === 1 ? "" : "s"}</h3>
        {versionMismatch && <p className="muted" style={{ color: "var(--aureon-color-status-warning)" }}>File version {file.schemaVersion || "unknown"} doesn't match this hub's version ({SUPREMEAUTO_VERSION}). Fields may be interpreted differently — review carefully before importing.</p>}

        <p className="muted" style={{ marginTop: 10 }}>Automations:</p>
        <ul className="import-list">
          {file.automations.map((a, i) => (
            <li key={i}>
              {a.name}{resolvedNames[i] !== a.name && <> → renamed to <strong>{resolvedNames[i]}</strong> (name already in use)</>}
            </li>
          ))}
        </ul>

        {missingIds.length > 0 && (
          <>
            <p className="muted" style={{ marginTop: 10 }}>Runtime Object Mapping Wizard — these devices weren't found on this hub:</p>
            {missingIds.map((id) => {
              const originalName = file.automations.flatMap((a) => Object.entries(a.deviceNames ?? {})).find(([k]) => k === id)?.[1] ?? id;
              return (
                <div key={id} className="row" style={{ gap: 8, alignItems: "center", margin: "6px 0" }}>
                  <span className="muted" style={{ minWidth: 160 }}>{originalName}</span>
                  <span>↓</span>
                  <select value={mapping[id] ?? ""} onChange={(e) => setMapping((m) => ({ ...m, [id]: e.target.value }))}>
                    <option value="">Map to…</option>
                    {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </div>
              );
            })}
          </>
        )}

        <div className="row" style={{ gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button onClick={onClose}>Cancel</button>
          <button className="edit-btn on" disabled={busy || unresolvable} onClick={() => void doImport()}>
            {busy ? "Importing…" : unresolvable ? "Map every device to continue" : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}

// § UX polish — one generic confirm shape reused everywhere a non-destructive-but-large action
// needs a check, so every confirmation in this module looks and behaves the same way.
function Confirm({ title, body, confirmLabel, danger, onCancel, onConfirm }: {
  title: string; body?: string; confirmLabel: string; danger?: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {body && <p className="muted">{body}</p>}
        <div className="row" style={{ gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button onClick={onCancel}>Cancel</button>
          <button className={danger ? "danger" : "edit-btn on"} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function DeleteConfirm({ automations, deviceNames, onCancel, onConfirm }: {
  automations: AutomationView[];
  deviceNames: (a: AutomationView) => string[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const bulk = automations.length > 1;
  const shownNames = automations.slice(0, 3).map((a) => a.name);
  const remaining = automations.length - shownNames.length;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {bulk ? (
          <>
            <h3>{automations.length} automations selected</h3>
            <p className="muted">{shownNames.join(", ")}{remaining > 0 ? ` and ${remaining} more` : ""}. Delete all?</p>
          </>
        ) : (
          <>
            <h3>Delete “{automations[0]?.name}”?</h3>
            {deviceNames(automations[0]!).length > 0 && (
              <p className="muted">This automation controls: {deviceNames(automations[0]!).join(", ")}.</p>
            )}
          </>
        )}
        <p className="muted">Execution history will no longer be reachable from the list. You can undo for 10 seconds after deleting.</p>
        <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onCancel}>Cancel</button>
          <button className="danger" onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  );
}

function UndoSnackbar({ names, deadline, onUndo }: { names: string[]; deadline: number; onUndo: () => void }) {
  const [left, setLeft] = useState(Math.ceil((deadline - Date.now()) / 1000));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000))), 250);
    return () => clearInterval(t);
  }, [deadline]);
  const label = names.length === 1 ? `“${names[0]}” deleted.` : `${names.length} automations deleted.`;
  return (
    <div className="snackbar">
      <span>{label}</span>
      <button onClick={onUndo}>Undo ({left}s)</button>
    </div>
  );
}

/**
 * Test Panel (§ Phase 1) — inject a synthetic device-state event through the REAL Automation
 * Engine (`/v1/automations/simulate-event` → `ctx.automations.onDeviceState`, the exact entry
 * point a genuine SIL state delta uses). No mocked execution path: a matching automation
 * really runs, really commands real devices, and really appears in the Automation Debugger.
 */
function TestPanel({ onClose }: { onClose: () => void }) {
  const [deviceId, setDeviceId] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [kind, setKind] = useState<"motion" | "time" | "temperature" | "presence" | "door">("motion");
  const [value, setValue] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void client.devices().then((r) => setDevices(r.devices)); }, []);

  const presets: Record<typeof kind, { capability: string; state: Record<string, unknown>; label: string }> = {
    motion: { capability: "sensor", state: { kind: "sensor", value: Number(value || 1), unit: "", measure: "motion" }, label: "Motion detected" },
    time: { capability: "sensor", state: { kind: "sensor", value: Number(value || 0), unit: "s", measure: "time" }, label: "Time tick" },
    temperature: { capability: "temperature", state: { kind: "temperature", ambientC: Number(value || 22), targetC: null, mode: "off" }, label: `Temperature → ${value || 22}°C` },
    presence: { capability: "sensor", state: { kind: "sensor", value: value === "0" ? 0 : 1, unit: "", measure: "presence" }, label: value === "0" ? "Presence: away" : "Presence: home" },
    door: { capability: "sensor", state: { kind: "sensor", value: value === "1" ? 1 : 0, unit: "", measure: "contact" }, label: value === "1" ? "Door opened" : "Door closed" },
  };

  async function inject() {
    if (!deviceId) return;
    setBusy(true);
    const preset = presets[kind];
    const ok = await simulateDeviceEvent({ deviceId, capability: preset.capability, state: preset.state });
    setLog((l) => [`${new Date().toLocaleTimeString()} · ${preset.label} on ${devices.find((d) => d.id === deviceId)?.name ?? deviceId} · ${ok ? "injected" : "failed"}`, ...l].slice(0, 30));
    setBusy(false);
  }

  return (
    <div className="autos">
      <div className="screen-head">
        <button className="back" onClick={onClose}>‹ Automations</button>
      </div>
      <h1 className="title">Test Panel</h1>
      <p className="muted">Inject a real Runtime Event through the live Automation Engine — no mocks. Any automation whose trigger matches will really run.</p>

      <label className="drv-field"><span className="lbl">Device</span>
        <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
          <option value="">Pick a device…</option>
          {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </label>
      <label className="drv-field"><span className="lbl">Event type</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="motion">Motion</option>
          <option value="time">Time</option>
          <option value="temperature">Temperature</option>
          <option value="presence">Presence</option>
          <option value="door">Door</option>
        </select>
      </label>
      <label className="drv-field"><span className="lbl">Value</span>
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={kind === "temperature" ? "e.g. 29" : kind === "presence" ? "1 = home, 0 = away" : kind === "door" ? "1 = open, 0 = closed" : "any number"} />
      </label>
      <button className="primary" disabled={!deviceId || busy} onClick={inject}>{busy ? "Injecting…" : "Inject Event"}</button>

      <h3 className="section" style={{ marginTop: 16 }}>Injection log</h3>
      <div className="run-list">
        {log.length === 0 && <p className="muted">No events injected yet.</p>}
        {log.map((l, i) => <div key={i} className="run-row ok"><span className="run-dot" /><span className="run-meta">{l}</span></div>)}
      </div>
    </div>
  );
}

// ── Drag-and-drop editor ─────────────────────────────────────────────────────────
type Node = Record<string, unknown> & { type: string };
export type EditorNode = Node;
const PALETTE: { section: "triggers" | "conditions" | "actions"; type: string; label: string }[] = [
  { section: "triggers", type: "time", label: "Time" },
  { section: "triggers", type: "device_state", label: "Device" },
  { section: "conditions", type: "device_state", label: "Device is" },
  { section: "actions", type: "device_command", label: "Adjust Device" },
  { section: "actions", type: "scene_activate", label: "Run Scene" },
  { section: "actions", type: "notify", label: "Notify" },
  { section: "actions", type: "delay", label: "Delay" },
];
export function defaultNode(type: string): Node {
  switch (type) {
    case "time": return { type, at: "07:00", days: [] };
    // § Capability-Driven Builder — no capability is assumed; the field/action pickers populate
    // themselves the moment a Runtime Object is chosen, from THAT device's real capabilities.
    case "device_state": return { type, deviceId: null, capability: null, field: null, op: "eq", value: null };
    case "device_command": return { type, deviceId: null, command: null };
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

      {/* § Part 6 — Automatic Natural-Language Summary, regenerated live on every edit. */}
      {(nodes.triggers.length > 0 || nodes.actions.length > 0) && (
        <p className="auto-summary">{summarizeAutomation(nodes.triggers, nodes.conditions, nodes.actions, devices, scenes)}</p>
      )}

      <div className="canvas">
        <Section label="When">{zone("When", "triggers")}</Section>
        <Section label="If">{zone("If", "conditions")}</Section>
        <Section label="Then">{zone("Then", "actions")}</Section>
      </div>

      {sel && nodes[sel.section][sel.index] && (
        <NodeConfig node={nodes[sel.section][sel.index]!} devices={devices} scenes={scenes} onChange={update} onDone={() => setSel(null)} />
      )}

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

/** Which capability kinds a device exposes for a given node type — `device_command` only ever
 * offers commandable (non-read-only) kinds, `device_state` offers every kind since state is
 * always readable. Extracted so the device-picker's initial value and its `onChange` handler
 * (which needs the SAME answer for whatever device was just selected) can't drift apart. */
function kindsForNode(device: Device | undefined, type: string): CapabilityKind[] {
  if (!device) return [];
  const kinds = device.capabilities.map((c) => c.kind);
  return type === "device_command" ? commandableCapabilities(kinds) : kinds;
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
      {(t === "device_command" || t === "device_state") && (() => {
        const device = devices.find((d) => d.id === node.deviceId);
        const kinds = kindsForNode(device, t);
        return (
          <>
            {/* § Part 5 Live Adaptation — picking a device regenerates every control below it,
                purely from THAT device's own real `capabilities[]`; nothing here is keyed off
                device type/manufacturer/protocol. */}
            <select
              value={String(node.deviceId ?? "")}
              onChange={(e) => {
                const d = devices.find((x) => x.id === e.target.value);
                const firstKind = kindsForNode(d, t)[0];
                // § QA-verified fix — picking a device for a Trigger/Condition must persist a
                // REAL default field (not null): the field <select> below displays the first
                // resolved field as "selected" via its own fallback (`field ?? def?.key`), which
                // made this look correct while `node.field` stayed null underneath — invisible
                // until Save's `triggers.0.field: Expected string, received null` 422.
                const firstField = firstKind && d ? resolveStateFields(firstKind, resolveNarrowingContext(d, firstKind))[0]?.key ?? null : null;
                // § QA-verified fix (§ Action Builder counterpart) — same class of bug: a bare
                // `{ capability }` with no verb/params looked complete in the UI (the picker
                // displays definitions[0]'s verb as "selected" via its own fallback) but wasn't
                // actually persisted, so Save 422'd on `actions.0.command.action: Required`.
                const firstDef = firstKind && d ? resolveCommandDefinitions(firstKind, resolveNarrowingContext(d, firstKind))[0] : undefined;
                const firstCommand = firstKind ? applyDefaults({ capability: firstKind, ...(firstDef?.action ? { action: firstDef.action } : {}) }, firstDef) : null;
                onChange(t === "device_command"
                  ? { ...node, deviceId: e.target.value, command: firstCommand }
                  : { ...node, deviceId: e.target.value, capability: firstKind ?? null, field: firstField, value: null });
              }}
            >
              <option value="">Choose device…</option>
              {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>

            {device && kinds.length === 0 && (
              <p className="muted" style={{ fontSize: 13 }}>This device has no {t === "device_command" ? "commandable" : "readable"} capabilities.</p>
            )}

            {device && kinds.length > 0 && t === "device_command" && (
              <CapabilityActionFields
                device={device}
                kinds={kinds}
                command={node.command as { capability: CapabilityKind } & Record<string, unknown> | null}
                onChange={(command) => onChange({ ...node, command })}
              />
            )}

            {device && kinds.length > 0 && t === "device_state" && (
              <CapabilityStateFields
                device={device}
                kinds={kinds}
                capability={node.capability as CapabilityKind | null}
                field={node.field as string | null}
                op={node.op as string}
                value={node.value}
                onChange={(patch) => onChange({ ...node, ...patch })}
              />
            )}
          </>
        );
      })()}
      <button className="edit-btn" onClick={onDone}>Done</button>
    </div>
  );
}

/** Seed a fresh command with every non-optional param's declared default, so a command that
 * takes e.g. `level` never starts silently empty. */
function applyDefaults(base: Record<string, unknown>, def: CommandDefinition | undefined): Record<string, unknown> {
  const next = { ...base };
  for (const p of def?.params ?? []) {
    if (!p.optional && p.default !== undefined && next[p.key] === undefined) next[p.key] = p.default;
  }
  return next;
}

/** § Part 1 — Capability-Driven Action Builder, rendered from COMMAND DEFINITIONS: capability
 * picker (only when the device has more than one), then the command itself (each a real
 * `CapabilityCommand` verb with its OWN param list — never a shared pool filtered after the
 * fact), narrowed against THIS device's own capability config so e.g. a CCT-only light's
 * "Set color" drops Hue/Saturation entirely and a device's real reported Kelvin range replaces
 * the generic default. Basic params first, advanced ones behind a disclosure (§ Part 4). */
function CapabilityActionFields({ device, kinds, command, onChange }: {
  device: Device; kinds: CapabilityKind[]; command: ({ capability: CapabilityKind } & Record<string, unknown>) | null; onChange: (c: Record<string, unknown>) => void;
}) {
  const capability = command?.capability ?? kinds[0]!;
  const definitions = resolveCommandDefinitions(capability, resolveNarrowingContext(device, capability));
  const action = (command?.action as string | undefined | null) ?? definitions[0]?.action ?? null;
  const def = definitions.find((d) => d.action === action) ?? definitions[0];
  const [showAdvanced, setShowAdvanced] = useState(false);

  function setCapability(kind: CapabilityKind) {
    const firstDef = resolveCommandDefinitions(kind, resolveNarrowingContext(device, kind))[0];
    onChange(applyDefaults({ capability: kind, ...(firstDef?.action ? { action: firstDef.action } : {}) }, firstDef));
  }
  function setCommand(nextDef: CommandDefinition) {
    onChange(applyDefaults({ capability, ...(nextDef.action ? { action: nextDef.action } : {}) }, nextDef));
  }
  function setField(key: string, value: unknown) {
    onChange({ ...command, capability, ...(action ? { action } : {}), [key]: value });
  }

  const basic = (def?.params ?? []).filter((p) => !p.advanced);
  const advanced = (def?.params ?? []).filter((p) => p.advanced);
  // § Domain-specific widget — a joint Hue/Saturation pair renders as ONE color wheel, never
  // two separate sliders, but only when the (per-device-narrowed) params actually carry both.
  const hasColorWheel = advanced.some((p) => p.key === "hue" && p.widget === "colorWheel") && advanced.some((p) => p.key === "saturation");
  const advancedRest = hasColorWheel ? advanced.filter((p) => p.key !== "hue" && p.key !== "saturation") : advanced;

  return (
    <>
      {kinds.length > 1 && (
        <select value={capability} onChange={(e) => setCapability(e.target.value as CapabilityKind)}>
          {kinds.map((k) => <option key={k} value={k}>{CAPABILITY_LABELS[k]}</option>)}
        </select>
      )}
      {definitions.length > 1 && (
        <select value={def?.action ?? ""} onChange={(e) => { const d = definitions.find((x) => x.action === e.target.value); if (d) setCommand(d); }}>
          {definitions.map((d) => <option key={d.action ?? "set"} value={d.action ?? ""}>{d.label}</option>)}
        </select>
      )}
      {basic.map((p) => <FieldControl key={p.key} def={p} value={command?.[p.key] ?? p.default} onChange={(v) => setField(p.key, v)} />)}
      {advanced.length > 0 && (
        <details className="adv-disclosure" open={showAdvanced} onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}>
          <summary>Advanced</summary>
          {hasColorWheel && (
            <ColorWheel
              hue={typeof command?.hue === "number" ? command.hue : 0}
              saturation={typeof command?.saturation === "number" ? command.saturation : 100}
              onChange={(hue, saturation) => onChange({ ...command, capability, ...(action ? { action } : {}), hue, saturation })}
            />
          )}
          {advancedRest.map((p) => <FieldControl key={p.key} def={p} value={command?.[p.key] ?? p.default} onChange={(v) => setField(p.key, v)} />)}
        </details>
      )}
    </>
  );
}

/** § Part 2/3 — Capability-Driven Trigger/Condition Builder: capability → field → comparator →
 * typed value, generated from the SAME per-device-resolved fields the Action builder uses, so a
 * trigger/condition and an action always agree on what THIS specific device actually reports. */
function CapabilityStateFields({ device, kinds, capability, field, op, value, onChange }: {
  device: Device; kinds: CapabilityKind[]; capability: CapabilityKind | null; field: string | null; op: string; value: unknown;
  onChange: (patch: { capability?: CapabilityKind; field?: string | null; op?: string; value?: unknown }) => void;
}) {
  const kind = capability ?? kinds[0]!;
  const fields = resolveStateFields(kind, resolveNarrowingContext(device, kind));
  const [showAdvanced, setShowAdvanced] = useState(false);
  const basic = fields.filter((f) => !f.advanced);
  const advanced = fields.filter((f) => f.advanced);
  const def = fields.find((f) => f.key === field) ?? fields[0];

  function setCapability(k: CapabilityKind) {
    const f = resolveStateFields(k, resolveNarrowingContext(device, k))[0];
    onChange({ capability: k, field: f?.key ?? null, value: null });
  }

  return (
    <>
      {kinds.length > 1 && (
        <select value={kind} onChange={(e) => setCapability(e.target.value as CapabilityKind)}>
          {kinds.map((k) => <option key={k} value={k}>{CAPABILITY_LABELS[k]}</option>)}
        </select>
      )}
      <select value={field ?? def?.key ?? ""} onChange={(e) => onChange({ field: e.target.value, value: null })}>
        {basic.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        {advanced.length > 0 && (
          <optgroup label="Advanced">
            {advanced.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </optgroup>
        )}
      </select>
      {def && def.type !== "boolean" && (
        <select value={op} onChange={(e) => onChange({ op: e.target.value })}>
          <option value="eq">is</option>
          <option value="ne">is not</option>
          {(def.type === "number" || def.type === "percent") && <option value="gt">is above</option>}
          {(def.type === "number" || def.type === "percent") && <option value="lt">is below</option>}
          <option value="changed">changes</option>
        </select>
      )}
      {def && op !== "changed" && <FieldControl def={def} value={value} onChange={(v) => onChange({ value: v })} />}
      {advanced.length > 0 && !advanced.some((f) => f.key === field) && (
        <button type="button" className="adv-toggle" onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? "Hide advanced fields" : "Show advanced fields"}
        </button>
      )}
    </>
  );
}

/** One capability field, one control — the single place that turns a `FieldDef` into an actual
 * widget. Every trigger, condition, and action field routes through this, so a boolean always
 * renders as the same toggle, a percent always as the same slider, everywhere in the app. */
function FieldControl({ def, value, onChange }: { def: FieldDef; value: unknown; onChange: (v: string | number | boolean) => void }) {
  if (def.type === "boolean") {
    return (
      <label className="onoff">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        {def.label}
      </label>
    );
  }
  if (def.type === "enum" && def.enumValues && (def.widget === "fanSelector" || def.widget === "chips")) {
    return <ChipSelector def={def} value={String(value ?? "")} onChange={onChange} />;
  }
  if (def.type === "enum" && def.enumValues) {
    return (
      <label className="field-row"><span className="lbl">{def.label}</span>
        <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          <option value="">…</option>
          {def.enumValues.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </label>
    );
  }
  if (def.type === "percent" && def.widget === "volumeSlider") {
    return <VolumeSlider def={def} value={typeof value === "number" ? value : 0} onChange={(n) => onChange(n)} />;
  }
  if (def.type === "percent") {
    const n = typeof value === "number" ? value : 0;
    return (
      <label className="field-row"><span className="lbl">{def.label}</span>
        <input type="range" min={0} max={100} step={def.step ?? 1} value={n} onChange={(e) => onChange(Number(e.target.value))} />
        <span className="field-val">{n}%</span>
      </label>
    );
  }
  if (def.type === "number" && def.widget === "duration") {
    return <DurationPicker def={def} value={typeof value === "number" ? value : 0} onChange={(n) => onChange(n)} />;
  }
  if (def.type === "number" && def.widget === "cctSlider" && def.min !== undefined && def.max !== undefined) {
    return <CctSlider def={def} value={typeof value === "number" ? value : def.min} onChange={(n) => onChange(n)} />;
  }
  if (def.type === "number" && def.min !== undefined && def.max !== undefined) {
    // A bounded numeric range (e.g. this device's own real Kelvin range) is a slider, never a
    // free-text box — the range IS the device's declared limit, not a suggestion.
    const n = typeof value === "number" ? value : def.min;
    return (
      <label className="field-row"><span className="lbl">{def.label}</span>
        <input type="range" min={def.min} max={def.max} step={def.step ?? 1} value={n} onChange={(e) => onChange(Number(e.target.value))} />
        <span className="field-val">{n}{def.unit ?? ""}</span>
      </label>
    );
  }
  if (def.type === "number") {
    return (
      <label className="field-row"><span className="lbl">{def.label}</span>
        <input type="number" step={def.step} value={typeof value === "number" ? value : ""} onChange={(e) => onChange(Number(e.target.value))} />
        {def.unit && <span className="field-val">{def.unit}</span>}
      </label>
    );
  }
  return (
    <label className="field-row"><span className="lbl">{def.label}</span>
      <input type="text" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** Domain-specific widget — an enum as a segmented button row instead of a native `<select>`,
 * purely presentational; still driven entirely by the command's own `enumValues`. Shared by
 * BOTH the `fanSelector` and `chips` hints (§ no duplicated UI logic) — "Fan Speed → Selector"
 * and "Mode/Preset → Chips" are different semantic intents that render identically. */
function ChipSelector({ def, value, onChange }: { def: FieldDef; value: string; onChange: (v: string) => void }) {
  return (
    <div className="field-row">
      <span className="lbl">{def.label}</span>
      <div className="fan-selector">
        {(def.enumValues ?? []).map((v) => (
          <button key={v} type="button" className={`fan-opt${value === v ? " on" : ""}`} onClick={() => onChange(v)}>{v}</button>
        ))}
      </div>
    </div>
  );
}

/** Domain-specific widget — a volume slider with a filled-track look distinct from a generic
 * percent slider, so Media/AVR volume reads at a glance. */
function VolumeSlider({ def, value, onChange }: { def: FieldDef; value: number; onChange: (v: number) => void }) {
  return (
    <label className="field-row volume-slider">
      <span className="lbl">{def.label}</span>
      <input type="range" min={0} max={100} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ "--fill": `${value}%` } as React.CSSProperties} />
      <span className="field-val">{value}%</span>
    </label>
  );
}

/** Domain-specific widget — a warm↔cool gradient slider for color temperature, bounded to
 * exactly the range the command definition carries (the device's own reported Kelvin range when
 * narrowed, the capability default otherwise) — never a bare number box for a value that's
 * physically a point on a warm/cool spectrum. */
function CctSlider({ def, value, onChange }: { def: FieldDef; value: number; onChange: (v: number) => void }) {
  const min = def.min ?? 2700;
  const max = def.max ?? 6500;
  const pct = Math.round(((value - min) / (max - min)) * 100);
  return (
    <label className="field-row cct-slider">
      <span className="lbl">{def.label}</span>
      <input type="range" min={min} max={max} step={def.step ?? 50} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ "--pct": `${pct}%` } as React.CSSProperties} />
      <span className="field-val">{value}K</span>
    </label>
  );
}

/** Domain-specific widget — a duration expressed and edited as mm:ss instead of a raw seconds
 * number box (§ "Duration → Duration Picker"). Still just a `number` field carrying seconds
 * underneath; only the presentation differs. */
function DurationPicker({ def, value, onChange }: { def: FieldDef; value: number; onChange: (v: number) => void }) {
  const mins = Math.floor(value / 60);
  const secs = value % 60;
  return (
    <div className="field-row duration-picker">
      <span className="lbl">{def.label}</span>
      <div className="duration-inputs">
        <input type="number" min={0} value={mins} onChange={(e) => onChange(Math.max(0, Number(e.target.value)) * 60 + secs)} />
        <span>m</span>
        <input type="number" min={0} max={59} value={secs} onChange={(e) => onChange(mins * 60 + Math.min(59, Math.max(0, Number(e.target.value))))} />
        <span>s</span>
      </div>
    </div>
  );
}

/** Domain-specific widget — a 2D hue/saturation color wheel replacing two separate sliders,
 * rendered ONLY when a command definition's params carry both `hue` and `saturation` together
 * (never fabricated for a device whose narrowed params dropped one or the other). */
function ColorWheel({ hue, saturation, onChange }: { hue: number; saturation: number; onChange: (hue: number, saturation: number) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  function pick(clientX: number, clientY: number) {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const r = Math.min(rect.width, rect.height) / 2;
    const dist = Math.min(1, Math.hypot(dx, dy) / r);
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    if (deg < 0) deg += 360;
    onChange(Math.round(deg), Math.round(dist * 100));
  }
  function onPointerDown(e: React.PointerEvent) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    pick(e.clientX, e.clientY);
  }
  const r = (saturation / 100) * 50;
  const angleRad = ((hue - 90) * Math.PI) / 180;
  const thumbX = 50 + r * Math.cos(angleRad);
  const thumbY = 50 + r * Math.sin(angleRad);
  return (
    <div className="field-row color-wheel-row">
      <span className="lbl">Color</span>
      <div
        ref={ref}
        className="color-wheel"
        onPointerDown={onPointerDown}
        onPointerMove={(e) => { if (e.buttons === 1) pick(e.clientX, e.clientY); }}
      >
        <div className="color-wheel-thumb" style={{ left: `${thumbX}%`, top: `${thumbY}%`, background: `hsl(${hue} 90% 55%)` }} />
      </div>
      <span className="field-val">{hue}° · {saturation}%</span>
    </div>
  );
}

export function nodeSummary(n: Node, devices: Device[], scenes: Scene[]): string {
  const dev = (id: unknown) => devices.find((d) => d.id === id)?.name ?? "device";
  switch (n.type) {
    case "time": return `Time · ${n.at}`;
    case "delay": return `Delay · ${Math.round(Number(n.ms) / 1000)}s`;
    case "notify": return `Notify · ${n.title}`;
    case "scene_activate": return `Scene · ${scenes.find((s) => s.id === n.sceneId)?.name ?? "…"}`;
    case "device_command": return `${dev(n.deviceId)} → ${describeCommand(n.command as ({ capability: CapabilityKind } & Record<string, unknown>) | null)}`;
    case "device_state": return `${dev(n.deviceId)} ${describeFieldCondition(n.capability as CapabilityKind | null, n.field as string | null, n.op as string, n.value)}`;
    default: return n.type;
  }
}

/** § Part 6 — the shared phrase-builder behind both node chips and the full sentence summary,
 * so the two never describe the same node differently. Every phrase is built ONLY from the real
 * capability field defs + whatever value is set — never a device-type/protocol switch. */
function describeCommand(command: ({ capability: CapabilityKind } & Record<string, unknown>) | null): string {
  if (!command) return "…";
  const label = CAPABILITY_LABELS[command.capability];
  const action = command.action as string | undefined;
  const def = (COMMAND_DEFINITIONS[command.capability] ?? []).find((d) => d.action === (action ?? null));
  const parts: string[] = [];
  if (action) parts.push(action);
  else parts.push(label.toLowerCase());
  for (const p of def?.params ?? []) {
    const v = command[p.key];
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${p.label.toLowerCase()} ${v}${p.unit ?? ""}`);
  }
  return parts.join(" · ");
}

const OP_WORDS: Record<string, string> = { eq: "is", ne: "is not", gt: "is above", lt: "is below", gte: "is at least", lte: "is at most", changed: "changes" };
function describeFieldCondition(capability: CapabilityKind | null, field: string | null, op: string, value: unknown): string {
  if (!capability) return "…";
  const def = (STATE_FIELDS[capability] ?? []).find((f) => f.key === field);
  const label = def?.label ?? field ?? CAPABILITY_LABELS[capability];
  if (op === "changed") return `${label.toLowerCase()} changes`;
  if (def?.type === "boolean") return value === true ? `${label.toLowerCase()} on` : `${label.toLowerCase()} off`;
  const word = OP_WORDS[op] ?? "is";
  const shown = value === null || value === undefined || value === "" ? "…" : `${value}${def?.unit ?? ""}`;
  return `${label.toLowerCase()} ${word} ${shown}`;
}

/** § Part 6 — the full natural-language sentence: "When X (and Y), turn Z…" — regenerated live
 * from the exact same node data the visual canvas renders, so it can never drift from the DSL. */
function summarizeAutomation(triggers: Node[], conditions: Node[], actions: Node[], devices: Device[], scenes: Scene[]): string {
  const dev = (id: unknown) => devices.find((d) => d.id === id)?.name ?? "the device";
  const phrase = (n: Node): string => {
    switch (n.type) {
      case "time": return `it's ${n.at}`;
      case "interval": return `every ${n.everyMinutes} minutes`;
      case "device_state": return `${dev(n.deviceId)}'s ${describeFieldCondition(n.capability as CapabilityKind | null, n.field as string | null, n.op as string, n.value)}`;
      case "time_window": return "it's within the scheduled window";
      default: return "a condition is met";
    }
  };
  const when = triggers.length > 0 ? triggers.map(phrase).join(", or ") : "nothing yet";
  const and = conditions.length > 0 ? ` while ${conditions.map(phrase).join(" and ")}` : "";
  const then = actions.length > 0
    ? actions.map((a) => {
        if (a.type === "device_command") return `set ${dev(a.deviceId)} to ${describeCommand(a.command as ({ capability: CapabilityKind } & Record<string, unknown>) | null)}`;
        if (a.type === "scene_activate") return `activate ${scenes.find((s) => s.id === a.sceneId)?.name ?? "the scene"}`;
        if (a.type === "notify") return `send a notification titled "${a.title}"`;
        if (a.type === "delay") return `wait ${Math.round(Number(a.ms) / 1000)}s`;
        return "do nothing";
      }).join(", then ")
    : "nothing yet";
  return `When ${when}${and}, ${then}.`;
}

function Canvas({ automation, onBack, onRequestDelete, onDuplicate }: {
  automation: AutomationView; onBack: () => void; onRequestDelete: (id: string) => void; onDuplicate: (id: string, name: string) => Promise<AutomationView | null>;
}) {
  const [enabled, setEnabled] = useState(automation.enabled);
  const [health, setHealth] = useState<AutomationHealth | null>(null);
  const [dryRun, setDryRun] = useState<AutomationRunView | null>(null);
  const [busy, setBusy] = useState<"run" | "dryrun" | "duplicate" | null>(null);
  const [refreshLog, setRefreshLog] = useState(0);
  const [name, setName] = useState(automation.name);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(automation.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);

  const loadHealth = () => void fetchAutomationHealth(automation.id).then(setHealth);
  useEffect(loadHealth, [automation.id, refreshLog]);
  useEffect(() => { void client.devices().then((r) => setDevices(r.devices)); }, []);

  // § Phase 1 Dependency Information — every Runtime Object this automation touches, derived
  // directly from its own trigger/condition/action nodes (never a separate stored graph).
  const involvedIds = new Set<string>([
    ...automation.triggers.map((t) => (t as { deviceId?: string }).deviceId).filter((x): x is string => Boolean(x)),
    ...automation.conditions.map((c) => (c as { deviceId?: string }).deviceId).filter((x): x is string => Boolean(x)),
    ...automation.actions.map((a) => (a as { deviceId?: string }).deviceId).filter((x): x is string => Boolean(x)),
  ]);

  async function doRun() {
    setBusy("run");
    await runAutomation(automation.id);
    setBusy(null);
    setRefreshLog((n) => n + 1);
  }
  async function doDryRun() {
    setBusy("dryrun");
    setDryRun(await dryRunAutomation(automation.id));
    setBusy(null);
  }
  async function doDuplicate() {
    setBusy("duplicate");
    const copy = await onDuplicate(automation.id, name);
    setBusy(null);
    if (copy) onBack(); // back to the list — the new (disabled) copy shows up there
  }

  async function commitRename() {
    const trimmed = renameValue.trim();
    setRenaming(false);
    if (!trimmed || trimmed === name) { setRenameValue(name); return; }
    setName(trimmed);
    if (!(await renameAutomation(automation.id, trimmed))) setName(name);
  }
  // Blur autosaves, same as the list row — Escape is the one explicit discard path.
  function blurRename() {
    if (renaming) void commitRename();
  }

  function doDelete() {
    setConfirmDelete(false);
    onRequestDelete(automation.id);
  }

  return (
    <div className="auto-canvas-wrap">
      <div className="screen-head">
        <button className="back" onClick={onBack}>‹ Automations</button>
        <div className="row" style={{ gap: 8 }}>
          <button
            className={`edit-btn${enabled ? " on" : ""}`}
            onClick={() => { const n = !enabled; setEnabled(n); void setAutomationEnabled(automation.id, n).then(loadHealth); }}
          >
            {enabled ? "Enabled" : "Off"}
          </button>
          <button className="danger" onClick={() => setConfirmDelete(true)}>Delete</button>
        </div>
      </div>
      {renaming ? (
        <input
          autoFocus
          className="auto-rename-input title-input"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void commitRename(); if (e.key === "Escape") { e.stopPropagation(); setRenaming(false); setRenameValue(name); } }}
          onBlur={blurRename}
        />
      ) : (
        <h1 className="title" onDoubleClick={() => { setRenameValue(name); setRenaming(true); }}>{name}</h1>
      )}

      {confirmDelete && (
        <div className="modal-backdrop" onClick={() => setConfirmDelete(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Delete “{name}”?</h3>
            {involvedIds.size > 0 && <p className="muted">This automation controls {involvedIds.size} device{involvedIds.size === 1 ? "" : "s"}.</p>}
            <p className="muted">Execution history will no longer be reachable from the list. You can undo for 10 seconds after deleting.</p>
            <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button className="danger" onClick={doDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* § Phase 1 Health — plain-language status derived from real run history. */}
      {health && (
        <p className={`auto-health auto-health-${health.status}`}>
          <span className="run-dot" /> {health.status[0]!.toUpperCase() + health.status.slice(1)} — {health.reason}
        </p>
      )}
      {involvedIds.size > 0 && (
        <p className="muted" style={{ fontSize: 13 }}>Involves {involvedIds.size} device{involvedIds.size === 1 ? "" : "s"}.</p>
      )}

      {/* § Part 6 — the same natural-language sentence Explainability/Documentation/AI Review
          can all reuse, generated live from this automation's own real trigger/condition/action
          data — never a separate hand-maintained description. */}
      <p className="auto-summary">{summarizeAutomation(automation.triggers, automation.conditions, automation.actions, devices, [])}</p>

      <div className="canvas">
        <Section label="When">
          {automation.triggers.map((t, i) => (
            <Node key={i} kind="trigger" type={t.type} title={triggerTitle(t)} />
          ))}
          <AddBtn label="Add Trigger" />
        </Section>
        <Section label="If">
          {automation.conditions.map((c, i) => (
            <Node key={i} kind="condition" type={c.type} title={condTitle(c)} />
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

      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button className="big-action canvas-run" disabled={busy !== null} onClick={doRun}>{busy === "run" ? "Running…" : "▷ Run now"}</button>
        <button disabled={busy !== null} onClick={doDryRun}>{busy === "dryrun" ? "Evaluating…" : "◌ Dry run"}</button>
        <button disabled={busy !== null} onClick={doDuplicate}>{busy === "duplicate" ? "Duplicating…" : "⧉ Duplicate"}</button>
      </div>

      {/* § Phase 1 Explainability — the dry-run's own trace, shown inline, clearly labeled as
          simulated (never confused with a real execution in the Activity log below). */}
      {dryRun && (
        <div className="run-list" style={{ marginTop: 8 }}>
          <div className={`run-row ${dryRun.ok ? "ok" : dryRun.conditionsPassed ? "err" : "skip"}`}>
            <span className="run-dot" />
            <div className="run-meta">
              <span className="run-head">Dry run · {dryRun.conditionsPassed ? "conditions passed" : "conditions NOT met"}{!dryRun.conditionsPassed && dryRun.failedCondition ? ` — ${dryRun.failedCondition}` : ""}</span>
              {dryRun.actions.map((a, i) => <span key={i} className="run-action">{a.summary}</span>)}
            </div>
          </div>
        </div>
      )}

      <ActivityLog automationId={automation.id} refreshToken={refreshLog} />
    </div>
  );
}

/**
 * Automation Debugger (§ Automation Debugger) — the recent execution timeline for one automation:
 * what triggered it, whether conditions passed (and which failed), each action's outcome + timing,
 * and failure reasons. Populated from the engine's real run history.
 */
function ActivityLog({ automationId, refreshToken }: { automationId: string; refreshToken?: number }) {
  const [runs, setRuns] = useState<import("./api.js").AutomationRunView[] | null>(null);
  const load = () => void fetchAutomationRuns(automationId).then(setRuns);
  useEffect(load, [automationId, refreshToken]);

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

export function nodeGlyph(type: string): string {
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
export function actionLabel(type?: string): string {
  return {
    device_command: "Adjust Device",
    scene_activate: "Run Scene",
    notify: "Notify",
    delay: "Delay",
  }[type ?? ""] ?? "Action";
}
export function condTitle(c: AutomationView["conditions"][number]): string {
  if (c.type === "time_window") return "Time window";
  const kind = c.capability as CapabilityKind | undefined;
  const label = kind ? CAPABILITY_LABELS[kind] : "Device";
  return `${label} · ${describeFieldCondition(kind ?? null, c.field ?? null, "eq", undefined)}`;
}
export function triggerTitle(t: AutomationView["triggers"][number]): string {
  if (t.type === "time") return `Time · ${t.at ?? ""}`;
  if (t.type === "interval") return `Every ${t.everyMinutes}m`;
  const kind = t.capability as CapabilityKind | undefined;
  const label = kind ? CAPABILITY_LABELS[kind] : "Device";
  return `${label} · ${(STATE_FIELDS[kind ?? "onoff"] ?? []).find((f) => f.key === t.field)?.label ?? t.field ?? ""}`.trim();
}

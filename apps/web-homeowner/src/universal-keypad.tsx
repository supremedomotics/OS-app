import { useMemo, useState } from "react";
import type { CapabilityKind, Device, DeviceId, KeypadCapabilityDeclaration, KeypadMapping, KeypadMappingBehavior, KeypadMappingId, KeypadMappingInput } from "@supreme/domain-model";
import { Button } from "@supreme/aureon-web";
import { client } from "./api.js";
import { useAsync } from "./use-async.js";
import {
  BEHAVIOR_DESCRIPTIONS,
  BEHAVIOR_LABELS,
  CAPABILITY_LABELS,
  KEYPAD_BEHAVIORS,
  alternatePreview,
  behaviorRequiresActions,
  behaviorRequiresTarget,
  behaviorUsesStep,
  buildCreateKeypadMappingRequest,
  buildUpdateKeypadMappingRequest,
  deviceSupportsDimSpeed,
  emptyKeypadMappingForm,
  groupKeypadsByRoom,
  mappingToFormState,
  resolveCommandDefinitions,
  summarizeMapping,
  targetableCapabilities,
  targetCapabilitiesForBehavior,
  validateKeypadMappingForm,
  type KeypadActionFormEntry,
  type KeypadMappingFormState,
} from "./universal-keypad-logic.js";

/**
 * Supreme Universal Keypad (§ Universal Keypad Framework, Stage 3B) — the dedicated
 * programming surface for physical keypad/button controllers, separate from Automations
 * (§1: keypad button configuration lives here; WHEN/IF/THEN logic stays in Automations —
 * see `universal-keypad-logic.ts`'s doc comment and `BEHAVIOR_DESCRIPTIONS`).
 *
 * Consumes the SAME `Device`/`Room` entities the Room page's "Keypads" category
 * (`screens.tsx`) already renders — `client.devices()` / `client.home()`, no second
 * registry — and the SAME Stage 3A mapping API (`client.*KeypadMapping*`). This file is
 * intentionally thin: all room-grouping, request-building, and validation logic lives in
 * `universal-keypad-logic.ts` as plain, independently-tested functions (this repo has no
 * component-rendering test infra — see that file's own doc comment).
 */
export function UniversalKeypad() {
  const [devices, reloadDevices] = useAsync(() => client.devices().then((d) => d.devices));
  const [home] = useAsync(() => client.home());
  const [mappings, reloadMappings] = useAsync(() => client.listKeypadMappings().then((m) => m.mappings));
  const [selectedKeypadId, setSelectedKeypadId] = useState<DeviceId | null>(null);
  const [editingMappingId, setEditingMappingId] = useState<KeypadMappingId | "new" | null>(null);
  const [editorSeed, setEditorSeed] = useState<{ control: string; event: KeypadMappingInput["event"] } | null>(null);

  const groups = useMemo(() => groupKeypadsByRoom(devices ?? [], home?.rooms ?? []), [devices, home]);
  const selectedKeypad = devices?.find((d) => d.id === selectedKeypadId) ?? null;

  function reload() {
    reloadDevices();
    reloadMappings();
  }

  if (editingMappingId !== null && selectedKeypad) {
    const existing = editingMappingId === "new" ? null : mappings?.find((m) => m.id === editingMappingId) ?? null;
    return (
      <MappingEditor
        keypad={selectedKeypad}
        devices={devices ?? []}
        existing={existing}
        seed={editorSeed}
        onClose={() => { setEditingMappingId(null); setEditorSeed(null); }}
        onSaved={() => { setEditingMappingId(null); setEditorSeed(null); reload(); }}
      />
    );
  }

  if (selectedKeypad) {
    return (
      <KeypadProgramming
        keypad={selectedKeypad}
        devices={devices ?? []}
        room={home?.rooms.find((r) => r.id === selectedKeypad.roomId) ?? null}
        mappings={(mappings ?? []).filter((m) => m.input.keypadId === selectedKeypad.id)}
        onBack={() => setSelectedKeypadId(null)}
        onConfigure={(control, event) => { setEditorSeed({ control, event }); setEditingMappingId("new"); }}
        onEdit={(mapping) => { setEditorSeed(null); setEditingMappingId(mapping.id); }}
        onDeleted={reload}
        onKeypadUpdated={reload}
      />
    );
  }

  return (
    <div className="ukp-page">
      <div className="screen-head">
        <h1>Supreme Universal Keypad</h1>
      </div>
      <p className="muted">Program physical keypads and buttons — short press, long press, and what they control. For conditional logic (WHEN / IF / THEN), use Automations instead.</p>

      {groups.length === 0 && devices !== null && (
        <p className="muted" style={{ marginTop: 24 }}>No keypads discovered yet. Keypads appear here automatically once commissioned, the same way any other device does.</p>
      )}

      {groups.map((g) => (
        <section key={g.room?.id ?? "unassigned"} className="ukp-room-group">
          <h2 className="ukp-room-title">{g.room?.name ?? "Unassigned"}</h2>
          <div className="ukp-keypad-grid">
            {g.keypads.map((kp) => (
              <button key={kp.id} className="ukp-keypad-card" onClick={() => setSelectedKeypadId(kp.id)}>
                <span className={`kp-dot${kp.status === "online" ? " on" : ""}`} aria-hidden />
                <span className="ukp-keypad-name">{kp.name}</span>
                <span className="ukp-keypad-meta">
                  {kp.status === "online" ? "Online" : "Offline"}
                  {typeof kp.metadata.buttonCount === "number" ? ` • ${kp.metadata.buttonCount} button${kp.metadata.buttonCount === 1 ? "" : "s"}` : ""}
                </span>
                {typeof kp.metadata.protocol === "string" && <span className="ukp-keypad-protocol">{kp.metadata.protocol}</span>}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// ── Keypad programming view (§4) — one card per physical button, Short/Long Press independent ──

function KeypadProgramming({
  keypad, devices, room, mappings, onBack, onConfigure, onEdit, onDeleted, onKeypadUpdated,
}: {
  keypad: Device;
  devices: Device[];
  room: { name: string } | null;
  mappings: KeypadMapping[];
  onBack: () => void;
  onConfigure: (control: string, event: KeypadMappingInput["event"]) => void;
  onEdit: (mapping: KeypadMapping) => void;
  onDeleted: () => void;
  onKeypadUpdated: () => void;
}) {
  const [capabilities] = useAsync<KeypadCapabilityDeclaration | null>(
    () => client.keypadCapabilities(keypad.id).then((r) => r.capabilities),
    [keypad.id],
  );

  async function remove(mapping: KeypadMapping) {
    if (!window.confirm(`Delete "${mapping.name}"?`)) return;
    await client.deleteKeypadMapping(mapping.id);
    onDeleted();
  }

  // § Casambi Universal Keypad — button list persistence. The live driver-reported
  // declaration (`capabilities`) is real but IN-MEMORY on the driver — it resets on every
  // gateway restart and stays empty until a real button-press telegram has been decoded at
  // least once. Mappings the installer already programmed must keep showing regardless
  // (§ "mapping should always show... no matter if gateway has rebooted, tab has been
  // changed"), so an installer-confirmed button count — persisted on the device record via
  // the same `device.metadata.<field>` pattern climate-console.tsx already uses — is the
  // PRIMARY source of truth once set; the live declaration only ever offers itself as the
  // one-time default suggestion in the setup prompt below.
  const persistedButtonCount = typeof keypad.metadata.buttonCount === "number" ? keypad.metadata.buttonCount : null;
  const controls =
    persistedButtonCount !== null
      ? synthesizeButtonControls(persistedButtonCount)
      : (capabilities?.controls ?? null);

  return (
    <div className="ukp-page">
      <button className="back" onClick={onBack}>‹ Supreme Universal Keypad</button>
      <div className="screen-head">
        <div>
          <span className="row" style={{ gap: 10 }}>
            <h1>{keypad.name}</h1>
            <button className="ukp-link" onClick={() => rename(keypad, onKeypadUpdated)}>Rename</button>
          </span>
          <p className="muted">{room?.name ?? "Unassigned"} • {keypad.status === "online" ? "Online" : "Offline"}</p>
        </div>
      </div>

      {controls === null && (
        <div className="card ukp-gate-notice">
          <p>This keypad's button count hasn't been set up yet.</p>
          <p className="muted">
            Tell SupremeOS how many physical buttons this keypad has — button 1 is control id
            0, button 2 is 1, and so on (matches the numbering the driver itself reports over
            the wire). This is remembered even if the gateway restarts, so you only set it up
            once.
          </p>
          <ButtonCountSetup
            suggested={capabilities?.controls.length ?? null}
            onSet={async (n) => {
              await client.updateDevice(keypad.id, { metadata: { ...keypad.metadata, buttonCount: n } });
              onKeypadUpdated();
            }}
          />
          <p className="muted" style={{ marginTop: 16 }}>
            Don't know the button count? You can still program a single button manually if you
            know its control id (e.g. from the keypad's install documentation).
          </p>
          <ManualControlEntry onAdd={(control) => onConfigure(control, "short_press")} />
        </div>
      )}

      {controls && controls.length > 0 && (
        <div className="ukp-button-grid">
          {controls.map((control) => {
            const forControl = mappings.filter((m) => m.input.control === control.id);
            const short = forControl.find((m) => m.input.event === "short_press") ?? null;
            const longStart = forControl.find((m) => m.input.event === "hold_start") ?? null;
            const longEnd = forControl.find((m) => m.input.event === "hold_end") ?? null;
            const label = control.label ?? `Button ${Number(control.id) + 1 || control.id}`;
            return (
              <div key={control.id} className="ukp-button-card">
                <span className="ukp-button-label">{label}</span>
                <div className="ukp-press-row">
                  <PressSlot
                    title="Short Press"
                    devices={devices}
                    mapping={short}
                    onConfigure={() => onConfigure(control.id, "short_press")}
                    onEdit={() => short && onEdit(short)}
                    onRemove={() => short && remove(short)}
                  />
                  <PressSlot
                    title="Long Press"
                    subtitle="Start / end preserved independently"
                    devices={devices}
                    mapping={longStart}
                    secondaryMapping={longEnd}
                    onConfigure={() => onConfigure(control.id, "hold_start")}
                    onEdit={() => longStart && onEdit(longStart)}
                    onRemove={() => longStart && remove(longStart)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** § Universal Keypad — same rename pattern as `device-detail-sections.tsx`'s
 * `DeviceManageActions.rename()` (reused verbatim, not a second implementation): a real
 * keypad is still just a `Device`, renamed through the SAME generic `updateDevice` endpoint
 * every other device uses. */
async function rename(keypad: Device, onRenamed: () => void): Promise<void> {
  const name = window.prompt("Rename keypad", keypad.name);
  if (!name || !name.trim() || name === keypad.name) return;
  try {
    await client.updateDevice(keypad.id, { name: name.trim() });
    onRenamed();
  } catch (e) {
    window.alert(e instanceof Error ? e.message : "Could not rename this keypad.");
  }
}

/** § Casambi Universal Keypad — button-count setup. Control ids are 0-indexed to match the
 * driver's own wire numbering exactly (button 1 = control id "0", button 2 = "1", …) — never a
 * fabricated count, only ever what the installer explicitly confirms. */
function synthesizeButtonControls(count: number): KeypadCapabilityDeclaration["controls"] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i),
    kind: "button" as const,
    label: `Button ${i + 1}`,
    input: [],
    feedback: [],
  }));
}

function ButtonCountSetup({ suggested, onSet }: { suggested: number | null; onSet: (n: number) => Promise<void> }) {
  const [value, setValue] = useState(String(suggested && suggested > 0 ? suggested : 4));
  const [saving, setSaving] = useState(false);
  const n = Number.parseInt(value, 10);
  const valid = Number.isInteger(n) && n >= 1 && n <= 16;
  return (
    <div className="row" style={{ gap: 8, marginTop: 8, alignItems: "center" }}>
      <label className="ukp-field" style={{ marginBottom: 0 }}>
        <span>Number of buttons</span>
        <input type="number" min={1} max={16} value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <Button variant="primary" disabled={!valid || saving} onClick={async () => { setSaving(true); try { await onSet(n); } finally { setSaving(false); } }}>
        {saving ? "Saving…" : "Set up"}
      </Button>
      {suggested !== null && <span className="muted">Driver last reported {suggested}.</span>}
    </div>
  );
}

function ManualControlEntry({ onAdd }: { onAdd: (control: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="row" style={{ gap: 8, marginTop: 8 }}>
      <input placeholder="Control id (e.g. button-0)" value={value} onChange={(e) => setValue(e.target.value)} />
      <Button disabled={!value.trim()} onClick={() => onAdd(value.trim())}>Add mapping</Button>
    </div>
  );
}

function PressSlot({
  title, subtitle, devices, mapping, secondaryMapping, onConfigure, onEdit, onRemove,
}: {
  title: string;
  subtitle?: string;
  devices: Device[];
  mapping: KeypadMapping | null;
  secondaryMapping?: KeypadMapping | null;
  onConfigure: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div className={`ukp-press-slot${mapping ? " assigned" : ""}`}>
      <span className="ukp-press-title">{title}</span>
      {subtitle && <span className="ukp-press-subtitle">{subtitle}</span>}
      {mapping ? (
        <>
          <span className="ukp-press-summary">{summarizeMapping(mapping, devices)}</span>
          <div className="ukp-press-actions">
            <button className="ukp-link" onClick={onEdit}>Edit</button>
            <button className="ukp-link danger" onClick={onRemove}>Remove</button>
          </div>
        </>
      ) : (
        <button className="ukp-configure" onClick={onConfigure}>+ Configure</button>
      )}
      {secondaryMapping && <span className="ukp-press-summary muted">On release: {summarizeMapping(secondaryMapping, devices)}</span>}
    </div>
  );
}

// ── Mapping editor (§5-§11) — behavior selector + dynamic target/action fields ──────────────────

function MappingEditor({
  keypad, devices, existing, seed, onClose, onSaved,
}: {
  keypad: Device;
  devices: Device[];
  existing: KeypadMapping | null;
  seed: { control: string; event: KeypadMappingInput["event"] } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<KeypadMappingFormState>(() =>
    existing
      ? mappingToFormState(existing)
      : { ...emptyKeypadMappingForm(keypad.id, seed?.control ?? "", seed?.event ?? "short_press"), name: `${keypad.name} — ${seed?.control ?? ""}` },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetDevice = devices.find((d) => d.id === form.targetDeviceId) ?? null;
  // § live-confirmed fix — only offer capabilities this specific behavior actually supports
  // (e.g. "Toggle" excludes "Color" — toggling between what and what? — the backend's own
  // schema already rejects it, this just stops the installer from selecting it at all).
  const targetCapabilities = targetDevice ? targetCapabilitiesForBehavior(targetDevice, form.behavior) : [];

  async function save() {
    setError(null);
    const validation = validateKeypadMappingForm(form);
    if (validation) { setError(validation); return; }
    setSaving(true);
    try {
      if (existing) await client.updateKeypadMapping(existing.id, buildUpdateKeypadMappingRequest(form));
      else await client.createKeypadMapping(buildCreateKeypadMappingRequest(form));
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this mapping.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ukp-page">
      <button className="back" onClick={onClose}>‹ Cancel</button>
      <div className="screen-head">
        <h1>{existing ? "Edit button mapping" : "New button mapping"}</h1>
        <Button variant="primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</Button>
      </div>
      {error && <p style={{ color: "var(--aureon-color-status-critical)" }}>{error}</p>}

      <label className="ukp-field">
        <span>Name</span>
        <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
      </label>

      <label className="ukp-field">
        <span>Event</span>
        <select
          value={form.event}
          onChange={(e) => setForm((f) => ({ ...f, event: e.target.value as KeypadMappingInput["event"] }))}
        >
          <option value="short_press">Short Press</option>
          <option value="hold_start">Long Press — Start</option>
          <option value="hold_end">Long Press — End</option>
        </select>
      </label>

      <label className="ukp-field">
        <span>Behavior</span>
        <select
          value={form.behavior}
          onChange={(e) => {
            const behavior = e.target.value as KeypadMappingBehavior;
            setForm((f) => {
              // § live-confirmed fix — a capability valid for the OLD behavior (e.g. "Color"
              // under "Direct") can be invalid for the new one ("Toggle") — reset to the
              // first still-valid choice rather than carry forward a combination the
              // backend's own schema would reject at save time.
              const stillValid = targetDevice && targetCapabilitiesForBehavior(targetDevice, behavior).includes(f.targetCapability as CapabilityKind);
              const fallback = targetDevice ? targetCapabilitiesForBehavior(targetDevice, behavior)[0] ?? null : null;
              return { ...f, behavior, targetCapability: stillValid ? f.targetCapability : fallback };
            });
          }}
        >
          {KEYPAD_BEHAVIORS.map((b) => <option key={b} value={b}>{BEHAVIOR_LABELS[b]}</option>)}
        </select>
      </label>
      <p className="muted">{BEHAVIOR_DESCRIPTIONS[form.behavior]}</p>

      {behaviorRequiresTarget(form.behavior) && (
        <TargetPicker devices={devices} form={form} setForm={setForm} targetDevice={targetDevice} targetCapabilities={targetCapabilities} />
      )}

      {form.behavior === "alternate" && targetDevice && (
        <p className="muted ukp-alternate-preview">
          {alternatePreview(form.targetCapability ?? undefined).first} · {alternatePreview(form.targetCapability ?? undefined).next}
        </p>
      )}

      {behaviorRequiresActions(form.behavior) && (
        <ActionListEditor
          devices={devices}
          actions={form.actions}
          onChange={(actions) => setForm((f) => ({ ...f, actions }))}
          cycleHint={form.behavior === "cycle"}
        />
      )}
    </div>
  );
}

function TargetPicker({
  devices, form, setForm, targetDevice, targetCapabilities,
}: {
  devices: Device[];
  form: KeypadMappingFormState;
  setForm: (fn: (f: KeypadMappingFormState) => KeypadMappingFormState) => void;
  targetDevice: Device | null;
  targetCapabilities: CapabilityKind[];
}) {
  return (
    <div className="ukp-target-picker">
      <label className="ukp-field">
        <span>Target device</span>
        <select
          value={form.targetDeviceId ?? ""}
          onChange={(e) => {
            const id = (e.target.value || null) as DeviceId | null;
            const dev = devices.find((d) => d.id === id) ?? null;
            const caps = dev ? targetCapabilitiesForBehavior(dev, form.behavior) : [];
            setForm((f) => ({ ...f, targetDeviceId: id, targetCapability: caps[0] ?? null }));
          }}
        >
          <option value="">Select a device…</option>
          {devices.filter((d) => targetableCapabilities(d).length > 0).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </label>
      {targetDevice && (
        <label className="ukp-field">
          <span>Capability</span>
          <select value={form.targetCapability ?? ""} onChange={(e) => setForm((f) => ({ ...f, targetCapability: e.target.value as CapabilityKind }))}>
            {targetCapabilities.map((c) => <option key={c} value={c}>{CAPABILITY_LABELS[c]}</option>)}
          </select>
        </label>
      )}
      {behaviorUsesStep(form.behavior) && (
        <label className="ukp-field">
          <span>Step</span>
          <input type="number" min={1} max={100} value={form.step} onChange={(e) => setForm((f) => ({ ...f, step: Number(e.target.value) || 10 }))} />
        </label>
      )}
      {deviceSupportsDimSpeed(targetDevice, form.targetCapability) && (
        <label className="ukp-field">
          <span>Transition speed (seconds)</span>
          <input
            type="number"
            min={0}
            max={60}
            step={0.5}
            placeholder="Instant"
            value={form.fadeSeconds ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, fadeSeconds: e.target.value === "" ? null : Math.max(0, Number(e.target.value)) }))}
          />
          <span className="muted">
            {form.targetCapability === "color"
              ? "How long a full warm↔cool sweep takes to ramp — blank means instant."
              : "How long a 0→100% change takes to ramp — blank means instant."}
          </span>
        </label>
      )}
    </div>
  );
}

function ActionListEditor({
  devices, actions, onChange, cycleHint,
}: {
  devices: Device[];
  actions: KeypadActionFormEntry[];
  onChange: (actions: KeypadActionFormEntry[]) => void;
  cycleHint: boolean;
}) {
  function addAction() {
    const first = devices.find((d) => targetableCapabilities(d).length > 0);
    if (!first) return;
    const cap = targetableCapabilities(first)[0]!;
    const def = resolveCommandDefinitions(cap)[0];
    onChange([...actions, { deviceId: first.id, capability: cap, action: def?.action ?? null, params: {} }]);
  }
  function updateAction(i: number, patch: Partial<KeypadActionFormEntry>) {
    onChange(actions.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  }
  function removeAction(i: number) {
    onChange(actions.filter((_, idx) => idx !== i));
  }

  return (
    <div className="ukp-actions">
      <div className="screen-head">
        <span>{cycleHint ? "Actions to cycle through, in order" : "Actions"}</span>
        <Button onClick={addAction}>Add action</Button>
      </div>
      {actions.map((a, i) => {
        const device = devices.find((d) => d.id === a.deviceId) ?? null;
        const caps = device ? targetableCapabilities(device) : [];
        const defs = a.capability ? resolveCommandDefinitions(a.capability) : [];
        return (
          <div key={i} className="ukp-action-row card">
            {cycleHint && <span className="ukp-cycle-index">{i + 1}</span>}
            <select value={a.deviceId} onChange={(e) => {
              const dev = devices.find((d) => d.id === e.target.value) ?? null;
              const cap = dev ? targetableCapabilities(dev)[0] : undefined;
              updateAction(i, { deviceId: e.target.value as DeviceId, capability: cap ?? a.capability, action: null, params: {} });
            }}>
              {devices.filter((d) => targetableCapabilities(d).length > 0).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            {caps.length > 1 && (
              <select value={a.capability} onChange={(e) => updateAction(i, { capability: e.target.value as CapabilityKind, action: null, params: {} })}>
                {caps.map((c) => <option key={c} value={c}>{CAPABILITY_LABELS[c]}</option>)}
              </select>
            )}
            <select value={a.action ?? ""} onChange={(e) => updateAction(i, { action: e.target.value || null, params: {} })}>
              {defs.map((d) => <option key={d.action ?? d.label} value={d.action ?? ""}>{d.label}</option>)}
            </select>
            <Button variant="danger" onClick={() => removeAction(i)}>✕</Button>
          </div>
        );
      })}
    </div>
  );
}

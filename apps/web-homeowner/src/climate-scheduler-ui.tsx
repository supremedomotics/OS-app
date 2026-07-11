import { useEffect, useMemo, useState } from "react";
import type { Device } from "@supreme/domain-model";
import type { ClimateScheduleEvent, ClimateScheduleEventInput } from "@supreme/sdk";
import { client } from "./api.js";

/**
 * The full HVAC scheduler (§ HVAC Detail Page "Schedule") — opened from the
 * ClimateConsole's Schedule quick action. One-time / daily / weekly events, each
 * carrying a target temperature/mode/fan speed; multiple events per device; enable/
 * disable per event; copy-day; a per-device holiday mode that suspends every event for
 * that device. Every event here is executed by SupremeOS's minute tick (§ "These
 * schedules are executed by SupremeOS, not CoolMaster") — this page never talks to the
 * driver directly, only to the same temperature/onoff commands the console itself uses.
 */

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MODE_LABELS: Record<string, string> = { heat: "Heat", cool: "Cool", auto: "Auto", fan_only: "Fan" };

function fmtTime(atMinutes: number): string {
  const h = Math.floor(atMinutes / 60);
  const m = atMinutes % 60;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${period}`;
}

function recurrenceSummary(e: ClimateScheduleEvent): string {
  if (e.recurrence === "once") return e.date ?? "One-time";
  if (e.recurrence === "daily") return "Every day";
  const days = (e.weekdays ?? []).slice().sort().map((d) => WEEKDAY_LABELS[d]);
  return days.join(", ") || "Weekly";
}

interface EventDraft {
  id?: string;
  recurrence: "once" | "daily" | "weekly";
  date: string;
  weekdays: number[];
  time: string; // HH:MM, local
  targetC: number;
  mode: "heat" | "cool" | "auto" | "fan_only";
  fanSpeed: string;
  label: string;
  enabled: boolean;
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
function minutesToTime(mins: number): string {
  return `${Math.floor(mins / 60).toString().padStart(2, "0")}:${(mins % 60).toString().padStart(2, "0")}`;
}

function draftFromEvent(e?: ClimateScheduleEvent): EventDraft {
  const today = new Date().toISOString().slice(0, 10);
  if (!e) {
    return { recurrence: "daily", date: today, weekdays: [1, 2, 3, 4, 5], time: "07:00", targetC: 22, mode: "cool", fanSpeed: "", label: "", enabled: true };
  }
  return {
    id: e.id, recurrence: e.recurrence, date: e.date ?? today, weekdays: e.weekdays ?? [1, 2, 3, 4, 5],
    time: minutesToTime(e.atMinutes), targetC: e.targetC, mode: e.mode, fanSpeed: e.fanSpeed ?? "", label: e.label ?? "", enabled: e.enabled,
  };
}

function draftToInput(draft: EventDraft, deviceId: string): ClimateScheduleEventInput {
  return {
    ...(draft.id ? { id: draft.id } : {}),
    deviceId,
    enabled: draft.enabled,
    recurrence: draft.recurrence,
    ...(draft.recurrence === "once" ? { date: draft.date } : {}),
    ...(draft.recurrence === "weekly" ? { weekdays: draft.weekdays } : {}),
    atMinutes: timeToMinutes(draft.time),
    targetC: draft.targetC,
    mode: draft.mode,
    ...(draft.fanSpeed ? { fanSpeed: draft.fanSpeed } : {}),
    ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
  };
}

function EventEditor({
  draft, modes, fanSpeeds, onChange, onSave, onCancel,
}: {
  draft: EventDraft; modes: string[]; fanSpeeds: string[];
  onChange: (d: EventDraft) => void; onSave: () => void; onCancel: () => void;
}) {
  const toggleWeekday = (d: number) => {
    const has = draft.weekdays.includes(d);
    onChange({ ...draft, weekdays: has ? draft.weekdays.filter((x) => x !== d) : [...draft.weekdays, d].sort() });
  };
  return (
    <div className="climate-modal-veil" onClick={onCancel}>
      <div className="climate-modal sched-editor" onClick={(e) => e.stopPropagation()}>
        <div className="climate-modal-head">
          <h3>{draft.id ? "Edit Event" : "New Event"}</h3>
          <button className="climate-icon-btn" onClick={onCancel} aria-label="Close">✕</button>
        </div>
        <div className="sched-editor-body">
          <label className="sched-field">
            <span>Label (optional)</span>
            <input type="text" value={draft.label} placeholder="e.g. Morning comfort" onChange={(e) => onChange({ ...draft, label: e.target.value })} />
          </label>

          <div className="sched-field">
            <span>Repeats</span>
            <div className="climate-hw-row">
              {(["once", "daily", "weekly"] as const).map((r) => (
                <button key={r} className={`climate-hw-btn${draft.recurrence === r ? " on" : ""}`} onClick={() => onChange({ ...draft, recurrence: r })}>
                  <span className="climate-hw-label">{r === "once" ? "One-Time" : r === "daily" ? "Daily" : "Weekly"}</span>
                </button>
              ))}
            </div>
          </div>

          {draft.recurrence === "once" && (
            <label className="sched-field">
              <span>Date</span>
              <input type="date" value={draft.date} onChange={(e) => onChange({ ...draft, date: e.target.value })} />
            </label>
          )}
          {draft.recurrence === "weekly" && (
            <div className="sched-field">
              <span>Days</span>
              <div className="sched-weekday-row">
                {WEEKDAY_LABELS.map((label, d) => (
                  <button key={d} className={`sched-weekday${draft.weekdays.includes(d) ? " on" : ""}`} onClick={() => toggleWeekday(d)}>{label}</button>
                ))}
              </div>
            </div>
          )}

          <label className="sched-field">
            <span>Time</span>
            <input type="time" value={draft.time} onChange={(e) => onChange({ ...draft, time: e.target.value })} />
          </label>

          <div className="sched-field">
            <span>Temperature</span>
            <div className="sched-temp-row">
              <button className="climate-icon-btn" onClick={() => onChange({ ...draft, targetC: Math.max(5, draft.targetC - 0.5) })}>−</button>
              <span className="sched-temp-value">{draft.targetC.toFixed(1)}°C</span>
              <button className="climate-icon-btn" onClick={() => onChange({ ...draft, targetC: Math.min(35, draft.targetC + 0.5) })}>+</button>
            </div>
          </div>

          <div className="sched-field">
            <span>Mode</span>
            <div className="climate-hw-row">
              {modes.map((m) => (
                <button key={m} className={`climate-hw-btn${draft.mode === m ? " on" : ""}`} onClick={() => onChange({ ...draft, mode: m as EventDraft["mode"] })}>
                  <span className="climate-hw-label">{MODE_LABELS[m] ?? m}</span>
                </button>
              ))}
            </div>
          </div>

          {fanSpeeds.length > 0 && (
            <div className="sched-field">
              <span>Fan Speed</span>
              <div className="climate-hw-row">
                <button className={`climate-hw-btn${draft.fanSpeed === "" ? " on" : ""}`} onClick={() => onChange({ ...draft, fanSpeed: "" })}>
                  <span className="climate-hw-label">Unchanged</span>
                </button>
                {fanSpeeds.map((s) => (
                  <button key={s} className={`climate-hw-btn${draft.fanSpeed === s ? " on" : ""}`} onClick={() => onChange({ ...draft, fanSpeed: s })}>
                    <span className="climate-hw-label">{s}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <label className="climate-modal-row">
            <span>Enabled</span>
            <button className={`climate-toggle${draft.enabled ? " on" : ""}`} onClick={() => onChange({ ...draft, enabled: !draft.enabled })} aria-pressed={draft.enabled}>
              <span className="climate-toggle-knob" />
            </button>
          </label>
        </div>
        <div className="sched-editor-actions">
          <button className="climate-modal-action" onClick={onCancel}>Cancel</button>
          <button className="climate-advanced-btn sched-save" onClick={onSave} disabled={draft.recurrence === "weekly" && draft.weekdays.length === 0}>Save Event</button>
        </div>
      </div>
    </div>
  );
}

export function ClimateSchedulerPage({
  device, modes, fanSpeeds, onBack,
}: { device: Device; modes: string[]; fanSpeeds: string[]; onBack: () => void }) {
  const [events, setEvents] = useState<ClimateScheduleEvent[]>([]);
  const [holidayDeviceIds, setHolidayDeviceIds] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<EventDraft | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyFrom, setCopyFrom] = useState(1);
  const [copyTo, setCopyTo] = useState<number[]>([]);

  useEffect(() => {
    void client.climateSchedule().then((res) => {
      setEvents(res.events);
      setHolidayDeviceIds(res.holidayDeviceIds);
      setLoaded(true);
    });
  }, []);

  const deviceEvents = useMemo(() => events.filter((e) => e.deviceId === device.id).sort((a, b) => a.atMinutes - b.atMinutes), [events, device.id]);
  const onHoliday = holidayDeviceIds.includes(device.id);

  const persist = async (nextEvents: ClimateScheduleEvent[], nextHoliday: string[]) => {
    const res = await client.setClimateSchedule({ events: nextEvents, holidayDeviceIds: nextHoliday });
    setEvents(res.events);
    setHolidayDeviceIds(res.holidayDeviceIds);
  };

  const saveEvent = async (draft: EventDraft) => {
    const input = draftToInput(draft, device.id);
    const others = events.filter((e) => e.id !== draft.id);
    // The PUT endpoint validates + assigns an id server-side for new events; existing
    // events keep theirs since draft.id is threaded through.
    const merged = [...others, input as ClimateScheduleEvent];
    await persist(merged, holidayDeviceIds);
    setEditing(null);
  };

  const removeEvent = async (id: string) => {
    if (!window.confirm("Remove this scheduled event?")) return;
    await persist(events.filter((e) => e.id !== id), holidayDeviceIds);
  };

  const toggleEvent = async (e: ClimateScheduleEvent) => {
    await persist(events.map((x) => (x.id === e.id ? { ...x, enabled: !x.enabled } : x)), holidayDeviceIds);
  };

  const toggleHoliday = async () => {
    const next = onHoliday ? holidayDeviceIds.filter((id) => id !== device.id) : [...holidayDeviceIds, device.id];
    await persist(events, next);
  };

  const applyCopyDay = async () => {
    if (copyTo.length === 0) { setCopyOpen(false); return; }
    const next = events.map((e) => {
      if (e.deviceId !== device.id || e.recurrence !== "weekly" || !(e.weekdays ?? []).includes(copyFrom)) return e;
      const weekdays = [...new Set([...(e.weekdays ?? []), ...copyTo])].sort();
      return { ...e, weekdays };
    });
    await persist(next, holidayDeviceIds);
    setCopyOpen(false);
    setCopyTo([]);
  };

  return (
    <div className="climate-console sched-page">
      <div className="climate-main">
        <div className="climate-head-card">
          <button className="climate-back" onClick={onBack} aria-label="Back">←</button>
          <div className="climate-head-ic">📅</div>
          <div className="climate-head-meta">
            <h2>Schedule</h2>
            <p>{device.name}</p>
          </div>
        </div>

        <div className="climate-info-card sched-holiday-card">
          <div className="climate-info-head">
            <span className="climate-info-title">Holiday Mode</span>
          </div>
          <p className="sched-holiday-copy">Suspends every scheduled event for this unit until turned off — SupremeOS won't apply any schedule while it's on.</p>
          <button className={`climate-toggle${onHoliday ? " on" : ""} sched-holiday-toggle`} onClick={() => void toggleHoliday()} aria-pressed={onHoliday}>
            <span className="climate-toggle-knob" />
          </button>
        </div>

        <div className="climate-quick sched-list-card">
          <div className="sched-list-head">
            <span className="climate-field-label">Events</span>
            <div className="sched-list-actions">
              <button className="climate-modal-action" onClick={() => setCopyOpen(true)} disabled={deviceEvents.every((e) => e.recurrence !== "weekly")}>Copy Day</button>
              <button className="climate-advanced-btn sched-add-btn" onClick={() => setEditing(draftFromEvent())}>+ Add Event</button>
            </div>
          </div>

          {loaded && deviceEvents.length === 0 && <p className="climate-modal-empty">No scheduled events yet — add one to let SupremeOS run this unit automatically.</p>}

          <div className="sched-event-list">
            {deviceEvents.map((e) => (
              <div key={e.id} className={`sched-event-row${e.enabled ? "" : " off"}`}>
                <button className={`climate-toggle${e.enabled ? " on" : ""}`} onClick={() => void toggleEvent(e)} aria-pressed={e.enabled}>
                  <span className="climate-toggle-knob" />
                </button>
                <div className="sched-event-meta" onClick={() => setEditing(draftFromEvent(e))}>
                  <span className="sched-event-title">{e.label || `${fmtTime(e.atMinutes)} · ${e.targetC}°C`}</span>
                  <span className="sched-event-sub">{fmtTime(e.atMinutes)} · {recurrenceSummary(e)} · {e.targetC}°C · {MODE_LABELS[e.mode] ?? e.mode}{e.fanSpeed ? ` · ${e.fanSpeed}` : ""}</span>
                </div>
                <button className="climate-icon-btn" onClick={() => void removeEvent(e.id)} aria-label="Remove event">🗑</button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {editing && (
        <EventEditor
          draft={editing} modes={modes} fanSpeeds={fanSpeeds}
          onChange={setEditing}
          onSave={() => void saveEvent(editing)}
          onCancel={() => setEditing(null)}
        />
      )}

      {copyOpen && (
        <div className="climate-modal-veil" onClick={() => setCopyOpen(false)}>
          <div className="climate-modal" onClick={(e) => e.stopPropagation()}>
            <div className="climate-modal-head">
              <h3>Copy Day</h3>
              <button className="climate-icon-btn" onClick={() => setCopyOpen(false)} aria-label="Close">✕</button>
            </div>
            <div className="sched-editor-body">
              <label className="sched-field">
                <span>Copy events from</span>
                <div className="sched-weekday-row">
                  {WEEKDAY_LABELS.map((label, d) => (
                    <button key={d} className={`sched-weekday${copyFrom === d ? " on" : ""}`} onClick={() => setCopyFrom(d)}>{label}</button>
                  ))}
                </div>
              </label>
              <label className="sched-field">
                <span>To</span>
                <div className="sched-weekday-row">
                  {WEEKDAY_LABELS.map((label, d) => (
                    <button
                      key={d} disabled={d === copyFrom}
                      className={`sched-weekday${copyTo.includes(d) ? " on" : ""}`}
                      onClick={() => setCopyTo((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </label>
            </div>
            <div className="sched-editor-actions">
              <button className="climate-modal-action" onClick={() => setCopyOpen(false)}>Cancel</button>
              <button className="climate-advanced-btn sched-save" onClick={() => void applyCopyDay()} disabled={copyTo.length === 0}>Copy</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

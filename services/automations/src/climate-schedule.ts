/**
 * Per-device HVAC scheduling (§ HVAC Detail Page "Schedule") — one-time, daily, or
 * weekly events that set a target temperature/mode/fan speed on a specific climate
 * device at a wall-clock time. Distinct from the simpler whole-home ClimateProgram
 * (climate-program.ts, a step-function weekday/weekend setpoint-only schedule applied
 * uniformly to every temperature device) — this is the richer, per-device, per-event
 * scheduler the HVAC console's "Schedule" quick action opens, executed by SupremeOS
 * (a regular capability command on the tick, same as any other automation here), never
 * by the driver itself. Pure + deterministic, mirroring services/scenes/src/schedule.ts's
 * shape exactly: given the events + the current local time, return what's due.
 */

export type ClimateRecurrence = "once" | "daily" | "weekly";

export interface ClimateScheduleEvent {
  id: string;
  deviceId: string;
  enabled: boolean;
  recurrence: ClimateRecurrence;
  /** ISO date (YYYY-MM-DD) — required and only meaningful for recurrence "once". */
  date?: string;
  /** 0=Sun..6=Sat — required and only meaningful for recurrence "weekly". */
  weekdays?: number[];
  /** Minutes since local midnight, 0..1439. */
  atMinutes: number;
  targetC: number;
  mode: "heat" | "cool" | "auto" | "fan_only";
  fanSpeed?: string;
  label?: string;
}

export class ClimateScheduleError extends Error {}

export function validateClimateScheduleEvent(e: unknown): ClimateScheduleEvent {
  const o = e as Partial<ClimateScheduleEvent>;
  if (!o || typeof o.deviceId !== "string" || !o.deviceId) throw new ClimateScheduleError("event needs a deviceId");
  if (o.recurrence !== "once" && o.recurrence !== "daily" && o.recurrence !== "weekly") {
    throw new ClimateScheduleError("recurrence must be once, daily, or weekly");
  }
  if (typeof o.atMinutes !== "number" || o.atMinutes < 0 || o.atMinutes > 1439) {
    throw new ClimateScheduleError("atMinutes must be 0..1439");
  }
  if (typeof o.targetC !== "number" || o.targetC < 5 || o.targetC > 35) {
    throw new ClimateScheduleError("targetC out of range (5..35)");
  }
  if (o.mode !== "heat" && o.mode !== "cool" && o.mode !== "auto" && o.mode !== "fan_only") {
    throw new ClimateScheduleError("mode must be heat, cool, auto, or fan_only");
  }
  if (o.recurrence === "once" && (typeof o.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.date))) {
    throw new ClimateScheduleError("a one-time event needs a YYYY-MM-DD date");
  }
  if (o.recurrence === "weekly" && (!Array.isArray(o.weekdays) || o.weekdays.length === 0 || o.weekdays.some((d) => d < 0 || d > 6))) {
    throw new ClimateScheduleError("a weekly event needs at least one weekday (0..6)");
  }
  return {
    id: typeof o.id === "string" && o.id ? o.id : `cse_${o.deviceId}_${o.atMinutes}_${Math.random().toString(36).slice(2, 8)}`,
    deviceId: o.deviceId,
    enabled: o.enabled !== false,
    recurrence: o.recurrence,
    ...(o.recurrence === "once" ? { date: o.date } : {}),
    ...(o.recurrence === "weekly" ? { weekdays: o.weekdays } : {}),
    atMinutes: o.atMinutes,
    targetC: o.targetC,
    mode: o.mode,
    ...(typeof o.fanSpeed === "string" && o.fanSpeed ? { fanSpeed: o.fanSpeed } : {}),
    ...(typeof o.label === "string" && o.label ? { label: o.label } : {}),
  };
}

export interface ClimateScheduleContext {
  /** Current local minute-of-day (0..1439). */
  nowMinute: number;
  /** Local day-of-week, 0=Sun..6=Sat. */
  dayOfWeek: number;
  /** Local calendar date, YYYY-MM-DD. */
  todayIso: string;
}

/**
 * The events due to fire at `ctx.nowMinute` for devices NOT currently in holiday mode
 * (§ Holiday mode: "These schedules are executed by SupremeOS" — holiday mode is a
 * SupremeOS-side suspension, not a driver feature, so it's applied here, before any
 * command is ever built). A "once" event is still returned here (not auto-disabled) —
 * the caller (ClimateScheduler) is responsible for disabling it after it actually fires,
 * since this function is pure and must not mutate.
 */
export function dueClimateEvents(
  events: ClimateScheduleEvent[],
  holidayDeviceIds: readonly string[],
  ctx: ClimateScheduleContext,
): ClimateScheduleEvent[] {
  const holiday = new Set(holidayDeviceIds);
  const out: ClimateScheduleEvent[] = [];
  for (const e of events) {
    if (!e.enabled) continue;
    if (holiday.has(e.deviceId)) continue;
    if (e.atMinutes !== ctx.nowMinute) continue;
    if (e.recurrence === "once" && e.date !== ctx.todayIso) continue;
    if (e.recurrence === "weekly" && !(e.weekdays ?? []).includes(ctx.dayOfWeek)) continue;
    out.push(e);
  }
  return out;
}

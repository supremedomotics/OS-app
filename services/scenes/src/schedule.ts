/**
 * Scene scheduling (§10) — activate a scene at a wall-clock time or anchored to sunrise/sunset
 * (with an offset). The most-requested automation ("run Evening at sunset", "Wake at 06:30"). The
 * trigger evaluation is PURE: given the schedules + the current local minute + today's sun times,
 * it returns which scenes are due this minute. The hub runner provides the clock + sun times and
 * activates the returned scenes.
 */

export type ScheduleTrigger =
  | { type: "time"; atMinutes: number }
  | { type: "solar"; event: "sunrise" | "sunset"; offsetMinutes?: number };

export interface SceneSchedule {
  id: string;
  sceneId: string;
  trigger: ScheduleTrigger;
  enabled?: boolean;
  /** Optional day-of-week filter (0=Sun..6=Sat); omit = every day. */
  days?: number[];
}

export interface ScheduleContext {
  /** Current local minute-of-day (0..1439). */
  nowMinute: number;
  /** Local day-of-week, 0=Sun..6=Sat. */
  dayOfWeek: number;
  /** Today's sunrise/sunset as local minutes-of-day. */
  sunriseMinute: number;
  sunsetMinute: number;
}

export class ScheduleError extends Error {}

/** Resolve a trigger to its fire minute-of-day given today's sun times. */
export function triggerMinute(trigger: ScheduleTrigger, sunriseMinute: number, sunsetMinute: number): number {
  if (trigger.type === "time") return trigger.atMinutes;
  const base = trigger.event === "sunrise" ? sunriseMinute : sunsetMinute;
  return base + (trigger.offsetMinutes ?? 0);
}

/**
 * The scene ids due to activate at `ctx.nowMinute`. A schedule fires when its resolved trigger
 * minute equals the current minute, it is enabled, and today matches its day filter. (The runner
 * calls this once per minute and de-dupes by minute, so each schedule fires at most once per day.)
 */
export function dueScenes(schedules: SceneSchedule[], ctx: ScheduleContext): string[] {
  const out: string[] = [];
  for (const s of schedules) {
    if (s.enabled === false) continue;
    if (s.days && !s.days.includes(ctx.dayOfWeek)) continue;
    const minute = triggerMinute(s.trigger, ctx.sunriseMinute, ctx.sunsetMinute);
    if (minute === ctx.nowMinute) out.push(s.sceneId);
  }
  return out;
}

/** Validate a schedule shape (used on write). Throws ScheduleError on malformed input. */
export function validateSchedule(s: unknown): SceneSchedule {
  const o = s as Partial<SceneSchedule>;
  if (!o || typeof o.sceneId !== "string" || !o.sceneId) throw new ScheduleError("schedule needs a sceneId");
  const t = o.trigger as ScheduleTrigger | undefined;
  if (!t) throw new ScheduleError("schedule needs a trigger");
  if (t.type === "time") {
    if (typeof t.atMinutes !== "number" || t.atMinutes < 0 || t.atMinutes > 1439) throw new ScheduleError("time trigger atMinutes must be 0..1439");
  } else if (t.type === "solar") {
    if (t.event !== "sunrise" && t.event !== "sunset") throw new ScheduleError("solar trigger event must be sunrise or sunset");
  } else {
    throw new ScheduleError("trigger type must be time or solar");
  }
  if (o.days && (!Array.isArray(o.days) || o.days.some((d) => d < 0 || d > 6))) throw new ScheduleError("days must be 0..6");
  return {
    id: typeof o.id === "string" && o.id ? o.id : `sch_${o.sceneId}_${t.type === "time" ? t.atMinutes : t.event}`,
    sceneId: o.sceneId,
    trigger: t,
    ...(o.enabled !== undefined ? { enabled: o.enabled } : {}),
    ...(o.days ? { days: o.days } : {}),
  };
}

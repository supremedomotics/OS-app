import type { CapabilityState } from "./capabilities.js";
import type { Comparator } from "./automations-dsl.js";
import type { ScheduleWindow } from "./users.js";

/**
 * Shared condition-evaluation primitives (§10, § Universal Keypad Framework).
 *
 * Extracted from `@supreme/automations`' engine so the Automation Engine and the
 * Universal Keypad Framework's Mapping Engine evaluate `device_state`/`time_window`
 * conditions identically instead of maintaining two copies of the same comparator —
 * both consume {@link CapabilityState}/{@link Comparator}/{@link ScheduleWindow}, which
 * already live here. Pure, side-effect-free, and covered by both engines' test suites.
 */

/** Read a named field off a capability state (e.g. "on", "level", "ambientC"). */
export function readCapabilityField(state: CapabilityState, field: string): unknown {
  return (state as unknown as Record<string, unknown>)[field];
}

/** Evaluate one comparator against an actual/expected value pair. */
export function evaluateComparator(actual: unknown, op: Comparator, value: unknown): boolean {
  switch (op) {
    case "changed":
      return true;
    case "eq":
      return actual === value;
    case "ne":
      return actual !== value;
    case "gt":
      return Number(actual) > Number(value);
    case "lt":
      return Number(actual) < Number(value);
    case "gte":
      return Number(actual) >= Number(value);
    case "lte":
      return Number(actual) <= Number(value);
    default:
      return false;
  }
}

/** Whether `now` falls inside a weekly schedule window (days/start/end, home-local time). */
export function isWithinScheduleWindow(window: ScheduleWindow, now: Date): boolean {
  if (!window.days.includes(now.getDay())) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= toMinutes(window.start) && minutes < toMinutes(window.end);
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

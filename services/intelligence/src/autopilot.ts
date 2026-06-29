/**
 * Auto Pilot + smart-notification suppression (pure). Given a Suggestion, its remembered state, and
 * the home's Auto Pilot settings, this decides the ONE thing to do this tick: suppress, notify
 * (once, then remind sparingly), ask for approval, or auto-execute. It encodes the product's
 * anti-spam contract precisely:
 *
 *   • Notify only once initially; only remind while the device is still ON, the area still vacant and
 *     confidence still high (the runner guarantees on/vacant; we gate on confidence + a reminder gap).
 *   • Keep On       → never notify again this on-episode.
 *   • Ignore Today  → suppress until tomorrow.
 *   • Always Ignore → permanent exclusion.
 *   • Enable Auto Pilot → flips the mode (handled by the host; recorded here).
 *
 * Auto Pilot executes automatically ONLY in auto_pilot/adaptive mode AND only above the configurable
 * decision-confidence threshold; otherwise it falls back to asking.
 */
import type { Suggestion, SuggestionAction } from "./engine.js";

export type AutoPilotMode = "notify_only" | "approval" | "auto_pilot" | "adaptive";
export const AUTO_PILOT_MODES: readonly AutoPilotMode[] = ["notify_only", "approval", "auto_pilot", "adaptive"];

export interface AutoPilotSettings {
  mode: AutoPilotMode;
  /** Decision confidence required to auto-execute (and to send reminders). Default 0.8. */
  threshold?: number;
  /** Minimum gap between reminders for the same suggestion. Default 30 min. */
  reminderMinutes?: number;
}

/** Remembered per-suggestion state (persisted by the host between ticks). */
export interface SuggestionState {
  key: string;
  firstNotifiedAt?: number;
  lastNotifiedAt?: number;
  /** The user's most recent response, for learning + transparency. */
  response?: SuggestionAction;
  /** ignore_today → suppress until this ms-epoch (next local midnight). */
  ignoreUntilMs?: number;
  /** always_ignore → permanent exclusion. */
  alwaysIgnore?: boolean;
  /** keep_on → don't notify again for the current on-episode. */
  keptOnEpisode?: boolean;
  /** Set when an automatic or user-confirmed turn-off has happened this episode. */
  executedAt?: number;
}

export type AutoPilotDecision =
  | { action: "suppress"; reason: string; notify: false }
  | { action: "notify"; kind: "suggest" | "approval"; notify: true }
  | { action: "execute"; kind: "executed"; notify: true };

const suppress = (reason: string): AutoPilotDecision => ({ action: "suppress", reason, notify: false });

/** Decide what to do with one suggestion this tick. Pure + deterministic. */
export function decideAutoPilot(suggestion: Suggestion, state: SuggestionState | undefined, settings: AutoPilotSettings, now: number): AutoPilotDecision {
  const s = state ?? { key: suggestion.key };
  const threshold = settings.threshold ?? 0.8;
  const reminderMs = (settings.reminderMinutes ?? 30) * 60_000;
  const confidence = suggestion.confidence.decision;

  // Honour prior user decisions first (cheapest + highest precedence).
  if (s.alwaysIgnore) return suppress("always_ignore");
  if (s.executedAt) return suppress("already_executed");
  if (s.keptOnEpisode) return suppress("kept_on");
  if (s.ignoreUntilMs !== undefined && now < s.ignoreUntilMs) return suppress("ignore_today");

  // Auto-execute only when allowed by mode AND confident enough; else fall through to asking.
  if ((settings.mode === "auto_pilot" || settings.mode === "adaptive") && confidence >= threshold) {
    return { action: "execute", kind: "executed", notify: true };
  }

  // Notify path. Notify once; afterward only remind once the gap has elapsed and confidence is high.
  const firstTime = s.firstNotifiedAt === undefined;
  const dueForReminder = s.lastNotifiedAt !== undefined && now - s.lastNotifiedAt >= reminderMs && confidence >= threshold;
  if (firstTime || dueForReminder) {
    return { action: "notify", kind: settings.mode === "approval" ? "approval" : "suggest", notify: true };
  }
  return suppress("debounced");
}

/** Apply a user's response to a suggestion, returning the next state to persist. */
export function applyResponse(state: SuggestionState, action: SuggestionAction, now: number): SuggestionState {
  const next: SuggestionState = { ...state, response: action };
  switch (action) {
    case "turn_off":
      next.executedAt = now; // user confirmed the off; runner performs it
      break;
    case "keep_on":
      next.keptOnEpisode = true;
      break;
    case "ignore_today":
      next.ignoreUntilMs = startOfNextUtcDay(now);
      break;
    case "always_ignore":
      next.alwaysIgnore = true;
      break;
    case "enable_auto_pilot":
      // Mode change is applied by the host to settings; nothing episode-scoped to record here.
      break;
  }
  return next;
}

/**
 * Reset the episode-scoped flags when a device turns off and on again (a fresh on-episode). Permanent
 * (always_ignore) and day-scoped (ignore_today) suppressions persist across episodes by design.
 */
export function resetEpisode(state: SuggestionState): SuggestionState {
  const { key, alwaysIgnore, ignoreUntilMs } = state;
  return { key, ...(alwaysIgnore ? { alwaysIgnore } : {}), ...(ignoreUntilMs !== undefined ? { ignoreUntilMs } : {}) };
}

/** Next local-midnight as ms-epoch (UTC-based; deployments can pass a tz-adjusted `now`). */
export function startOfNextUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

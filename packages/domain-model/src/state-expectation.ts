/**
 * What authoritative device state proves that a command took effect — the ONE definition of "done"
 * shared by the Hub (scene runs confirm a step with it) and every client (a homeowner control
 * confirms a command with it, an Experience derives Active/Partial with it).
 *
 * A Hub `SceneStep.values` IS a command, so the same mapping applies to a scene step. Only
 * capabilities whose command has an observable state counterpart are verifiable; everything else
 * returns `null` and must never be reported as confirmed.
 *
 * Two implementations exist on purpose (this one and `apps/new/shared/lib/src/residence/
 * state_expectation.dart`); both are pinned to `fixtures/state-expectation.json` by their own
 * tests, so they cannot drift apart silently.
 */
export type StateCheck = (state: Record<string, unknown>) => boolean;

export interface StateExpectation {
  capability: string;
  matches: StateCheck;
  /** For logs and tests — never shown to a homeowner. */
  description: string;
}

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

export function expectationOf(capability: string, cmd: Record<string, unknown>): StateExpectation | null {
  const action = typeof cmd.action === "string" ? cmd.action : null;
  const ex = (matches: StateCheck, description: string): StateExpectation => ({ capability, matches, description });
  switch (capability) {
    case "onoff":
      if (action === "on") return ex((s) => s.on === true, "on");
      if (action === "off") return ex((s) => s.on === false, "off");
      return null; // toggle: the target depends on prior state
    case "brightness": {
      if (action === "on") return ex((s) => s.on === true, "on");
      if (action === "off") return ex((s) => s.on === false, "off");
      const level = num(cmd.level);
      if (action === "set" && level !== null) {
        return ex(
          (s) =>
            level <= 0
              ? s.on === false || (num(s.level) ?? 100) <= 0
              : s.on === true && Math.abs((num(s.level) ?? -100) - level) <= 2,
          `level ${level}`,
        );
      }
      return null;
    }
    case "position": {
      const target = action === "open" ? 100 : action === "close" ? 0 : action === "set" ? num(cmd.position) : null;
      if (target === null) return null; // stop has no target position
      return ex((s) => s.moving !== true && Math.abs((num(s.position) ?? -100) - target) <= 2, `position ${target}`);
    }
    case "temperature": {
      const t = num(cmd.targetC);
      const mode = typeof cmd.mode === "string" ? cmd.mode : null;
      if (t === null && mode === null) return null;
      return ex(
        (s) =>
          (t === null || (num(s.targetC) !== null && Math.abs(num(s.targetC)! - t) < 0.26)) &&
          (mode === null || s.mode === mode),
        `target ${t ?? "-"} mode ${mode ?? "-"}`,
      );
    }
    case "media":
      switch (action) {
        case "play":
          return ex((s) => s.playback === "playing", "playing");
        case "pause":
          return ex((s) => s.playback === "paused", "paused");
        case "stop":
          return ex((s) => s.playback === "stopped" || s.playback === "idle", "stopped");
        case "volume": {
          const v = num(cmd.volume);
          if (v === null) return null;
          return ex((s) => num(s.volume) !== null && Math.abs(num(s.volume)! - v) <= 1, `volume ${v}`);
        }
        case "mute":
          return ex((s) => s.muted === true, "muted");
        case "unmute":
          return ex((s) => s.muted === false, "unmuted");
      }
      return null;
  }
  return null;
}

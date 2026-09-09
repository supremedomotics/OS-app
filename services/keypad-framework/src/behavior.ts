import type { AutomationExecutors } from "@supreme/automations";
import type { CapabilityCommand, KeypadMapping, KeypadMappingBehaviorState, KeypadMappingTarget } from "@supreme/domain-model";

/**
 * Behavior resolution (§ Universal Keypad Framework, Stage 2). The ONE place a non-"direct"
 * `KeypadMapping.behavior` turns into a concrete `CapabilityCommand` — always by reading the
 * target's CURRENT state via `AutomationExecutors.getState` at resolve time, never a boolean
 * or level the mapping itself remembers. The mapping's own `behaviorState` only ever
 * remembers what a PAST press did (`lastDirection`, `cycleIndex`), never what the target
 * device's state currently is — that distinction is the whole point of "authoritative live
 * state, not a locally maintained flag."
 */

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** Read the target's current on/off-shaped boolean, capability by capability — honest per
 * capability, never a guess for one this behavior doesn't recognize. */
async function readOnOff(ex: AutomationExecutors, target: KeypadMappingTarget): Promise<boolean> {
  const state = await ex.getState(target.deviceId, target.capability);
  switch (target.capability) {
    case "onoff":
      return state?.kind === "onoff" ? state.on : false;
    case "brightness":
      return state?.kind === "brightness" ? state.on : false;
    case "fan":
      return state?.kind === "fan" ? state.on : false;
    case "lock":
      // "on" reads as "unlocked" here purely so toggle's on/off inversion below applies
      // uniformly — the actual command still uses lock's own lock/unlock vocabulary.
      return state?.kind === "lock" ? !state.locked : false;
    case "vacuum":
      return state?.kind === "vacuum" ? state.status === "cleaning" : false;
    default:
      throw new Error(`keypad-framework: "toggle" behavior is not supported for capability "${target.capability}"`);
  }
}

function onOffCommand(capability: KeypadMappingTarget["capability"], turnOn: boolean): CapabilityCommand {
  switch (capability) {
    case "onoff":
      return { capability: "onoff", action: turnOn ? "on" : "off" };
    case "brightness":
      return { capability: "brightness", action: turnOn ? "on" : "off" };
    case "fan":
      return { capability: "fan", action: turnOn ? "on" : "off" };
    case "lock":
      return { capability: "lock", action: turnOn ? "unlock" : "lock" };
    case "vacuum":
      return { capability: "vacuum", action: turnOn ? "start" : "stop" };
    default:
      throw new Error(`keypad-framework: "toggle" behavior is not supported for capability "${capability}"`);
  }
}

/** Read the target's current level (0-100), for the level-shaped capabilities `alternate`/
 * `increment`/`decrement` step. */
async function readLevel(ex: AutomationExecutors, target: KeypadMappingTarget): Promise<number> {
  const state = await ex.getState(target.deviceId, target.capability);
  if (target.capability === "brightness") return state?.kind === "brightness" ? state.level : 0;
  if (target.capability === "position") return state?.kind === "position" ? state.position : 0;
  throw new Error(`keypad-framework: level-stepping behaviors are not supported for capability "${target.capability}"`);
}

/** § Keypad dim-speed — `fadeMs` only ever applies to `brightness` (the only level-stepping
 * capability with a real fade concept; `position` is motor movement, not a light ramp, and
 * has no such field on its own `CapabilityCommand` variant). */
function levelCommand(capability: KeypadMappingTarget["capability"], level: number, fadeMs?: number): CapabilityCommand {
  if (capability === "brightness") return { capability: "brightness", action: "set", level, ...(fadeMs !== undefined ? { fadeMs } : {}) };
  if (capability === "position") return { capability: "position", action: "set", position: level };
  throw new Error(`keypad-framework: level-stepping behaviors are not supported for capability "${capability}"`);
}

export interface ResolvedBehavior {
  command: CapabilityCommand;
  /** Present only when the behavior mutates `behaviorState` (alternate/cycle) — absent for
   * toggle/increment/decrement, which never persist anything about their own past firings. */
  nextBehaviorState?: KeypadMappingBehaviorState;
}

/**
 * Resolve one non-"direct" mapping firing into a single command (+ any behaviorState update
 * to persist). Throws for `"direct"`/`"cycle"` — the caller (the mapping engine) handles
 * those itself, since `"direct"` runs the whole `actions` list and `"cycle"` walks it rather
 * than resolving a synthesized command at all.
 */
export async function resolveBehaviorCommand(
  ex: AutomationExecutors,
  mapping: Pick<KeypadMapping, "behavior" | "target" | "behaviorState">,
): Promise<ResolvedBehavior> {
  const target = mapping.target;
  if (!target) throw new Error(`keypad-framework: behavior "${mapping.behavior}" has no target`);

  switch (mapping.behavior) {
    case "toggle": {
      const on = await readOnOff(ex, target);
      return { command: onOffCommand(target.capability, !on) };
    }
    case "alternate": {
      // First-ever firing (lastDirection still null) starts UP, matching the spec's example
      // literally ("First Long Press → DIM UP"); every firing after that flips.
      const direction: "up" | "down" = mapping.behaviorState.lastDirection === "up" ? "down" : "up";
      const level = await readLevel(ex, target);
      const nextLevel = clamp(direction === "up" ? level + target.step : level - target.step, 0, 100);
      return {
        command: levelCommand(target.capability, nextLevel, target.fadeMs),
        nextBehaviorState: { ...mapping.behaviorState, lastDirection: direction },
      };
    }
    case "increment": {
      const level = await readLevel(ex, target);
      return { command: levelCommand(target.capability, clamp(level + target.step, 0, 100), target.fadeMs) };
    }
    case "decrement": {
      const level = await readLevel(ex, target);
      return { command: levelCommand(target.capability, clamp(level - target.step, 0, 100), target.fadeMs) };
    }
    default:
      throw new Error(`keypad-framework: resolveBehaviorCommand does not handle "${mapping.behavior}"`);
  }
}

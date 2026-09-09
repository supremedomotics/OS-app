import { z } from "zod";
import { AutomationAction, AutomationCondition } from "./automations-dsl.js";
import { CapabilityKind } from "./capabilities.js";
import { DeviceId, HomeId, KeypadMappingId } from "./ids.js";
import { KeypadInputEventType } from "./keypad-events.js";

/**
 * Mapping Engine Interface (§ Universal Keypad Framework, Phase 1 — backend
 * schema/API only, no visual editor yet).
 *
 * A `KeypadMapping` is the protocol-independent pipeline the brief asks for:
 * `Input → Action → Target Device → Capability → Optional Conditions → Optional
 * Delays → Optional Variables`. It deliberately REUSES {@link AutomationCondition}
 * and {@link AutomationAction} verbatim from the existing, already-shipped Automation
 * DSL (`automations-dsl.ts`) rather than re-declaring an equivalent shape — "Optional
 * Delays" is simply an `AutomationAction` of type `"delay"` in the same `actions`
 * array, and every action still ultimately resolves to a {@link CapabilityCommand}/
 * scene activation, so a keypad mapping can NEVER become a protocol-to-protocol
 * shortcut: it is always Input (protocol-independent event) → Action (Supreme
 * capability vocabulary) → Target Device, with the target driver as the only thing
 * that ever sees protocol-native bytes on either end. This is a distinct resource
 * from `Automation` on purpose (§ ADR 0016) — a keypad mapping is installer
 * commissioning work tied to physical bus wiring, not a homeowner-authored
 * automation — and the existing Automation Engine/DSL is left completely untouched.
 */

/** Which physical keypad control + which normalized input event triggers this mapping. */
export const KeypadMappingInput = z.object({
  keypadId: DeviceId,
  control: z.string().min(1),
  event: KeypadInputEventType,
});
export type KeypadMappingInput = z.infer<typeof KeypadMappingInput>;

/**
 * Behavior (§ Universal Keypad — Stage 2). How this mapping's firing turns into a command,
 * layered ON TOP of the plain `actions` list above rather than replacing it:
 *
 * - `"direct"` (the default, and the ONLY behavior Phase 1 ever produced) — unchanged:
 *   `actions` runs exactly as declared, in order. Every mapping created before Stage 2
 *   is `"direct"` and behaves identically to before.
 * - `"toggle"` — a SINGLE resolved `device_command` against `target`, computed from the
 *   target's CURRENT authoritative state (read fresh via `AutomationExecutors.getState`
 *   at firing time — never a boolean the mapping itself remembers) each time it fires.
 *   Turning the light off from a different interface and then pressing the keypad still
 *   turns it ON, because the engine reads real state, not a locally-tracked flag.
 * - `"alternate"` — a single resolved `device_command` that flips direction every firing
 *   (dim up, dim down, dim up, …), persisted in `behaviorState.lastDirection` so a restart
 *   resumes the correct next direction instead of always restarting at "up".
 * - `"increment"` / `"decrement"` — a single resolved `device_command` that always steps
 *   the target's level the same direction (no alternation, no persisted direction).
 * - `"cycle"` — walks `actions` one at a time per firing (not "run them all" like
 *   `"direct"`), wrapping back to the start; the current position is `behaviorState.
 *   cycleIndex`, persisted the same way `lastDirection` is.
 *
 * `target`/`behaviorState` are meaningless for `"direct"` (always null/default) and
 * required for every other behavior — enforced by the object-level `.superRefine` below,
 * not left as a silent runtime gap.
 */
export const KeypadMappingBehavior = z.enum(["direct", "toggle", "alternate", "cycle", "increment", "decrement"]);
export type KeypadMappingBehavior = z.infer<typeof KeypadMappingBehavior>;

/**
 * § Universal Keypad Framework, Stage 5A-3 — Capability Compatibility Validation.
 *
 * These are the SAME capability sets `@supreme/keypad-framework`'s `behavior.ts`
 * (`readOnOff`/`readLevel`) already enforces at execution time — promoted here as
 * the single source of truth so `KeypadMapping`'s own schema validation (below) can
 * reject an impossible behavior/capability combination at create/update time instead
 * of only discovering it on the mapping's first firing. Never re-derive this list a
 * second time anywhere else; `behavior.ts` still owns the actual command-building
 * switch statements (which command shape, which action), this only owns "is this
 * capability even eligible for this behavior at all." Protocol-independent by
 * construction — it's keyed on Supreme's own `CapabilityKind` vocabulary, never a
 * driver/brand distinction.
 */
export const TOGGLE_CAPABLE_CAPABILITIES: readonly CapabilityKind[] = ["onoff", "brightness", "fan", "lock", "vacuum"];
export const LEVEL_STEP_CAPABLE_CAPABILITIES: readonly CapabilityKind[] = ["brightness", "position"];

/** The single device+capability a non-`"direct"` behavior resolves its command against.
 * `step` is the level delta `alternate`/`increment`/`decrement` apply to a level-shaped
 * capability (brightness/position) — meaningless for `toggle`/`cycle`. */
export const KeypadMappingTarget = z.object({
  deviceId: DeviceId,
  capability: CapabilityKind,
  step: z.number().min(1).max(100).default(10),
  /** § Keypad dim-speed — ramp duration (ms) for a resolved brightness/color level command,
   * same shape/contract as `CapabilityCommand.brightness.fadeMs`. Meaningless (simply unused)
   * for `onoff`/any non-level capability, exactly like `step` already is. Optional: omitted
   * means instant, unchanged from every mapping created before this field existed. */
  fadeMs: z.number().int().min(0).max(60_000).optional(),
});
export type KeypadMappingTarget = z.infer<typeof KeypadMappingTarget>;

/** Persisted, behavior-derived state — the ONLY state a keypad mapping remembers about
 * its own past firings (never target device state, which always comes from `getState`).
 * `lastDirection` drives `"alternate"`; `cycleIndex` drives `"cycle"`. Both survive a
 * restart via the mapping's own persistence (§ Stage 2 — see `@supreme/persistence`'s
 * `keypad-mapping-repo.ts`), not an in-process-only cache. */
export const KeypadMappingBehaviorState = z.object({
  lastDirection: z.enum(["up", "down"]).nullable().default(null),
  cycleIndex: z.number().int().min(0).default(0),
});
export type KeypadMappingBehaviorState = z.infer<typeof KeypadMappingBehaviorState>;

export const KeypadMapping = z
  .object({
    id: KeypadMappingId,
    homeId: HomeId,
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    input: KeypadMappingInput,
    /** All must hold for `actions`/the resolved behavior command to run (identical
     * evaluation semantics to `Automation.conditions` — see `@supreme/domain-model`'s
     * `condition-eval.ts`). */
    conditions: z.array(AutomationCondition).default([]),
    /** Runs in order for `"direct"`; walked one-at-a-time for `"cycle"`; unused (but still
     * schema-valid, may be empty) for `"toggle"`/`"alternate"`/`"increment"`/`"decrement"`,
     * which resolve their own single command from `target` instead. */
    actions: z.array(AutomationAction).default([]),
    behavior: KeypadMappingBehavior.default("direct"),
    target: KeypadMappingTarget.nullable().default(null),
    behaviorState: KeypadMappingBehaviorState.default({ lastDirection: null, cycleIndex: 0 }),
    /** Optional Variables: named constants this mapping's actions/conditions were
     * authored against (e.g. `{ step: 10 }` for a `"{{step}}"` reference used when the
     * mapping was created). Every `AutomationAction`/`AutomationCondition` above is
     * ALWAYS fully concrete/valid by the time it's stored here — substitution happens
     * once, at create/update time, via `@supreme/keypad-framework`'s `expandVariables`,
     * never re-applied at execution time (see that module for why: this schema's
     * strict numeric/boolean fields can't hold a template string). Retained here
     * purely so a future editor can re-surface "this mapping's tunable constants."
     * Restricted to primitives (never an object/array). */
    variables: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  })
  .superRefine((m, ctx) => {
    if (m.behavior === "direct") {
      if (m.actions.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actions"], message: "a \"direct\" mapping needs at least one action" });
      }
      return;
    }
    if (!m.target) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["target"], message: `behavior "${m.behavior}" requires a target` });
    }
    if (m.behavior === "cycle" && m.actions.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actions"], message: "a \"cycle\" mapping needs at least one action to cycle through" });
    }
    // § Stage 5A-3 — reject at validation time what `resolveBehaviorCommand` would
    // otherwise only discover on first firing. "cycle" has no capability constraint
    // here (it walks `actions[]` rather than resolving a synthesized command against
    // `target.capability` at all), so it's deliberately excluded from both checks.
    if (m.target) {
      if (m.behavior === "toggle" && !TOGGLE_CAPABLE_CAPABILITIES.includes(m.target.capability)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["target", "capability"],
          message: `behavior "toggle" is not supported for capability "${m.target.capability}"`,
        });
      }
      if (
        (m.behavior === "alternate" || m.behavior === "increment" || m.behavior === "decrement") &&
        !LEVEL_STEP_CAPABLE_CAPABILITIES.includes(m.target.capability)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["target", "capability"],
          message: `behavior "${m.behavior}" is not supported for capability "${m.target.capability}"`,
        });
      }
    }
  });
export type KeypadMapping = z.infer<typeof KeypadMapping>;

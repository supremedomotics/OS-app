import { z } from "zod";
import { AutomationAction, AutomationCondition } from "./automations-dsl.js";
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

export const KeypadMapping = z.object({
  id: KeypadMappingId,
  homeId: HomeId,
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  input: KeypadMappingInput,
  /** All must hold for `actions` to run (identical evaluation semantics to
   * `Automation.conditions` — see `@supreme/domain-model`'s `condition-eval.ts`). */
  conditions: z.array(AutomationCondition).default([]),
  /** Runs in order; a `"delay"` action is how "Optional Delays" is expressed. */
  actions: z.array(AutomationAction).min(1),
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
});
export type KeypadMapping = z.infer<typeof KeypadMapping>;

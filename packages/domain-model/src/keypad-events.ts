import { z } from "zod";
import { DeviceId } from "./ids.js";

/**
 * Universal Input Event Definitions (§ Universal Keypad Framework, Phase 1).
 *
 * Protocol-independent, future-proofed input vocabulary. Every keypad driver —
 * regardless of wire protocol — normalizes its own raw traffic into these events
 * before anything else in the framework ever sees them (the Universal Input Engine
 * is the ONLY place raw driver payloads are translated). `raw` carries the
 * untranslated protocol payload for diagnostics only; nothing above the Input Engine
 * is permitted to branch on it.
 *
 * `button_pressed`/`button_released` are the only events some hardware can ever
 * report (bare momentary contacts with no onboard timing logic); the Universal Input
 * Engine derives `short_press`/`long_press`/`double_press`/`triple_press`/
 * `hold_start`/`holding`/`hold_end` from those two primitives via one shared timing
 * state machine, so no individual driver has to reimplement press-timing logic.
 * Devices with onboard gesture recognition (a rotary encoder's own delta reporting,
 * a touch-strip's own swipe detection) publish the derived event directly instead.
 */

const base = z.object({
  keypadId: DeviceId,
  /** Which physical control on the keypad (`KeypadControlDescriptor.id`). */
  control: z.string().min(1),
  ts: z.string().datetime(),
  /** Untranslated protocol payload, diagnostics-only (never branched on above the
   * Universal Input Engine). */
  raw: z.record(z.unknown()).optional(),
});

export const KeypadInputEvent = z.discriminatedUnion("type", [
  base.extend({ type: z.literal("button_pressed") }),
  base.extend({ type: z.literal("button_released") }),
  base.extend({ type: z.literal("short_press") }),
  base.extend({ type: z.literal("long_press"), holdMs: z.number().int().nonnegative() }),
  base.extend({ type: z.literal("double_press") }),
  base.extend({ type: z.literal("triple_press") }),
  base.extend({ type: z.literal("hold_start") }),
  /** Repeats at a driver/engine-defined tick rate while a button stays held down. */
  base.extend({ type: z.literal("holding"), elapsedMs: z.number().int().nonnegative() }),
  base.extend({ type: z.literal("hold_end"), heldMs: z.number().int().nonnegative() }),
  base.extend({
    type: z.literal("rotate_clockwise"),
    steps: z.number().int().positive().default(1),
    velocity: z.number().nonnegative().optional(),
  }),
  base.extend({
    type: z.literal("rotate_counterclockwise"),
    steps: z.number().int().positive().default(1),
    velocity: z.number().nonnegative().optional(),
  }),
  base.extend({ type: z.literal("swipe"), direction: z.enum(["up", "down", "left", "right"]) }),
  /** Escape hatch for future/vendor-specific named gestures (e.g. a Casambi
   * double-tap-and-hold) that don't yet warrant their own first-class event type —
   * `gesture` is a free string precisely so adding a new gesture is a driver-side
   * change, never a framework schema change. */
  base.extend({ type: z.literal("gesture"), gesture: z.string().min(1) }),
]);
export type KeypadInputEvent = z.infer<typeof KeypadInputEvent>;

/** The `type` discriminant values alone — used by mapping inputs to reference "which
 * event fires this mapping" without re-declaring the full event union. */
export const KeypadInputEventType = z.enum([
  "button_pressed",
  "button_released",
  "short_press",
  "long_press",
  "double_press",
  "triple_press",
  "hold_start",
  "holding",
  "hold_end",
  "rotate_clockwise",
  "rotate_counterclockwise",
  "swipe",
  "gesture",
]);
export type KeypadInputEventType = z.infer<typeof KeypadInputEventType>;

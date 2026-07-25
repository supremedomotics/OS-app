import { z } from "zod";
import { Percent } from "./capabilities.js";
import { DeviceId } from "./ids.js";

/**
 * Universal Feedback Definitions (§ Universal Keypad Framework, Phase 1).
 *
 * Generic feedback actions the Universal Feedback Engine issues toward a keypad.
 * Every feedback driver translates these into its own protocol-specific wire command
 * (a KNX DPT write, a Casambi keypad LED command, a Lutron LED-state message, …) —
 * exactly mirroring how `CapabilityCommand` is the generic vocabulary a device driver
 * translates into bus writes. Only feedback types a keypad actually declares via its
 * {@link KeypadCapabilityDeclaration} are ever sent to it (§ Feedback Routing,
 * "capability gating" — never a fabricated LED/display update to hardware that has
 * neither).
 */

const target = z.object({
  keypadId: DeviceId,
  /** Which physical control on the keypad this feedback targets. */
  control: z.string().min(1),
});

export const KeypadFeedbackCommand = z.discriminatedUnion("type", [
  target.extend({ type: z.literal("led_on") }),
  target.extend({ type: z.literal("led_off") }),
  target.extend({
    type: z.literal("led_color"),
    hue: z.number().min(0).max(360),
    saturation: Percent,
  }),
  target.extend({ type: z.literal("led_brightness"), level: Percent }),
  target.extend({ type: z.literal("display_text"), text: z.string() }),
  target.extend({ type: z.literal("display_icon"), icon: z.string().min(1) }),
  target.extend({ type: z.literal("display_page"), page: z.string().min(1) }),
  target.extend({ type: z.literal("ring_brightness"), level: Percent }),
  target.extend({ type: z.literal("ring_color"), hue: z.number().min(0).max(360), saturation: Percent }),
  target.extend({
    type: z.literal("haptic_pulse"),
    durationMs: z.number().int().positive().max(5_000),
    /** 0..100 relative intensity; drivers map it onto their own motor-drive range. */
    intensity: Percent.default(100),
  }),
  target.extend({ type: z.literal("buzzer"), pattern: z.enum(["short", "long", "double"]).default("short") }),
]);
export type KeypadFeedbackCommand = z.infer<typeof KeypadFeedbackCommand>;

/** The `type` discriminant values alone (mirrors `KeypadInputEventType`). */
export const KeypadFeedbackType = z.enum([
  "led_on",
  "led_off",
  "led_color",
  "led_brightness",
  "display_text",
  "display_icon",
  "display_page",
  "ring_brightness",
  "ring_color",
  "haptic_pulse",
  "buzzer",
]);
export type KeypadFeedbackType = z.infer<typeof KeypadFeedbackType>;

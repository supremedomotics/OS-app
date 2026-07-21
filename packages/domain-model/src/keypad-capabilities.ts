import { z } from "zod";
import { DeviceId } from "./ids.js";

/**
 * Keypad Capability Model (§ Universal Keypad Framework, Phase 1).
 *
 * Mirrors the device `CapabilityKind` model (`capabilities.ts`) exactly, but for
 * *input* hardware: a keypad advertises what it can DO — never what protocol it
 * speaks. A KNX push-button, a Casambi keypad, a Lutron Pico, a Matter switch, an
 * MQTT button, an RTI keypad, a Zigbee remote, a BLE fob, and a DALI push-button
 * input unit all declare the same vocabulary below; the Universal Input/Feedback
 * Engines and the Mapping Engine branch on THESE capabilities, never on
 * `ProtocolKind`. This is the same discipline `capabilities.ts` already enforces for
 * controlled devices, applied to controlling ones.
 */

/** What a keypad can generate as raw/derived input. */
export const KeypadInputCapability = z.enum([
  "buttons", // discrete momentary buttons (press/release)
  "long_press",
  "double_press",
  "triple_press",
  "hold", // sustained hold with start/repeat/end semantics
  "rotary_encoder",
  "swipe", // capacitive/touch-strip directional gesture
  "gesture", // higher-level named gesture (protocol/device-specific vocabulary)
]);
export type KeypadInputCapability = z.infer<typeof KeypadInputCapability>;

/** What a keypad can render as feedback to the installer/homeowner. */
export const KeypadFeedbackCapability = z.enum([
  "led",
  "rgb_led",
  "display",
  "haptic",
  "buzzer",
  "brightness_feedback", // LED/backlight brightness is itself adjustable
  "icon_feedback", // display can render a glyph/icon, not just text
  "text_feedback", // display can render free text
]);
export type KeypadFeedbackCapability = z.infer<typeof KeypadFeedbackCapability>;

/** The physical shape of one addressable control on a keypad. */
export const KeypadControlKind = z.enum([
  "button",
  "rotary_encoder",
  "touch_zone",
  "slider",
]);
export type KeypadControlKind = z.infer<typeof KeypadControlKind>;

/**
 * One physical control on a keypad (e.g. "button 2 of 4", "the encoder", "the top
 * touch strip"). `id` is the driver-assigned, protocol-independent identifier used
 * everywhere else in the framework (input events, feedback commands, mappings,
 * subscriptions) — never a raw protocol address (a KNX group address, a Casambi
 * keypad button index, …); that translation is the owning driver's job alone.
 */
export const KeypadControlDescriptor = z.object({
  id: z.string().min(1),
  kind: KeypadControlKind,
  /** Installer-facing label (e.g. "Scene 1", "Volume"). Never fabricated — either
   * driver-reported or installer-declared during commissioning; falls back to `id`
   * in the UI when absent. */
  label: z.string().nullable().default(null),
  /** Input capabilities this specific control supports (a keypad can mix control
   * kinds — e.g. 4 buttons + 1 encoder — each with its own capability set). */
  input: z.array(KeypadInputCapability).default([]),
  /** Feedback capabilities this specific control supports. */
  feedback: z.array(KeypadFeedbackCapability).default([]),
});
export type KeypadControlDescriptor = z.infer<typeof KeypadControlDescriptor>;

/**
 * The full capability declaration a keypad-capable driver reports for one device
 * (§ Driver SDK Extension). Fetched once after `bind()`, exactly like
 * `INativeProtocolDriver.getCapabilityConfig` — a keypad with no real driver-reported
 * declaration simply has none (`null`); the framework never invents one.
 */
export const KeypadCapabilityDeclaration = z.object({
  keypadId: DeviceId,
  /** Protocol identifier for diagnostics/UI only — never branched on by the engines. */
  protocol: z.string(),
  controls: z.array(KeypadControlDescriptor).min(1),
});
export type KeypadCapabilityDeclaration = z.infer<typeof KeypadCapabilityDeclaration>;

import { z } from "zod";
import { CapabilityKind } from "./capabilities.js";
import { DeviceId, HomeId, KeypadSubscriptionId } from "./ids.js";

/**
 * Subscription Manager model (§ Universal Keypad Framework, Phase 1).
 *
 * Records that one keypad control should mirror one device capability's state as
 * feedback — e.g. "Living Room Light (onoff) is subscribed by the KNX keypad's
 * button 2 LED, the Casambi keypad's button 1 LED, and the Lutron keypad's LED 3".
 * Many keypads (many controls) can subscribe to the same device+capability; the
 * Universal Feedback Engine fans a single state change out to every one of them, and
 * each keypad's owning driver renders it through whatever feedback types that
 * specific control actually declared (§ Feedback Routing — never protocol-specific
 * here, never assuming every subscriber renders it the same way).
 */
export const KeypadSubscription = z.object({
  id: KeypadSubscriptionId,
  homeId: HomeId,
  /** The device+capability being watched. */
  deviceId: DeviceId,
  capability: CapabilityKind,
  /** The subscribing keypad and which of its controls reflects the state. */
  keypadId: DeviceId,
  control: z.string().min(1),
});
export type KeypadSubscription = z.infer<typeof KeypadSubscription>;

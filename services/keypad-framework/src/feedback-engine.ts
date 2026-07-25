import type {
  CapabilityKind,
  CapabilityState,
  DeviceId,
  KeypadCapabilityDeclaration,
  KeypadControlDescriptor,
  KeypadFeedbackCommand,
  KeypadSubscription,
} from "@supreme/domain-model";
import type { SubscriptionManager } from "./subscription-manager.js";

/**
 * Universal Feedback Engine (§ Universal Keypad Framework, deliverable 2).
 *
 * Receives device state changes (via `onDeviceState`, wired to the SIL's normalized
 * state stream — never a protocol event) and routes them to every subscribed keypad
 * control (§ Subscription Manager). Feedback is rendered honestly: a keypad only
 * ever receives a {@link KeypadFeedbackCommand} for a feedback type it actually
 * declared via `getKeypadCapabilities` (§ Feedback Routing, "capability gating") —
 * never a fabricated LED/display update to hardware that has neither. Drivers alone
 * translate the generic command into protocol-native bytes.
 */

/** Deliberately local (not imported from `@supreme/integration-layer`) — mirrors
 * `@supreme/automations`' own `DeviceStateEvent`, keeping this package's dependency
 * graph as narrow as the executors it actually needs. The gateway adapts the SIL's
 * `BackendStateEvent` into this shape when wiring the engine, exactly as it already
 * does for `AutomationEngine.onDeviceState`. */
export interface DeviceStateEvent {
  deviceId: DeviceId;
  capability: CapabilityKind;
  state: CapabilityState;
}

export interface UniversalFeedbackEngineOptions {
  subscriptions: SubscriptionManager;
  /** Fetch a keypad's real capability declaration (null if unknown/undeclared). */
  getKeypadCapabilities(keypadId: DeviceId): Promise<KeypadCapabilityDeclaration | null>;
  /** Write one generic feedback command to its target keypad's owning driver. */
  sendFeedback(command: KeypadFeedbackCommand): Promise<void>;
  /** A fault sending to ONE subscriber must never abort fan-out to the rest —
   * reported here instead (diagnostics/audit), mirroring the fleet's
   * "unbind() must be idempotent, never throw for what it doesn't own" philosophy of
   * isolating one subscriber's failure from every other subscriber. */
  onError?(error: unknown, subscription: KeypadSubscription): void;
}

export class UniversalFeedbackEngine {
  constructor(private readonly opts: UniversalFeedbackEngineOptions) {}

  /** Fan a device+capability's new state out to every subscribed keypad control. */
  async onDeviceState(event: DeviceStateEvent): Promise<void> {
    const subs = this.opts.subscriptions.subscribersFor(event.deviceId, event.capability);
    if (subs.length === 0) return;

    // A keypad with several subscribed controls shouldn't re-fetch its own
    // capability declaration once per control on the same fan-out.
    const declarationCache = new Map<DeviceId, KeypadCapabilityDeclaration | null>();
    for (const sub of subs) {
      let decl = declarationCache.get(sub.keypadId);
      if (decl === undefined) {
        decl = await this.opts.getKeypadCapabilities(sub.keypadId);
        declarationCache.set(sub.keypadId, decl);
      }
      const control = decl?.controls.find((c) => c.id === sub.control);
      if (!control) continue; // undeclared control — never fabricate feedback to it

      for (const command of renderFeedback(event.state, control, sub)) {
        try {
          await this.opts.sendFeedback(command);
        } catch (err) {
          this.opts.onError?.(err, sub);
        }
      }
    }
  }
}

/**
 * Pure, capability-gated state → feedback renderer (exported for direct testing).
 * Every command it emits is backed by BOTH a real state field AND a feedback
 * capability the control actually declared — never one without the other.
 */
export function renderFeedback(
  state: CapabilityState,
  control: KeypadControlDescriptor,
  target: { keypadId: DeviceId; control: string },
): KeypadFeedbackCommand[] {
  const has = (c: KeypadControlDescriptor["feedback"][number]): boolean => control.feedback.includes(c);
  const commands: KeypadFeedbackCommand[] = [];
  const { keypadId, control: controlId } = target;

  const on = onOffOf(state);
  if (on !== null && has("led")) {
    commands.push({ type: on ? "led_on" : "led_off", keypadId, control: controlId });
  }

  if (state.kind === "brightness" && has("brightness_feedback") && (has("led") || has("rgb_led"))) {
    commands.push({ type: "led_brightness", keypadId, control: controlId, level: state.level });
  }

  if (state.kind === "color") {
    if (has("rgb_led") && state.hue !== null && state.saturation !== null) {
      commands.push({ type: "led_color", keypadId, control: controlId, hue: state.hue, saturation: state.saturation });
    }
    if (has("brightness_feedback") && (has("led") || has("rgb_led"))) {
      commands.push({ type: "led_brightness", keypadId, control: controlId, level: state.level });
    }
  }

  if (has("text_feedback") || has("display")) {
    const text = describeState(state);
    if (text !== null) commands.push({ type: "display_text", keypadId, control: controlId, text });
  }

  return commands;
}

/** `null` for capabilities with no single boolean "is it on" field (e.g. media, which
 * has a playback/transport state instead). */
function onOffOf(state: CapabilityState): boolean | null {
  switch (state.kind) {
    case "onoff":
    case "brightness":
    case "color":
    case "fan":
      return state.on;
    case "temperature":
    case "position":
    case "media":
    case "lock":
    case "vacuum":
    case "sensor":
      return null;
  }
}

/** A short, honest human-readable summary of any capability state, for a keypad's
 * text/icon display. Every branch reads a real reported field — never fabricated. */
function describeState(state: CapabilityState): string | null {
  switch (state.kind) {
    case "onoff":
      return state.on ? "On" : "Off";
    case "brightness":
      return state.on ? `On · ${state.level}%` : "Off";
    case "color":
      return state.on ? `On · ${state.level}%` : "Off";
    case "temperature":
      return state.targetC !== null ? `${state.targetC.toFixed(1)}°` : `${state.ambientC.toFixed(1)}°`;
    case "position":
      return `${state.position}%`;
    case "media":
      return state.title ?? describePlayback(state.playback);
    case "lock":
      return state.jammed ? "Jammed" : state.locked ? "Locked" : "Unlocked";
    case "fan":
      return state.on ? "On" : "Off";
    case "vacuum":
      return describeVacuum(state.status);
    case "sensor":
      return `${state.value}${state.unit}`;
  }
}

function describePlayback(playback: "playing" | "paused" | "stopped" | "idle"): string {
  switch (playback) {
    case "playing":
      return "Playing";
    case "paused":
      return "Paused";
    case "stopped":
      return "Stopped";
    case "idle":
      return "Idle";
  }
}

function describeVacuum(status: "idle" | "cleaning" | "paused" | "returning" | "docked"): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "cleaning":
      return "Cleaning";
    case "paused":
      return "Paused";
    case "returning":
      return "Returning";
    case "docked":
      return "Docked";
  }
}

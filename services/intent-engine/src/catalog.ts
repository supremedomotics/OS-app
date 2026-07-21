import { IntentDefinition } from "@supreme/domain-model";
import type { CapabilityCommand, IntentTarget } from "@supreme/domain-model";
import { SupremeError } from "@supreme/contracts";
import type { IntentEngineExecutors } from "./engine.js";
import type { IntentRegistry, IntentTranslateInput } from "./registry.js";

/**
 * The built-in Intent catalog (§ Universal Intent & Capability Engine, Phase 2).
 * Every intent the brief lists as an example is registered here — `registry.
 * register()` is public API, so this file is not the only place an intent can
 * ever be added; it's the seed of built-ins, exactly like a driver fleet starts
 * with N drivers but isn't limited to them.
 *
 * Two intents are honest exceptions: `executeScript`/`webhook` are registered
 * (so the catalog/API surface is complete, per the brief's example list) but
 * their `runSystem` handler always throws — SupremeOS has no script sandbox or
 * webhook dispatcher today. `swingMode`/`tiltUp`/`tiltDown` are similarly
 * registered against a real capability (`temperature`/`position`) but their
 * `translate` always throws — swing position and blind tilt angle aren't
 * modeled fields in `TemperatureState`/`PositionState` yet. This is the same
 * "visibly incomplete, never silently faked" discipline the rest of the
 * codebase already applies (e.g. ADR 0015's undocumented Denon feature-query
 * gap) — not a shortcut unique to this file.
 */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const toggleOnOff: (input: IntentTranslateInput) => CapabilityCommand = () => ({
  capability: "onoff",
  action: "toggle",
});

export function registerBuiltinIntents(registry: IntentRegistry<IntentEngineExecutors>): void {
  /** Validates + applies defaults via the real schema — a catalog authoring
   * mistake (bad id pattern, unknown category, empty targetKinds, …) fails
   * loudly here at module-load time, never silently. */
  const def = (partial: {
    id: string;
    name: string;
    category: IntentDefinition["category"];
    description?: string;
    requiredCapabilities?: IntentDefinition["requiredCapabilities"];
    parameters?: IntentDefinition["parameters"];
    targetKinds: IntentDefinition["targetKinds"];
  }): IntentDefinition => IntentDefinition.parse(partial);

  // ── Lighting ─────────────────────────────────────────────────────────────
  registry.register(
    def({
      id: "toggleLight",
      name: "Toggle Light",
      category: "lighting",
      description: "Toggle a light (or every light in a room) on/off.",
      requiredCapabilities: ["onoff"],
      parameters: [],
      targetKinds: ["device", "room"],
    }),
    { translate: toggleOnOff },
  );
  registry.register(
    def({
      id: "lightOn",
      name: "Light On",
      category: "lighting",
      requiredCapabilities: ["onoff"],
      parameters: [],
      targetKinds: ["device", "room"],
    }),
    { translate: () => ({ capability: "onoff", action: "on" }) },
  );
  registry.register(
    def({
      id: "lightOff",
      name: "Light Off",
      category: "lighting",
      requiredCapabilities: ["onoff"],
      parameters: [],
      targetKinds: ["device", "room"],
    }),
    { translate: () => ({ capability: "onoff", action: "off" }) },
  );
  registry.register(
    def({
      id: "increaseBrightness",
      name: "Increase Brightness",
      category: "lighting",
      requiredCapabilities: ["brightness"],
      parameters: [{ key: "step", type: "number", required: false, min: 1, max: 100, default: 10, description: "Percentage points to raise." }],
      targetKinds: ["device", "room"],
    }),
    {
      translate: ({ params, state }) => {
        const level = state?.kind === "brightness" ? state.level : 0;
        return { capability: "brightness", action: "set", level: clamp(level + Number(params.step), 0, 100) };
      },
    },
  );
  registry.register(
    def({
      id: "decreaseBrightness",
      name: "Decrease Brightness",
      category: "lighting",
      requiredCapabilities: ["brightness"],
      parameters: [{ key: "step", type: "number", required: false, min: 1, max: 100, default: 10, description: "Percentage points to lower." }],
      targetKinds: ["device", "room"],
    }),
    {
      translate: ({ params, state }) => {
        const level = state?.kind === "brightness" ? state.level : 0;
        return { capability: "brightness", action: "set", level: clamp(level - Number(params.step), 0, 100) };
      },
    },
  );
  registry.register(
    def({
      id: "setBrightness",
      name: "Set Brightness",
      category: "lighting",
      requiredCapabilities: ["brightness"],
      parameters: [{ key: "level", type: "number", required: true, min: 0, max: 100, description: "Target brightness percentage." }],
      targetKinds: ["device", "room"],
    }),
    { translate: ({ params }) => ({ capability: "brightness", action: "set", level: Number(params.level) }) },
  );
  registry.register(
    def({
      id: "increaseCCT",
      name: "Increase Colour Temperature",
      category: "lighting",
      requiredCapabilities: ["color"],
      parameters: [{ key: "step", type: "number", required: false, min: 1, max: 2000, default: 200, description: "Kelvin to raise." }],
      targetKinds: ["device", "room"],
    }),
    {
      translate: ({ params, state }) => {
        const kelvin = state?.kind === "color" && state.kelvin !== null ? state.kelvin : 2700;
        return { capability: "color", kelvin: clamp(kelvin + Number(params.step), 1000, 10000) };
      },
    },
  );
  registry.register(
    def({
      id: "decreaseCCT",
      name: "Decrease Colour Temperature",
      category: "lighting",
      requiredCapabilities: ["color"],
      parameters: [{ key: "step", type: "number", required: false, min: 1, max: 2000, default: 200, description: "Kelvin to lower." }],
      targetKinds: ["device", "room"],
    }),
    {
      translate: ({ params, state }) => {
        const kelvin = state?.kind === "color" && state.kelvin !== null ? state.kelvin : 2700;
        return { capability: "color", kelvin: clamp(kelvin - Number(params.step), 1000, 10000) };
      },
    },
  );
  registry.register(
    def({
      id: "setColor",
      name: "Set Color",
      category: "lighting",
      requiredCapabilities: ["color"],
      parameters: [
        { key: "hue", type: "number", required: false, min: 0, max: 360, description: "Hue 0-360." },
        { key: "saturation", type: "number", required: false, min: 0, max: 100, description: "Saturation 0-100." },
      ],
      targetKinds: ["device", "room"],
    }),
    {
      translate: ({ params }) => ({
        capability: "color",
        ...(params.hue !== undefined ? { hue: Number(params.hue) } : {}),
        ...(params.saturation !== undefined ? { saturation: Number(params.saturation) } : {}),
      }),
    },
  );
  registry.register(
    def({
      id: "activateScene",
      name: "Activate Scene",
      category: "lighting",
      description: "Activate a lighting scene (a category-specific alias of Run Scene, for AI/UI discoverability).",
      requiredCapabilities: [],
      parameters: [],
      targetKinds: ["scene"],
    }),
    { runSystem: runSceneHandler },
  );

  // ── Climate ──────────────────────────────────────────────────────────────
  registry.register(
    def({
      id: "increaseTemperature",
      name: "Increase Temperature",
      category: "climate",
      requiredCapabilities: ["temperature"],
      parameters: [{ key: "step", type: "number", required: false, min: 0.5, max: 10, default: 1, description: "Degrees C to raise." }],
      targetKinds: ["device", "room"],
    }),
    {
      translate: ({ params, state }) => {
        const base = state?.kind === "temperature" ? (state.targetC ?? state.ambientC) : 21;
        return { capability: "temperature", targetC: base + Number(params.step) };
      },
    },
  );
  registry.register(
    def({
      id: "decreaseTemperature",
      name: "Decrease Temperature",
      category: "climate",
      requiredCapabilities: ["temperature"],
      parameters: [{ key: "step", type: "number", required: false, min: 0.5, max: 10, default: 1, description: "Degrees C to lower." }],
      targetKinds: ["device", "room"],
    }),
    {
      translate: ({ params, state }) => {
        const base = state?.kind === "temperature" ? (state.targetC ?? state.ambientC) : 21;
        return { capability: "temperature", targetC: base - Number(params.step) };
      },
    },
  );
  registry.register(
    def({
      id: "setTemperature",
      name: "Set Temperature",
      category: "climate",
      requiredCapabilities: ["temperature"],
      parameters: [{ key: "targetC", type: "number", required: true, min: 5, max: 35, description: "Target setpoint in Celsius." }],
      targetKinds: ["device", "room"],
    }),
    { translate: ({ params }) => ({ capability: "temperature", targetC: Number(params.targetC) }) },
  );
  registry.register(
    def({
      id: "fanSpeedUp",
      name: "Fan Speed Up",
      category: "climate",
      description: "Steps a fan device through its preset order: sleep → auto → turbo.",
      requiredCapabilities: ["fan"],
      parameters: [],
      targetKinds: ["device", "room"],
    }),
    { translate: ({ state }) => ({ capability: "fan", action: "preset", preset: stepFanPreset(state, 1) }) },
  );
  registry.register(
    def({
      id: "fanSpeedDown",
      name: "Fan Speed Down",
      category: "climate",
      description: "Steps a fan device through its preset order: turbo → auto → sleep.",
      requiredCapabilities: ["fan"],
      parameters: [],
      targetKinds: ["device", "room"],
    }),
    { translate: ({ state }) => ({ capability: "fan", action: "preset", preset: stepFanPreset(state, -1) }) },
  );
  registry.register(
    def({
      id: "hvacMode",
      name: "HVAC Mode",
      category: "climate",
      requiredCapabilities: ["temperature"],
      parameters: [{ key: "mode", type: "enum", required: true, options: ["off", "heat", "cool", "auto", "fan_only"], description: "Target HVAC mode." }],
      targetKinds: ["device", "room"],
    }),
    { translate: ({ params }) => ({ capability: "temperature", mode: params.mode as "off" | "heat" | "cool" | "auto" | "fan_only" }) },
  );
  registry.register(
    def({
      id: "toggleHVAC",
      name: "Toggle HVAC",
      category: "climate",
      description: "Off → Auto, Auto/Heat/Cool/Fan-only → Off.",
      requiredCapabilities: ["temperature"],
      parameters: [],
      targetKinds: ["device", "room"],
    }),
    {
      translate: ({ state }) => ({
        capability: "temperature",
        mode: state?.kind === "temperature" && state.mode !== "off" ? "off" : "auto",
      }),
    },
  );
  registry.register(
    def({
      id: "swingMode",
      name: "Swing Mode",
      category: "climate",
      description: "Not yet executable: swing position is not a modeled Supreme capability field.",
      requiredCapabilities: ["temperature"],
      parameters: [],
      targetKinds: ["device", "room"],
    }),
    {
      translate: () => {
        throw new SupremeError(
          "backend_unavailable",
          "swing position is not a modeled Supreme capability field yet — no device can honor the swingMode intent",
        );
      },
    },
  );

  // ── AV ───────────────────────────────────────────────────────────────────
  registry.register(
    def({
      id: "powerToggle",
      name: "Power Toggle",
      category: "av",
      description: "Toggle an AV device's power (the same onoff capability toggleLight uses).",
      requiredCapabilities: ["onoff"],
      parameters: [],
      targetKinds: ["device", "room"],
    }),
    { translate: toggleOnOff },
  );
  registry.register(
    def({
      id: "volumeUp",
      name: "Volume Up",
      category: "av",
      requiredCapabilities: ["media"],
      parameters: [{ key: "step", type: "number", required: false, min: 1, max: 100, default: 10, description: "Percentage points." }],
      targetKinds: ["device", "room"],
    }),
    {
      translate: ({ params, state }) => {
        const volume = state?.kind === "media" ? state.volume : 0;
        return { capability: "media", action: "volume", volume: clamp(volume + Number(params.step), 0, 100) };
      },
    },
  );
  registry.register(
    def({
      id: "volumeDown",
      name: "Volume Down",
      category: "av",
      requiredCapabilities: ["media"],
      parameters: [{ key: "step", type: "number", required: false, min: 1, max: 100, default: 10, description: "Percentage points." }],
      targetKinds: ["device", "room"],
    }),
    {
      translate: ({ params, state }) => {
        const volume = state?.kind === "media" ? state.volume : 0;
        return { capability: "media", action: "volume", volume: clamp(volume - Number(params.step), 0, 100) };
      },
    },
  );
  registry.register(
    def({
      id: "mute",
      name: "Mute",
      category: "av",
      description: "Toggle mute based on the device's current reported mute state.",
      requiredCapabilities: ["media"],
      parameters: [],
      targetKinds: ["device", "room"],
    }),
    { translate: ({ state }) => ({ capability: "media", action: state?.kind === "media" && state.muted ? "unmute" : "mute" }) },
  );
  registry.register(
    def({
      id: "playPause",
      name: "Play/Pause",
      category: "av",
      requiredCapabilities: ["media"],
      parameters: [],
      targetKinds: ["device", "room"],
    }),
    { translate: ({ state }) => ({ capability: "media", action: state?.kind === "media" && state.playback === "playing" ? "pause" : "play" }) },
  );
  registry.register(
    def({ id: "stop", name: "Stop", category: "av", requiredCapabilities: ["media"], parameters: [], targetKinds: ["device", "room"] }),
    { translate: () => ({ capability: "media", action: "stop" }) },
  );
  registry.register(
    def({ id: "nextTrack", name: "Next Track", category: "av", requiredCapabilities: ["media"], parameters: [], targetKinds: ["device", "room"] }),
    { translate: () => ({ capability: "media", action: "next" }) },
  );
  registry.register(
    def({ id: "previousTrack", name: "Previous Track", category: "av", requiredCapabilities: ["media"], parameters: [], targetKinds: ["device", "room"] }),
    { translate: () => ({ capability: "media", action: "previous" }) },
  );
  registry.register(
    def({
      id: "inputNext",
      name: "Next Input",
      category: "av",
      description: "Cycles the device's real, driver-reported input list — never a guessed input.",
      requiredCapabilities: ["media"],
      parameters: [],
      targetKinds: ["device", "room"],
    }),
    { translate: (input) => stepMediaInput(input, 1) },
  );
  registry.register(
    def({
      id: "inputPrevious",
      name: "Previous Input",
      category: "av",
      description: "Cycles the device's real, driver-reported input list — never a guessed input.",
      requiredCapabilities: ["media"],
      parameters: [],
      targetKinds: ["device", "room"],
    }),
    { translate: (input) => stepMediaInput(input, -1) },
  );

  // ── Blinds ───────────────────────────────────────────────────────────────
  registry.register(
    def({ id: "open", name: "Open", category: "blinds", requiredCapabilities: ["position"], parameters: [], targetKinds: ["device", "room"] }),
    { translate: () => ({ capability: "position", action: "open" }) },
  );
  registry.register(
    def({ id: "close", name: "Close", category: "blinds", requiredCapabilities: ["position"], parameters: [], targetKinds: ["device", "room"] }),
    { translate: () => ({ capability: "position", action: "close" }) },
  );
  registry.register(
    def({
      id: "stopCover",
      name: "Stop",
      category: "blinds",
      description: "Named stopCover (not stop) to avoid colliding with AV's Stop intent id.",
      requiredCapabilities: ["position"],
      parameters: [],
      targetKinds: ["device", "room"],
    }),
    { translate: () => ({ capability: "position", action: "stop" }) },
  );
  registry.register(
    def({
      id: "tiltUp",
      name: "Tilt Up",
      category: "blinds",
      description: "Not yet executable: slat tilt angle is not a modeled Supreme capability field.",
      requiredCapabilities: ["position"],
      parameters: [],
      targetKinds: ["device", "room"],
    }),
    {
      translate: () => {
        throw new SupremeError("backend_unavailable", "tilt is not a modeled Supreme capability field yet — no device can honor the tiltUp intent");
      },
    },
  );
  registry.register(
    def({
      id: "tiltDown",
      name: "Tilt Down",
      category: "blinds",
      description: "Not yet executable: slat tilt angle is not a modeled Supreme capability field.",
      requiredCapabilities: ["position"],
      parameters: [],
      targetKinds: ["device", "room"],
    }),
    {
      translate: () => {
        throw new SupremeError("backend_unavailable", "tilt is not a modeled Supreme capability field yet — no device can honor the tiltDown intent");
      },
    },
  );

  // ── Security ─────────────────────────────────────────────────────────────
  registry.register(
    def({ id: "lock", name: "Lock", category: "security", requiredCapabilities: ["lock"], parameters: [], targetKinds: ["device", "room"] }),
    { translate: () => ({ capability: "lock", action: "lock" }) },
  );
  registry.register(
    def({ id: "unlock", name: "Unlock", category: "security", requiredCapabilities: ["lock"], parameters: [], targetKinds: ["device", "room"] }),
    { translate: () => ({ capability: "lock", action: "unlock" }) },
  );
  registry.register(
    def({
      id: "arm",
      name: "Arm",
      category: "security",
      requiredCapabilities: [],
      parameters: [{ key: "mode", type: "enum", required: false, options: ["armed_home", "armed_away", "armed_night"], default: "armed_away", description: "Arm mode." }],
      targetKinds: ["home"],
    }),
    {
      runSystem: async ({ params, executors }) => {
        if (!executors.security) throw new SupremeError("backend_unavailable", "no security panel is configured on this hub");
        await executors.security.arm(params.mode as "armed_home" | "armed_away" | "armed_night");
      },
    },
  );
  registry.register(
    def({ id: "disarm", name: "Disarm", category: "security", requiredCapabilities: [], parameters: [], targetKinds: ["home"] }),
    {
      runSystem: async ({ executors }) => {
        if (!executors.security) throw new SupremeError("backend_unavailable", "no security panel is configured on this hub");
        await executors.security.disarm();
      },
    },
  );
  registry.register(
    def({ id: "panic", name: "Panic", category: "security", requiredCapabilities: [], parameters: [], targetKinds: ["home"] }),
    {
      runSystem: async ({ executors }) => {
        if (!executors.security) throw new SupremeError("backend_unavailable", "no security panel is configured on this hub");
        await executors.security.panic();
      },
    },
  );

  // ── System ───────────────────────────────────────────────────────────────
  registry.register(
    def({ id: "runAutomation", name: "Run Automation", category: "system", requiredCapabilities: [], parameters: [], targetKinds: ["automation"] }),
    {
      runSystem: async ({ target, executors }) => {
        if (target.kind !== "automation") throw new SupremeError("validation_failed", "runAutomation requires an automation target");
        await executors.runAutomation(target.automationId);
      },
    },
  );
  registry.register(
    def({ id: "runScene", name: "Run Scene", category: "system", requiredCapabilities: [], parameters: [], targetKinds: ["scene"] }),
    { runSystem: runSceneHandler },
  );
  registry.register(
    def({
      id: "executeScript",
      name: "Execute Script",
      category: "system",
      description: "Not yet executable: SupremeOS has no script sandbox/engine.",
      requiredCapabilities: [],
      parameters: [],
      targetKinds: ["home"],
    }),
    {
      runSystem: async () => {
        throw new SupremeError("backend_unavailable", "executeScript is registered but has no execution backend — SupremeOS has no script engine yet");
      },
    },
  );
  registry.register(
    def({
      id: "notification",
      name: "Notification",
      category: "system",
      requiredCapabilities: [],
      parameters: [
        { key: "level", type: "enum", required: false, options: ["info", "warning", "critical"], default: "info", description: "Notification severity." },
        { key: "title", type: "string", required: true, description: "Notification title." },
        { key: "body", type: "string", required: false, default: "", description: "Notification body." },
      ],
      targetKinds: ["home"],
    }),
    {
      runSystem: async ({ params, executors }) => {
        await executors.notify({
          level: params.level as "info" | "warning" | "critical",
          title: String(params.title),
          body: String(params.body ?? ""),
          userId: null,
        });
      },
    },
  );
  registry.register(
    def({
      id: "webhook",
      name: "Webhook",
      category: "system",
      description: "Not yet executable: SupremeOS has no outbound webhook dispatcher.",
      requiredCapabilities: [],
      parameters: [],
      targetKinds: ["home"],
    }),
    {
      runSystem: async () => {
        throw new SupremeError("backend_unavailable", "webhook is registered but has no execution backend — SupremeOS has no webhook dispatcher yet");
      },
    },
  );
}

const FAN_PRESET_ORDER = ["sleep", "auto", "turbo"] as const;
function stepFanPreset(state: IntentTranslateInput["state"], direction: 1 | -1): "sleep" | "auto" | "turbo" {
  const current = state?.kind === "fan" ? state.preset : "auto";
  const index = FAN_PRESET_ORDER.indexOf(current);
  const next = clamp((index === -1 ? 1 : index) + direction, 0, FAN_PRESET_ORDER.length - 1);
  return FAN_PRESET_ORDER[next]!;
}

function stepMediaInput(input: IntentTranslateInput, direction: 1 | -1): CapabilityCommand {
  const inputs = input.capabilityConfig?.inputs;
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new SupremeError("backend_unavailable", "device has no known input list to cycle (no capability config reported)");
  }
  const ids = inputs.map((i) => (i as { id: string }).id);
  const currentSource = input.state?.kind === "media" ? input.state.source : null;
  const currentIndex = currentSource ? ids.indexOf(currentSource) : -1;
  const nextIndex = (((currentIndex === -1 ? 0 : currentIndex) + direction) % ids.length + ids.length) % ids.length;
  return { capability: "media", action: "source", source: ids[nextIndex] };
}

async function runSceneHandler({ target, executors }: { target: IntentTarget; executors: IntentEngineExecutors }): Promise<void> {
  if (target.kind !== "scene") throw new SupremeError("validation_failed", "this intent requires a scene target");
  await executors.activateScene(target.sceneId);
}

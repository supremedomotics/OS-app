import type { CapabilityKind } from "@supreme/domain-model";

/**
 * Capability-Driven Automation Builder (§ ADR 0016 Capability-Driven UI, § ADR 0017 Capability
 * Normalization, § ADR 0020 Runtime Object Contract).
 *
 * The Action builder is generated from COMMAND DEFINITIONS, not from a flat per-capability field
 * list: each verb a `CapabilityCommand` supports (`onoff.on`, `color.set`, `media.volume`, …) is
 * its own definition with its OWN parameter list — mirroring the real discriminated-union shape
 * in `packages/domain-model/src/capabilities.ts` exactly (one command variant → one definition),
 * rather than one shared param bag post-hoc filtered by which verb happens to be selected. A
 * command's params carry full presentation metadata (type, range, unit, enum, default,
 * optionality, and a widget hint) so the editor renders ONLY the parameters that command takes,
 * with the right control for each — never a generic field for every capability. Adding a new
 * driver never touches this file: whatever `CapabilityKind`s it reports back through
 * `device.capabilities` are automatically fully editable, because those kinds are the same
 * closed vocabulary this table is keyed on.
 *
 * Triggers/Conditions are a separate, deliberately different concept — they read a device's
 * *state*, not a command — so they're driven by `STATE_FIELDS` below, not by command
 * definitions. A command and its matching state field share units/ranges (single source per
 * capability) but are never the same object, since "what you can set" and "what you can read"
 * are genuinely different surfaces on the same capability (e.g. `ambientC` is state-only).
 */

export type FieldType = "boolean" | "percent" | "number" | "enum" | "string";

/** How a param should actually be drawn — beyond generic type-based rendering. Every widget
 * still degrades to its `type`'s generic control when the hint doesn't apply (e.g. narrowed
 * away by device config), so nothing is ever unrenderable. `chips` and `fanSelector` render
 * through the SAME segmented-button component (§ no duplicated UI logic) — kept as two hint
 * names because "Mode → Chips" and "Fan Speed → Selector" are different semantic intents even
 * though they're visually identical. */
export type Widget = "toggle" | "slider" | "colorWheel" | "cctSlider" | "volumeSlider" | "fanSelector" | "chips" | "duration" | "select" | "text";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  enumValues?: readonly string[];
  min?: number;
  max?: number;
  /** Slider/number granularity — purely a UI precision choice, never a device capability claim. */
  step?: number;
  unit?: string;
  default?: string | number | boolean;
  /** Present (and non-optional) params render even before the installer has touched them, using
   * `default`. Optional params start absent from the command until set. */
  optional?: boolean;
  widget?: Widget;
  /** Hidden behind "Advanced" (§ Part 4 Progressive Disclosure) until expanded. */
  advanced?: boolean;
}

export const CAPABILITY_LABELS: Record<CapabilityKind, string> = {
  onoff: "Power",
  brightness: "Brightness",
  color: "Color",
  temperature: "Climate",
  position: "Position",
  media: "Media",
  lock: "Lock",
  fan: "Fan",
  vacuum: "Vacuum",
  sensor: "Sensor",
};

/** Capabilities that can never be the target of a `device_command` action (read-only). */
export const READONLY_CAPABILITIES: readonly CapabilityKind[] = ["sensor"];

// ── State fields — drive the Trigger/Condition "field" picker + typed value input ───────────
export const STATE_FIELDS: Record<CapabilityKind, FieldDef[]> = {
  onoff: [{ key: "on", label: "Power", type: "boolean", widget: "toggle" }],
  brightness: [
    { key: "on", label: "Power", type: "boolean", widget: "toggle" },
    { key: "level", label: "Brightness", type: "percent", unit: "%", widget: "slider" },
  ],
  color: [
    { key: "on", label: "Power", type: "boolean", widget: "toggle" },
    { key: "level", label: "Brightness", type: "percent", unit: "%", widget: "slider" },
    { key: "hue", label: "Hue", type: "number", min: 0, max: 360, unit: "°", advanced: true },
    { key: "saturation", label: "Saturation", type: "percent", unit: "%", advanced: true },
    { key: "kelvin", label: "Color temperature", type: "number", min: 2700, max: 6500, step: 50, unit: "K", widget: "cctSlider", advanced: true },
  ],
  temperature: [
    { key: "ambientC", label: "Ambient temperature", type: "number", unit: "°C" },
    { key: "targetC", label: "Target temperature", type: "number", unit: "°C" },
    { key: "mode", label: "Mode", type: "enum", enumValues: ["off", "heat", "cool", "auto", "fan_only"], widget: "chips" },
    { key: "humidity", label: "Humidity", type: "percent", unit: "%", widget: "slider", advanced: true },
  ],
  position: [
    { key: "position", label: "Position", type: "percent", unit: "%", widget: "slider" },
    { key: "moving", label: "Moving", type: "boolean", widget: "toggle", advanced: true },
  ],
  media: [
    { key: "playback", label: "Playback", type: "enum", enumValues: ["playing", "paused", "stopped", "idle"] },
    { key: "volume", label: "Volume", type: "percent", unit: "%", widget: "volumeSlider" },
    { key: "muted", label: "Muted", type: "boolean", widget: "toggle" },
    { key: "source", label: "Source", type: "string", advanced: true },
    { key: "shuffle", label: "Shuffle", type: "boolean", widget: "toggle", advanced: true },
    { key: "repeat", label: "Repeat", type: "enum", enumValues: ["off", "all", "one"], advanced: true },
  ],
  lock: [
    { key: "locked", label: "Locked", type: "boolean", widget: "toggle" },
    { key: "jammed", label: "Jammed", type: "boolean", widget: "toggle", advanced: true },
  ],
  fan: [
    { key: "on", label: "Power", type: "boolean", widget: "toggle" },
    { key: "preset", label: "Preset", type: "enum", enumValues: ["auto", "sleep", "turbo"], widget: "fanSelector" },
    { key: "direction", label: "Direction", type: "enum", enumValues: ["forward", "reverse"], advanced: true },
  ],
  vacuum: [
    { key: "status", label: "Status", type: "enum", enumValues: ["idle", "cleaning", "paused", "returning", "docked"] },
    { key: "fanSpeed", label: "Fan speed", type: "enum", enumValues: ["quiet", "normal", "turbo"], widget: "fanSelector", advanced: true },
  ],
  sensor: [
    { key: "value", label: "Value", type: "number" },
  ],
};

/** § Part 1 — one entry per real `CapabilityCommand` verb, params owned directly by that verb
 * (not filtered post-hoc from a shared pool). `action: null` marks capabilities whose command has
 * no verb at all (color, temperature — every param is always relevant). Mirrors
 * `packages/domain-model/src/capabilities.ts`'s `CapabilityCommand` discriminated union member
 * for member. */
export interface CommandDefinition {
  capability: CapabilityKind;
  action: string | null;
  label: string;
  params: FieldDef[];
}

export const COMMAND_DEFINITIONS: Record<CapabilityKind, CommandDefinition[]> = {
  onoff: [
    { capability: "onoff", action: "on", label: "Turn on", params: [] },
    { capability: "onoff", action: "off", label: "Turn off", params: [] },
    { capability: "onoff", action: "toggle", label: "Toggle", params: [] },
  ],
  brightness: [
    { capability: "brightness", action: "on", label: "Turn on", params: [] },
    { capability: "brightness", action: "off", label: "Turn off", params: [] },
    {
      capability: "brightness", action: "set", label: "Set brightness",
      params: [{ key: "level", label: "Brightness", type: "percent", unit: "%", widget: "slider", default: 100 }],
    },
  ],
  color: [
    {
      capability: "color", action: null, label: "Set color",
      params: [
        { key: "level", label: "Brightness", type: "percent", unit: "%", widget: "slider", optional: true },
        { key: "hue", label: "Hue", type: "number", min: 0, max: 360, unit: "°", widget: "colorWheel", optional: true, advanced: true },
        { key: "saturation", label: "Saturation", type: "percent", unit: "%", widget: "colorWheel", optional: true, advanced: true },
        { key: "kelvin", label: "Color temperature", type: "number", min: 2700, max: 6500, step: 50, unit: "K", widget: "cctSlider", optional: true, advanced: true },
      ],
    },
  ],
  temperature: [
    {
      capability: "temperature", action: null, label: "Set climate",
      params: [
        { key: "mode", label: "Mode", type: "enum", enumValues: ["off", "heat", "cool", "auto", "fan_only"], widget: "chips", optional: true },
        { key: "targetC", label: "Target temperature", type: "number", unit: "°C", optional: true },
        { key: "targetLowC", label: "Target low", type: "number", unit: "°C", optional: true, advanced: true },
        { key: "targetHighC", label: "Target high", type: "number", unit: "°C", optional: true, advanced: true },
      ],
    },
  ],
  position: [
    { capability: "position", action: "open", label: "Open", params: [] },
    { capability: "position", action: "close", label: "Close", params: [] },
    { capability: "position", action: "stop", label: "Stop", params: [] },
    {
      capability: "position", action: "set", label: "Set position",
      params: [{ key: "position", label: "Position", type: "percent", unit: "%", widget: "slider", default: 50 }],
    },
  ],
  media: [
    { capability: "media", action: "play", label: "Play", params: [] },
    { capability: "media", action: "pause", label: "Pause", params: [] },
    { capability: "media", action: "stop", label: "Stop", params: [] },
    { capability: "media", action: "next", label: "Next track", params: [] },
    { capability: "media", action: "previous", label: "Previous track", params: [] },
    { capability: "media", action: "mute", label: "Mute", params: [] },
    { capability: "media", action: "unmute", label: "Unmute", params: [] },
    {
      capability: "media", action: "volume", label: "Set volume",
      params: [{ key: "volume", label: "Volume", type: "percent", unit: "%", widget: "volumeSlider", default: 30 }],
    },
    {
      capability: "media", action: "source", label: "Switch source",
      params: [{ key: "source", label: "Source", type: "string" }],
    },
    {
      capability: "media", action: "seek", label: "Seek",
      params: [{ key: "positionSec", label: "Seek to", type: "number", unit: "s", widget: "duration" }],
    },
    {
      capability: "media", action: "shuffle", label: "Set shuffle",
      params: [{ key: "shuffle", label: "Shuffle", type: "boolean", widget: "toggle", default: true }],
    },
    {
      capability: "media", action: "repeat", label: "Set repeat",
      params: [{ key: "repeat", label: "Repeat", type: "enum", enumValues: ["off", "all", "one"], default: "off" }],
    },
  ],
  lock: [
    { capability: "lock", action: "lock", label: "Lock", params: [] },
    { capability: "lock", action: "unlock", label: "Unlock", params: [] },
  ],
  fan: [
    { capability: "fan", action: "on", label: "Turn on", params: [] },
    { capability: "fan", action: "off", label: "Turn off", params: [] },
    {
      capability: "fan", action: "preset", label: "Set preset",
      params: [{ key: "preset", label: "Preset", type: "enum", enumValues: ["auto", "sleep", "turbo"], widget: "fanSelector", default: "auto" }],
    },
    {
      capability: "fan", action: "direction", label: "Set direction",
      params: [{ key: "direction", label: "Direction", type: "enum", enumValues: ["forward", "reverse"], default: "forward" }],
    },
  ],
  vacuum: [
    { capability: "vacuum", action: "start", label: "Start", params: [] },
    { capability: "vacuum", action: "pause", label: "Pause", params: [] },
    { capability: "vacuum", action: "stop", label: "Stop", params: [] },
    { capability: "vacuum", action: "return", label: "Return to dock", params: [] },
    {
      capability: "vacuum", action: "fan", label: "Set fan speed",
      params: [{ key: "fanSpeed", label: "Fan speed", type: "enum", enumValues: ["quiet", "normal", "turbo"], widget: "fanSelector", default: "normal" }],
    },
  ],
  sensor: [],
};

export function commandableCapabilities(kinds: readonly CapabilityKind[]): CapabilityKind[] {
  return kinds.filter((k) => !READONLY_CAPABILITIES.includes(k));
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// § FIELD RESOLUTION CHAIN (§ ADR 0017 Capability Normalization)
// ══════════════════════════════════════════════════════════════════════════════════════════
//
// `STATE_FIELDS`/`COMMAND_DEFINITIONS` above are each capability's FULL possible surface — every
// field/param that capability could ever have, across every device that might report it. A
// specific Runtime Object almost never exposes all of it (a CCT-only light has no Hue/
// Saturation; a dimmer has no color at all). `resolveStateFields`/`resolveCommandDefinitions`
// narrow that full surface down to what ONE real device actually supports, checking four
// sources in strict priority order. Each tier exists to answer a question the tier below it
// can't:
//
//   1. DRIVER COMMAND METADATA  — "did the driver already tell us, completely and precisely?"
//      `config.commandMetadata` (an opt-in convention inside the existing free-form
//      `DeviceCapability.config` bag — no domain-model schema change). When a driver publishes
//      this, it's a complete, authoritative description of exactly what ITS device supports —
//      used verbatim, no further narrowing. No driver publishes it today; this tier exists so
//      a *future* driver can skip tiers 2–4 entirely once it does. See the Driver Command
//      Metadata Contract doc (`docs/architecture/automation-editor-field-resolution.md`) for the
//      recommended future shape — NOT implemented, examples only, per this task's scope.
//
//   2. CAPABILITY STRUCTURAL CONFIG — "did the driver tell us SOMETHING, even if not everything?"
//      `config.colorModes` / `config.kelvinRange` — narrower, capability-specific signals a
//      driver can populate today without adopting full command metadata (e.g. Casambi's
//      `colorConfigFromUnit()`, populated at discovery time from the unit's real protocol
//      model). Answers one specific question ("is this RGB, CCT, or both?") rather than
//      describing the whole command surface.
//
//   3. LIVE-STATE INFERENCE — "the driver told us nothing structural, but state already proves
//      something." `colormode.ts`'s nullability inference: if a `color` capability's last
//      reported state has non-null `hue`/`saturation` but null `kelvin`, the device is
//      demonstrably RGB-only, whether or not its driver ever says so explicitly. This is a
//      *fallback signal*, weaker than tier 2 (it needs at least one real state report to work,
//      and can't distinguish "never reported" from "unsupported" — see `colormode.ts`'s own
//      documented safe default for that case).
//
//   4. STATIC CAPABILITY TABLE — the answer when nothing above narrowed anything: show the
//      capability's full generic surface (`STATE_FIELDS[kind]` / `COMMAND_DEFINITIONS[kind]`).
//      Never wrong, just not narrowed to one specific device — the safe default for a driver
//      that hasn't adopted ANY of tiers 1–3 yet, so a brand new/basic driver is still fully
//      usable in the automation editor on day one.
//
// Tiers 2–3 are pre-resolved by the caller into a `NarrowingContext` (via
// `getDeviceUiCapabilities()` in `device-ui-capabilities.ts`, which already implements the
// tier-2-then-3 preference order) and passed in as one object — see `resolveNarrowingContext()`
// in `automations.tsx`. This file only ever receives the RESULT of that resolution, never raw
// capability config for tiers 2/3, so there is exactly one place in the app that knows how to
// tell RGB from CCT.
//
// Expected future evolution: as official drivers adopt tier 1 (rich command metadata), this
// chain doesn't change shape — it just gets used less deep, more often, for more capabilities.
// Tiers 2–4 stay as the permanent compatibility floor for any driver that never adopts it.
// See `docs/architecture/automation-editor-field-resolution.md` for the full writeup.

export interface ColorModes { rgb: boolean; cct: boolean }
export interface KelvinRange { min: number; max: number }

/** Everything tiers 2–3 resolved for one capability on one device, bundled so callers make ONE
 * `device.capabilities.find()` pass instead of one per tier (§ Part 5 Performance). `config` is
 * also carried through so tier 1 (driver command metadata) can be checked from the same object. */
export interface NarrowingContext {
  modes?: ColorModes;
  kelvinRange?: KelvinRange;
  config?: Record<string, unknown>;
}

function narrowColorFields<T extends FieldDef>(fields: T[], ctx: NarrowingContext): T[] {
  const { modes, kelvinRange } = ctx;
  return fields
    .filter((f) => {
      if (modes && (f.key === "hue" || f.key === "saturation") && !modes.rgb) return false;
      if (modes && f.key === "kelvin" && !modes.cct) return false;
      return true;
    })
    .map((f) => (f.key === "kelvin" && kelvinRange ? { ...f, min: kelvinRange.min, max: kelvinRange.max } : f));
}

/**
 * § Command Metadata (tier 1) — a driver MAY publish its own rich per-command/per-field metadata
 * for a capability under `config.commandMetadata`. When present, it's already this specific
 * device's own real, complete description — used as-is, no further capability-table narrowing
 * needed (a driver publishing metadata is by definition telling the truth about what IT
 * supports). Absent for every driver today (none populate it yet), so `resolveStateFields`/
 * `resolveCommandDefinitions` fall straight through to tiers 2–4, unchanged from before this
 * tier existed. Mirrors `services/integration-layer`'s `discoverScenes?()` optional-hook pattern
 * on the backend: additive, opt-in, zero required driver changes.
 */
export interface CommandMetadata {
  commands?: CommandDefinition[];
  stateFields?: FieldDef[];
}

function readCommandMetadata(config: Record<string, unknown> | undefined): CommandMetadata | undefined {
  const meta = config?.commandMetadata as CommandMetadata | undefined;
  if (!meta || (!meta.commands?.length && !meta.stateFields?.length)) return undefined;
  return meta;
}

/** Real state fields for a capability, narrowed to what THIS device actually supports — used to
 * build the Trigger/Condition field picker. See the resolution-chain writeup above for tier
 * order; `ctx` is typically produced once per (device, capability) by `resolveNarrowingContext`
 * in `automations.tsx` and reused across all four call sites that need it. */
export function resolveStateFields(kind: CapabilityKind, ctx: NarrowingContext = {}): FieldDef[] {
  const driverFields = readCommandMetadata(ctx.config)?.stateFields;
  if (driverFields?.length) return driverFields;
  const base = STATE_FIELDS[kind] ?? [];
  return kind === "color" ? narrowColorFields(base, ctx) : base;
}

/** § Part 1 — the command definitions THIS specific device can actually issue: every real verb
 * for the capability, each with its own param list narrowed to what the device actually supports
 * (e.g. a CCT-only light's "Set color" command drops Hue/Saturation entirely rather than showing
 * them disabled). See the resolution-chain writeup above for tier order. */
export function resolveCommandDefinitions(kind: CapabilityKind, ctx: NarrowingContext = {}): CommandDefinition[] {
  const driverCommands = readCommandMetadata(ctx.config)?.commands;
  if (driverCommands?.length) return driverCommands;
  const defs = COMMAND_DEFINITIONS[kind] ?? [];
  if (kind !== "color") return defs;
  return defs.map((d) => ({ ...d, params: narrowColorFields(d.params, ctx) }));
}

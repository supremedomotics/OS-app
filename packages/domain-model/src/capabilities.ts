import { z } from "zod";

/**
 * The Supreme capability model.
 *
 * This is the heart of the abstraction guarantee (blueprint §7). Heterogeneous
 * backend domains — HA's `light`, `climate`, `cover`, `media_player`, `lock`, … —
 * are normalized into a small, stable set of Supreme *capabilities*. Clients issue
 * commands and read state purely in terms of these capabilities; the SIL is the
 * only layer that translates them to/from a concrete backend.
 *
 * A device advertises one or more capabilities. Each capability defines:
 *   - the shape of its reported STATE, and
 *   - the COMMANDS that can be issued against it.
 */

export const CapabilityKind = z.enum([
  "onoff", // generic power toggle
  "brightness", // dimmable level 0..100
  "color", // color light (hs + kelvin)
  "temperature", // climate setpoint(s) + ambient
  "position", // covers / blinds / awnings 0..100
  "media", // media player transport + volume
  "lock", // door lock / latch
  "fan", // fan: speed preset + direction
  "vacuum", // robot vacuum: status + suction
  "sensor", // read-only measured value
]);
export type CapabilityKind = z.infer<typeof CapabilityKind>;

/** A 0..100 percentage, used for brightness and cover position. */
export const Percent = z.number().min(0).max(100);

// ── State shapes (what the device reports up through the SIL) ────────────────

export const OnOffState = z.object({ on: z.boolean() });

export const BrightnessState = z.object({
  on: z.boolean(),
  level: Percent,
});

/**
 * Structural color-mode metadata for a `color` capability (§ ADR 0017 — Capability Normalization
 * & the `color` Capability Model). Lives in `DeviceCapability.config` (the SAME generic
 * capability-config bag every other capability already uses for its own structural metadata —
 * e.g. a `temperature` capability's `config.modes`/`config.fanSpeeds`) — no schema-breaking
 * change, purely additive.
 *
 * This answers "what can this device do," known at DISCOVERY time from the driver's own
 * protocol model (a Casambi unit's advertised `controls`, a KNX DPT, a Zigbee cluster's
 * ColorCapabilities bitmap, …) — never inferred from a live state snapshot. `colorModes` is
 * `undefined` (the field simply absent) for any driver that hasn't been updated to populate it
 * yet — the UI's compatibility fallback then infers from live state nullability exactly as it
 * always has, keeping every existing driver working unmodified (§ Backward Compatibility).
 */
export const ColorCapabilityConfig = z.object({
  /** Explicit, driver-declared support — never both true from a guess, only from the driver's
   * own real protocol signal. Absent entirely (not `false`/`false`) means "this driver hasn't
   * adopted structural color-mode reporting yet," which is different from "confirmed neither." */
  colorModes: z.object({
    rgb: z.boolean(),
    cct: z.boolean(),
  }).optional(),
  /** Kelvin range this fixture actually supports, when the driver reports it (e.g. KNX DPT
   * 5.001-adjacent range objects, a Zigbee ColorTempPhysicalMin/MaxMireds pair). */
  kelvinRange: z.object({ min: z.number().int(), max: z.number().int() }).optional(),
});
export type ColorCapabilityConfig = z.infer<typeof ColorCapabilityConfig>;

export const ColorState = z.object({
  on: z.boolean(),
  level: Percent,
  /** Hue 0..360, saturation 0..100; null when in white/kelvin mode. */
  hue: z.number().min(0).max(360).nullable(),
  saturation: Percent.nullable(),
  /** Correlated color temperature in Kelvin; null when in color mode. */
  kelvin: z.number().int().min(1000).max(10000).nullable(),
});

/**
 * (§ HVAC Domain-Model Correction) Structured, protocol-neutral HVAC status/fault
 * information — the universal counterpart to KNX `DPT_StatusRHCC` (22.101)'s 15 named
 * status bits (KNX Association "KNX Standard Interworking Datapoint Types" v02.02.01
 * §4.5.2), generalized so any HVAC driver (KNX, CoolMaster, a future protocol) can
 * populate whichever fields it has real, authoritative feedback for. Every field is
 * optional — a driver with no status feedback at all simply omits the whole object
 * (`TemperatureState.status` stays `null`/absent), never a fabricated `false`.
 * Field names follow DPT_StatusRHCC's own bit names (translated to camelCase) since that
 * is the richest real-world source of HVAC status semantics reviewed for this model —
 * not because this type is KNX-specific (a CoolMaster-style `faultCode`/`filterWarning`
 * flag set could map onto `fault`/`heatingDisabled` etc. equally well if a future driver
 * chooses to).
 */
export const HvacStatus = z.object({
  /** DPT_StatusRHCC bit 0 (mandatory in KNX) — the controller itself reports a failure. */
  fault: z.boolean().optional(),
  /** Bit 13 — room temperature dropped below a critical threshold. */
  frostAlarm: z.boolean().optional(),
  /** Bit 14 — room temperature exceeded a critical threshold. */
  overheatAlarm: z.boolean().optional(),
  /** Bit 12 — dew-point condition alarm. */
  dewPointAlarm: z.boolean().optional(),
  /** Bit 7 — heating disabled (e.g. summer mode / calendar). */
  heatingDisabled: z.boolean().optional(),
  /** Bit 11 — cooling disabled (e.g. calendar / outside-temperature threshold). */
  coolingDisabled: z.boolean().optional(),
  /** Bit 2 — flow-temperature limitation active (e.g. floor-heating protection). */
  flowTempLimitActive: z.boolean().optional(),
  /** Bit 3 — return-temperature limitation active (e.g. boiler protection). */
  returnTempLimitActive: z.boolean().optional(),
  /** Bit 1 — heating controller temporarily in energy-saving mode, no real heat demand. */
  ecoHeatingActive: z.boolean().optional(),
  /** Bit 9 — cooling controller temporarily in energy-saving mode, no real cool demand. */
  ecoCoolingActive: z.boolean().optional(),
});
export type HvacStatus = z.infer<typeof HvacStatus>;

export const TemperatureState = z.object({
  ambientC: z.number(),
  targetC: z.number().nullable(),
  /** Optional dual setpoints for heat/cool ranges. */
  targetLowC: z.number().nullable().optional(),
  targetHighC: z.number().nullable().optional(),
  /**
   * (§ HVAC Domain-Model Correction) Baseline controlling-mode value — UNCHANGED from
   * before this correction, kept exactly as-is for backward compatibility with every
   * existing consumer (CoolMaster, KNX, Matter Thermostat adapter, UI, automation). This
   * is the narrow (5-value) approximation of KNX `DPT_HVACContrMode` (20.105)'s much
   * richer enumeration — see `controllingModeExtended` below for the cases where this
   * enum alone would lose real information.
   */
  mode: z.enum(["off", "heat", "cool", "auto", "fan_only"]),
  /**
   * (§ HVAC Domain-Model Correction) The full KNX `DPT_HVACContrMode`/`DPT_HVACContrMode_Z`
   * (20.105/201.104) value, for the cases where it carries a real, distinct state
   * `mode`'s 5-value enum cannot represent losslessly (e.g. "morning_warmup",
   * "night_purge", "precool", "emergency_heat", "emergency_cool", "emergency_steam",
   * "free_cool", "ice", "maximum_heating", "economic_heat_cool", "dehumidification",
   * "calibration", "test", "no_demand"). Deliberately a free-form, driver/protocol-
   * declared string rather than a fixed enum (KNX Association "KNX Standard
   * Interworking Datapoint Types" v02.02.01 §4.3, DPT 20.105's 18-value table) — an
   * enum here would just relocate the same "can't represent everything" problem one
   * level down. Set ONLY as an enrichment alongside `mode` (never instead of it) when a
   * driver has a real, richer value; `null`/absent means "no richer value than `mode`
   * already carries," never a claim that the device has no controlling-mode concept at
   * all. Never populated by inventing a plausible-sounding string — only ever the
   * driver's own real, protocol-native mode name.
   */
  controllingModeExtended: z.string().nullable().optional(),
  /**
   * (§ HVAC Domain-Model Correction) KNX `DPT_HVACMode`/`DPT_HVACMode_Z` (20.102/201.100)
   * — a genuinely DIFFERENT concept from `mode`/`controllingModeExtended`: a
   * comfort/energy PRESET the installer or occupant selects, not a heat/cool/fan
   * operating state (KNX Association "KNX Standard Interworking Datapoint Types"
   * v02.02.01 §4.3, DPT 20.102's 5-value table: Auto/Comfort/Standby/Economy/Building
   * Protection). Named `operatingMode` (matching the KNX document's own "HVAC Operating
   * Mode" heading for this DPT) rather than the more generic "preset", since "preset"
   * does not by itself convey that this is specifically an HVAC comfort-level concept
   * distinct from `mode`'s heat/cool/fan operating state. `null`/absent when a driver
   * has no such concept (e.g. CoolMaster, which has no equivalent) — never fabricated.
   */
  operatingMode: z.enum(["auto", "comfort", "standby", "economy", "building_protection"]).nullable().optional(),
  /**
   * (§ HVAC Domain-Model Correction) KNX `DPT_Heat/Cool`/`DPT_Heat/Cool_Z` (1.100/200.100)
   * — a separate, simple heat-vs-cool selector distinct from `mode`/`controllingModeExtended`.
   * Some KNX installations expose this as its OWN group object rather than folding it into
   * the controlling-mode enum (KNX Association "KNX Standard Interworking Datapoint
   * Types" v02.02.01 §4.3/§4.8.1: "0 = cooling, 1 = heating"). `null`/absent when a
   * driver has no separate signal for this (the common case — most drivers only ever
   * report a single combined mode via `mode`).
   */
  heatCool: z.enum(["heat", "cool"]).nullable().optional(),
  /**
   * (§ HVAC Domain-Model Correction) Structured HVAC status/fault information — see
   * {@link HvacStatus}. `null`/absent when a driver has no status/fault feedback at all.
   */
  status: HvacStatus.nullable().optional(),
  /**
   * (§ HVAC Domain-Model Correction) Named preset setpoints — KNX `DPT_TempRoomSetpSet[3]`/
   * `[4]`/`DPT_TempRoomSetpSetF16[3]` (212.101/213.100/222.100)'s Comfort/Standby/Economy/
   * [Building Protection] values, for installations that expose all of them as distinct,
   * simultaneously-known setpoints rather than one active `targetC`. `null`/absent (the
   * common case) means the driver only ever reports the single currently-active setpoint
   * via `targetC` — never fabricated by splitting `targetC` three ways.
   */
  setpoints: z
    .object({
      comfortC: z.number().nullable().optional(),
      standbyC: z.number().nullable().optional(),
      economyC: z.number().nullable().optional(),
      buildingProtectionC: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
  humidity: Percent.nullable().optional(),
  /** Current value of whichever "advanced" (installer/brand-specific) HVAC parameters
   * this specific device supports — fan speed, swing position, filter/demand/fault
   * flags, remote lock, installer inhibit, runtime hours, etc. Keys are device-declared
   * (see ClimateCapabilityConfig in @supreme/protocols), never a fixed cross-brand enum
   * — mirrors MediaState.advanced. Absent entirely for devices with no advanced state. */
  advanced: z.record(z.unknown()).nullable().optional(),
});

export const PositionState = z.object({
  /** 0 = fully closed, 100 = fully open. */
  position: Percent,
  moving: z.boolean().default(false),
});

export const MediaState = z.object({
  playback: z.enum(["playing", "paused", "stopped", "idle"]),
  volume: Percent,
  muted: z.boolean(),
  title: z.string().nullable(),
  artist: z.string().nullable(),
  /** Album/collection name; null/absent when the source doesn't report one (radio,
   * line-in, an AVR's classic control protocol). */
  album: z.string().nullable().optional(),
  source: z.string().nullable(),
  artworkUrl: z.string().url().nullable(),
  /** Track duration/position in seconds; null/absent when the source doesn't report them
   * (e.g. a live radio station) or the device hasn't reported them yet. */
  durationSec: z.number().nonnegative().nullable().optional(),
  positionSec: z.number().nonnegative().nullable().optional(),
  /** Null/absent when the source doesn't support shuffle/repeat (e.g. AVR line-in). */
  shuffle: z.boolean().nullable().optional(),
  repeat: z.enum(["off", "all", "one"]).nullable().optional(),
  /** Current value of whichever "advanced" (installer-facing) audio parameters this
   * specific device supports — bass/treble/soundMode/equalizer bands, etc. Keys are
   * device-declared (see AudioCapabilityConfig in @supreme/protocols), never a fixed
   * cross-brand enum; the shared schema stays uncluttered by any one brand's DSP/tone
   * vocabulary. Absent entirely for devices with no advanced controls. */
  advanced: z.record(z.unknown()).nullable().optional(),
});

export const LockState = z.object({
  locked: z.boolean(),
  jammed: z.boolean().default(false),
});

export const FanState = z.object({
  on: z.boolean(),
  preset: z.enum(["auto", "sleep", "turbo"]),
  direction: z.enum(["forward", "reverse"]),
});

export const VacuumState = z.object({
  status: z.enum(["idle", "cleaning", "paused", "returning", "docked"]),
  fanSpeed: z.enum(["quiet", "normal", "turbo"]),
});

export const SensorState = z.object({
  value: z.number(),
  unit: z.string(),
  /** e.g. "temperature" | "humidity" | "air_quality" | "power" … */
  measure: z.string(),
});

/** Discriminated union of all capability states, keyed by capability kind. */
export const CapabilityState = z.discriminatedUnion("kind", [
  OnOffState.extend({ kind: z.literal("onoff") }),
  BrightnessState.extend({ kind: z.literal("brightness") }),
  ColorState.extend({ kind: z.literal("color") }),
  TemperatureState.extend({ kind: z.literal("temperature") }),
  PositionState.extend({ kind: z.literal("position") }),
  MediaState.extend({ kind: z.literal("media") }),
  LockState.extend({ kind: z.literal("lock") }),
  FanState.extend({ kind: z.literal("fan") }),
  VacuumState.extend({ kind: z.literal("vacuum") }),
  SensorState.extend({ kind: z.literal("sensor") }),
]);
export type CapabilityState = z.infer<typeof CapabilityState>;

// ── Commands (what clients send down through the SIL) ────────────────────────

export const CapabilityCommand = z.discriminatedUnion("capability", [
  z.object({ capability: z.literal("onoff"), action: z.enum(["on", "off", "toggle"]) }),
  z.object({
    capability: z.literal("brightness"),
    action: z.enum(["set", "on", "off"]),
    level: Percent.optional(),
    /** § Keypad dim-speed — ramp duration for this level change, in milliseconds. Optional
     * and additive: omitted (as every existing caller does) means instant, exactly today's
     * behavior. Only ever honored by a driver that genuinely supports a native fade/ramp
     * concept (Casambi Local UDP today — see `local-command-mapper.ts`'s already-real
     * `fadeMs` plumbing); every other driver silently ignores it rather than fabricating a
     * software-timed ramp this codebase hasn't built. */
    fadeMs: z.number().int().min(0).max(60_000).optional(),
  }),
  z.object({
    capability: z.literal("color"),
    hue: z.number().min(0).max(360).optional(),
    saturation: Percent.optional(),
    kelvin: z.number().int().min(1000).max(10000).optional(),
    level: Percent.optional(),
    /** § Keypad dim-speed — same contract as `brightness.fadeMs` above. */
    fadeMs: z.number().int().min(0).max(60_000).optional(),
  }),
  z.object({
    capability: z.literal("temperature"),
    targetC: z.number().optional(),
    targetLowC: z.number().optional(),
    targetHighC: z.number().optional(),
    mode: z.enum(["off", "heat", "cool", "auto", "fan_only"]).optional(),
    /** (§ HVAC Domain-Model Correction) Command mirror of `TemperatureState.operatingMode`
     * — only meaningful for a driver that has a real, writable KNX-DPT_HVACMode-style
     * comfort/economy preset concept (KNX 20.102) distinct from `mode`. A driver with no
     * such concept simply never reads this field off an incoming command. */
    operatingMode: z.enum(["auto", "comfort", "standby", "economy", "building_protection"]).optional(),
    /** (§ HVAC Domain-Model Correction) Command mirror of `TemperatureState.heatCool` —
     * only meaningful for a driver with a real, separately-writable KNX-DPT_Heat/Cool-style
     * (1.100) heat/cool selector distinct from `mode`. `controllingModeExtended` and
     * `status` are intentionally NOT commandable here: the extended controlling-mode
     * values have no driver that can safely execute an arbitrary one yet, and status is
     * inherently read-only feedback, never something a client writes. */
    heatCool: z.enum(["heat", "cool"]).optional(),
    /** Set one or more device-declared "advanced" parameters (fan speed, swing, remote
     * lock, installer inhibit, …) — see TemperatureState.advanced and
     * ClimateCapabilityConfig.advancedControls for which keys a device actually accepts. */
    advanced: z.record(z.unknown()).optional(),
  }),
  z.object({
    capability: z.literal("position"),
    action: z.enum(["open", "close", "stop", "set"]),
    position: Percent.optional(),
  }),
  z.object({
    capability: z.literal("media"),
    action: z.enum([
      "play", "pause", "stop", "next", "previous", "volume", "mute", "unmute", "source",
      "seek", "shuffle", "repeat", "advanced",
    ]),
    volume: Percent.optional(),
    source: z.string().optional(),
    /** Seek target in seconds — used with action "seek". */
    positionSec: z.number().nonnegative().optional(),
    /** Used with action "shuffle". */
    shuffle: z.boolean().optional(),
    /** Used with action "repeat". */
    repeat: z.enum(["off", "all", "one"]).optional(),
    /** Used with action "advanced" — one or more device-declared parameters (bass,
     * treble, soundMode, sleepMinutes, …) from this device's own AudioCapabilityConfig.
     * Only the keys a device lists in `AudioCapabilityConfig.advancedControls` are
     * ever rendered as a generic homeowner-facing control (e.g. a receiver's Sleep
     * Timer); everything else stays an installer/developer surface. */
    advanced: z.record(z.unknown()).optional(),
  }),
  z.object({ capability: z.literal("lock"), action: z.enum(["lock", "unlock"]) }),
  z.object({
    capability: z.literal("fan"),
    action: z.enum(["on", "off", "preset", "direction"]),
    preset: z.enum(["auto", "sleep", "turbo"]).optional(),
    direction: z.enum(["forward", "reverse"]).optional(),
  }),
  z.object({
    capability: z.literal("vacuum"),
    action: z.enum(["start", "pause", "stop", "return", "fan"]),
    fanSpeed: z.enum(["quiet", "normal", "turbo"]).optional(),
  }),
]);
export type CapabilityCommand = z.infer<typeof CapabilityCommand>;

/** Capabilities that are read-only (cannot be commanded). */
export const READONLY_CAPABILITIES: readonly CapabilityKind[] = ["sensor"];

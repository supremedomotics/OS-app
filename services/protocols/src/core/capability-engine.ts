import type { CapabilityKind, CapabilityState } from "@supreme/domain-model";

/**
 * SupremeOS Capability Engine (§ Casambi Driver Refactor — PR-2). The one place that turns a
 * device's real, already-discovered `CapabilityKind[]` (+ its structural capability config, e.g.
 * `ColorCapabilityConfig.colorModes`) into a flat set of boolean support flags. Every future
 * protocol (KNX, Matter, Lutron, RTI, Denon, DALI, Apple TV, Home Assistant, Bluetooth, MQTT)
 * should expose ONLY these flags to the UI — never a device-type check (`if (device.type ===
 * "light")`), never a protocol check (`if (driver.protocol === "casambi")`). The UI renders
 * entirely from capability flags.
 *
 * Pure, synchronous, and computed from data the driver already reports at discovery time — this
 * module invents nothing. `supportsRGBW` is the one flag that is honestly always `false` today:
 * `packages/domain-model/src/capabilities.ts`'s `ColorCapabilityConfig`/`ColorState` model RGB and
 * CCT (`colorModes.rgb`/`colorModes.cct`) but have no distinct white-channel field, so no driver —
 * Casambi included, even though its own wire protocol has a real `W` component (`0x2F` RGBW,
 * `0x49` Target Color) — has anywhere to report "this fixture has a fourth, independent white
 * channel." Computing `true` here would be a guess, not a signal; see `TODO.md`.
 */

export interface CapabilitySnapshot {
  capabilities: CapabilityKind[];
  colorConfig?: { colorModes?: { rgb: boolean; cct: boolean } };
  /** Latest known state per capability, when available. Sensor sub-kind flags (motion/presence/
   * lux/temperature/humidity/battery) can only be read here — `SensorState.measure` is a live-
   * state field in the domain model, never a discovery-time declaration (no driver today
   * declares "this sensor measures lux" before its first reading arrives). */
  latestStates?: Partial<Record<CapabilityKind, CapabilityState>>;
}

export interface EntityCapabilityFlags {
  supportsOnOff: boolean;
  supportsBrightness: boolean;
  supportsRGB: boolean;
  /** Always `false` today — see module doc comment. */
  supportsRGBW: boolean;
  supportsCCT: boolean;
  supportsButtonEvents: boolean;
  supportsMotion: boolean;
  supportsPresence: boolean;
  supportsLux: boolean;
  supportsBattery: boolean;
  supportsTemperature: boolean;
  supportsHumidity: boolean;
  supportsEnergy: boolean;
}

const SENSOR_MEASURE_FLAGS: Record<string, keyof EntityCapabilityFlags> = {
  motion: "supportsMotion",
  presence: "supportsMotion",
  lux: "supportsLux",
  battery_level: "supportsBattery",
  battery: "supportsBattery",
  temperature: "supportsTemperature",
  humidity: "supportsHumidity",
  power: "supportsEnergy",
  energy: "supportsEnergy",
};

/** Compute a device/entity's capability flags. `nativeButtonEvents` is a driver-reported fact
 * (e.g. Casambi Local's NotifyButtonEvent subscription being active for this unit) since button
 * support isn't expressed as a `CapabilityKind` in the domain model at all. */
export function computeEntityCapabilities(
  snapshot: CapabilitySnapshot,
  nativeButtonEvents = false,
): EntityCapabilityFlags {
  const caps = new Set(snapshot.capabilities);
  const colorModes = snapshot.colorConfig?.colorModes;
  const flags: EntityCapabilityFlags = {
    supportsOnOff: caps.has("onoff") || caps.has("brightness") || caps.has("color"),
    supportsBrightness: caps.has("brightness") || caps.has("color"),
    supportsRGB: caps.has("color") && (colorModes ? colorModes.rgb : true),
    supportsRGBW: false,
    supportsCCT: caps.has("color") && (colorModes ? colorModes.cct : false),
    supportsButtonEvents: nativeButtonEvents,
    supportsMotion: false,
    supportsPresence: false,
    supportsLux: false,
    supportsBattery: false,
    supportsTemperature: caps.has("temperature"),
    supportsHumidity: false,
    supportsEnergy: false,
  };
  if (caps.has("sensor")) {
    const state = snapshot.latestStates?.sensor;
    const measure = state?.kind === "sensor" ? state.measure : undefined;
    const flagKey = measure ? SENSOR_MEASURE_FLAGS[measure] : undefined;
    if (flagKey) (flags[flagKey] as boolean) = true;
  }
  return flags;
}

export interface DriverCapabilityInfo {
  /** The driver's underlying system has a real scene concept it can call/report (e.g. Casambi
   * scenes, an ETS project's scene group addresses). */
  hasScenes: boolean;
  /** The driver's underlying system has a real group concept. */
  hasGroups: boolean;
  /** This driver reports `getDiagnostics?()`/an equivalent driver-level diagnostics snapshot. */
  hasDiagnostics: boolean;
  /** This driver can report the connected device/gateway's firmware version. */
  hasFirmwareInfo: boolean;
  /** This driver is wired into the Driver Health Engine. */
  hasHealthMonitoring: boolean;
}

export interface DriverCapabilityFlags {
  supportsScene: boolean;
  supportsGroups: boolean;
  supportsDiagnostics: boolean;
  supportsFirmware: boolean;
  supportsHealthMonitoring: boolean;
}

/** Compute a driver's (not a single entity's) capability flags — scenes/groups/diagnostics/
 * firmware/health-monitoring are properties of the underlying system as a whole, not of one
 * device, so they're computed separately from {@link computeEntityCapabilities}. */
export function computeDriverCapabilities(info: DriverCapabilityInfo): DriverCapabilityFlags {
  return {
    supportsScene: info.hasScenes,
    supportsGroups: info.hasGroups,
    supportsDiagnostics: info.hasDiagnostics,
    supportsFirmware: info.hasFirmwareInfo,
    supportsHealthMonitoring: info.hasHealthMonitoring,
  };
}

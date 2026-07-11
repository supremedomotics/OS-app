import type { CoolMasterFanSpeed } from "./coolmaster-types.js";

/**
 * Shared CoolMaster capability-config shape — the payload the driver stores on
 * `DeviceCapability.config` for the `temperature` capability, mirroring how
 * AudioCapabilityConfig (avr-capabilities.ts) drives the AVR console generically. The
 * Installer "Advanced Climate" panel (a future UI, out of scope here) would render THIS
 * shape without knowing CoolMaster specifically, the same way it renders any AVR's
 * AudioCapabilityConfig — so a unit's supported fan speeds/swing positions/optional
 * features are never hardcoded anywhere above this driver (§ "Do not hardcode
 * assumptions... render only the features available for that device").
 */

/** One generic, self-describing "extra" HVAC control a unit advertises via
 * `advancedControls`. `key` is the field this control reads/writes inside the
 * `temperature` capability's `advanced` state/command bag — the ONLY mechanism a
 * CoolMaster-specific control (fan speed, swing, lock, inhibit, filter reset, …)
 * reaches the homeowner UI. Mirrors AvrAdvancedControl exactly. */
export interface ClimateAdvancedControl {
  key: string;
  label: string;
  kind: "toggle" | "select" | "range" | "action";
  icon?: string;
  /** For kind "select" — legal values, each written as `{ [key]: option.id }`. */
  options?: { id: string; label: string }[];
  /** For kind "range". */
  range?: { min: number; max: number; step: number };
}

export interface ClimateCapabilityConfig {
  /** How this config was populated. CoolMaster discovery genuinely queries the unit
   * (`ls2`/`query`), so this is normally "device_reported" — mirrors AudioCapabilityConfig's
   * same field/intent for AVR configs that ARE installer-declared instead. */
  source: "device_reported" | "installer_declared";
  /** Which of the five ASCII_IF mode words this unit actually accepts. Discovered from
   * `query`/`ls2` where the gateway reports it; when a line/unit doesn't distinguish
   * (many report all five regardless of physical support), the full set is used and
   * marked accordingly — never silently narrowed on a guess. */
  modes: ("heat" | "cool" | "auto" | "fan_only")[];
  /** Fan speeds this specific unit reports supporting. */
  fanSpeeds?: CoolMasterFanSpeed[];
  /** Swing positions this specific unit reports supporting — brand-variant strings,
   * passed through verbatim (see CoolMasterSwingValue). */
  swingPositions?: string[];
  /** Setpoint range/step this unit accepts, when the gateway reports it; otherwise the
   * UI should assume a conservative 16-30°C/1° default rather than reject all input. */
  temperatureRange?: { minC: number; maxC: number; step: number };
  filterSupported?: boolean;
  demandSupported?: boolean;
  faultSupported?: boolean;
  lockSupported?: boolean;
  inhibitSupported?: boolean;
  /** HVAC line + manufacturer this unit was discovered on, surfaced for installer
   * diagnostics (never used to branch driver logic — a manufacturer string here is
   * informational only, per "future compatibility" / never-hardcode-per-brand). */
  line?: string;
  manufacturer?: string | null;
  advancedControls?: ClimateAdvancedControl[];
}

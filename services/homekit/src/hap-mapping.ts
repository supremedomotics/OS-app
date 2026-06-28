import type { CapabilityKind } from "@supreme/domain-model";

/**
 * Supreme capability ↔ HomeKit Accessory Protocol (HAP) mapping. HomeKit models a device as an
 * accessory exposing one or more SERVICES, each with typed CHARACTERISTICS. This module is the pure,
 * deterministic translation layer (no I/O): Supreme capabilities → HAP services, a HAP
 * characteristic write → a Supreme capability command, and Supreme state → HAP characteristic
 * values. The HAP transport (pairing/SRP, mDNS advertisement, the accessory database) is separate
 * (see bridge.ts) — this is what makes the bridge certifiable and unit-testable.
 *
 * Ref: HomeKit Accessory Protocol Specification, service/characteristic UUIDs.
 */

export type HapServiceType = "Switch" | "Lightbulb" | "LockMechanism" | "WindowCovering" | "Thermostat" | "Fanv2" | "TemperatureSensor";

export interface HapService {
  type: HapServiceType;
  /** Characteristics this service exposes (HAP characteristic names). */
  characteristics: string[];
}

/** The HAP service(s) a Supreme capability projects to (deduped + merged by the bridge per device). */
export function hapServicesFor(capability: CapabilityKind): HapService[] {
  switch (capability) {
    case "onoff":
      return [{ type: "Switch", characteristics: ["On"] }];
    case "brightness":
      return [{ type: "Lightbulb", characteristics: ["On", "Brightness"] }];
    case "color":
      return [{ type: "Lightbulb", characteristics: ["On", "Brightness", "Hue", "Saturation", "ColorTemperature"] }];
    case "lock":
      return [{ type: "LockMechanism", characteristics: ["LockCurrentState", "LockTargetState"] }];
    case "position":
      return [{ type: "WindowCovering", characteristics: ["CurrentPosition", "TargetPosition", "PositionState"] }];
    case "temperature":
      return [{ type: "Thermostat", characteristics: ["CurrentTemperature", "TargetTemperature", "TargetHeatingCoolingState", "CurrentHeatingCoolingState"] }];
    case "fan":
      return [{ type: "Fanv2", characteristics: ["Active", "RotationSpeed"] }];
    case "sensor":
      return [{ type: "TemperatureSensor", characteristics: ["CurrentTemperature"] }];
    default:
      return []; // media / vacuum have no first-class HAP service we expose yet
  }
}

/** A Supreme capability command (mirrors the domain-model discriminated union the hub validates). */
export type HapCommand =
  | { capability: "onoff"; action: "on" | "off" }
  | { capability: "brightness"; action: "set"; level: number }
  | { capability: "color"; hue?: number; saturation?: number; kelvin?: number }
  | { capability: "lock"; action: "lock" | "unlock" }
  | { capability: "position"; action: "set"; position: number }
  | { capability: "temperature"; targetC: number };

const clampPct = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
/** HAP ColorTemperature is in mireds (reciprocal megakelvin); convert to/from kelvin. */
export const miredToKelvin = (mired: number) => Math.round(1_000_000 / mired);
export const kelvinToMired = (kelvin: number) => Math.round(1_000_000 / kelvin);

/**
 * Translate a HAP characteristic write into a Supreme command. Returns null for reads-only or
 * unmapped characteristics (the bridge ignores those).
 */
export function commandFromCharacteristic(characteristic: string, value: unknown): HapCommand | null {
  switch (characteristic) {
    case "On":
      return { capability: "onoff", action: value ? "on" : "off" };
    case "Brightness":
      return { capability: "brightness", action: "set", level: clampPct(Number(value)) };
    case "Hue":
      return { capability: "color", hue: Math.max(0, Math.min(360, Math.round(Number(value)))) };
    case "Saturation":
      return { capability: "color", saturation: clampPct(Number(value)) };
    case "ColorTemperature":
      return { capability: "color", kelvin: miredToKelvin(Number(value)) };
    case "LockTargetState":
      // HAP: 0 = unsecured, 1 = secured.
      return { capability: "lock", action: Number(value) === 1 ? "lock" : "unlock" };
    case "TargetPosition":
      return { capability: "position", action: "set", position: clampPct(Number(value)) };
    case "TargetTemperature":
      return { capability: "temperature", targetC: Number(value) };
    default:
      return null;
  }
}

/**
 * Project a Supreme capability state into the HAP characteristics to push to HomeKit. `state` is the
 * Supreme capability state object. Returns an empty record for capabilities with no HAP projection.
 */
export function characteristicsFromState(capability: CapabilityKind, state: Record<string, unknown>): Record<string, number | boolean> {
  switch (capability) {
    case "onoff":
      return { On: Boolean(state.on) };
    case "brightness":
      return { On: Boolean(state.on), Brightness: clampPct(Number(state.level ?? 0)) };
    case "color": {
      const out: Record<string, number | boolean> = { On: Boolean(state.on) };
      if (state.level !== undefined) out.Brightness = clampPct(Number(state.level));
      if (state.hue !== undefined) out.Hue = Math.max(0, Math.min(360, Math.round(Number(state.hue))));
      if (state.saturation !== undefined) out.Saturation = clampPct(Number(state.saturation));
      if (state.kelvin !== undefined) out.ColorTemperature = kelvinToMired(Number(state.kelvin));
      return out;
    }
    case "lock": {
      const secured = Boolean(state.locked) ? 1 : 0;
      return { LockCurrentState: secured, LockTargetState: secured };
    }
    case "position": {
      const pos = clampPct(Number(state.position ?? 0));
      return { CurrentPosition: pos, TargetPosition: pos, PositionState: 2 /* stopped */ };
    }
    case "temperature":
      return { CurrentTemperature: Number(state.targetC ?? 0), TargetTemperature: Number(state.targetC ?? 0) };
    case "sensor":
      return typeof state.value === "number" ? { CurrentTemperature: Number(state.value) } : {};
    default:
      return {};
  }
}

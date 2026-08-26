import type { CapabilityCommand, CapabilityState } from "@supreme/domain-model";

/**
 * KNX capability ↔ datapoint-value codec (§3, §7). KNX devices are addressed by
 * **group address** (e.g. "1/1/3") and typed by **DPT** (datapoint type). This maps
 * Supreme capabilities to the decoded JS values KNXnet/IP carries:
 *
 *   onoff      → DPT1.001    boolean
 *   brightness → DPT5.001    scaling 0..100 (%)          (on/off derived from level)
 *   position   → DPT5.001    scaling 0..100 (% open)
 *   sensor     → DPT9.001    2-byte float (e.g. °C)      (read-only)
 *   color      → DPT232.600  RGB triplet {red,green,blue} 0..255 each
 *              → DPT251.600  RGBW {red,green,blue,white,mR,mG,mB,mW} — white channel is
 *                left unset (mW: 0) since Supreme's ColorState has no dedicated white
 *                channel; only RGB is driven.
 *              → DPT7.600    absolute colour temperature in Kelvin (tunable-white
 *                fixtures with a dedicated colour-temp GA and a separate DPT5.001
 *                brightness GA bound as the device's "brightness" capability)
 *   lock       → DPT1.xxx    boolean (1 = locked, matching the common KNX door-lock
 *                actuator convention)
 *   temperature → DPT9.001   2-byte float °C, single-GA. Real KNX thermostats split
 *                setpoint/ambient/mode/fan/swing across separate group addresses that
 *                Supreme's one-capability-one-binding model can't fuse into one telegram;
 *                the KNX import engine binds the single writable setpoint GA when one is
 *                identifiable (see services/commissioning/src/knx/entity-generator.ts) and
 *                reports the rest as unbound in an import warning rather than fabricating
 *                a fused multi-address state. Reads on the bound GA are reflected as BOTH
 *                `ambientC` and `targetC` (the only real number available) — not a true
 *                ambient/setpoint split.
 *
 * Byte-level DPT (de)serialization is handled by the KNXnet/IP transport; this codec
 * works in decoded values so the driver stays transport-agnostic and unit-testable.
 */

export interface KnxRgb {
  red: number;
  green: number;
  blue: number;
}
export interface KnxRgbw extends KnxRgb {
  white: number;
  mR: number;
  mG: number;
  mB: number;
  mW: number;
}
export type KnxValue = boolean | number | KnxRgb | KnxRgbw;

/** Default DPT for a capability when a binding doesn't specify one. */
export function defaultDpt(capability: CapabilityState["kind"]): string {
  switch (capability) {
    case "onoff":
      return "DPT1.001";
    case "brightness":
    case "position":
      return "DPT5.001";
    case "sensor":
      return "DPT9.001";
    case "color":
      return "DPT232.600";
    case "lock":
      return "DPT1.001";
    case "temperature":
      return "DPT9.001";
    default:
      return "DPT1.001";
  }
}

/** Translate a Supreme command into the KNX group-write value (null = unsupported). */
export function valueFromCommand(
  command: CapabilityCommand,
  prev: CapabilityState | null,
  dpt?: string,
): KnxValue | null {
  switch (command.capability) {
    case "onoff": {
      if (command.action === "toggle") return !(prev?.kind === "onoff" ? prev.on : false);
      return command.action === "on";
    }
    case "brightness": {
      if (command.action === "off") return 0;
      if (typeof command.level === "number") return clampPct(command.level);
      // "on" with no level → full brightness on a scaling object.
      return prev?.kind === "brightness" && prev.level > 0 ? prev.level : 100;
    }
    case "position": {
      if (command.action === "open") return 100;
      if (command.action === "close") return 0;
      if (typeof command.position === "number") return clampPct(command.position);
      return prev?.kind === "position" ? prev.position : 0;
    }
    case "color": {
      const { major } = dptParts(dpt);
      if (major === 7) {
        // Colour-temperature-only DPT (tunable white): plain Kelvin passthrough.
        if (typeof command.kelvin === "number") return clampKelvin(command.kelvin);
        return prev?.kind === "color" && prev.kelvin !== null ? prev.kelvin : 4000;
      }
      const prevColor = prev?.kind === "color" ? prev : null;
      const hue = command.hue ?? prevColor?.hue ?? 0;
      const saturation = command.saturation ?? prevColor?.saturation ?? 100;
      const level = command.level ?? prevColor?.level ?? 100;
      const { red, green, blue } = hsvToRgb(hue, saturation, level);
      if (major === 251) return { red, green, blue, white: 0, mR: 1, mG: 1, mB: 1, mW: 0 };
      return { red, green, blue };
    }
    case "lock":
      return command.action === "lock";
    case "temperature":
      if (typeof command.targetC === "number") return command.targetC;
      return prev?.kind === "temperature" ? prev.targetC ?? prev.ambientC : 21;
    default:
      return null; // media not mapped to a KNX DPT
  }
}

/** Translate a decoded KNX group value into a Supreme capability state (null = ignore). */
export function stateFromValue(
  capability: CapabilityState["kind"],
  value: KnxValue,
  config: Record<string, unknown> = {},
): CapabilityState | null {
  switch (capability) {
    case "onoff":
      return { kind: "onoff", on: toBool(value) };
    case "brightness": {
      const level = clampPct(Number(value));
      return { kind: "brightness", on: level > 0, level };
    }
    case "position":
      return { kind: "position", position: clampPct(Number(value)), moving: false };
    case "color": {
      if (typeof value === "number") {
        // DPT7.600: colour-temperature-only telegram (tunable white).
        return { kind: "color", on: true, level: 100, hue: null, saturation: null, kelvin: clampKelvin(value) };
      }
      if (typeof value === "object" && value !== null && "red" in value) {
        const { hue, saturation, level } = rgbToHsv(value.red, value.green, value.blue);
        return { kind: "color", on: level > 0, level, hue, saturation, kelvin: null };
      }
      return null;
    }
    case "sensor":
      return {
        kind: "sensor",
        value: Number(value),
        unit: typeof config.unit === "string" ? config.unit : "",
        measure: typeof config.measure === "string" ? config.measure : "value",
      };
    case "lock":
      return { kind: "lock", locked: toBool(value), jammed: false };
    case "temperature": {
      // Single-GA fidelity (see the module docstring): the one real number we have is
      // reflected as both fields rather than fabricating a separate ambient reading.
      const v = Number(value);
      return { kind: "temperature", ambientC: v, targetC: v, mode: "auto" };
    }
    default:
      return null;
  }
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}
function clampKelvin(n: number): number {
  return Math.max(1000, Math.min(10000, Math.round(n)));
}
function toBool(v: KnxValue): boolean {
  return typeof v === "boolean" ? v : v !== 0;
}

/** Parse "DPT232.600" / "232.600" / "232" → { major, minor }. */
export function dptParts(dpt: string | undefined): { major: number; minor: number | null } {
  const m = dpt ? /(\d+)(?:\.(\d+))?/.exec(dpt) : null;
  if (!m) return { major: 232, minor: null }; // default: full-colour RGB
  return { major: Number(m[1]), minor: m[2] ? Number(m[2]) : null };
}

/** Hue 0..360, saturation 0..100, value(level) 0..100 → 0..255 RGB bytes. */
function hsvToRgb(h: number, s: number, v: number): KnxRgb {
  const sat = s / 100;
  const val = v / 100;
  const c = val * sat;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let [r, g, b] = [0, 0, 0];
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = val - c;
  return {
    red: Math.round((r + m) * 255),
    green: Math.round((g + m) * 255),
    blue: Math.round((b + m) * 255),
  };
}

/** 0..255 RGB bytes → hue 0..360, saturation 0..100, level(value) 0..100. */
function rgbToHsv(red: number, green: number, blue: number): { hue: number; saturation: number; level: number } {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let hue = 0;
  if (d !== 0) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  const saturation = max === 0 ? 0 : (d / max) * 100;
  const level = max * 100;
  return { hue: Math.round(hue), saturation: Math.round(saturation), level: Math.round(level) };
}

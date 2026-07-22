import type { CapabilityCommand, CapabilityKind, CapabilityState } from "@supreme/domain-model";

/**
 * Casambi codec (§3) — the ONLY place that knows the Casambi Cloud wire shapes. Pure functions that
 * translate a Casambi unit/event into Supreme capabilities + normalized state, and a Supreme command
 * into a Casambi `targetControls` object. No I/O; the driver owns the transport. Capabilities are
 * derived dynamically from each unit's advertised `controls` (never hard-coded per device model),
 * exactly as the Casambi WebSocket/REST API describes them.
 */

/** A single Casambi control field as advertised in a unit's `controls` array. */
export interface CasambiControl {
  type?: string;
  source?: string;
  value?: number;
  min?: number;
  max?: number;
  level?: number;
  x?: number;
  y?: number;
  rgb?: string;
  name?: string;
}

/** A Casambi unit as returned by REST (`/units`, `/state`) or a `unitChanged` event. */
export interface CasambiUnit {
  id: number;
  name?: string;
  type?: string;
  fixtureId?: number;
  groupId?: number;
  /** BLE mesh address (stable hardware id); preferred backend id when present. */
  address?: string;
  online?: boolean;
  /** Explicit on/off flag (some gateways include it alongside dimLevel). */
  on?: boolean;
  dimLevel?: number;
  status?: string;
  condition?: number;
  activeSceneId?: number;
  controls?: CasambiControl[];
  sensors?: Record<string, unknown>;
  image?: string;
}

const controlType = (c: CasambiControl): string => (c.type ?? "").toLowerCase();
const hasControl = (u: CasambiUnit, ...types: string[]): boolean =>
  (u.controls ?? []).some((c) => types.includes(controlType(c)));

/** Derive the Supreme capabilities a Casambi unit supports from its advertised controls. */
export function capabilitiesFromUnit(u: CasambiUnit): CapabilityKind[] {
  const type = (u.type ?? "").toLowerCase();
  // Sensors (lux / presence / temperature / …) surface as Supreme sensors.
  if (type === "sensor" || (u.sensors && Object.keys(u.sensors).length > 0 && !hasControl(u, "dimmer"))) {
    return ["sensor"];
  }
  const caps: CapabilityKind[] = [];
  const dimmable = hasControl(u, "dimmer");
  const colour = hasControl(u, "color", "rgb", "xy", "cct", "colortemperature");
  // A cover/shade advertises a Slider/vertical control and is not a luminaire.
  const cover = hasControl(u, "slider", "vertical") && !dimmable && !colour;
  if (cover) return ["position"];
  if (dimmable) caps.push("brightness");
  else caps.push("onoff");
  if (colour) caps.push("color");
  return caps;
}

/**
 * Structural color-mode normalization (§ ADR 0017 — Capability Normalization). Casambi's own
 * unit model advertises a real `type` per control (`rgb`/`xy` vs `cct`/`colortemperature`) — a
 * property of the FIXTURE, known from the network model at discovery time, never from a live
 * state snapshot. This is the Casambi-specific instance of "Drivers → Capability Normalization
 * Layer → Supreme Device Capability Model": every driver implements one of these, the UI never
 * sees Casambi's control-type vocabulary. Returns `undefined` for a unit with no color capability
 * at all (nothing to normalize) — never a guess.
 */
export function colorConfigFromUnit(u: CasambiUnit): { colorModes: { rgb: boolean; cct: boolean } } | undefined {
  if (!hasControl(u, "color", "rgb", "xy", "cct", "colortemperature")) return undefined;
  return {
    colorModes: {
      rgb: hasControl(u, "color", "rgb", "xy"),
      cct: hasControl(u, "cct", "colortemperature"),
    },
  };
}

/** Parse "rgb(r, g, b)" into 0–255 components, or null if not parseable. */
function parseRgb(rgb: string | undefined): { r: number; g: number; b: number } | null {
  if (!rgb) return null;
  const m = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i.exec(rgb);
  if (!m) return null;
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

/** RGB (0–255) → hue (0–360) + saturation (0–100). */
export function rgbToHueSat(r: number, g: number, b: number): { hue: number; saturation: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let hue = 0;
  if (d !== 0) {
    if (max === rn) hue = ((gn - bn) / d) % 6;
    else if (max === gn) hue = (bn - rn) / d + 2;
    else hue = (rn - gn) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  const saturation = max === 0 ? 0 : (d / max) * 100;
  return { hue: Math.round(hue), saturation: Math.round(saturation) };
}

const clampPct = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

/** Normalize a Casambi unit into the Supreme states it currently reports (one per capability). */
export function statesFromUnit(u: CasambiUnit): { capability: CapabilityKind; state: CapabilityState }[] {
  const caps = capabilitiesFromUnit(u);
  const out: { capability: CapabilityKind; state: CapabilityState }[] = [];
  const dim = typeof u.dimLevel === "number"
    ? u.dimLevel
    : (u.controls ?? []).find((c) => controlType(c) === "dimmer")?.value ?? 0;
  const on = typeof u.on === "boolean" ? u.on : dim > 0;
  const level = clampPct(dim * 100);

  for (const cap of caps) {
    if (cap === "onoff") {
      out.push({ capability: "onoff", state: { kind: "onoff", on } });
    } else if (cap === "brightness") {
      out.push({ capability: "brightness", state: { kind: "brightness", on, level } });
    } else if (cap === "color") {
      const colorCtl = (u.controls ?? []).find((c) => ["color", "rgb", "xy"].includes(controlType(c)));
      const cctCtl = (u.controls ?? []).find((c) => ["cct", "colortemperature"].includes(controlType(c)));
      let hue: number | null = null, saturation: number | null = null;
      const rgb = parseRgb(colorCtl?.rgb);
      if (rgb) { const hs = rgbToHueSat(rgb.r, rgb.g, rgb.b); hue = hs.hue; saturation = hs.saturation; }
      const kelvin = typeof cctCtl?.value === "number" ? Math.round(cctCtl.value) : null;
      out.push({ capability: "color", state: { kind: "color", on, level, hue, saturation, kelvin } });
    } else if (cap === "position") {
      const slider = (u.controls ?? []).find((c) => ["slider", "vertical"].includes(controlType(c)));
      const min = slider?.min ?? 0, max = slider?.max ?? 100, val = slider?.value ?? 0;
      const position = max > min ? clampPct(((val - min) / (max - min)) * 100) : clampPct(val);
      out.push({ capability: "position", state: { kind: "position", position, moving: false } });
    } else if (cap === "sensor") {
      const { measure, value, unit } = firstSensor(u);
      out.push({ capability: "sensor", state: { kind: "sensor", value, unit, measure } });
    }
  }
  return out;
}

/** Pull the primary sensor reading (lux / temperature / presence / …) from a Casambi unit. */
function firstSensor(u: CasambiUnit): { measure: string; value: number; unit: string } {
  const sensors = (u.sensors ?? {}) as Record<string, unknown>;
  const units: Record<string, string> = { lux: "lx", temperature: "°C", battery_level: "%", presence: "" };
  for (const [key, raw] of Object.entries(sensors)) {
    const value = typeof raw === "number" ? raw : Number((raw as { value?: unknown })?.value ?? 0);
    if (Number.isFinite(value)) return { measure: key, value, unit: units[key] ?? "" };
  }
  return { measure: "sensor", value: 0, unit: "" };
}

/**
 * Translate a Supreme command into a Casambi `targetControls` object for a `controlUnit` message.
 * Returns null for commands this unit can't express. Casambi Dimmer/OnOff use a 0..1 value; RGB
 * hue/sat are normalized to 0..1; ColorTemperature is in Kelvin (with Colorsource "TW"). A
 * non-dimmable unit surfaces as `onoff` and is driven via the documented `OnOff` control; a
 * dimmable luminaire surfaces as `brightness` and is driven via `Dimmer`.
 */
export function commandToTargetControls(
  command: CapabilityCommand,
  prev: CapabilityState | null,
): Record<string, unknown> | null {
  switch (command.capability) {
    case "onoff": {
      const on = command.action === "on" ? true : command.action === "off" ? false : !(prev?.kind === "onoff" && prev.on);
      return { OnOff: { value: on ? 1 : 0 } };
    }
    case "brightness": {
      if (command.action === "off") return { Dimmer: { value: 0 } };
      if (command.action === "on") return { Dimmer: { value: 1 } };
      const level = typeof command.level === "number" ? command.level : 100;
      return { Dimmer: { value: clampPct(level) / 100 } };
    }
    case "color": {
      const controls: Record<string, unknown> = {};
      if (typeof command.kelvin === "number") {
        controls.ColorTemperature = { value: command.kelvin };
        controls.Colorsource = { source: "TW" };
      } else if (typeof command.hue === "number" || typeof command.saturation === "number") {
        const prevColor = prev?.kind === "color" ? prev : null;
        const hue = typeof command.hue === "number" ? command.hue : prevColor?.hue ?? 0;
        const sat = typeof command.saturation === "number" ? command.saturation : prevColor?.saturation ?? 100;
        controls.RGB = { hue: (hue ?? 0) / 360, sat: (sat ?? 0) / 100 };
        controls.Colorsource = { source: "RGB" };
      }
      if (typeof command.level === "number") controls.Dimmer = { value: clampPct(command.level) / 100 };
      return Object.keys(controls).length > 0 ? controls : null;
    }
    case "position": {
      if (command.action === "open") return { Slider: { value: 100 } };
      if (command.action === "close") return { Slider: { value: 0 } };
      if (command.action === "set" && typeof command.position === "number") {
        return { Slider: { value: clampPct(command.position) } };
      }
      return null; // "stop" is not expressible on the Casambi Slider control
    }
    default:
      return null;
  }
}

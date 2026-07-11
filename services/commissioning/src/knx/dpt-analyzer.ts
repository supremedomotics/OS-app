/**
 * DPT Analyzer (§ DPT Recognition Table). Classifies a normalized KNX datapoint type
 * ("major.minor", e.g. "9.001") into a fine-grained {@link DptCategory} — the primary
 * signal the device recognition engine uses to tell a switch from a dimmer from a cover
 * from a sensor, before it ever looks at a name. Falls back gracefully: an unknown
 * subtype still classifies by its major type's general shape (binary/step/percentage/
 * float/counter/…) rather than failing.
 */

export type DptCategory =
  | "binary_switch"
  | "binary_alarm"
  | "binary_occupancy"
  | "binary_updown"
  | "binary_openclose"
  | "binary_windowdoor"
  | "binary_generic"
  | "step_dimming"
  | "step_blind"
  | "percentage"
  | "fan_speed_percentage"
  | "float_temperature"
  | "float_humidity"
  | "float_lux"
  | "float_pressure"
  | "float_co2"
  | "float_generic"
  | "float14_power"
  | "float14_voltage"
  | "float14_current"
  | "float14_generic"
  | "counter_energy"
  | "counter_generic"
  | "scene_control"
  | "color_rgb"
  | "color_rgbw"
  | "color_temperature_kelvin"
  | "hvac_mode"
  | "hvac_fan_speed"
  | "enum_generic"
  | "string"
  | "datetime"
  | "unknown";

export interface DptClassification {
  dpt: string;
  major: number;
  minor: number | null;
  category: DptCategory;
  /** Human label for the review UI / warnings, e.g. "1-bit switch", "RGB colour". */
  label: string;
  /** True for DPTs this analyzer has no specific rule for (classified by major-type shape only). */
  isFallback: boolean;
}

/** Exact "major.minor" rules — the common, well-documented KNX subtypes. Anything not
 * listed here still classifies via the major-type fallback in {@link classifyDpt}. */
const SUBTYPE_RULES: Record<string, { category: DptCategory; label: string }> = {
  "1.001": { category: "binary_switch", label: "Switch" },
  "1.002": { category: "binary_generic", label: "Boolean" },
  "1.003": { category: "binary_generic", label: "Enable" },
  "1.005": { category: "binary_alarm", label: "Alarm" },
  "1.008": { category: "binary_updown", label: "Up/Down" },
  "1.009": { category: "binary_openclose", label: "Open/Close" },
  "1.010": { category: "binary_generic", label: "Start/Stop" },
  "1.011": { category: "binary_generic", label: "State" },
  "1.017": { category: "binary_generic", label: "Trigger" },
  "1.018": { category: "binary_occupancy", label: "Occupancy" },
  "1.019": { category: "binary_windowdoor", label: "Window/Door" },
  "1.021": { category: "binary_generic", label: "Logical Function" },
  "1.022": { category: "binary_generic", label: "Scene A/B" },

  "3.007": { category: "step_dimming", label: "Relative Dimming" },
  "3.008": { category: "step_blind", label: "Blind Step" },

  "5.001": { category: "percentage", label: "Scaling (%)" },
  "5.003": { category: "float_generic", label: "Angle" },
  "5.004": { category: "percentage", label: "Percentage (0..255)" },
  "5.010": { category: "counter_generic", label: "Counter Pulses (1 byte)" },
  "5.100": { category: "fan_speed_percentage", label: "Fan Speed (%)" },

  "6.001": { category: "float_generic", label: "Percentage V8" },
  "6.010": { category: "counter_generic", label: "Counter Pulses (signed 1 byte)" },

  "7.001": { category: "counter_generic", label: "Pulses (2 byte)" },
  "7.002": { category: "counter_generic", label: "Time (ms)" },
  "7.005": { category: "counter_generic", label: "Time (s)" },
  "7.013": { category: "float_generic", label: "Brightness (lux, 2 byte)" },
  "7.600": { category: "color_temperature_kelvin", label: "Colour Temperature (K)" },

  "9.001": { category: "float_temperature", label: "Temperature (°C)" },
  "9.002": { category: "float_temperature", label: "Temperature Difference (K)" },
  "9.004": { category: "float_lux", label: "Illuminance (lux)" },
  "9.005": { category: "float_generic", label: "Wind Speed (m/s)" },
  "9.006": { category: "float_pressure", label: "Pressure (Pa)" },
  "9.007": { category: "float_humidity", label: "Humidity (%)" },
  "9.008": { category: "float_co2", label: "Air Quality (ppm)" },
  "9.020": { category: "float_generic", label: "Voltage (mV)" },
  "9.021": { category: "float_generic", label: "Current (mA)" },
  "9.024": { category: "float_generic", label: "Power (kW)" },
  "9.025": { category: "float_generic", label: "Power (kVA)" },

  "12.001": { category: "counter_generic", label: "Counter (4 byte unsigned)" },

  "13.010": { category: "counter_energy", label: "Active Energy (Wh)" },
  "13.012": { category: "counter_energy", label: "Reactive Energy (VArh)" },
  "13.013": { category: "counter_energy", label: "Active Energy (kWh)" },
  "13.014": { category: "counter_energy", label: "Reactive Energy (kVArh)" },

  "14.019": { category: "float14_current", label: "Electric Current (A)" },
  "14.027": { category: "float14_voltage", label: "Electric Voltage (V)" },
  "14.033": { category: "float14_generic", label: "Frequency (Hz)" },
  "14.056": { category: "float14_power", label: "Power (W)" },
  "14.057": { category: "float14_power", label: "Power Factor" },
  "14.076": { category: "float14_generic", label: "Wind Speed (m/s)" },

  "16.000": { category: "string", label: "ASCII String" },
  "16.001": { category: "string", label: "Latin-1 String" },

  "17.001": { category: "scene_control", label: "Scene Number" },
  "18.001": { category: "scene_control", label: "Scene Control" },

  "19.001": { category: "datetime", label: "Date & Time" },

  "20.102": { category: "hvac_mode", label: "HVAC Controller Mode" },
  "20.105": { category: "hvac_fan_speed", label: "HVAC Fan Speed" },
  "20.106": { category: "hvac_mode", label: "HVAC Controller Status" },

  "28.001": { category: "string", label: "UTF-8 String" },

  "29.010": { category: "counter_energy", label: "Active Energy (V64, Wh)" },
  "29.011": { category: "counter_energy", label: "Apparent Energy (V64, VAh)" },
  "29.012": { category: "counter_energy", label: "Reactive Energy (V64, VARh)" },

  "232.600": { category: "color_rgb", label: "RGB Colour" },
  "251.600": { category: "color_rgbw", label: "RGBW Colour" },
};

/** Fallback classification by DPT major type alone, when the exact subtype isn't in the
 * table above (an unlisted or manufacturer-specific subtype). */
const MAJOR_FALLBACK: Record<number, { category: DptCategory; label: string }> = {
  1: { category: "binary_generic", label: "1-bit value" },
  2: { category: "binary_generic", label: "1-bit controlled" },
  3: { category: "step_dimming", label: "3-bit controlled" },
  4: { category: "string", label: "Character" },
  5: { category: "percentage", label: "8-bit unsigned value" },
  6: { category: "float_generic", label: "8-bit signed value" },
  7: { category: "counter_generic", label: "2-byte unsigned value" },
  8: { category: "float_generic", label: "2-byte signed value" },
  9: { category: "float_generic", label: "2-byte float value" },
  10: { category: "datetime", label: "Time" },
  11: { category: "datetime", label: "Date" },
  12: { category: "counter_generic", label: "4-byte unsigned value" },
  13: { category: "counter_generic", label: "4-byte signed value" },
  14: { category: "float14_generic", label: "4-byte float value" },
  16: { category: "string", label: "String" },
  17: { category: "scene_control", label: "Scene number" },
  18: { category: "scene_control", label: "Scene control" },
  19: { category: "datetime", label: "Date & time" },
  20: { category: "enum_generic", label: "1-byte enum" },
  21: { category: "binary_generic", label: "8-bit set" },
  28: { category: "string", label: "UTF-8 string" },
  29: { category: "counter_energy", label: "8-byte signed value" },
  232: { category: "color_rgb", label: "3-byte colour" },
  251: { category: "color_rgbw", label: "6-byte colour" },
};

/** Classify a normalized "major.minor" DPT string. Never throws — an unparseable or
 * absent DPT classifies as `"unknown"` so callers fall back to other recognition signals. */
export function classifyDpt(dpt: string | null | undefined): DptClassification {
  if (!dpt) return { dpt: "", major: -1, minor: null, category: "unknown", label: "Unknown", isFallback: true };
  const parts = dpt.split(".");
  const major = Number(parts[0]);
  const minor = parts.length > 1 ? Number(parts[1]) : null;
  if (!Number.isFinite(major)) {
    return { dpt, major: -1, minor: null, category: "unknown", label: "Unknown", isFallback: true };
  }

  const exact = SUBTYPE_RULES[dpt];
  if (exact) return { dpt, major, minor, category: exact.category, label: exact.label, isFallback: false };

  const fallback = MAJOR_FALLBACK[major];
  if (fallback) return { dpt, major, minor, category: fallback.category, label: fallback.label, isFallback: true };

  return { dpt, major, minor, category: "unknown", label: `DPT ${dpt}`, isFallback: true };
}

/** Categories with no bus-writable command — read-only telemetry. */
const READONLY_CATEGORIES: ReadonlySet<DptCategory> = new Set<DptCategory>([
  "float_temperature",
  "float_humidity",
  "float_lux",
  "float_pressure",
  "float_co2",
  "float14_power",
  "float14_voltage",
  "float14_current",
  "float14_generic",
  "counter_energy",
  "counter_generic",
  "binary_alarm",
  "binary_occupancy",
  "binary_windowdoor",
]);

export function isReadonlyCategory(category: DptCategory): boolean {
  return READONLY_CATEGORIES.has(category);
}

/** Normalize an ETS DPT string ("DPST-1-1", "DPT-1", "1.001") to "major.minor" / "major". */
export function normalizeDpt(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = /DPST-(\d+)-(\d+)/i.exec(s);
  if (m) return `${m[1]}.${String(m[2]).padStart(3, "0")}`;
  m = /DPT-?(\d+)/i.exec(s);
  if (m && !s.includes(".")) return `${m[1]}`;
  m = /(\d+)\.(\d+)/.exec(s);
  if (m) return `${m[1]}.${m[2]}`;
  m = /^(\d+)$/.exec(s);
  return m ? m[1]! : null;
}

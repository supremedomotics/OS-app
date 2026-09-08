import { MatterClusterId } from "../device-types/matter-cluster-ids.js";
import type { MatterClusterAdapter } from "./matter-cluster-adapter.js";

export const ColorControlAdapter: MatterClusterAdapter = { clusterId: MatterClusterId.ColorControl, clusterName: "ColorControl" };

/** ColorControl's CurrentHue/CurrentSaturation are both 0-254 (verified against
 * `@matter/node`'s `ColorControlServer.ts`, e.g. `(this.state.currentHue * 360) / 254`). */
const MATTER_HUE_MAX = 254;
const MATTER_SATURATION_MAX = 254;

/** SupremeOS hue (0-360 degrees) -> Matter CurrentHue (0-254). */
export function hueToMatter(hueDegrees: number): number {
  return Math.max(0, Math.min(MATTER_HUE_MAX, Math.round((hueDegrees / 360) * MATTER_HUE_MAX)));
}
/** Matter CurrentHue (0-254) -> SupremeOS hue (0-360 degrees). */
export function hueFromMatter(matterHue: number): number {
  return Math.max(0, Math.min(360, Math.round((matterHue / MATTER_HUE_MAX) * 360)));
}
/** SupremeOS saturation (0-100%) -> Matter CurrentSaturation (0-254). */
export function saturationToMatter(percent: number): number {
  return Math.max(0, Math.min(MATTER_SATURATION_MAX, Math.round((percent / 100) * MATTER_SATURATION_MAX)));
}
/** Matter CurrentSaturation (0-254) -> SupremeOS saturation (0-100%). */
export function saturationFromMatter(matterSaturation: number): number {
  return Math.max(0, Math.min(100, Math.round((matterSaturation / MATTER_SATURATION_MAX) * 100)));
}
/** Correlated color temperature: SupremeOS Kelvin -> Matter's ColorTemperatureMireds (the
 * standard Matter/Zigbee reciprocal-megakelvin unit: mireds = 1,000,000 / kelvin). */
export function kelvinToMireds(kelvin: number): number {
  return Math.max(1, Math.round(1_000_000 / kelvin));
}
/** Matter ColorTemperatureMireds -> SupremeOS Kelvin. */
export function miredsToKelvin(mireds: number): number {
  return Math.max(1, Math.round(1_000_000 / mireds));
}

// ── Hue/Saturation <-> CIE 1931 xy chromaticity ───────────────────────────────────────────────
//
// @matter/node's generated Extended Color Light device (`extended-color-light.ts`) requires the
// ColorControl cluster's "Xy" feature, not "HueSaturation" — this Phase composes the device
// exactly as the SDK's own conformant definition requires (no custom feature override, which
// would risk deviating from what a real Matter conformance test — and a real controller —
// actually expects), so a hue/saturation ↔ xy conversion is required at this boundary.
// SupremeOS's own `ColorState` model is hue/saturation, matching how most SupremeOS-native
// drivers (Casambi, KNX, DALI) natively report color, so the conversion belongs here, not in
// the domain model. The RGB<->XYZ matrix below is the standard sRGB/D65 Wright-Guild transform
// published in Philips' Hue API developer documentation and replicated by Home Assistant's own
// color utilities — not a novel derivation, and not guessed.

function hsvToRgb(hueDeg: number, satPercent: number): [number, number, number] {
  const h = ((hueDeg % 360) + 360) % 360 / 60;
  const s = Math.max(0, Math.min(1, satPercent / 100));
  const c = s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = 1 - c;
  let r = 0, g = 0, b = 0;
  if (h < 1) [r, g, b] = [c, x, 0];
  else if (h < 2) [r, g, b] = [x, c, 0];
  else if (h < 3) [r, g, b] = [0, c, x];
  else if (h < 4) [r, g, b] = [0, x, c];
  else if (h < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

function rgbToHsv(r: number, g: number, b: number): [number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s * 100];
}

const srgbToLinear = (v: number): number => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const linearToSrgb = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/** D65 white point — the fallback when X+Y+Z would otherwise be zero (fully desaturated black,
 * which has no defined hue), so this never divides by zero. */
const D65_WHITE = { x: 0.3127, y: 0.329 };

/** SupremeOS hue (0-360°) + saturation (0-100%) -> CIE 1931 xy chromaticity (0..1 each). */
export function hueSaturationToXy(hueDeg: number, satPercent: number): { x: number; y: number } {
  const [r, g, b] = hsvToRgb(hueDeg, satPercent);
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  const X = R * 0.664511 + G * 0.154324 + B * 0.162028;
  const Y = R * 0.283881 + G * 0.668433 + B * 0.047685;
  const Z = R * 0.000088 + G * 0.07231 + B * 0.986039;
  const sum = X + Y + Z;
  if (sum === 0) return D65_WHITE;
  return { x: X / sum, y: Y / sum };
}

/** CIE 1931 xy chromaticity -> SupremeOS hue (0-360°) + saturation (0-100%). */
export function xyToHueSaturation(x: number, y: number): { hue: number; saturation: number } {
  if (y === 0) return { hue: 0, saturation: 0 };
  const Y = 1;
  const X = (Y / y) * x;
  const Z = (Y / y) * (1 - x - y);
  const rLin = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
  const gLin = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
  const bLin = X * 0.051713 - Y * 0.121364 + Z * 1.01153;
  let r = linearToSrgb(rLin);
  let g = linearToSrgb(gLin);
  let b = linearToSrgb(bLin);
  const max = Math.max(r, g, b, 0.0001);
  r = Math.max(0, r / max);
  g = Math.max(0, g / max);
  b = Math.max(0, b / max);
  const [hue, saturation] = rgbToHsv(r, g, b);
  return { hue, saturation };
}

/** ColorControl's CurrentX/CurrentY are UInt16, 0..65279 representing chromaticity 0.0..0.9961
 * (per the Matter 1.6 ColorControl cluster spec: value = chromaticity × 65536, clamped). */
const MATTER_XY_MAX = 65279;
export function xyChannelToMatter(v: number): number {
  return Math.max(0, Math.min(MATTER_XY_MAX, Math.round(v * 65536)));
}
export function xyChannelFromMatter(v: number): number {
  return Math.max(0, Math.min(1, v / 65536));
}

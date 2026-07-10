/**
 * Capability-aware colour mode detection. A `color` capability can be RGB(W)-only, tunable-white
 * (CCT)-only, or both — Supreme doesn't yet carry static per-device colour-mode metadata, but every
 * driver's codec structurally nulls the field a fixture doesn't have (e.g. the Casambi codec only
 * populates `hue`/`saturation` when the unit actually advertises an RGB/XY control, and `kelvin` only
 * when it advertises a CCT control — never both from "which mode is active", since Casambi reports
 * every advertised control in the same state snapshot). Reading that nullability is therefore a
 * reliable, zero-plumbing signal of what a specific light supports.
 *
 * Before any state has ever been seen (fresh commission, nothing reported yet) everything is null —
 * that's indistinguishable from "unsupported", so the safe default is to show both controls.
 */
export interface ColorModes {
  rgb: boolean;
  cct: boolean;
}

export interface ColorLike {
  hue?: number | null;
  saturation?: number | null;
  kelvin?: number | null;
}

export function colorModes(state: ColorLike | null | undefined): ColorModes {
  if (!state) return { rgb: true, cct: true };
  const hasHueSat = state.hue != null || state.saturation != null;
  const hasKelvin = state.kelvin != null;
  if (!hasHueSat && !hasKelvin) return { rgb: true, cct: true };
  return { rgb: hasHueSat, cct: hasKelvin };
}

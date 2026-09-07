/**
 * Capability-aware colour mode detection. A `color` capability can be RGB(W)-only, tunable-white
 * (CCT)-only, or both — Supreme doesn't yet carry static per-device colour-mode metadata, but every
 * driver's codec structurally nulls the field a fixture doesn't have (e.g. the Casambi codec only
 * populates `hue`/`saturation` when the unit actually advertises an RGB/XY control, and `kelvin` only
 * when it advertises a CCT control — never both from "which mode is active", since Casambi reports
 * every advertised control in the same state snapshot). Reading that nullability is therefore a
 * reliable, zero-plumbing signal of what a specific light supports.
 *
 * § Pass 24 (P1 — RGB intermittently visible on CCT-only KNX lights) — before any state has ever
 * been seen (fresh commission, nothing reported yet, or the driver's structural `colorModes` config
 * hasn't arrived/resolved yet — see `SupremeKnxDriver.getCapabilityConfig`, which returns `null`
 * until a binding's real DPT is known), the old boolean model collapsed "genuinely unsupported" and
 * "don't know yet" into the same `false`, and its ONLY safe default was showing BOTH controls. That
 * is exactly what live KNX hardware testing caught: a CCT-only fixture whose structural config
 * hadn't landed yet (or whose live state hadn't reported a kelvin value yet) rendered the RGB wheel.
 * `colorModesTriState` distinguishes the three real states explicitly; `"unknown"` never renders as
 * RGB (or CCT) visible — see `getDeviceUiCapabilities`, which is the only caller that turns this
 * into a boolean UI flag. The boolean `colorModes()` below is kept only for any caller that still
 * wants a simple boolean read of tri-state data (`unknown` reads as `false` — the same "never show
 * a control we can't confirm" rule, no longer "assume both").
 */
export type ColorModeState = "unknown" | "supported" | "unsupported";

export interface ColorModesTriState {
  rgb: ColorModeState;
  cct: ColorModeState;
}

export interface ColorModes {
  rgb: boolean;
  cct: boolean;
}

export interface ColorLike {
  hue?: number | null;
  saturation?: number | null;
  kelvin?: number | null;
}

export function colorModesTriState(state: ColorLike | null | undefined): ColorModesTriState {
  if (!state) return { rgb: "unknown", cct: "unknown" };
  const hasHueSat = state.hue != null || state.saturation != null;
  const hasKelvin = state.kelvin != null;
  if (!hasHueSat && !hasKelvin) return { rgb: "unknown", cct: "unknown" };
  return { rgb: hasHueSat ? "supported" : "unsupported", cct: hasKelvin ? "supported" : "unsupported" };
}

/** Boolean projection of {@link colorModesTriState} — `"supported"` is the only state that reads
 * `true`; both `"unsupported"` and `"unknown"` read `false`. */
export function colorModes(state: ColorLike | null | undefined): ColorModes {
  const tri = colorModesTriState(state);
  return { rgb: tri.rgb === "supported", cct: tri.cct === "supported" };
}

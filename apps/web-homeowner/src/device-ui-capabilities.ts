import type { CapabilityKind, Device } from "@supreme/domain-model";
import { colorModesTriState, type ColorLike } from "./colormode.js";

/**
 * Single source of truth for "which controls may this device's/room's UI show" (§ ADR 0017 —
 * Capability Normalization & the `color` Capability Model, and § ADR 0016 — Capability-Driven UI
 * Architecture). Every page that renders — or decides whether to render — a capability-specific
 * control, or that filters a device list by "is this a light/thermostat/lock/…", must derive
 * that decision from `getDeviceUiCapabilities()` / `getRoomUiCapabilities()` instead of
 * re-deriving its own `capabilities.some(...)` check. This is the ONE place that answers "what
 * controls exist" — never mixed with "what value does the control currently show" (state), so a
 * device the driver hasn't reported state for yet never has a control silently disappear.
 */
export interface DeviceUiCapabilities {
  showPower: boolean;
  showBrightness: boolean;
  showRGB: boolean;
  showCCT: boolean;
  showPosition: boolean;
  showClimate: boolean;
  showFan: boolean;
  showLock: boolean;
  showMedia: boolean;
  showSensor: boolean;
  /** True when RGB/CCT were resolved from the driver's own structural capability config (§ ADR
   * 0017) rather than inferred from live state — surfaced so a page COULD show "confirmed" vs.
   * "best guess" if it ever wants to; no current page uses it to hide anything. */
  colorModeConfirmed: boolean;
}

type CapabilityLike = { kind: string; config?: Record<string, unknown> | null };

/** Accepts `kind: string` too — some lighter API shapes (e.g. `DeviceLite`) carry capabilities
 * with a loosened string type rather than the full `CapabilityKind` union; the check itself is
 * identical either way. */
export function hasCapability(capabilities: readonly { kind: string }[], kind: CapabilityKind): boolean {
  return capabilities.some((c) => c.kind === kind);
}

/**
 * `colorState` is live-merged state for the `color` capability (hue/saturation/kelvin) — pass
 * it when you have it, omit it when you don't. It is the FALLBACK signal only: RGB/CCT
 * disambiguation now prefers the `color` capability's own structural `config.colorModes` (§ ADR
 * 0017 — populated by drivers that have adopted Capability Normalization, e.g. Casambi's
 * `colorConfigFromUnit()`, from the driver's real protocol model at discovery time, never from a
 * state snapshot). Only when a device's `color` capability carries no such config (a driver that
 * hasn't adopted structural reporting yet) does this fall back to `colorModesTriState(colorState)`'s
 * documented state-nullability inference — keeping every existing driver working unmodified
 * (§ Backward Compatibility).
 *
 * § Pass 24 (P1 — RGB intermittently visible on CCT-only KNX lights, live-confirmed) — a device
 * that HAS `color` but whose mode is genuinely `"unknown"` (no structural config resolved yet AND
 * no state seen yet — e.g. a freshly-bound KNX device before `SupremeKnxDriver.getCapabilityConfig`
 * has a DPT to report, or before the first feedback telegram lands) no longer defaults to showing
 * BOTH controls. `"unknown"` never renders as an available control (see `colormode.ts`'s tri-state
 * doc comment for why the old "assume both" default was live-confirmed wrong). `colorModeConfirmed`
 * keeps its existing narrower meaning — "the driver's own structural config resolved this" — a
 * state-inferred `"supported"`/`"unsupported"` still leaves it `false`.
 */
export function getDeviceUiCapabilities(
  capabilities: readonly CapabilityLike[],
  colorState?: ColorLike | null,
): DeviceUiCapabilities {
  const colorCap = capabilities.find((c) => c.kind === "color");
  const hasColor = Boolean(colorCap);
  const structuralModes = colorCap?.config?.colorModes as { rgb: boolean; cct: boolean } | undefined;
  const bool2tri = (v: boolean): "supported" | "unsupported" => (v ? "supported" : "unsupported");
  const modes = !hasColor
    ? { rgb: "unsupported" as const, cct: "unsupported" as const }
    : structuralModes
      ? { rgb: bool2tri(structuralModes.rgb), cct: bool2tri(structuralModes.cct) }
      : colorModesTriState(colorState);
  return {
    colorModeConfirmed: hasColor && Boolean(structuralModes),
    showPower: hasCapability(capabilities, "onoff") || hasCapability(capabilities, "brightness") || hasColor,
    showBrightness: hasCapability(capabilities, "brightness") || hasColor,
    showRGB: modes.rgb === "supported",
    showCCT: modes.cct === "supported",
    showPosition: hasCapability(capabilities, "position"),
    showClimate: hasCapability(capabilities, "temperature"),
    showFan: hasCapability(capabilities, "fan"),
    showLock: hasCapability(capabilities, "lock"),
    showMedia: hasCapability(capabilities, "media"),
    showSensor: hasCapability(capabilities, "sensor"),
  };
}

/** Convenience overload for callers already holding a real {@link Device} with live-merged
 * state — reads `state.color` itself so call sites don't each repeat that extraction. */
export function deviceUiCapabilities(device: Device, liveState?: Record<string, unknown>): DeviceUiCapabilities {
  const merged = { ...device.state, ...liveState } as Record<string, ColorLike | undefined>;
  return getDeviceUiCapabilities(device.capabilities, merged.color);
}

/**
 * Room/aggregate-level (§ Room-Level Aggregate Controls): a room-wide control is shown when AT
 * LEAST ONE device in the room supports it — derived ONLY from each device's own
 * {@link getDeviceUiCapabilities} result, never by re-inspecting raw capability arrays. Room
 * pages must treat this as the only source of truth for "does this room have an X control."
 * It does NOT decide which devices a room-wide command targets — that's still each device's own
 * flag (`perDevice.filter(d => d.showRGB)`, etc.), so an RGB command never reaches a CCT-only or
 * dimmer-only light and vice versa.
 */
export type RoomUiCapabilities = DeviceUiCapabilities;

export function getRoomUiCapabilities(perDevice: readonly DeviceUiCapabilities[]): RoomUiCapabilities {
  const any = (flag: keyof DeviceUiCapabilities) => perDevice.some((c) => c[flag]);
  return {
    showPower: any("showPower"),
    showBrightness: any("showBrightness"),
    showRGB: any("showRGB"),
    showCCT: any("showCCT"),
    showPosition: any("showPosition"),
    showClimate: any("showClimate"),
    showFan: any("showFan"),
    showLock: any("showLock"),
    showMedia: any("showMedia"),
    showSensor: any("showSensor"),
    colorModeConfirmed: perDevice.every((c) => !c.showRGB && !c.showCCT ? true : c.colorModeConfirmed),
  };
}

/** `anyDeviceHas(perDevice, "showRGB")` — kept as a named helper for call sites that only need
 * one flag rather than the full aggregate object. */
export function anyDeviceHas(perDevice: readonly DeviceUiCapabilities[], flag: keyof DeviceUiCapabilities): boolean {
  return perDevice.some((c) => c[flag]);
}

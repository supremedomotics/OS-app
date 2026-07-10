/**
 * Shared AVR capability-config shape (§7 of the Universal AVR Framework review,
 * docs/architecture/avr-framework-review.md) — the payload every AVR/media codec
 * (Denon/Marantz Telnet, HEOS, Yamaha YXC) stores on `DeviceCapability.config` for the
 * `media` capability. The Installer/Developer "Advanced Audio" panel renders THIS shape
 * generically, the same way the Driver Manager renders any manifest's `configSchema`
 * without knowing the driver in advance — so a brand's input list, DSP mode names, and
 * tone/EQ ranges are never hardcoded anywhere in the UI.
 *
 * Detection is NOT equally possible on every protocol (verified against the real specs,
 * not assumed): Yamaha's `getFeatures` and HEOS's fixed protocol-level input enum both
 * genuinely populate this on the wire; classic Denon/Marantz Telnet has no feature-query
 * command at all, so its `AudioCapabilityConfig` comes from installer-declared binding
 * config instead of a device response. Either source produces the same shape, so the UI
 * never needs to know which one supplied it.
 */

/** One selectable input/source. `label` defaults to `id` when a protocol has no separate
 * display name (e.g. Denon's Telnet `SI` parameters double as both).
 *
 * `type` is a loose, non-enumerated hint (e.g. "hdmi" | "optical" | "analog" | "tuner" |
 * "usb" | "bluetooth" | "streaming" | "network") the UI uses ONLY to pick an icon — it's
 * never required and never validated against a fixed list, matching every other
 * brand-specific string in this file. Absent when a codec can't reasonably guess it. */
export interface AvrInput {
  id: string;
  label: string;
  type?: string;
}

/** One selectable DSP / surround / sound-program mode. Brand-specific names (Yamaha's
 * "munich"/"vienna", Denon's "DOLBY DIGITAL"/"MATRIX") are passed through verbatim —
 * never mapped onto a shared enum, since they don't correspond 1:1 across brands. */
export interface AvrSoundMode {
  id: string;
  label: string;
}

/** A single adjustable range (tone control, EQ band, dialogue level, …). `step` is the
 * smallest legal increment; some devices report a non-percentage native scale (e.g.
 * Yamaha volume 0..194) — see {@link percentFromScale}/{@link scaleFromPercent}. */
export interface AvrRange {
  min: number;
  max: number;
  step: number;
}

/** One physical or logical zone this driver can bind as its own Supreme device. */
export interface AvrZoneInfo {
  /** Protocol-native zone id, e.g. "main" | "zone2" | "z2" | HEOS pid. */
  id: string;
  label: string;
  inputs: AvrInput[];
}

export interface AudioCapabilityConfig {
  /** How this config was populated — surfaced in the Installer UI so a "declared, not
   * detected" config (Denon Telnet zones/tone) reads honestly rather than implying a
   * live query backs every field. */
  source: "device_reported" | "installer_declared";
  inputs: AvrInput[];
  soundModes?: AvrSoundMode[];
  volumeRange?: AvrRange;
  toneControl?: { bass: AvrRange; treble: AvrRange };
  equalizer?: { low: AvrRange; mid: AvrRange; high: AvrRange };
  zones?: AvrZoneInfo[];
  /** Transport actions this specific source/input actually supports right now (HEOS's
   * per-service table, Yamaha's `attribute` bitfield) — a Supreme `media` capability is
   * always present, but not every command necessarily applies to every input. */
  transport?: {
    play?: boolean;
    pause?: boolean;
    stop?: boolean;
    next?: boolean;
    previous?: boolean;
    seek?: boolean;
    shuffle?: boolean;
    repeat?: boolean;
  };
  presets?: { id: string; label: string }[];
  bluetooth?: boolean;
  /** Extra homeowner-facing controls this device genuinely supports, beyond the fixed
   * play/pause/volume/mute/source/shuffle/repeat surface — e.g. a receiver's sleep
   * timer. Each entry's `key` matches a key the device reads/writes inside the `media`
   * capability's `advanced` state/command bag. This is the ONLY mechanism a brand-
   * specific "quick action" (Sleep Timer, Night Mode, …) reaches the homeowner UI —
   * nothing outside this list is ever rendered generically, so a control a device
   * doesn't declare here simply doesn't appear (§ Universal AVR Framework "never
   * hardcode a brand's controls"). */
  advancedControls?: AvrAdvancedControl[];
}

/** One generic, self-describing "extra" control a device advertises via
 * `advancedControls`. `key` is the field this control reads/writes inside the `media`
 * capability's `advanced` bag (state and the "advanced" command's `advanced` payload). */
export interface AvrAdvancedControl {
  key: string;
  label: string;
  kind: "toggle" | "select" | "range";
  /** UI icon hint — same loose, unvalidated convention as {@link AvrInput.type}. */
  icon?: string;
  /** For kind "select" — the legal values, each written as `{ [key]: option.id }`. */
  options?: { id: string; label: string }[];
  /** For kind "range". */
  range?: AvrRange;
}

/** Convert a device-native scale reading (e.g. Yamaha volume 0..194) to Supreme's 0..100. */
export function percentFromScale(raw: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.max(0, Math.min(100, Math.round(((raw - min) / (max - min)) * 100)));
}

/** Convert a Supreme 0..100 percent to a device-native scale value, snapped to `step`. */
export function scaleFromPercent(pct: number, min: number, max: number, step = 1): number {
  const clamped = Math.max(0, Math.min(100, pct));
  const raw = min + (clamped / 100) * (max - min);
  const snapped = Math.round(raw / step) * step;
  return Math.max(min, Math.min(max, snapped));
}

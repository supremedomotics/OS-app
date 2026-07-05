/**
 * Circadian (human-centric) lighting (§10, §16) — a marquee luxury feature. A circadian PROFILE is a
 * set of keyframes across the day (warm + dim at night, neutral-bright at midday, warm again in the
 * evening); the engine interpolates the target color temperature + brightness for any moment, so
 * lights track the body's natural rhythm. Pure and deterministic (no clock, no I/O): the caller
 * passes the local minute-of-day, and a scene/automation applies the result as a color command.
 */

export interface CircadianKeyframe {
  /** Minutes since local midnight, 0..1439. */
  atMinutes: number;
  /** Color temperature in kelvin (warm ~2000, neutral ~4000, cool ~6500). */
  kelvin: number;
  /** Brightness 0..100. */
  brightness: number;
}

export interface CircadianProfile {
  keyframes: CircadianKeyframe[];
}

export interface CircadianTarget {
  kelvin: number;
  brightness: number;
}

export class CircadianError extends Error {}

/**
 * A sensible default profile: deep warm at night, warming sunrise, cool bright midday, warm dim
 * evening. Installers/owners can override with their own keyframes.
 */
export const defaultCircadianProfile: CircadianProfile = {
  keyframes: [
    { atMinutes: 0, kelvin: 2000, brightness: 1 }, // 00:00 — night
    { atMinutes: 6 * 60, kelvin: 2700, brightness: 20 }, // 06:00 — wake
    { atMinutes: 9 * 60, kelvin: 4000, brightness: 70 }, // 09:00 — morning
    { atMinutes: 13 * 60, kelvin: 6000, brightness: 100 }, // 13:00 — midday peak
    { atMinutes: 17 * 60, kelvin: 4500, brightness: 80 }, // 17:00 — afternoon
    { atMinutes: 20 * 60, kelvin: 3000, brightness: 50 }, // 20:00 — evening
    { atMinutes: 22 * 60, kelvin: 2300, brightness: 20 }, // 22:00 — wind down
  ],
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function normalizedKeyframes(profile: CircadianProfile): CircadianKeyframe[] {
  if (profile.keyframes.length === 0) throw new CircadianError("circadian profile needs at least one keyframe");
  for (const k of profile.keyframes) {
    if (k.atMinutes < 0 || k.atMinutes > 1439) throw new CircadianError(`keyframe atMinutes out of range: ${k.atMinutes}`);
    if (k.kelvin < 1000 || k.kelvin > 10000) throw new CircadianError(`keyframe kelvin out of range: ${k.kelvin}`);
  }
  return [...profile.keyframes].sort((a, b) => a.atMinutes - b.atMinutes);
}

/**
 * The circadian target at a given local minute-of-day. Linearly interpolates color temperature +
 * brightness between the surrounding keyframes, wrapping around midnight (so 23:30 blends toward the
 * first keyframe of the next day).
 */
export function circadianAt(profile: CircadianProfile, minutesSinceMidnight: number): CircadianTarget {
  const frames = normalizedKeyframes(profile);
  const m = clamp(Math.round(minutesSinceMidnight), 0, 1439);
  if (frames.length === 1) return { kelvin: frames[0]!.kelvin, brightness: clamp(frames[0]!.brightness, 0, 100) };

  // Find the keyframe at or before m; the next one (wrapping) is the upper bound.
  let lowerIdx = -1;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i]!.atMinutes <= m) lowerIdx = i;
  }
  // Before the first keyframe or after the last → wrap across midnight.
  const lower = lowerIdx >= 0 ? frames[lowerIdx]! : frames[frames.length - 1]!;
  const upper = lowerIdx >= 0 ? frames[(lowerIdx + 1) % frames.length]! : frames[0]!;

  const spanMinutes = lowerIdx >= 0 && lowerIdx + 1 < frames.length ? upper.atMinutes - lower.atMinutes : 1440 - lower.atMinutes + upper.atMinutes;
  const intoSpan = lowerIdx >= 0 ? (m >= lower.atMinutes ? m - lower.atMinutes : 1440 - lower.atMinutes + m) : 1440 - lower.atMinutes + m;
  const t = spanMinutes === 0 ? 0 : clamp(intoSpan / spanMinutes, 0, 1);

  return {
    kelvin: Math.round(lower.kelvin + (upper.kelvin - lower.kelvin) * t),
    brightness: clamp(Math.round(lower.brightness + (upper.brightness - lower.brightness) * t), 0, 100),
  };
}

/** Build a Supreme color CapabilityCommand from a circadian target (drives a tunable-white light). */
export function circadianColorCommand(target: CircadianTarget): { capability: "color"; kelvin: number; level: number } {
  return { capability: "color", kelvin: target.kelvin, level: target.brightness };
}

/** Convenience: the target for a Date's LOCAL time (hours/minutes). */
export function circadianForLocalTime(profile: CircadianProfile, hours: number, minutes: number): CircadianTarget {
  return circadianAt(profile, hours * 60 + minutes);
}

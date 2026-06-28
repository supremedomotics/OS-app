/**
 * Occupancy (vacation) simulation (§12, §16) — a luxury-security feature. While the home is armed-
 * away for an extended period, replay a believable lighting pattern so the house looks lived-in
 * (lights coming on and off through the evening, staggered across rooms) to deter burglars.
 *
 * The planner is PURE and DETERMINISTIC given a seed (no clock, no Math.random) — so a preview shows
 * exactly what the hub will do, and tests are reproducible. The hub's scheduler applies each event
 * when the wall clock reaches its minute.
 */

export interface OccupancyConfig {
  /** Controllable lights to animate. */
  deviceIds: string[];
  /** Active window as minutes since local midnight (e.g. 18:00–23:30 → 1080..1410). */
  startMinute: number;
  endMinute: number;
  /** Deterministic seed; the same seed yields the same plan. */
  seed: number;
  /** Minimum / maximum minutes a light stays on per activation. */
  minOnMinutes?: number;
  maxOnMinutes?: number;
}

export interface OccupancyEvent {
  atMinutes: number;
  deviceId: string;
  action: "on" | "off";
}

export class OccupancyError extends Error {}

/** Deterministic 32-bit PRNG (mulberry32) → floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a believable schedule of light on/off events across the window. Each light gets one or more
 * staggered "on" intervals; lights are interleaved so the house lights up room by room, not all at
 * once. Returns events sorted by time (and balanced — every `on` has a matching `off`).
 */
export function planOccupancy(config: OccupancyConfig): OccupancyEvent[] {
  if (config.deviceIds.length === 0) throw new OccupancyError("occupancy simulation needs at least one light");
  if (config.endMinute <= config.startMinute) throw new OccupancyError("endMinute must be after startMinute");
  const windowLen = config.endMinute - config.startMinute;
  const minOn = config.minOnMinutes ?? 20;
  const maxOn = config.maxOnMinutes ?? 90;
  if (minOn <= 0 || maxOn < minOn) throw new OccupancyError("invalid on-duration bounds");

  const rand = mulberry32(config.seed);
  const events: OccupancyEvent[] = [];

  config.deviceIds.forEach((deviceId, i) => {
    // Stagger each light's first activation across the window so rooms light up in sequence.
    const stagger = Math.floor((windowLen / config.deviceIds.length) * i);
    let cursor = config.startMinute + stagger + Math.floor(rand() * 15);
    // One or two activations per light within the window.
    const activations = 1 + (rand() < 0.5 ? 1 : 0);
    for (let a = 0; a < activations; a++) {
      if (cursor >= config.endMinute) break;
      const onAt = cursor + Math.floor(rand() * 20);
      if (onAt >= config.endMinute) break;
      const duration = minOn + Math.floor(rand() * (maxOn - minOn + 1));
      const offAt = Math.min(onAt + duration, config.endMinute);
      events.push({ atMinutes: onAt, deviceId, action: "on" });
      events.push({ atMinutes: offAt, deviceId, action: "off" });
      cursor = offAt + 10 + Math.floor(rand() * 30); // gap before the light's next activation
    }
  });

  return events.sort((x, y) => x.atMinutes - y.atMinutes || (x.action === "off" ? -1 : 1));
}

/** The events due at a given minute-of-day (the hub scheduler calls this each tick). */
export function occupancyEventsAt(plan: OccupancyEvent[], minutesSinceMidnight: number): OccupancyEvent[] {
  return plan.filter((e) => e.atMinutes === minutesSinceMidnight);
}

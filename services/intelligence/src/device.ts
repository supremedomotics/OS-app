/**
 * Device intelligence metadata — the per-device facts the engine reasons over beyond raw capability
 * state: who owns it, who shares it, its priority, whether it's critical (never auto-off), whether it
 * opts out of Auto Pilot, whether it's legitimately always-on, and its rated power. Stored per-home
 * in the durable config store (key `device_intel`: deviceId → DeviceIntel); validated on write.
 */

export type DevicePriority = "low" | "normal" | "high" | "critical";
const PRIORITIES: readonly DevicePriority[] = ["low", "normal", "high", "critical"];

export interface DeviceIntel {
  ownerUserId?: string;
  sharedUserIds?: string[];
  /** Optional explicit zone override; normally derived from the device's room → zone. */
  zoneId?: string;
  priority?: DevicePriority;
  /** Critical loads (fridge, medical, security) are NEVER auto-controlled, only ever surfaced. */
  critical?: boolean;
  /** Owner opted this device out of Auto Pilot entirely. */
  ignoreAutoPilot?: boolean;
  /** Legitimately stays on with nobody around (router, NAS, fish-tank pump). */
  expectedAlwaysOn?: boolean;
  /** Rated watts, for energy/cost estimation when the device has no power meter. */
  estimatedWatts?: number;
}

export class DeviceIntelError extends Error {}

function asStringArray(v: unknown, field: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new DeviceIntelError(`${field} must be an array of ids`);
  return v as string[];
}

/** Validate + normalize a single DeviceIntel record on write. */
export function validateDeviceIntel(v: unknown): DeviceIntel {
  const o = (v ?? {}) as Record<string, unknown>;
  if (typeof o !== "object" || Array.isArray(o)) throw new DeviceIntelError("device intel must be an object");
  const out: DeviceIntel = {};
  if (o.ownerUserId !== undefined) {
    if (typeof o.ownerUserId !== "string") throw new DeviceIntelError("ownerUserId must be a string");
    out.ownerUserId = o.ownerUserId;
  }
  const shared = asStringArray(o.sharedUserIds, "sharedUserIds");
  if (shared) out.sharedUserIds = shared;
  if (o.zoneId !== undefined) {
    if (typeof o.zoneId !== "string") throw new DeviceIntelError("zoneId must be a string");
    out.zoneId = o.zoneId;
  }
  if (o.priority !== undefined) {
    if (!PRIORITIES.includes(o.priority as DevicePriority)) throw new DeviceIntelError(`priority must be one of ${PRIORITIES.join("|")}`);
    out.priority = o.priority as DevicePriority;
  }
  for (const flag of ["critical", "ignoreAutoPilot", "expectedAlwaysOn"] as const) {
    if (o[flag] !== undefined) {
      if (typeof o[flag] !== "boolean") throw new DeviceIntelError(`${flag} must be a boolean`);
      out[flag] = o[flag] as boolean;
    }
  }
  if (o.estimatedWatts !== undefined) {
    const w = o.estimatedWatts;
    if (typeof w !== "number" || !Number.isFinite(w) || w < 0 || w > 100000) throw new DeviceIntelError("estimatedWatts must be 0..100000");
    out.estimatedWatts = w;
  }
  // A critical device implies it shouldn't be auto-piloted.
  if (out.critical) out.ignoreAutoPilot = true;
  return out;
}

/** Validate a whole deviceId → DeviceIntel map. */
export function validateDeviceIntelMap(v: unknown): Record<string, DeviceIntel> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new DeviceIntelError("device intel map must be an object of deviceId → intel");
  const out: Record<string, DeviceIntel> = {};
  for (const [id, intel] of Object.entries(v as Record<string, unknown>)) out[id] = validateDeviceIntel(intel);
  return out;
}

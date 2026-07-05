/**
 * Energy Intelligence decision core (pure). For each ON device it answers the product's checklist —
 * who owns it, is the owner present, is anyone in the room/zone/house, is it expected to stay on, how
 * long has it been on, what's it costing — and turns that into a multi-dimension Confidence plus, when
 * warranted, a Suggestion to turn it off. It NEVER controls anything and never decides to act on its
 * own: it emits a recommendation + confidence, and the host's Auto Pilot mode + threshold decide.
 *
 * Deterministic: same world snapshot + `now` → same result. No clock, no I/O.
 */
import { type Confidence, clamp01, makeConfidence } from "../confidence.js";
import type { Suggestion, Observation, ModuleResult } from "../engine.js";
import type { PresenceEstimate } from "../presence/fusion.js";
import type { HouseOccupancy } from "../zones.js";
import type { DeviceIntel } from "../device.js";

export interface EnergyDeviceInput {
  deviceId: string;
  name: string;
  roomId: string | null;
  zoneId: string | null;
  on: boolean;
  /** ms-epoch the device turned on (null if unknown / not on). */
  onSinceMs: number | null;
  /** Rated/measured watts; absent → no cost estimate and no auto-off (we won't guess blind). */
  watts?: number;
  intel?: DeviceIntel;
}

export interface EnergyIntelOptions {
  /** Don't flag a device until it's been on at least this long. Default 15 min. */
  minIdleMinutes?: number;
  /** Ignore trivial loads below this. Default 5 W. */
  minWatts?: number;
  /** A user must be at least this confident-present to count as occupying an area. Default 0.6. */
  presentThreshold?: number;
  /** Minimum area-vacancy before a device is even a candidate to suggest off. Default 0.5. */
  candidateVacancyFloor?: number;
}

export interface EnergyIntelInput {
  now: number;
  devices: EnergyDeviceInput[];
  presence: PresenceEstimate[];
  house: HouseOccupancy;
  ratePerKwh?: number;
  currency?: string;
  options?: EnergyIntelOptions;
}

const MIN = 60_000;

/** Max presence confidence among users currently located in `roomId` (0 if none). */
function roomOccupancyConfidence(presence: PresenceEstimate[], roomId: string | null, threshold: number): number {
  if (!roomId) return 0;
  let max = 0;
  for (const e of presence) if (e.present && e.confidence >= threshold && e.roomId === roomId) max = Math.max(max, e.confidence);
  return max;
}

/** Max presence confidence among users in `zoneId`, using the house occupancy snapshot. */
function zoneOccupancyConfidence(presence: PresenceEstimate[], house: HouseOccupancy, zoneId: string | null, threshold: number): number {
  if (!zoneId) return 0;
  const zone = house.zones.find((z) => z.zoneId === zoneId);
  if (!zone || zone.occupants.length === 0) return 0;
  let max = 0;
  for (const e of presence) if (e.present && e.confidence >= threshold && zone.occupants.includes(e.userId)) max = Math.max(max, e.confidence);
  return max;
}

/** Confidence the whole home is empty (1 − strongest present user). */
function houseVacancyConfidence(presence: PresenceEstimate[]): number {
  let maxPresent = 0;
  for (const e of presence) if (e.present) maxPresent = Math.max(maxPresent, e.confidence);
  return clamp01(1 - maxPresent);
}

export interface DeviceEvaluation {
  deviceId: string;
  /** True when this device is a genuine candidate for an off-suggestion. */
  candidate: boolean;
  /** Why it was skipped (critical/always-on/too-short/etc.), for transparency. */
  skipReason?: string;
  confidence: Confidence;
  onMinutes: number;
  estimatedWatts?: number;
  estimatedCost?: number;
}

/** Evaluate a single device. Pure; returns the full breakdown even when it's not a candidate. */
export function evaluateDevice(device: EnergyDeviceInput, input: EnergyIntelInput): DeviceEvaluation {
  const opts = input.options ?? {};
  const minIdle = opts.minIdleMinutes ?? 15;
  const minWatts = opts.minWatts ?? 5;
  const threshold = opts.presentThreshold ?? 0.6;
  const floor = opts.candidateVacancyFloor ?? 0.5;
  const watts = device.intel?.estimatedWatts ?? device.watts;
  const onMinutes = device.on && device.onSinceMs !== null ? Math.max(0, (input.now - device.onSinceMs) / MIN) : 0;

  const roomVacancy = clamp01(1 - roomOccupancyConfidence(input.presence, device.roomId, threshold));
  const zoneVacancy = clamp01(1 - zoneOccupancyConfidence(input.presence, input.house, device.zoneId, threshold));
  const houseVacancy = houseVacancyConfidence(input.presence);
  // "Presence" dimension = our confidence the relevant AREA is unoccupied (room if known, else zone, else house).
  const areaVacancy = device.roomId ? roomVacancy : device.zoneId ? zoneVacancy : houseVacancy;

  // Ownership: how confident we are the owner is NOT by the device. Unknown owner → fall back to house vacancy.
  const owner = device.intel?.ownerUserId;
  let ownership: number;
  if (!owner) {
    ownership = houseVacancy; // no owner set → use whole-house emptiness as the ownership proxy
  } else {
    const ownerEst = input.presence.find((e) => e.userId === owner);
    if (!ownerEst) {
      ownership = houseVacancy; // owner has no presence signal at all → proxy with house emptiness
    } else if (!ownerEst.present) {
      ownership = clamp01(1 - ownerEst.confidence); // owner away → as confident as the away reading is
    } else if (device.roomId && ownerEst.roomId === device.roomId) {
      ownership = 0; // owner is right here with the device → never suggest off
    } else {
      // Owner present but elsewhere — they may return; blend their absence-here with area vacancy.
      ownership = clamp01(0.5 * (1 - ownerEst.confidence) + 0.5 * areaVacancy);
    }
  }

  // Energy: forgotten-ness from how long it's been on, gated on knowing a material wattage.
  const hasMaterialWatts = typeof watts === "number" && watts >= minWatts;
  const energy = hasMaterialWatts ? clamp01(onMinutes / (minIdle * 2)) : 0;

  const confidence = makeConfidence({ presence: areaVacancy, roomVacancy, zoneVacancy, ownership, energy });

  const estimatedWatts = hasMaterialWatts ? watts : undefined;
  const estimatedCost = hasMaterialWatts && input.ratePerKwh ? round2((watts! / 1000) * (onMinutes / 60) * input.ratePerKwh) : undefined;

  // Candidacy gates — reasons we would NOT suggest turning it off.
  let skipReason: string | undefined;
  if (!device.on) skipReason = "not_on";
  else if (device.intel?.critical) skipReason = "critical";
  else if (device.intel?.ignoreAutoPilot) skipReason = "ignored";
  else if (device.intel?.expectedAlwaysOn) skipReason = "expected_always_on";
  else if (!hasMaterialWatts) skipReason = "no_wattage";
  else if (onMinutes < minIdle) skipReason = "recently_on";
  else if (areaVacancy < floor) skipReason = "area_occupied";

  return { deviceId: device.deviceId, candidate: skipReason === undefined, skipReason, confidence, onMinutes: Math.round(onMinutes), estimatedWatts, estimatedCost };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Evaluate every device and produce observations for all + suggestions for candidates. */
export function evaluateEnergyIntelligence(input: EnergyIntelInput): ModuleResult {
  const observations: Observation[] = [];
  const suggestions: Suggestion[] = [];
  for (const device of input.devices) {
    const ev = evaluateDevice(device, input);
    observations.push({
      module: "energy",
      kind: "device_evaluation",
      subject: device.deviceId,
      data: { candidate: ev.candidate, skipReason: ev.skipReason, onMinutes: ev.onMinutes, estimatedCost: ev.estimatedCost },
      confidence: ev.confidence.decision,
      ts: input.now,
    });
    if (!ev.candidate) continue;
    const areaLabel = device.roomId ? "the room" : device.zoneId ? "the area" : "the home";
    suggestions.push({
      key: `energy:idle:${device.deviceId}`,
      module: "energy",
      kind: "idle_device_vacant_area",
      title: "Device left on while nobody appears present",
      body: `${device.name} has been running for ${ev.onMinutes} min and ${areaLabel} appears empty.`,
      deviceId: device.deviceId,
      roomId: device.roomId ?? undefined,
      zoneId: device.zoneId ?? undefined,
      ownerUserId: device.intel?.ownerUserId,
      actions: ["turn_off", "keep_on", "ignore_today", "always_ignore", "enable_auto_pilot"],
      confidence: ev.confidence,
      estimatedWatts: ev.estimatedWatts,
      estimatedCostToday: ev.estimatedCost,
      currency: input.currency,
      ts: input.now,
      metadata: { onMinutes: ev.onMinutes },
    });
  }
  return { observations, suggestions };
}

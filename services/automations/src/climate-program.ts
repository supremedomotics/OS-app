/**
 * Climate programs (§10) — a programmable-thermostat schedule: setpoint "blocks" through the day
 * (wake / away / home / sleep), with separate weekday and weekend programs. Unlike circadian
 * lighting (which interpolates), a thermostat holds the most-recent block's setpoint until the next
 * block — so this is a step function. Pure + deterministic: given the program, the day type, and the
 * local minute-of-day, it returns the target °C. The hub runner applies it to climate devices when
 * it changes.
 */

export type DayType = "weekday" | "weekend";

export interface ClimateBlock {
  /** Minutes since local midnight, 0..1439. */
  atMinutes: number;
  /** Target temperature in °C. */
  targetC: number;
}

export interface ClimateProgram {
  weekday: ClimateBlock[];
  weekend: ClimateBlock[];
}

export class ClimateProgramError extends Error {}

function normalize(blocks: ClimateBlock[]): ClimateBlock[] {
  if (blocks.length === 0) throw new ClimateProgramError("climate program needs at least one block");
  for (const b of blocks) {
    if (b.atMinutes < 0 || b.atMinutes > 1439) throw new ClimateProgramError(`block atMinutes out of range: ${b.atMinutes}`);
    if (b.targetC < 5 || b.targetC > 35) throw new ClimateProgramError(`block targetC out of range (5..35): ${b.targetC}`);
  }
  return [...blocks].sort((a, b) => a.atMinutes - b.atMinutes);
}

/**
 * The target setpoint at `minuteOfDay` for the given day type: the most recent block at or before
 * the minute, wrapping across midnight (before the first block, the previous day's last block holds).
 */
export function climateSetpointAt(program: ClimateProgram, dayType: DayType, minuteOfDay: number): number {
  const blocks = normalize(dayType === "weekend" ? program.weekend : program.weekday);
  let current = blocks[blocks.length - 1]!; // wrap: before the first block, last block of the day holds
  for (const b of blocks) {
    if (b.atMinutes <= minuteOfDay) current = b;
    else break;
  }
  return current.targetC;
}

/** Validate a program shape on write. */
export function validateClimateProgram(p: unknown): ClimateProgram {
  const o = p as Partial<ClimateProgram>;
  if (!o || !Array.isArray(o.weekday) || !Array.isArray(o.weekend)) throw new ClimateProgramError("program needs weekday and weekend block arrays");
  // normalize() throws on any malformed/out-of-range block.
  normalize(o.weekday as ClimateBlock[]);
  normalize(o.weekend as ClimateBlock[]);
  return { weekday: o.weekday as ClimateBlock[], weekend: o.weekend as ClimateBlock[] };
}

/** A sensible default comfort program (21°C wake/home, 18°C away/sleep). */
export const defaultClimateProgram: ClimateProgram = {
  weekday: [
    { atMinutes: 6 * 60, targetC: 21 }, // wake
    { atMinutes: 8 * 60 + 30, targetC: 18 }, // away
    { atMinutes: 17 * 60, targetC: 21 }, // home
    { atMinutes: 22 * 60, targetC: 18 }, // sleep
  ],
  weekend: [
    { atMinutes: 7 * 60 + 30, targetC: 21 }, // later wake
    { atMinutes: 23 * 60, targetC: 18 }, // sleep
  ],
};

import type { CapabilityCommand, CapabilityState } from "@supreme/domain-model";

/**
 * CoolAutomation CoolMasterNet codec (§3). CoolMasterNet bridges VRF/VRV HVAC
 * (Daikin/Mitsubishi/…) and exposes an ASCII line protocol over TCP (port 10102):
 * `ls2` lists units (`L1.100 ON 24.0C 22.5C Low Cool OK - 0`), and `on`/`off`/`temp`/
 * mode commands control them. This maps Supreme onoff + temperature (climate) onto
 * that protocol and parses unit status back into Supreme state.
 */

type SupremeMode = "off" | "heat" | "cool" | "auto" | "fan_only";

/** CoolMaster UID pattern, e.g. "L1.100". */
export function isCoolMasterUid(s: string): boolean {
  return /^[A-Za-z]\d+\.\d+$/.test(s);
}

function parseTemp(token: string): number | null {
  const m = /^(-?\d+(?:\.\d+)?)([CF])?$/.exec(token);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "F" ? Math.round(((n - 32) * 5) / 9 * 10) / 10 : n;
}

function modeFromCoolMaster(word: string, on: boolean): SupremeMode {
  if (!on) return "off";
  switch (word.toLowerCase()) {
    case "heat":
      return "heat";
    case "cool":
      return "cool";
    case "auto":
      return "auto";
    case "fan":
      return "fan_only";
    case "dry":
      return "cool"; // Supreme has no dedicated dry mode; cool is the closest
    default:
      return "auto";
  }
}

/** The CoolMaster command word that sets a Supreme mode. */
export function coolMasterModeWord(mode: SupremeMode): string {
  return mode === "fan_only" ? "fan" : mode; // "off"|"heat"|"cool"|"auto"|"fan"
}

export interface CoolMasterUnit {
  uid: string;
  on: boolean;
  setC: number | null;
  roomC: number | null;
  mode: SupremeMode;
}

/** Parse one `ls2` status line into a unit (null if it isn't a unit line). */
export function parseUnitLine(line: string): CoolMasterUnit | null {
  const t = line.trim().split(/\s+/);
  if (t.length < 6 || !isCoolMasterUid(t[0]!)) return null;
  const on = (t[1] ?? "").toUpperCase() === "ON";
  return {
    uid: t[0]!,
    on,
    setC: parseTemp(t[2] ?? ""),
    roomC: parseTemp(t[3] ?? ""),
    mode: modeFromCoolMaster(t[5] ?? "", on),
  };
}

/** CoolMaster command lines for a Supreme command (null = unsupported). */
export function commandToCoolMaster(
  uid: string,
  command: CapabilityCommand,
  prev: CapabilityState | null,
): string[] | null {
  switch (command.capability) {
    case "onoff": {
      if (command.action === "toggle") {
        const on = prev?.kind === "onoff" ? prev.on : false;
        return [`${on ? "off" : "on"} ${uid}`];
      }
      return [`${command.action === "on" ? "on" : "off"} ${uid}`];
    }
    case "temperature": {
      const lines: string[] = [];
      if (command.mode) {
        lines.push(command.mode === "off" ? `off ${uid}` : `${coolMasterModeWord(command.mode)} ${uid}`);
        if (command.mode !== "off") lines.unshift(`on ${uid}`);
      }
      if (typeof command.targetC === "number") lines.push(`temp ${uid} ${command.targetC}`);
      return lines.length > 0 ? lines : null;
    }
    default:
      return null;
  }
}

/** Build a Supreme TemperatureState from a parsed unit. */
export function temperatureStateFromUnit(u: CoolMasterUnit): CapabilityState {
  return {
    kind: "temperature",
    ambientC: u.roomC ?? u.setC ?? 21,
    targetC: u.setC,
    mode: u.mode,
  };
}

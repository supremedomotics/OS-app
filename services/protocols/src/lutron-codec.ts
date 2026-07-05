import type { CapabilityCommand, CapabilityKind, CapabilityState } from "@supreme/domain-model";

/**
 * Lutron Integration Protocol (LIP) codec (§3). LIP is Lutron's documented ASCII
 * integration protocol over Telnet (port 23). It is spoken by the WIRED pro systems
 * (RadioRA 2, RA3, HomeWorks QS) AND the WIRELESS Caséta Smart Bridge Pro — so one
 * driver covers both. Outputs (dimmers / switches / shades) are driven by
 * `#OUTPUT,<id>,1,<level>` and reported as `~OUTPUT,<id>,1,<level>`.
 *
 * Binding `address` = the output's integration ID.
 */

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** A LIP command string for a Supreme command (null = unsupported). */
export function commandToLutron(command: CapabilityCommand, id: string, prev: CapabilityState | null): string | null {
  switch (command.capability) {
    case "onoff": {
      const on =
        command.action === "on" ? true : command.action === "off" ? false : !(prev?.kind === "onoff" ? prev.on : false);
      return `#OUTPUT,${id},1,${on ? 100 : 0}`;
    }
    case "brightness": {
      if (command.action === "off") return `#OUTPUT,${id},1,0`;
      const level = typeof command.level === "number" ? command.level : prev?.kind === "brightness" ? prev.level : 100;
      return `#OUTPUT,${id},1,${clampPct(level)}`;
    }
    case "position": {
      const pos =
        command.action === "open"
          ? 100
          : command.action === "close"
            ? 0
            : (command.position ?? (prev?.kind === "position" ? prev.position : 0));
      return `#OUTPUT,${id},1,${clampPct(pos)}`;
    }
    default:
      return null;
  }
}

export type LutronLine =
  | { kind: "login" }
  | { kind: "password" }
  | { kind: "ready" }
  | { kind: "output"; id: string; level: number }
  | null;

/** Parse a line from the bridge: auth prompts, the GNET> ready prompt, or ~OUTPUT reports. */
export function parseLutronLine(line: string): LutronLine {
  const t = line.trim();
  if (/login:/i.test(t)) return { kind: "login" };
  if (/password:/i.test(t)) return { kind: "password" };
  if (t.startsWith("GNET>") || t === "QNET>") return { kind: "ready" };
  const m = /^~OUTPUT,(\d+),1,(-?\d+(?:\.\d+)?)/.exec(t);
  if (m) return { kind: "output", id: m[1]!, level: Number(m[2]) };
  return null;
}

/** Map a reported output level to a Supreme state for a capability. */
export function stateFromLutronLevel(capability: CapabilityKind, level: number): CapabilityState | null {
  const lvl = clampPct(level);
  if (capability === "onoff") return { kind: "onoff", on: lvl > 0 };
  if (capability === "brightness") return { kind: "brightness", on: lvl > 0, level: lvl };
  if (capability === "position") return { kind: "position", position: lvl, moving: false };
  return null;
}

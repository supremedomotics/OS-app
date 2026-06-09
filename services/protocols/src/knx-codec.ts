import type { CapabilityCommand, CapabilityState } from "@supreme/domain-model";

/**
 * KNX capability ↔ datapoint-value codec (§3, §7). KNX devices are addressed by
 * **group address** (e.g. "1/1/3") and typed by **DPT** (datapoint type). This maps
 * Supreme capabilities to the decoded JS values KNXnet/IP carries:
 *
 *   onoff      → DPT1.001  boolean
 *   brightness → DPT5.001  scaling 0..100 (%)         (on/off derived from level)
 *   position   → DPT5.001  scaling 0..100 (% open)
 *   sensor     → DPT9.001  2-byte float (e.g. °C)     (read-only)
 *
 * Byte-level DPT (de)serialization is handled by the KNXnet/IP transport; this codec
 * works in decoded values so the driver stays transport-agnostic and unit-testable.
 */

export type KnxValue = boolean | number;

/** Default DPT for a capability when a binding doesn't specify one. */
export function defaultDpt(capability: CapabilityState["kind"]): string {
  switch (capability) {
    case "onoff":
      return "DPT1.001";
    case "brightness":
    case "position":
      return "DPT5.001";
    case "sensor":
      return "DPT9.001";
    default:
      return "DPT1.001";
  }
}

/** Translate a Supreme command into the KNX group-write value (null = unsupported). */
export function valueFromCommand(
  command: CapabilityCommand,
  prev: CapabilityState | null,
): KnxValue | null {
  switch (command.capability) {
    case "onoff": {
      if (command.action === "toggle") return !(prev?.kind === "onoff" ? prev.on : false);
      return command.action === "on";
    }
    case "brightness": {
      if (command.action === "off") return 0;
      if (typeof command.level === "number") return clampPct(command.level);
      // "on" with no level → full brightness on a scaling object.
      return prev?.kind === "brightness" && prev.level > 0 ? prev.level : 100;
    }
    case "position": {
      if (command.action === "open") return 100;
      if (command.action === "close") return 0;
      if (typeof command.position === "number") return clampPct(command.position);
      return prev?.kind === "position" ? prev.position : 0;
    }
    default:
      return null; // color/temperature/lock/media not mapped to these KNX DPTs
  }
}

/** Translate a decoded KNX group value into a Supreme capability state (null = ignore). */
export function stateFromValue(
  capability: CapabilityState["kind"],
  value: KnxValue,
  config: Record<string, unknown> = {},
): CapabilityState | null {
  switch (capability) {
    case "onoff":
      return { kind: "onoff", on: toBool(value) };
    case "brightness": {
      const level = clampPct(Number(value));
      return { kind: "brightness", on: level > 0, level };
    }
    case "position":
      return { kind: "position", position: clampPct(Number(value)), moving: false };
    case "sensor":
      return {
        kind: "sensor",
        value: Number(value),
        unit: typeof config.unit === "string" ? config.unit : "",
        measure: typeof config.measure === "string" ? config.measure : "value",
      };
    default:
      return null;
  }
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}
function toBool(v: KnxValue): boolean {
  return typeof v === "boolean" ? v : v !== 0;
}

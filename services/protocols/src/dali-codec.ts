import type { CapabilityCommand, CapabilityKind, CapabilityState } from "@supreme/domain-model";

/**
 * DALI (IEC 62386) capability codec (§3). DALI is an open lighting-control standard:
 * a two-wire bus addressing control gear by short address (0–63), group (0–15), or
 * broadcast, with a logarithmic dimming curve. This maps Supreme capabilities to DALI
 * operations and back, encoding the real IEC 62386 framing + dimming curve so the
 * driver confines all DALI detail and emits pure Supreme capabilities.
 */

export interface DaliAddress {
  kind: "short" | "group" | "broadcast";
  /** Short 0–63, group 0–15; ignored for broadcast. */
  value: number;
}

/** Parse a binding address: "short:5" | "group:2" | "broadcast" (bare "5" = short 5). */
export function parseDaliAddress(address: string): DaliAddress {
  const [kind, raw] = address.split(":");
  if (kind === "broadcast") return { kind: "broadcast", value: 0 };
  if (kind === "group") return { kind: "group", value: clampInt(Number(raw), 0, 15) };
  return { kind: "short", value: clampInt(Number(raw ?? kind), 0, 63) };
}

/**
 * Encode the DALI address byte per IEC 62386-102. `selector` is the YAAAAAAS bit:
 * 0 = direct arc power (DAPC level frame), 1 = command frame.
 */
export function daliAddressByte(addr: DaliAddress, selector: 0 | 1): number {
  switch (addr.kind) {
    case "short":
      return ((addr.value & 0x3f) << 1) | selector;
    case "group":
      return 0x80 | ((addr.value & 0x0f) << 1) | selector;
    case "broadcast":
      return 0xfe | selector; // 0xFE = broadcast DAPC, 0xFF = broadcast command
  }
}

/** A subset of the IEC 62386-102 standard command opcodes. */
export const DALI_CMD = {
  OFF: 0x00,
  UP: 0x01,
  DOWN: 0x02,
  RECALL_MAX_LEVEL: 0x05,
  RECALL_MIN_LEVEL: 0x06,
  QUERY_DEVICE_TYPE: 0x99,
  QUERY_ACTUAL_LEVEL: 0xa0,
} as const;

export type DimmingCurve = "logarithmic" | "linear";

// IEC 62386-102 logarithmic curve constant: arc level 1..254 ↔ 0.1%..100% light.
const LOG_K = 253 / 3;

/** Supreme brightness % (0–100) → DALI arc power level (0 = off, 1–254). */
export function arcPowerFromPercent(pct: number, curve: DimmingCurve = "logarithmic"): number {
  if (pct <= 0) return 0;
  const p = Math.min(100, pct);
  if (curve === "linear") return clampInt(Math.round((p / 100) * 254), 1, 254);
  // n = 1 + (253/3)·(log10(L%) + 1), so 100%→254, 0.1%→1.
  return clampInt(Math.round(1 + LOG_K * (Math.log10(Math.max(0.1, p)) + 1)), 1, 254);
}

/** DALI arc power level (0–254) → Supreme brightness % (0–100). */
export function percentFromArcPower(level: number, curve: DimmingCurve = "logarithmic"): number {
  if (level <= 0) return 0;
  if (curve === "linear") return clampInt(Math.round((level / 254) * 100), 0, 100);
  // Inverse of the log curve: L% = 10^((n-1)/(253/3) − 1).
  return clampInt(Math.round(Math.pow(10, (level - 1) / LOG_K - 1)), 0, 100);
}

/** Capabilities a control-gear device type exposes (DT6 = LED, DT8 = colour control). */
export function capabilitiesFromDeviceType(deviceType: number): CapabilityKind[] {
  const caps: CapabilityKind[] = ["onoff", "brightness"];
  if (deviceType === 8) caps.push("color");
  return caps;
}

/** A semantic DALI operation the bus executes (it owns the byte-level framing). */
export type DaliOperation =
  | { op: "arc"; level: number }
  | { op: "off" }
  | { op: "colourTemp"; mireds: number };

/** Translate a Supreme command into a DALI operation (null = unsupported). */
export function commandToDali(
  command: CapabilityCommand,
  prev: CapabilityState | null,
  curve: DimmingCurve = "logarithmic",
): DaliOperation | null {
  switch (command.capability) {
    case "onoff": {
      if (command.action === "off") return { op: "off" };
      if (command.action === "toggle") {
        const on = prev?.kind === "onoff" ? prev.on : false;
        return on ? { op: "off" } : { op: "arc", level: 254 };
      }
      return { op: "arc", level: 254 };
    }
    case "brightness": {
      if (command.action === "off") return { op: "off" };
      const pct = typeof command.level === "number" ? command.level : prev?.kind === "brightness" ? prev.level : 100;
      return { op: "arc", level: arcPowerFromPercent(pct, curve) };
    }
    case "color": {
      // DT8 tunable white via colour temperature (Tc); RGBWAF/xy is a later add.
      if (typeof command.kelvin === "number") return { op: "colourTemp", mireds: Math.round(1_000_000 / command.kelvin) };
      return null;
    }
    default:
      return null; // position/lock/temperature/sensor are not DALI control-gear capabilities here
  }
}

/** Map a queried arc power level to a Supreme state for a capability. */
export function stateFromArcLevel(
  capability: CapabilityKind,
  level: number,
  curve: DimmingCurve = "logarithmic",
): CapabilityState | null {
  if (capability === "onoff") return { kind: "onoff", on: level > 0 };
  if (capability === "brightness") return { kind: "brightness", on: level > 0, level: percentFromArcPower(level, curve) };
  return null;
}

/** Map a DT8 colour temperature (mireds) to a Supreme colour state. */
export function colorStateFromMireds(mireds: number, prev: CapabilityState | null): CapabilityState {
  const base = prev?.kind === "color" ? prev : null;
  return {
    kind: "color",
    on: base?.on ?? true,
    level: base?.level ?? 100,
    hue: null,
    saturation: null,
    kelvin: mireds > 0 ? Math.round(1_000_000 / mireds) : null,
  };
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(Number.isFinite(n) ? n : lo)));
}

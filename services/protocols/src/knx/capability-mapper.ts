import type { CapabilityKind } from "@supreme/domain-model";
import type { FunctionalBlock } from "./functional-block-parser.js";

/**
 * KNX Capability Mapper (§ Unified Device Intelligence — Phase 3).
 *
 * Maps functional-block/ETS-signal hints to the EXISTING, fixed Supreme
 * {@link CapabilityKind} vocabulary (`@supreme/domain-model`) — never a new one. Also
 * derives an internal `KnxDeviceKind` classification for diagnostics/UI-labeling
 * purposes; this classification is KNX-driver-internal only (never exposed as part of
 * the outward `DiscoveredDevice.capabilities` contract, per "do not expose KNX
 * terminology outside the driver").
 *
 * Classification is keyword-driven over whatever `rt`/`if`/`title` text is actually
 * present (functional-block resource type, ETS circuit name, KNX IoT device title) —
 * this codebase has not ingested the KNX Association's official functional-block
 * catalog (see the Compatibility Report), so this is a documented heuristic, not a
 * verified 1:1 mapping to the official KNX IoT rt vocabulary.
 */

export type KnxDeviceKind =
  | "light" | "rgb_light" | "rgbw_light" | "tunable_white_light"
  | "climate" | "thermostat" | "valve_actuator"
  | "blind" | "curtain" | "fan"
  | "switch" | "socket"
  | "energy_meter" | "meter" | "sensor" | "weather"
  | "motion_sensor" | "presence_sensor" | "window_contact"
  | "lock" | "button" | "scene" | "media" | "unknown";

export interface CapabilityHint {
  capabilities: CapabilityKind[];
  deviceKind: KnxDeviceKind;
  /** Which keyword(s) drove this classification — explainability, never a silent guess. */
  matchedOn: string[];
}

interface KeywordRule {
  keywords: string[];
  deviceKind: KnxDeviceKind;
  capabilities: CapabilityKind[];
}

// Order matters — more specific device kinds (rgbw before light) are checked first so a
// name/rt containing both "rgbw" and "light" classifies as the more specific kind.
const RULES: KeywordRule[] = [
  { keywords: ["rgbw"], deviceKind: "rgbw_light", capabilities: ["onoff", "brightness", "color"] },
  { keywords: ["rgb"], deviceKind: "rgb_light", capabilities: ["onoff", "brightness", "color"] },
  { keywords: ["tunablewhite", "tunable_white", "cct", "colortemp", "kelvin"], deviceKind: "tunable_white_light", capabilities: ["onoff", "brightness", "color"] },
  { keywords: ["dimm", "dim", "dimming", "brightness"], deviceKind: "light", capabilities: ["onoff", "brightness"] },
  { keywords: ["light", "lighting", "lamp"], deviceKind: "light", capabilities: ["onoff"] },

  { keywords: ["thermostat"], deviceKind: "thermostat", capabilities: ["temperature"] },
  { keywords: ["valve"], deviceKind: "valve_actuator", capabilities: ["temperature"] },
  { keywords: ["climate", "hvac", "heating", "cooling"], deviceKind: "climate", capabilities: ["temperature"] },

  { keywords: ["blind", "shutter"], deviceKind: "blind", capabilities: ["position"] },
  { keywords: ["curtain", "awning", "cover"], deviceKind: "curtain", capabilities: ["position"] },
  { keywords: ["fan", "ventilation"], deviceKind: "fan", capabilities: ["fan"] },

  { keywords: ["lock", "latch"], deviceKind: "lock", capabilities: ["lock"] },
  { keywords: ["window", "contact"], deviceKind: "window_contact", capabilities: ["sensor"] },
  { keywords: ["motion"], deviceKind: "motion_sensor", capabilities: ["sensor"] },
  { keywords: ["presence", "occupancy"], deviceKind: "presence_sensor", capabilities: ["sensor"] },
  { keywords: ["button", "pushbutton", "rocker"], deviceKind: "button", capabilities: ["sensor"] },
  { keywords: ["scene"], deviceKind: "scene", capabilities: ["sensor"] },

  { keywords: ["energy", "kwh", "power"], deviceKind: "energy_meter", capabilities: ["sensor"] },
  { keywords: ["meter", "counter", "voltage", "current"], deviceKind: "meter", capabilities: ["sensor"] },
  { keywords: ["weather", "wind", "rain", "brightness_sensor", "lux"], deviceKind: "weather", capabilities: ["sensor"] },
  { keywords: ["media", "audio", "player"], deviceKind: "media", capabilities: ["media"] },

  { keywords: ["socket", "outlet", "plug"], deviceKind: "socket", capabilities: ["onoff"] },
  { keywords: ["switch", "switching", "sw"], deviceKind: "switch", capabilities: ["onoff"] },
  { keywords: ["sensor", "value"], deviceKind: "sensor", capabilities: ["sensor"] },
];

function tokensOf(...texts: (string | null | undefined)[]): string[] {
  return texts
    .filter((t): t is string => Boolean(t))
    .flatMap((t) => t.toLowerCase().split(/[^a-z0-9]+/i))
    .filter(Boolean);
}

/** Classifies from raw text hints (a circuit name, an ETS function name, a KNX IoT
 * `rt`/`if`/`title`) — used both for functional blocks and for plain circuit names when
 * no functional block is available yet. */
export function classifyFromText(...texts: (string | null | undefined)[]): CapabilityHint {
  const tokenSet = new Set(tokensOf(...texts));
  for (const rule of RULES) {
    const matched = rule.keywords.filter((k) => tokenSet.has(k));
    if (matched.length > 0) return { capabilities: rule.capabilities, deviceKind: rule.deviceKind, matchedOn: matched };
  }
  return { capabilities: [], deviceKind: "unknown", matchedOn: [] };
}

/** Classifies a parsed functional block using its resource types, interfaces, and title
 * — the richest signal available once KNX IoT discovery has run. */
export function classifyFunctionalBlock(block: FunctionalBlock): CapabilityHint {
  return classifyFromText(block.title, ...block.resourceTypes, ...block.interfaces, block.href);
}

/** Merges capability hints from multiple functional blocks belonging to the same
 * physical device (e.g. one block for on/off, one for brightness) into the device's
 * final capability set — deduplicated, never a fabricated capability neither block hints
 * at. Picks the most specific device kind among contributing blocks (RULES order acts as
 * a specificity ranking — a lower rule index wins). */
export function mergeCapabilityHints(hints: CapabilityHint[]): CapabilityHint {
  const capabilities = [...new Set(hints.flatMap((h) => h.capabilities))] as CapabilityKind[];
  const matchedOn = [...new Set(hints.flatMap((h) => h.matchedOn))];
  const specific = hints
    .filter((h) => h.deviceKind !== "unknown")
    .sort((a, b) => RULES.findIndex((r) => r.deviceKind === a.deviceKind) - RULES.findIndex((r) => r.deviceKind === b.deviceKind))[0];
  return { capabilities, deviceKind: specific?.deviceKind ?? "unknown", matchedOn };
}

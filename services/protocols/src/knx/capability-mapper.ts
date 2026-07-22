import { classifyDpt, type DptCategory } from "@supreme/commissioning";
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

/** KNX-specific abbreviations this driver's own ETS-import pipeline needs to recognize
 * as "operation words" (§ Universal Device Grouping's documented extension contract,
 * `packages/domain-model/src/device-grouping.ts` — a protocol supplies its own
 * vocabulary via `GroupingOptions`, the generic engine never hardcodes one). Real ETS
 * installer exports abbreviate "Absolute"/"Relative"/"Colour"/"Dimming" inconsistently
 * (e.g. "Abs Col", "Dimm", "Relative Color") — these are the KNX-specific tokens the
 * generic engine's own `DEFAULT_OPERATION_WORDS` deliberately leaves out. */
export const KNX_EXTRA_OPERATION_WORDS = ["abs", "absolute", "dimm", "rel", "relative", "col"];

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

/** One communication object's DPT → the capability it, on its own, represents — never a
 * whole device's capability set (unlike the keyword `RULES` above, which classify a
 * whole circuit from one name). Reuses the existing, tested DPT table from
 * `@supreme/commissioning` (`classifyDpt`) rather than a second one. Only DPT categories
 * with an unambiguous capability meaning are listed; anything else (scenes, counters,
 * strings, …) falls through to keyword classification exactly as before. */
const DPT_CATEGORY_CAPABILITY: Partial<Record<DptCategory, { capabilities: CapabilityKind[]; deviceKind: KnxDeviceKind }>> = {
  binary_switch: { capabilities: ["onoff"], deviceKind: "switch" },
  // step_dimming (DPT 3.007) is handled separately below — it's genuinely overloaded in
  // real KNX projects for both "relative dimming" AND "relative colour temperature"
  // stepping (a 3-bit controlled value has no room to encode which), so DPT alone can't
  // resolve it; the name is consulted only for this one, otherwise-unresolvable case.
  percentage: { capabilities: ["brightness"], deviceKind: "light" },
  fan_speed_percentage: { capabilities: ["fan"], deviceKind: "fan" },
  step_blind: { capabilities: ["position"], deviceKind: "blind" },
  binary_updown: { capabilities: ["position"], deviceKind: "blind" },
  binary_openclose: { capabilities: ["position"], deviceKind: "blind" },
  color_temperature_kelvin: { capabilities: ["color"], deviceKind: "tunable_white_light" },
  color_rgb: { capabilities: ["color"], deviceKind: "rgb_light" },
  color_rgbw: { capabilities: ["color"], deviceKind: "rgbw_light" },
  float_temperature: { capabilities: ["temperature"], deviceKind: "thermostat" },
  hvac_mode: { capabilities: ["temperature"], deviceKind: "climate" },
  hvac_fan_speed: { capabilities: ["fan"], deviceKind: "fan" },
  binary_occupancy: { capabilities: ["sensor"], deviceKind: "presence_sensor" },
  binary_windowdoor: { capabilities: ["sensor"], deviceKind: "window_contact" },
};

/** Classifies ONE ETS group-address signal (§ priority order: DPT, then name, per the
 * production KNX import requirements) — DPT first via the existing, tested
 * `classifyDpt()` table; falls back to {@link classifyFromText} only when the DPT is
 * absent or maps to a category with no unambiguous capability (e.g. a scene number).
 * This is deliberately per-SIGNAL, not per-circuit: `mapUnifiedDevices` calls this once
 * per communication object in a cluster and merges the results, so a Tunable White
 * circuit's absolute/relative/feedback color-temperature objects each correctly
 * contribute `color` regardless of what the switch/dimming objects in the same cluster
 * contribute — never a single guess about the whole circuit from one blended bag of
 * words. */
const COLOR_STEP_NAME_WORDS = new Set(["colour", "color", "cct", "kelvin", "tw", "tunablewhite", "temp"]);

export function classifyEtsSignal(dpt: string | null | undefined, ...texts: (string | null | undefined)[]): CapabilityHint {
  const { category } = classifyDpt(dpt);
  if (category === "step_dimming") {
    const isColorStep = tokensOf(...texts).some((t) => COLOR_STEP_NAME_WORDS.has(t));
    return isColorStep
      ? { capabilities: ["color"], deviceKind: "tunable_white_light", matchedOn: [`dpt:${dpt}`, "name:color-step"] }
      : { capabilities: ["brightness"], deviceKind: "light", matchedOn: [`dpt:${dpt}`] };
  }
  const known = DPT_CATEGORY_CAPABILITY[category];
  if (known) return { capabilities: known.capabilities, deviceKind: known.deviceKind, matchedOn: [`dpt:${dpt}`] };
  return classifyFromText(...texts);
}

/** Which of a capability's (up to three) real-world communication objects a single
 * signal is — needed by {@link "./binding-engine.js" planBindings} so a merged
 * multi-capability device binds each capability to ITS OWN group address instead of
 * reusing the first write/status pair found on the whole device (§ production defect:
 * a Tunable White circuit's brightness and color-temperature capabilities were both
 * silently binding to the switch's group address once clustering correctly merged them
 * onto one device — this function is what lets binding tell them apart).
 *
 * DPT decides "step" outright — `step_dimming` (DPT 3.007, "Relative Dimming"/"Relative
 * Color Temperature") is definitionally a step/nudge control in KNX, never a write or a
 * status object, regardless of name. Otherwise a name-based feedback/status keyword
 * (the same generic vocabulary `packages/domain-model/src/device-grouping.ts` already
 * treats as an operation word) decides "status" vs "primary" — DPT alone cannot, since
 * a real project's absolute-write and its feedback object routinely share one DPT
 * (e.g. "Abs Dim" and "Abs Dim FB" are both DPT 5.001). */
export type CommunicationObjectRole = "primary" | "status" | "step";

const STATUS_NAME_WORDS = new Set(["status", "stat", "feedback", "fb", "fdbk", "state", "readback", "rb"]);

export function roleOfEtsSignal(dpt: string | null | undefined, name: string): CommunicationObjectRole {
  if (classifyDpt(dpt).category === "step_dimming") return "step";
  const hasStatusWord = tokensOf(name).some((t) => STATUS_NAME_WORDS.has(t));
  return hasStatusWord ? "status" : "primary";
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

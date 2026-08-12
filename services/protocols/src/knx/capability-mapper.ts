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
  // § Correctness Fix — knx-codec.ts's valueFromCommand()/stateFromValue() has no case
  // for the `fan` capability at all, so a device classified with it was GUARANTEED to
  // throw on the very first command (§ Never advertise unsupported functionality).
  // `deviceKind: "fan"` is kept (driver-internal diagnostics/labeling only, per this
  // file's own doc comment — never part of the outward `DiscoveredDevice.capabilities`
  // contract); `capabilities` is empty until the codec genuinely supports fan control.
  { keywords: ["fan", "ventilation"], deviceKind: "fan", capabilities: [] },

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
  // § Correctness Fix — see the identical note on the "fan"/"ventilation" keyword rule
  // above: knx-codec.ts cannot execute a fan command, so this DPT category classifies
  // the device kind for diagnostics only, without advertising an unsupported capability.
  fan_speed_percentage: { capabilities: [], deviceKind: "fan" },
  step_blind: { capabilities: ["position"], deviceKind: "blind" },
  binary_updown: { capabilities: ["position"], deviceKind: "blind" },
  binary_openclose: { capabilities: ["position"], deviceKind: "blind" },
  color_temperature_kelvin: { capabilities: ["color"], deviceKind: "tunable_white_light" },
  color_rgb: { capabilities: ["color"], deviceKind: "rgb_light" },
  color_rgbw: { capabilities: ["color"], deviceKind: "rgbw_light" },
  float_temperature: { capabilities: ["temperature"], deviceKind: "thermostat" },
  hvac_mode: { capabilities: ["temperature"], deviceKind: "climate" },
  // § Correctness Fix — same reason as fan_speed_percentage above.
  hvac_fan_speed: { capabilities: [], deviceKind: "fan" },
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

/** § Generalized Functional-Relationship Engine (fifth pass) — the raw DPT structural
 * category (`@supreme/commissioning`'s `classifyDpt`, already the single source of DPT
 * truth in this codebase), exposed directly rather than through a SupremeOS capability
 * name. `unified-device-mapper.ts`'s channel-grouping evidence evaluator uses this
 * INSTEAD of a hardcoded capability allowlist (`position`/`color`/`temperature`) — it
 * needs to know "is this DPT structurally a generic on/off toggle or scene trigger"
 * (the one real false-positive pattern found across two real ETS projects), not "which
 * SupremeOS capability does this map to," so the grouping engine works for a capability
 * this codebase doesn't have a name for yet without any source change. */
export function dptStructuralCategory(dpt: string | null | undefined): DptCategory {
  return classifyDpt(dpt).category;
}

/** § DPT 5.001 Semantic Resolution (sixth pass) — DPT 5.001 ("Scaling (%)") is
 * genuinely overloaded in the KNX standard itself: a dimmer's absolute brightness, a
 * blind's absolute position, and a generic 0-100% value all use it identically at the
 * wire level. `classifyEtsSignal`'s existing `percentage → brightness` mapping stays
 * exactly as-is — this function does NOT replace it, is NOT wired into the production
 * capability-assignment pipeline, and changes NO real-project classification. It exists
 * as an explicit, testable, ADDITIONAL evidence result (surfaced only in diagnostics/
 * the synthesis report) for exactly the ambiguous cases `classifyEtsSignal` cannot
 * safely resolve today — building it as a parallel, non-wired evidence layer is the
 * only way to add semantic disambiguation with a categorical guarantee of zero
 * unexpected real-project device/capability-count changes (§ explicit instruction: "if
 * classification changes unexpectedly, STOP and investigate" — not wiring it in is what
 * makes that unnecessary to investigate at all).
 *
 * Evidence priority (strongest first — a weaker source never overrides a stronger one
 * that already resolved a verdict):
 *   1. `applicationProgramHint` (device/application-program semantics — e.g. a
 *      manufacturer product name containing "Blind Actuator" or "Dimmer")
 *   2. `comObjectText` (the actual Communication Object's own function text/name)
 *   3. `gaName` (the Group Address's own name)
 *   4. `groupRangeContext` (Main/Middle Group text — e.g. a GroupRange named
 *      "Curtains" or "Lightings")
 * DPT alone (no evidence at any tier) resolves `"unknown"` at `"low"` confidence —
 * never fabricates `"brightness"` just because that's the common case. */
export interface Dpt5001SemanticResult {
  semantic: "brightness" | "position" | "percentage" | "speed" | "unknown";
  confidence: "high" | "medium" | "low";
  evidence: string[];
  reason: string;
}

const DPT_5001_BRIGHTNESS_WORDS = new Set(["brightness", "dim", "dimming", "dimmer", "luminance"]);
const DPT_5001_POSITION_WORDS = new Set(["position", "blind", "blinds", "shutter", "shutters", "curtain", "curtains", "cover", "covers", "awning", "awnings", "roller", "rollers"]);
const DPT_5001_SPEED_WORDS = new Set(["speed", "fan", "fans", "rpm", "velocity"]);

/** § Real-project finding (seventh pass) — a text can contain keywords from MORE than
 * one category simultaneously without being ambiguous evidence, e.g. a real Juhu light
 * fixture literally named "Curtain LED Strip Brightness Value" or "Curtain DL-5+6
 * Brightness Value" — "Curtain" here names the light's LOCATION (installed near a
 * curtain), "Brightness Value" is its actual FUNCTION. Checking one keyword family
 * before another (originally: position checked before brightness) picked "position" for
 * these 16 real, genuinely-brightness signals — confirmed wrong by inspecting the real
 * project before integrating, not shipped. Fixed: when a text matches keywords from 2+
 * categories at once, that's CONTRADICTORY evidence, not resolvable — return null
 * (unknown) rather than picking one arbitrarily; only an UNAMBIGUOUS single-category
 * match is real evidence. */
function matchDpt5001Semantic(text: string): "brightness" | "position" | "speed" | null {
  const tokens = new Set(tokensOf(text));
  const matchesPosition = [...tokens].some((t) => DPT_5001_POSITION_WORDS.has(t));
  const matchesSpeed = [...tokens].some((t) => DPT_5001_SPEED_WORDS.has(t));
  const matchesBrightness = [...tokens].some((t) => DPT_5001_BRIGHTNESS_WORDS.has(t));
  const matchCount = [matchesPosition, matchesSpeed, matchesBrightness].filter(Boolean).length;
  if (matchCount !== 1) return null; // zero or contradictory (2+) — never guessed
  if (matchesPosition) return "position";
  if (matchesSpeed) return "speed";
  return "brightness";
}

export function resolveDpt5001Semantic(input: {
  dpt: string | null | undefined;
  comObjectText?: string | null;
  gaName?: string | null;
  groupRangeContext?: string | null;
  applicationProgramHint?: string | null;
}): Dpt5001SemanticResult {
  const normalized = classifyDpt(input.dpt);
  if (normalized.category !== "percentage" || (input.dpt ?? "").trim() !== "5.001") {
    return { semantic: "unknown", confidence: "low", evidence: [], reason: `not DPT 5.001 (got "${input.dpt ?? "null"}") — this resolver only disambiguates that specific overloaded DPT` };
  }

  const tiers: { label: string; text: string | null | undefined; confidence: "high" | "medium" }[] = [
    { label: "application-program/device semantics", text: input.applicationProgramHint, confidence: "high" },
    { label: "communication object function text", text: input.comObjectText, confidence: "high" },
    { label: "Group Address name", text: input.gaName, confidence: "medium" },
    { label: "GroupRange context", text: input.groupRangeContext, confidence: "medium" },
  ];

  const evidence: string[] = [];
  for (const tier of tiers) {
    if (!tier.text) continue;
    const semantic = matchDpt5001Semantic(tier.text);
    if (!semantic) continue;
    evidence.push(`${tier.label} ("${tier.text}") matched "${semantic}"`);
    return {
      semantic,
      confidence: tier.confidence,
      evidence,
      reason: `resolved from ${tier.label} — the strongest available evidence source that matched`,
    };
  }

  return {
    semantic: "unknown",
    confidence: "low",
    evidence: [],
    reason: "DPT 5.001 alone is structurally ambiguous (brightness/position/generic percentage all use it identically); no comm-object text, GA name, GroupRange, or application-program evidence resolved it — never fabricated as brightness by default",
  };
}

export function classifyEtsSignal(dpt: string | null | undefined, ...texts: (string | null | undefined)[]): CapabilityHint {
  const { category } = classifyDpt(dpt);
  if (category === "step_dimming") {
    const isColorStep = tokensOf(...texts).some((t) => COLOR_STEP_NAME_WORDS.has(t));
    return isColorStep
      ? { capabilities: ["color"], deviceKind: "tunable_white_light", matchedOn: [`dpt:${dpt}`, "name:color-step"] }
      : { capabilities: ["brightness"], deviceKind: "light", matchedOn: [`dpt:${dpt}`] };
  }
  // § DPT 5.001 Semantic Resolution — safe integration (seventh pass). DPT 5.001
  // ("Scaling (%)") defaults to `brightness` via DPT_CATEGORY_CAPABILITY below, which is
  // right most of the time but genuinely wrong for a blind/curtain's absolute-position
  // object using the SAME DPT. Only a HIGH-or-MEDIUM-confidence `"position"` verdict
  // from `resolveDpt5001Semantic` overrides the default; everything else (`brightness`,
  // `speed`, `percentage`, `unknown`, or low confidence) is intentionally left as the
  // existing, unchanged `brightness` default.
  //
  // § Eighth pass — DELIBERATELY still reads only `texts` (the caller's original,
  // narrow pool: circuit key + GA name), never a richer `comObjectText`/application-
  // program hint. An eighth-pass attempt to thread real ETS Communication-Object text
  // through this SAME shared `texts` array was tried and reverted: `texts` also feeds
  // the step_dimming color-step check above and the generic `classifyFromText` fallback
  // below, so enriching it changed classification for MANY unrelated signals project-
  // wide (confirmed on real data: Juhu's `color` capability count jumped 0→71, Nirma
  // gained 30 unexpected `position` entries) — a scope explosion the eighth pass's own
  // "any unexpected capability change is a STOP condition" rule caught before shipping.
  // The correct, properly-isolated integration point for real comm-object text is
  // `mapUnifiedDevices`'s per-signal loop AFTER this function returns (it already reads
  // `s.comObjectText`/`s.model` and can override just the `position` case there,
  // touching nothing else) — not inside this shared, multi-purpose function.
  if (category === "percentage" && (dpt ?? "").trim() === "5.001") {
    const gaName = texts[texts.length - 1] ?? null;
    const semantic = resolveDpt5001Semantic({ dpt, gaName });
    if (semantic.semantic === "position" && (semantic.confidence === "high" || semantic.confidence === "medium")) {
      return { capabilities: ["position"], deviceKind: "blind", matchedOn: [`dpt:${dpt}`, `dpt5001-semantic:${semantic.semantic}/${semantic.confidence}`] };
    }
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
 * status object, regardless of name or Send/Receive wiring. Otherwise a name-based
 * feedback/status keyword (the same generic vocabulary `packages/domain-model/src/
 * device-grouping.ts` already treats as an operation word) decides "status" vs "primary"
 * — DPT alone cannot, since a real project's absolute-write and its feedback object
 * routinely share one DPT (e.g. "Abs Dim" and "Abs Dim FB" are both DPT 5.001). */
export type CommunicationObjectRole = "primary" | "status" | "step";

const STATUS_NAME_WORDS = new Set(["status", "stat", "feedback", "fb", "fdbk", "state", "readback", "rb"]);

/** § Command/Feedback Binding Architecture (Production KNX Driver 2.0, third pass) —
 * real ETS `<Connectors>` Send/Receive relationships, when available. */
export interface EtsSignalRoleLink {
  /** `"unknown"` (§ Real ETS5 export compatibility, `@supreme/commissioning`'s
   * `KnxGroupAddressLink`) means this GA↔device association is real but carries no
   * Send/Receive distinction (a flat `Links=` attribute export, not `<Connectors>`) —
   * never fabricated as a role. It matches neither `=== "send"` nor `=== "receive"`
   * below, so `roleOfEtsSignal` correctly falls through to its DPT/name heuristics. */
  role: "send" | "receive" | "unknown";
  /** Physical device this relationship belongs to (§ Shared GA runtime propagation,
   * fourth pass) — optional, unused by `roleOfEtsSignal` itself, but read by
   * `unified-device-mapper.ts`'s `attachSharedGaSignals` to fan a shared GA out to
   * every physical device its relationships name. */
  individualAddress?: string | null;
  /** Which functional channel of `individualAddress` THIS relationship belongs to
   * (§ Channel Synthesis, Pass 2) — unused by `roleOfEtsSignal`, read by
   * `mergeRelatedChannels` to detect when a GA is referenced from two different
   * channels of the SAME physical device: real structural evidence those channels form
   * one functional circuit, never inferred from name similarity or channel adjacency. */
  channel?: number | null;
  /** The referencing comm object's own function text (§ Control-Relationship Model,
   * third pass) — unused by `roleOfEtsSignal`, read by `unified-device-mapper.ts` to
   * describe an external control relationship (e.g. "a keypad's Main+Sheer button"),
   * never fabricated beyond what the relationship data itself carries. */
  comObjectText?: string;
}

/** Role hierarchy (highest confidence first), per §"Role hierarchy":
 *   1. Explicit ETS Send/Receive relationship (`links`) — a comm object that WRITES this
 *      GA is unambiguously its device's command target; one that only READS it is
 *      unambiguously a feedback/status source — regardless of what its name says. A
 *      Group Address literally named "... Status" that this device actually WRITES
 *      (unusual, but real projects are inconsistent) is still "primary": the wire
 *      relationship is ground truth, the name is not.
 *   2. KNX IoT explicit command/state relationship — not yet exposed by any KNX IoT
 *      signal today (no case reaches this tier yet; reserved so it activates for free
 *      the moment KNX IoT semantic discovery exposes one, matching the same
 *      forward-compatible pattern already used for cross-source identity).
 *   3. DPT classification (`step_dimming` → "step") — a structural KNX distinction
 *      Send/Receive doesn't capture, so it's still checked even when `links` resolved a
 *      tier-1 verdict for a DIFFERENT function, and remains authoritative for "is this a
 *      step/nudge control" regardless of tier 1.
 *   4. Name/text heuristics — the weakest fallback, used only when no ETS Send/Receive
 *      data exists for this signal at all (KNX-IoT-only signals, or a flat ESF/GA export
 *      with no device tree — see `links` being empty/undefined in both cases).
 *
 * § Relationship-specific role resolution (Production KNX Driver 2.0, fifth pass) — a
 * shared GA does not have one universal role; it has one role PER PHYSICAL DEVICE that
 * references it (Device A SENDs it, Device B/C only RECEIVE it — same GA, different
 * relationships). `forIndividualAddress`, when given, scopes tier 1 to only the links
 * belonging to THAT device before deciding primary/status, so the same signal correctly
 * resolves "primary" for its sender and "status" for everyone else who merely receives
 * it — never one global verdict forced onto every device that happens to share the GA.
 * When no link mentions that address at all (legacy callers with no per-link identity,
 * or a signal that isn't actually shared), falls back to the full, unscoped link set —
 * byte-for-byte the pre-existing behavior, so nothing regresses for callers that never
 * populate `individualAddress` on their links. */
export function roleOfEtsSignal(
  dpt: string | null | undefined,
  name: string,
  links?: EtsSignalRoleLink[],
  forIndividualAddress?: string | null,
): CommunicationObjectRole {
  if (classifyDpt(dpt).category === "step_dimming") return "step";
  if (links && links.length > 0) {
    const scoped = forIndividualAddress
      ? links.filter((l) => l.individualAddress === forIndividualAddress)
      : [];
    const relevant = scoped.length > 0 ? scoped : links;
    if (relevant.some((l) => l.role === "send")) return "primary";
    if (relevant.some((l) => l.role === "receive")) return "status";
  }
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

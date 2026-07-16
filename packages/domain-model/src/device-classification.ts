import { DEFAULT_DEVICE_VOCABULARY, type DeviceVocabularyEntry } from "./device-vocabulary.js";

/**
 * Universal Device Intelligence Engine (§ Universal Device Intelligence Engine —
 * "This is not a KNX feature. This is a SupremeOS platform feature. Every protocol must
 * benefit automatically... Do NOT duplicate classification logic inside drivers.").
 *
 * Protocol-agnostic on purpose: this file imports nothing from any driver/protocol
 * package, and every driver package should import FROM here, never re-implement its own
 * copy. It EXTENDS the existing capability/confidence/room-assignment engines — it does
 * not replace `services/protocols/src/knx/capability-mapper.ts` (which maps text hints to
 * the fixed `CapabilityKind` vocabulary for BINDING purposes) or `confidence-engine.ts`
 * (which scores the Unified Device Mapper's merge quality). This engine answers a
 * different question: given whatever text a driver could discover, what IS this device to
 * a human — its category, its specific type, which canonical UI it belongs on — regardless
 * of which protocol found it.
 */

export interface DeviceClassification {
  category: string;
  type: string;
  canonicalDetailPage: DeviceVocabularyEntry["canonicalDetailPage"];
  icon: string;
  automationCategory: string;
  /** 0-100. Never fabricated — a real function of how much of the input text the winning
   * vocabulary entry actually accounted for (§ "Everything should remain explainable"). */
  confidence: number;
  /** Which vocabulary phrase won, and against which source text — the whole reason this
   * classification exists rather than "unknown" (§ Confidence: "Explain why"). */
  reason: string;
  /** The specific keyword phrase that matched, for callers that want it structured rather
   * than parsed out of `reason`. */
  matchedKeyword: string | null;
}

const UNKNOWN: DeviceClassification = {
  category: "Other",
  type: "Unknown",
  canonicalDetailPage: "generic",
  icon: "devices",
  automationCategory: "other",
  confidence: 0,
  reason: "no vocabulary entry matched any of the provided signals",
  matchedKeyword: null,
};

/** The Intelligence Priority order (§ Intelligence Priority) as an ordered list of named
 * text sources — every one is OPTIONAL (a driver may only ever supply a subset), and
 * earlier sources are tried first, but ALL non-empty sources are pooled into one search
 * (§ "Never rely on only one source") rather than short-circuiting on the first hit, since
 * a later, richer source (e.g. functional blocks) can disambiguate what an earlier one
 * left generic (e.g. a bare circuit name). AI inference (priority 9) is intentionally
 * absent — there is no model wired up to fabricate a result from. */
export interface ClassificationInput {
  userOverride?: string | null;
  driverMetadata?: string | null;
  protocolMetadata?: string | null;
  circuitName?: string | null;
  groupName?: string | null;
  communicationObjectNames?: string[];
  functionalBlockTitles?: string[];
}

function tokensOf(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9À-ɏ]+/i).filter(Boolean);
}

/** User override is authoritative — if the installer already said what this device type
 * is, no scoring is needed; look it up by name to inherit its category/page/icon, or fall
 * back to a bespoke "as entered" classification when it matches nothing in the vocabulary
 * (an installer's own words always win, even if the vocabulary doesn't recognize them). */
function classifyOverride(userOverride: string, vocabulary: DeviceVocabularyEntry[]): DeviceClassification {
  const match = vocabulary.find((e) => e.type.toLowerCase() === userOverride.toLowerCase());
  if (match) {
    return { category: match.category, type: match.type, canonicalDetailPage: match.canonicalDetailPage, icon: match.icon, automationCategory: match.automationCategory, confidence: 100, reason: "installer override", matchedKeyword: match.keywords[0] ?? null };
  }
  return { category: "Other", type: userOverride, canonicalDetailPage: "generic", icon: "devices", automationCategory: "other", confidence: 100, reason: "installer override (custom type, not in vocabulary)", matchedKeyword: null };
}

/**
 * Classify a device from whatever text signals are available, using the given vocabulary
 * (defaults to {@link DEFAULT_DEVICE_VOCABULARY}, but callers may pass an
 * installer/company/regional/marketplace vocabulary — §"Vocabulary Engine" — with zero
 * changes to this function).
 */
export function classifyDevice(input: ClassificationInput, vocabulary: DeviceVocabularyEntry[] = DEFAULT_DEVICE_VOCABULARY): DeviceClassification {
  if (input.userOverride) return classifyOverride(input.userOverride, vocabulary);

  // Pool every remaining source into one search text, in priority order — a source
  // present but empty just contributes nothing, never breaks the chain.
  const sources: [string, string | null | undefined][] = [
    ["driver metadata", input.driverMetadata],
    ["protocol metadata", input.protocolMetadata],
    ["circuit name", input.circuitName],
    ["group name", input.groupName],
    ["communication objects", input.communicationObjectNames?.join(" ")],
    ["functional blocks", input.functionalBlockTitles?.join(" ")],
  ];
  const nonEmpty = sources.filter((s): s is [string, string] => Boolean(s[1] && s[1].trim()));
  if (nonEmpty.length === 0) return UNKNOWN;

  const combinedText = nonEmpty.map(([, text]) => text).join(" ");
  const lower = combinedText.toLowerCase();
  const tokenSet = new Set(tokensOf(combinedText));

  // Rank every matching vocabulary entry by specificity, measured in WORD count (a
  // multi-word phrase match beats a single-token match, e.g. "roller blind" over
  // "blind") — never raw character length, which would wrongly let a long generic word
  // like "switch" (6 chars) outrank a short specific one like "gate" (4 chars) or "tv"
  // (2 chars). Ties (equal word count) keep whichever matched FIRST in vocabulary array
  // order, which is why specific types are listed before generic fallbacks like
  // "Switch"/"Socket"/"Relay" (§ device-vocabulary.ts's "Fallback" section) — a strict
  // `>` here, not `>=`, is what makes the first match win a tie instead of the last.
  let best: { entry: DeviceVocabularyEntry; keyword: string; sourceLabel: string; wordCount: number } | null = null;
  for (const entry of vocabulary) {
    for (const keyword of entry.keywords) {
      const isPhrase = keyword.includes(" ");
      const matched = isPhrase ? lower.includes(keyword) : tokenSet.has(keyword);
      if (!matched) continue;
      const wordCount = tokensOf(keyword).length;
      if (!best || wordCount > best.wordCount) {
        const sourceLabel = nonEmpty.find(([, text]) => text.toLowerCase().includes(keyword))?.[0] ?? nonEmpty[0]![0];
        best = { entry, keyword, sourceLabel, wordCount };
      }
    }
  }
  if (!best) return UNKNOWN;

  // Confidence: how much of the matched source's own tokens the winning keyword accounts
  // for, floored at 50 for any real match (a match is never "barely" confident — it either
  // matched a real vocabulary phrase or it didn't) and capped at 98 (never claim certainty
  // absent a human confirming it, matching the Confidence Engine's own convention).
  const keywordTokenCount = tokensOf(best.keyword).length;
  const matchedSourceText = nonEmpty.find(([label]) => label === best!.sourceLabel)?.[1] ?? combinedText;
  const sourceTokenCount = Math.max(tokensOf(matchedSourceText).length, keywordTokenCount);
  const coverage = keywordTokenCount / sourceTokenCount;
  const confidence = Math.min(98, Math.max(50, Math.round(coverage * 100)));

  return {
    category: best.entry.category,
    type: best.entry.type,
    canonicalDetailPage: best.entry.canonicalDetailPage,
    icon: best.entry.icon,
    automationCategory: best.entry.automationCategory,
    confidence,
    reason: `detected "${best.keyword}" in ${best.sourceLabel}`,
    matchedKeyword: best.keyword,
  };
}

/**
 * Generic Room-From-Name Inference (§ Additional Enhancement — Critical): given a device
 * name and the classification already computed for it, extracts whatever text comes
 * BEFORE the matched device-type phrase as a room-name candidate — "Kitchen Ceiling
 * Light" classifies "Ceiling Light" as the type, leaving "Kitchen" as the room. Returns
 * null (never a guess) when there's no matched keyword, or nothing precedes it. Protocol-
 * agnostic and driver-independent: it operates purely on the classification result and
 * the same device-name string every protocol already threads through discovery.
 */
export function inferRoomFromName(deviceName: string, classification: DeviceClassification): string | null {
  if (!classification.matchedKeyword) return null;
  const idx = deviceName.toLowerCase().indexOf(classification.matchedKeyword);
  if (idx <= 0) return null;
  const candidate = deviceName
    .slice(0, idx)
    .replace(/[-–—/|]+$/, "")
    .trim();
  return candidate.length > 0 ? candidate : null;
}

export type { DeviceVocabularyEntry } from "./device-vocabulary.js";
export { DEFAULT_DEVICE_VOCABULARY } from "./device-vocabulary.js";

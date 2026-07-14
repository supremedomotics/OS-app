import type { MetadataSourceKind } from "./metadata-merge.js";
import type { UnifiedKnxDevice } from "./unified-device-mapper.js";

/**
 * Confidence Engine (§ Unified Device Intelligence — Phase 4).
 *
 * A deterministic, explainable scoring function over what the Unified Device Mapper
 * already recorded (merge sources, grouping cluster size, capability match strength) —
 * NOT a machine-learning model, and not presented as one. Each score is a documented
 * heuristic: how much a given source is trusted, translated to a 0-100 number so the
 * installer workflow can render it and flag anything below threshold for review
 * (§ "If confidence is below a threshold: Flag for installer review").
 */
export interface ConfidenceScores {
  name: number;
  room: number;
  capability: number;
  grouping: number;
  manufacturer: number;
  model: number;
  overall: number;
}

/** How much each metadata source is trusted, on a 0-100 scale — a user override is
 * certain (100); an unassigned/never-set field is 0. Mirrors the merge priority order in
 * {@link "./metadata-merge.js"} 1:1, so a field's confidence and its winning source are
 * always consistent with each other (§ "every merge decision must be explainable"). */
const SOURCE_CONFIDENCE: Record<MetadataSourceKind, number> = {
  user: 100,
  knx_iot: 90,
  ets: 85,
  grouping: 60,
  inference: 40,
};

function sourceScore(source: MetadataSourceKind | null): number {
  return source ? SOURCE_CONFIDENCE[source] : 0;
}

/** Extracts which source won for a field from the device's recorded merge explanation
 * (`"deviceName: \"X\" ← ets"`) — reuses the trail the merge engine already produced
 * instead of re-deriving it. */
function winningSource(device: UnifiedKnxDevice, field: string): MetadataSourceKind | null {
  const line = device.raw.mergeExplanation.find((e) => e.startsWith(`${field}:`));
  if (!line) return null;
  const source = line.split("←")[1]?.trim();
  return (source as MetadataSourceKind) ?? null;
}

const THRESHOLD = 70;

/** Scores every dimension the spec's Preview Screen displays. Grouping confidence reads
 * cluster richness (more than one contributing signal is real corroborating evidence,
 * not a guess); capability confidence reads how many functional blocks/keywords actually
 * matched vs. produced nothing. */
export function scoreConfidence(device: UnifiedKnxDevice): ConfidenceScores {
  const name = sourceScore(winningSource(device, "deviceName"));
  const room = sourceScore(winningSource(device, "room"));
  const manufacturer = sourceScore(winningSource(device, "manufacturer"));
  const model = sourceScore(winningSource(device, "model"));

  const grouping = device.raw.communicationObjects.length > 1 ? 100 : device.raw.communicationObjects.length === 1 ? 60 : 0;
  const capability = device.capabilities.length === 0
    ? 0
    : device.raw.deviceKind === "unknown"
      ? 35
      : Math.min(100, 70 + device.raw.sourceHrefs.length * 10);

  const overall = Math.round((name + room + capability + grouping) / 4);

  return { name, room, capability, grouping, manufacturer, model, overall };
}

/** Fields whose score falls below the review threshold — the concrete list the installer
 * workflow uses to decide "Ready to Approve" vs. "Needs Review" (§ Discover Devices UX). */
export function fieldsNeedingReview(scores: ConfidenceScores): (keyof ConfidenceScores)[] {
  return (Object.keys(scores) as (keyof ConfidenceScores)[]).filter((k) => k !== "overall" && scores[k] < THRESHOLD);
}

export { THRESHOLD as CONFIDENCE_REVIEW_THRESHOLD };

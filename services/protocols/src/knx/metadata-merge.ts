import type { SemanticMetadata } from "./semantic-metadata.js";

/**
 * Metadata Merge Engine (§ Unified Device Intelligence — Phase 3).
 *
 * Deterministic, explainable field-level merge across every metadata source that can
 * contribute to one Supreme device. Priority (highest first), per spec:
 *   1. user override
 *   2. KNX IoT metadata
 *   3. ETS metadata
 *   4. circuit grouping (the grouping key itself, as a last-resort name)
 *   5. intelligent inference (device-kind-derived generic name)
 *
 * For each field, the highest-priority source that actually has a non-null value wins —
 * never blindly "first source", never silently averaging/concatenating conflicting
 * values. Every decision is recorded so it can be displayed/audited later
 * (§ Diagnostics: "Merge Source").
 */
export type MetadataSourceKind = "user" | "knx_iot" | "ets" | "grouping" | "inference";

const PRIORITY_ORDER: MetadataSourceKind[] = ["user", "knx_iot", "ets", "grouping", "inference"];

export interface MetadataSource {
  kind: MetadataSourceKind;
  metadata: Partial<SemanticMetadata>;
}

export interface MergedMetadataField<T> {
  value: T | null;
  source: MetadataSourceKind | null;
}

export type MergedMetadata = {
  [K in keyof SemanticMetadata]: MergedMetadataField<SemanticMetadata[K]>;
};

const FIELDS: (keyof SemanticMetadata)[] = [
  "manufacturer", "model", "serialNumber", "hardwareVersion", "firmwareVersion",
  "deviceName", "room", "floor", "building", "installation", "application", "description",
];

/** Merges metadata from every contributing source using the fixed priority order —
 * sources are pre-sorted so callers can pass them in any order. */
export function mergeMetadata(sources: MetadataSource[]): MergedMetadata {
  const sorted = [...sources].sort(
    (a, b) => PRIORITY_ORDER.indexOf(a.kind) - PRIORITY_ORDER.indexOf(b.kind),
  );

  const result = {} as MergedMetadata;
  for (const field of FIELDS) {
    let value: unknown = null;
    let source: MetadataSourceKind | null = null;
    for (const s of sorted) {
      const candidate = s.metadata[field];
      if (candidate !== null && candidate !== undefined && candidate !== "") {
        value = candidate;
        source = s.kind;
        break;
      }
    }
    (result as Record<string, MergedMetadataField<unknown>>)[field] = { value, source };
  }
  return result;
}

/** Flattens a {@link MergedMetadata} back to a plain {@link SemanticMetadata} for
 * consumers that only need the final values, not the provenance. */
export function flattenMergedMetadata(merged: MergedMetadata): SemanticMetadata {
  const out: Partial<SemanticMetadata> = {};
  for (const field of FIELDS) {
    (out as Record<string, unknown>)[field] = merged[field].value;
  }
  return out as SemanticMetadata;
}

/** Human-readable explanation of every field's winning source — the concrete
 * "explainable merge decision" the spec requires, not just an internal data structure. */
export function explainMerge(merged: MergedMetadata): string[] {
  return FIELDS
    .filter((f) => merged[f].value !== null)
    .map((f) => `${f}: "${String(merged[f].value)}" ← ${merged[f].source}`);
}

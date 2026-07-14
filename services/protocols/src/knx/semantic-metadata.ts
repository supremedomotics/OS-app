/**
 * Semantic Metadata (§ Unified Device Intelligence — Phase 3).
 *
 * A protocol-independent device-metadata record, and a real parser that extracts
 * whatever of it is actually present in a KNX IoT Link-Format discovery/functional-block
 * response (`title=`, `rt=` device-type hints). The KNX IoT `/dev` resource carries
 * richer CBOR-encoded fields (manufacturer, serial, hardware/firmware version) per the
 * Association's schema, but decoding it needs the exact `Datapoint.json`/device-resource
 * schema this codebase has not ingested (see the Compatibility Report) — those fields
 * are left `null` here rather than guessed, exactly like KNX Ultimate's undeclared
 * `bus.group_read` gap.
 */
export interface SemanticMetadata {
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  hardwareVersion: string | null;
  firmwareVersion: string | null;
  deviceName: string | null;
  room: string | null;
  floor: string | null;
  building: string | null;
  installation: string | null;
  application: string | null;
  description: string | null;
}

export const EMPTY_SEMANTIC_METADATA: SemanticMetadata = {
  manufacturer: null,
  model: null,
  serialNumber: null,
  hardwareVersion: null,
  firmwareVersion: null,
  deviceName: null,
  room: null,
  floor: null,
  building: null,
  installation: null,
  application: null,
  description: null,
};

/** Extracts the metadata fields KNX IoT's Link-Format discovery genuinely carries today
 * (a resource's `title`) — everything else stays `null`, never fabricated. */
export function semanticMetadataFromLinkFormatTitle(title: string | null): SemanticMetadata {
  return { ...EMPTY_SEMANTIC_METADATA, deviceName: title };
}

/** ETS's own metadata surface (§ existing `device-recognition-engine.ts`) — room/circuit
 * name and, when the ETS project records it, a free-text description. Kept as a thin,
 * explicit adapter so the merge engine never has to know about ETS's project shape. */
export interface EtsMetadataSource {
  circuitName?: string | null;
  room?: string | null;
  description?: string | null;
}

export function semanticMetadataFromEts(ets: EtsMetadataSource): SemanticMetadata {
  return {
    ...EMPTY_SEMANTIC_METADATA,
    deviceName: ets.circuitName ?? null,
    room: ets.room ?? null,
    description: ets.description ?? null,
  };
}

import { groupByCircuitName, type DeviceCluster, type GroupingSignal } from "@supreme/domain-model";

/**
 * Group Address Schema Engine (§ Supreme KNX Driver — deferred from an earlier session,
 * now implemented).
 *
 * Different KNX integrators structure a group address's human-readable name differently
 * — this engine's ONLY job is turning a raw name into a normalized (circuitName +
 * metadata) shape, per whichever schema the installer selected. It never re-implements
 * clustering itself: every schema hands its extracted names to the EXISTING Universal
 * Device Grouping Engine (`groupByCircuitName`, `@supreme/domain-model`, unmodified) for
 * the actual "same circuit → one device" decision (§ ignore case/operation-words/
 * abbreviations/punctuation/separators — all already implemented there).
 *
 * Modular by construction: a schema is just an object implementing {@link
 * GroupAddressSchema}, registered once in {@link SCHEMA_REGISTRY}. Adding a new one — or
 * a future installer's own plugin — never touches discovery code, only adds a registry
 * entry.
 */

/** What a schema pulls out of one raw group-address name. `circuitName` is the ONLY
 * field grouping ever clusters on; the rest is metadata a schema may or may not be able
 * to supply (schema-dependent — e.g. Schema 1 supplies room, Schema 2 doesn't). */
export interface SchemaExtraction {
  circuitName: string;
  room: string | null;
  floor: string | null;
  circuitType: string | null;
  operationType: string | null;
}

export interface SchemaOptions {
  /** Segment separator(s) — default splits on " - ", "-", "/", or multiple spaces, the
   * common ETS export delimiters. Override for a project with a different convention. */
  separators?: RegExp;
  /** Installer-configurable stop words (§ "Ignore configurable stop words") — merged
   * with the schema's own built-in operation-word list before the final grouping pass. */
  stopWords?: string[];
  abbreviations?: Record<string, string>;
}

export interface GroupAddressSchema {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** The role each hierarchy LEVEL plays for this schema — used only for documentation/
   * UI labeling, never for clustering logic itself. */
  readonly levels: readonly string[];
  extract(rawName: string, options: SchemaOptions): SchemaExtraction;
}

// Requires whitespace around a hyphen to count as a segment break — "Living DL-1" must
// NOT split on the hyphen inside "DL-1" itself, only on genuine " - " level separators.
const DEFAULT_SEPARATORS = /\s+-\s+|\s*[/>]\s*|\s{2,}/;

function splitSegments(rawName: string, options: SchemaOptions): string[] {
  return rawName
    .split(options.separators ?? DEFAULT_SEPARATORS)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Built-in Schema 1: Floor → Room → Device Name. Degrades gracefully when a raw name
 * has fewer than 3 segments (a flatter export still using this convention) — the LAST
 * segment is always the circuit name; whatever precedes it fills room then floor. */
export const floorRoomDeviceSchema: GroupAddressSchema = {
  id: "floor-room-device",
  name: "Floor → Room → Device Name",
  description: 'Ground Floor / Living Room / "Main Ceiling Light"',
  levels: ["floor", "room", "circuitName"],
  extract(rawName, options) {
    const segments = splitSegments(rawName, options);
    const circuitName = segments[segments.length - 1] ?? rawName.trim();
    const room = segments.length >= 2 ? (segments[segments.length - 2] ?? null) : null;
    const floor = segments.length >= 3 ? (segments[segments.length - 3] ?? null) : null;
    return { circuitName, room, floor, circuitType: null, operationType: null };
  },
};

/** Built-in Schema 2: Circuit Type → Operation Type → Circuit Name. The circuit name is
 * again always last; the two LEADING segments are metadata, not part of device
 * identity — this is the schema that would otherwise defeat the generic engine's
 * trailing-operation-word stripping (its example puts the operation word in the MIDDLE
 * of the raw string, not the end), which is exactly why a schema-aware extraction step
 * has to run before grouping rather than relying on the generic engine alone. */
export const circuitOperationNameSchema: GroupAddressSchema = {
  id: "circuit-operation-name",
  name: "Circuit Type → Operation Type → Circuit Name",
  description: 'Lighting / Switching / "Living DL-1"',
  levels: ["circuitType", "operationType", "circuitName"],
  extract(rawName, options) {
    const segments = splitSegments(rawName, options);
    const circuitName = segments[segments.length - 1] ?? rawName.trim();
    const operationType = segments.length >= 2 ? (segments[segments.length - 2] ?? null) : null;
    const circuitType = segments.length >= 3 ? (segments[segments.length - 3] ?? null) : null;
    return { circuitName, room: null, floor: null, circuitType, operationType };
  },
};

/** Registry — the modular seam. Adding a schema (built-in or a future installer plugin)
 * is exactly one `register()` call; discovery code never changes. */
export class SchemaRegistry {
  private readonly byId = new Map<string, GroupAddressSchema>();

  register(schema: GroupAddressSchema): void {
    this.byId.set(schema.id, schema);
  }

  get(id: string): GroupAddressSchema | undefined {
    return this.byId.get(id);
  }

  list(): GroupAddressSchema[] {
    return [...this.byId.values()];
  }
}

export const SCHEMA_REGISTRY = new SchemaRegistry();
SCHEMA_REGISTRY.register(floorRoomDeviceSchema);
SCHEMA_REGISTRY.register(circuitOperationNameSchema);

export interface SchemaGroupedCluster extends DeviceCluster {
  room: string | null;
  floor: string | null;
  circuitType: string | null;
  operationType: string | null;
}

/**
 * Runs the full pipeline: schema-extract every signal's circuitName + metadata, then
 * hand every extracted circuitName to the EXISTING `groupByCircuitName` for the actual
 * clustering (§ "reuse the existing engine, do not duplicate grouping logic" — this
 * function does not implement its own tokenization/operation-word/abbreviation logic
 * anywhere). A cluster's metadata (room/floor/circuitType/operationType) is taken from
 * its first contributing signal — consistent within one circuit by construction, since
 * every signal for the same circuit shares the same hierarchy prefix.
 */
export function groupWithSchema(
  signals: GroupingSignal[],
  schemaId: string,
  options: SchemaOptions = {},
): SchemaGroupedCluster[] {
  const schema = SCHEMA_REGISTRY.get(schemaId);
  if (!schema) throw new Error(`knx schema engine: unknown schema "${schemaId}"`);

  const extractionBySignalId = new Map<string, SchemaExtraction>();
  const circuitSignals: GroupingSignal[] = signals.map((s) => {
    const extraction = schema.extract(s.name, options);
    extractionBySignalId.set(s.id, extraction);
    return { id: s.id, name: extraction.circuitName };
  });

  const clusters = groupByCircuitName(circuitSignals, {
    extraOperationWords: options.stopWords,
    abbreviations: options.abbreviations,
  });

  return clusters.map((cluster) => {
    const first = extractionBySignalId.get(cluster.signals[0]?.id ?? "");
    return {
      ...cluster,
      room: first?.room ?? null,
      floor: first?.floor ?? null,
      circuitType: first?.circuitType ?? null,
      operationType: first?.operationType ?? null,
    };
  });
}

import { groupByCircuitName, type DeviceCluster, type GroupingSignal } from "@supreme/domain-model";

/**
 * Group Address Schema PLUGIN Engine (§ Supreme KNX Driver — Plugin Architecture).
 *
 * Different KNX integrators structure a group address's human-readable name differently
 * — this engine's ONLY job is turning a raw name into a normalized (circuitName +
 * metadata) shape, per whichever schema plugin the installer selected. It never
 * re-implements clustering itself: every plugin hands its extracted names to the
 * EXISTING Universal Device Grouping Engine (`groupByCircuitName`,
 * `@supreme/domain-model`, unmodified) for the actual "same circuit → one device"
 * decision (§ ignore case/operation-words/abbreviations/punctuation/separators — all
 * already implemented there).
 *
 * The engine ({@link groupWithSchema}) talks to exactly ONE thing: the
 * {@link GroupAddressSchemaPlugin} interface. It has no knowledge of "Schema 1" or
 * "Schema 2" or any other specific plugin, built-in or otherwise — it only ever calls
 * `plugin.extract()` on whatever plugin `SCHEMA_REGISTRY.get(schemaId)` returns. Adding
 * a plugin (built-in, community, installer-authored, or future AI-generated — see
 * {@link defineHierarchySchema} and the Future AI Schema Architecture notes below) is
 * exactly one `register()` call; this file's discovery logic never changes.
 */

/** What a plugin pulls out of one raw group-address name. `circuitName` is the ONLY
 * field grouping ever clusters on; the rest is metadata a plugin may or may not be able
 * to supply (plugin-dependent — e.g. the Floor→Room→Device plugin supplies room, the
 * Circuit→Operation→Name plugin doesn't). */
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
   * with the plugin's own built-in operation-word list before the final grouping pass. */
  stopWords?: string[];
  abbreviations?: Record<string, string>;
}

/** Where a plugin came from — surfaced to the installer UI so a community/AI-generated
 * schema is never presented as if Supreme Domotics authored it (§ Future AI Schema
 * Architecture: trust and provenance matter more, not less, once plugins aren't all
 * hand-written by this codebase's own developers). */
export type SchemaPluginSource = "built-in" | "community" | "ai-generated" | "custom";

export interface SchemaPluginMetadata {
  readonly source: SchemaPluginSource;
  readonly version: string;
  /** Human/organization/model that authored this plugin — required for anything that
   * isn't "built-in", so an installer always knows who to credit or blame. */
  readonly author?: string;
}

/** The common Schema Plugin interface (§ Plugin Architecture) — the ONLY surface
 * `groupWithSchema` ever calls. A plugin is data-and-behavior together (an `extract`
 * function), but see {@link defineHierarchySchema} for a way to define one as PURE DATA
 * — no function body at all — which is what makes a plugin safely constructible by an
 * installer-facing form, a community JSON import, or a future AI generator, without any
 * of them needing to write or evaluate arbitrary code. */
export interface GroupAddressSchemaPlugin {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** The role each hierarchy LEVEL plays for this plugin — used for documentation/UI
   * labeling and by generic tooling (§ defineHierarchySchema), never required by
   * `extract()` itself, which is free to ignore hierarchy entirely if it wants to. */
  readonly levels: readonly string[];
  readonly metadata: SchemaPluginMetadata;
  extract(rawName: string, options: SchemaOptions): SchemaExtraction;
}

/** @deprecated Alias kept so nothing that imported the pre-plugin-architecture type name
 * breaks. Use {@link GroupAddressSchemaPlugin}. */
export type GroupAddressSchema = GroupAddressSchemaPlugin;

/** Runtime validation for a plugin that didn't come from this file's own trusted
 * built-ins — the defensive boundary a community-imported or AI-generated plugin has to
 * cross before the registry will accept it (§ Future AI Schema Architecture: never trust
 * a dynamically-produced plugin's shape implicitly). Checked, not merely typed, because
 * TypeScript types don't survive `JSON.parse()` or a model's output. */
export function validateSchemaPlugin(plugin: unknown): plugin is GroupAddressSchemaPlugin {
  if (typeof plugin !== "object" || plugin === null) return false;
  const p = plugin as Partial<GroupAddressSchemaPlugin>;
  return (
    typeof p.id === "string" && p.id.length > 0 &&
    typeof p.name === "string" && p.name.length > 0 &&
    typeof p.description === "string" &&
    Array.isArray(p.levels) && p.levels.every((l) => typeof l === "string") &&
    typeof p.metadata === "object" && p.metadata !== null &&
    typeof (p.metadata as SchemaPluginMetadata).source === "string" &&
    typeof p.extract === "function"
  );
}

// Requires whitespace around a hyphen to count as a segment break — "Living DL-1" must
// NOT split on the hyphen inside "DL-1" itself, only on genuine " - " level separators.
const DEFAULT_SEPARATORS = /\s+-\s+|\s*[/>]\s*|\s{2,}/;

function splitSegments(rawName: string, separators: RegExp): string[] {
  return rawName.split(separators).map((s) => s.trim()).filter(Boolean);
}

/**
 * Declarative plugin factory (§ Plugin Architecture, § Future AI Schema Architecture) —
 * defines a plugin as PURE DATA: an ordered list of hierarchy levels, always ending in
 * `"circuitName"`. No function body to write, review, or trust — which is exactly what
 * makes this the shape a future AI generator, a community JSON import, or an
 * installer-facing "build your own schema" form can safely produce. Both built-in
 * plugins below are defined this way now — "hardcoded logic" for the two original
 * schemas no longer exists anywhere in this file (§ item 8: "built-in schemas should
 * become built-in plugins rather than hardcoded logic").
 *
 * The generic algorithm: split the raw name into segments, and — walking backward from
 * the end — assign the last segment to `"circuitName"`, the one before it to whatever
 * the second-to-last entry in `levels` is, and so on. A name with fewer segments than
 * `levels` degrades gracefully (the leading levels are simply `null`), exactly like the
 * original hand-written implementations did.
 */
export interface HierarchySchemaDefinition {
  id: string;
  name: string;
  description: string;
  /** Ordered outermost → innermost; MUST end with `"circuitName"`. Any other level name
   * that happens to match `"room"`/`"floor"`/`"circuitType"`/`"operationType"` populates
   * the matching {@link SchemaExtraction} field; anything else is still respected for
   * segment-splitting purposes but has nowhere in `SchemaExtraction` to land — kept out
   * of the result rather than invented a new field for.
   */
  levels: readonly string[];
  metadata?: Partial<SchemaPluginMetadata>;
  separators?: RegExp;
}

export function defineHierarchySchema(def: HierarchySchemaDefinition): GroupAddressSchemaPlugin {
  if (def.levels[def.levels.length - 1] !== "circuitName") {
    throw new Error(`knx schema engine: plugin "${def.id}" must end its levels with "circuitName"`);
  }
  const separators = def.separators ?? DEFAULT_SEPARATORS;

  return {
    id: def.id,
    name: def.name,
    description: def.description,
    levels: def.levels,
    metadata: { source: "built-in", version: "1.0.0", ...def.metadata },
    extract(rawName, options) {
      const segments = splitSegments(rawName, options.separators ?? separators);
      const result: SchemaExtraction = { circuitName: rawName.trim(), room: null, floor: null, circuitType: null, operationType: null };
      // Walk both arrays from the end simultaneously — segments[last] <-> levels[last]
      // ("circuitName"), segments[last-1] <-> levels[last-1], etc.
      for (let i = 0; i < def.levels.length; i++) {
        const level = def.levels[def.levels.length - 1 - i];
        const segment = segments[segments.length - 1 - i];
        if (segment === undefined) break; // fewer segments than levels — degrade gracefully
        if (level === "circuitName") result.circuitName = segment;
        else if (level === "room") result.room = segment;
        else if (level === "floor") result.floor = segment;
        else if (level === "circuitType") result.circuitType = segment;
        else if (level === "operationType") result.operationType = segment;
      }
      return result;
    },
  };
}

/** Built-in plugin: Floor → Room → Device Name. */
export const floorRoomDeviceSchema: GroupAddressSchemaPlugin = defineHierarchySchema({
  id: "floor-room-device",
  name: "Floor → Room → Device Name",
  description: 'Ground Floor / Living Room / "Main Ceiling Light"',
  levels: ["floor", "room", "circuitName"],
});

/** Built-in plugin: Circuit Type → Operation Type → Circuit Name. The circuit name is
 * always last; the two LEADING segments are metadata, not part of device identity —
 * this is the plugin that would otherwise defeat the generic engine's trailing-
 * operation-word stripping (its example puts the operation word in the MIDDLE of the
 * raw string, not the end), which is exactly why schema-aware extraction has to run
 * before grouping rather than relying on the generic engine alone. */
export const circuitOperationNameSchema: GroupAddressSchemaPlugin = defineHierarchySchema({
  id: "circuit-operation-name",
  name: "Circuit Type → Operation Type → Circuit Name",
  description: 'Lighting / Switching / "Living DL-1"',
  levels: ["circuitType", "operationType", "circuitName"],
});

/** Registry — the modular plugin seam (§ Plugin Architecture). Adding a plugin (built-
 * in, community, installer-authored, or AI-generated) is exactly one `register()` call;
 * `groupWithSchema` below never changes regardless of what's registered. */
export class SchemaRegistry {
  private readonly byId = new Map<string, GroupAddressSchemaPlugin>();

  /** Registers a plugin. Built-ins register unconditionally (this file trusts its own
   * code); anything else should be checked with {@link validateSchemaPlugin} first —
   * `register()` itself stays permissive so a caller that already validated doesn't pay
   * for a redundant check, but never call this with unchecked external input directly. */
  register(plugin: GroupAddressSchemaPlugin): void {
    this.byId.set(plugin.id, plugin);
  }

  get(id: string): GroupAddressSchemaPlugin | undefined {
    return this.byId.get(id);
  }

  list(): GroupAddressSchemaPlugin[] {
    return [...this.byId.values()];
  }

  /** Plugins from a specific source (§ Future AI Schema Architecture) — e.g. an
   * installer settings page listing "Built-in" separately from "Community"/"AI-
   * generated"/"Custom" so provenance is always visible, never blurred together. */
  listBySource(source: SchemaPluginSource): GroupAddressSchemaPlugin[] {
    return this.list().filter((p) => p.metadata.source === source);
  }

  unregister(id: string): void {
    this.byId.delete(id);
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
 * Runs the full pipeline: ask the registered plugin to extract every signal's
 * circuitName + metadata, then hand every extracted circuitName to the EXISTING
 * `groupByCircuitName` for the actual clustering (§ "reuse the existing engine, do not
 * duplicate grouping logic" — this function does not implement its own tokenization/
 * operation-word/abbreviation logic anywhere, and it does not know or care which plugin
 * it's talking to). A cluster's metadata (room/floor/circuitType/operationType) is taken
 * from its first contributing signal — consistent within one circuit by construction,
 * since every signal for the same circuit shares the same hierarchy prefix.
 */
export function groupWithSchema(
  signals: GroupingSignal[],
  schemaId: string,
  options: SchemaOptions = {},
): SchemaGroupedCluster[] {
  const plugin = SCHEMA_REGISTRY.get(schemaId);
  if (!plugin) throw new Error(`knx schema engine: unknown schema plugin "${schemaId}"`);

  const extractionBySignalId = new Map<string, SchemaExtraction>();
  const circuitSignals: GroupingSignal[] = signals.map((s) => {
    const extraction = plugin.extract(s.name, options);
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

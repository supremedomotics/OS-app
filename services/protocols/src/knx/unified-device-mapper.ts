import { groupByCircuitName, type DeviceCluster, type GroupingSignal } from "@supreme/domain-model";
import type { DiscoveredDevice } from "@supreme/integration-layer";
import { classifyFromText, classifyFunctionalBlock, mergeCapabilityHints, type KnxDeviceKind } from "./capability-mapper.js";
import type { FunctionalBlock } from "./functional-block-parser.js";
import {
  explainMerge,
  flattenMergedMetadata,
  mergeMetadata,
  type MetadataSource,
} from "./metadata-merge.js";
import { EMPTY_SEMANTIC_METADATA, semanticMetadataFromEts, semanticMetadataFromLinkFormatTitle, type EtsMetadataSource, type SemanticMetadata } from "./semantic-metadata.js";
import { groupWithSchema, type SchemaOptions } from "./schema-engine.js";

/**
 * Unified Device Mapper (§ Unified Device Intelligence — Phase 3).
 *
 * The single place that turns raw provider output into ONE canonical Supreme device per
 * physical circuit, per the pipeline:
 *
 *   KNX IoT discovery → functional blocks → semantic metadata → ETS metadata →
 *   Universal Circuit Grouping → capability detection → merge → Supreme device
 *
 * Neither provider owns a device — both only ever CONTRIBUTE signals into this mapper.
 * Ownership of the resulting device stays with {@link "./supreme-knx-driver.js"
 * SupremeKnxDriver} (§ Architectural Rule), which calls this mapper but never the other
 * way around.
 */

export interface KnxIotDiscoverySignal {
  /** From {@link "./knx-iot-provider.js" KnxIotProvider}'s DiscoveredDevice.raw. */
  host: string;
  linkFormat: string;
  /** Functional blocks fetched separately via `discovery.functional_blocks`, if any —
   * absent when only bare discovery has run (§ pipeline: this stage is optional and
   * additive, never required for a device to exist). */
  functionalBlocks?: FunctionalBlock[];
}

export interface UnifiedDeviceMapperInput {
  knxIot?: KnxIotDiscoverySignal[];
  /** ETS-derived circuit signals (group address + name) — same shape the generic
   * grouping engine already accepts, so no new signal format is invented. */
  ets?: (GroupingSignal & { room?: string | null; description?: string | null })[];
  /** Installer/user-entered overrides, keyed by the grouping key the device will land
   * under (§ Merge priority: user always wins). */
  userOverrides?: Record<string, Partial<SemanticMetadata>>;
  /** Group Address Schema Engine selection (§ Configurable Group Address Schema Engine)
   * — which naming convention this project's group-address names follow. Absent means
   * the plain circuit-name grouping this mapper has always done (backward compatible —
   * every existing caller that never selects a schema is unaffected). When present,
   * clustering runs through {@link groupWithSchema} instead of the bare
   * `groupByCircuitName` call, which still does 100% of the actual clustering work —
   * the schema only decides what text gets fed to it. */
  schemaId?: string;
  schemaOptions?: SchemaOptions;
}

/** A single communication object contributing to this device — a KNX Ultimate group
 * address or a KNX IoT resource (§ Phase 4 Binding Engine input). Kept generic (id+name)
 * rather than protocol-typed so the Binding Engine decides, per-id, whether it looks like
 * a bindable classic group address (`n/n/n`) or an IoT-only resource reference. */
export interface CommunicationObject {
  id: string;
  name: string;
  source: "knx_iot" | "ets";
}

export interface UnifiedKnxDevice extends DiscoveredDevice {
  raw: {
    deviceKind: KnxDeviceKind;
    metadata: SemanticMetadata;
    mergeExplanation: string[];
    sourceHrefs: string[];
    groupingKey: string;
    communicationObjects: CommunicationObject[];
  };
}

function titleCase(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

function inferredMetadata(deviceKind: KnxDeviceKind, groupingKey: string): Partial<SemanticMetadata> {
  if (deviceKind === "unknown") return {};
  const label = titleCase(deviceKind.replace(/_/g, " "));
  return { deviceName: `${titleCase(groupingKey)} (${label})` };
}

/** Runs the full Unified Device Pipeline over whatever signals are available this cycle
 * — KNX IoT alone, ETS alone, or both together — and returns one canonical device per
 * circuit-name cluster. Never duplicates a device across sources: KNX IoT and ETS
 * signals for the same circuit name merge into a single cluster before mapping. */
export function mapUnifiedDevices(input: UnifiedDeviceMapperInput): UnifiedKnxDevice[] {
  const signals: GroupingSignal[] = [
    ...(input.knxIot ?? []).map((d) => ({ id: `knx-iot:${d.host}`, name: d.linkFormat.match(/title="([^"]*)"/)?.[1] ?? d.host })),
    ...(input.ets ?? []).map((s) => ({ id: s.id, name: s.name })),
  ];
  if (signals.length === 0) return [];

  const clusters: (DeviceCluster & { room?: string | null; circuitType?: string | null; operationType?: string | null })[] = input.schemaId
    ? groupWithSchema(signals, input.schemaId, input.schemaOptions ?? {})
    : groupByCircuitName(signals);
  const iotByHost = new Map((input.knxIot ?? []).map((d) => [`knx-iot:${d.host}`, d]));
  const etsById = new Map((input.ets ?? []).map((s) => [s.id, s]));

  return clusters.map((cluster) => {
    const iotSignals = cluster.signals.map((s) => iotByHost.get(s.id)).filter((d): d is KnxIotDiscoverySignal => d !== undefined);
    const etsSignals = cluster.signals.map((s) => etsById.get(s.id)).filter((s): s is NonNullable<typeof s> => s !== undefined);

    const functionalBlocks = iotSignals.flatMap((d) => d.functionalBlocks ?? []);
    // Classify from the RAW signal names too, not just the grouping key — the grouping
    // engine (§ Phase 2, unmodified) strips trailing operation words like "Switch"/"SW"
    // to find circuit identity, which is correct for its job but can strip the ONLY
    // classification keyword a single-signal device has (e.g. "Hallway Switch" → circuit
    // key "hallway"). classifyFromText already accepts multiple hints — this costs
    // nothing extra and never overrides a real functional-block classification.
    // Classify from the ORIGINAL raw signal names (etsSignals/iotSignals), not
    // `cluster.signals[].name` — when a Group Address Schema Engine extraction ran
    // (§ Configurable Group Address Schema Engine), `cluster.signals[].name` is the
    // STRIPPED circuit name only ("Living DL-1"), with real classification signal like
    // "Switching"/"Dimming" moved out into per-signal metadata the cluster only keeps
    // one copy of (first signal). The raw pre-extraction names still carry every
    // signal's full text, so classification never loses signal to schema stripping.
    const rawNames = [...etsSignals.map((s) => s.name), ...iotSignals.map((s) => s.linkFormat)];
    const hints = functionalBlocks.length > 0
      ? functionalBlocks.map(classifyFunctionalBlock)
      : [classifyFromText(cluster.key, ...rawNames)];
    const { capabilities, deviceKind, matchedOn } = mergeCapabilityHints(hints);

    const knxIotTitle = iotSignals[0]?.linkFormat.match(/title="([^"]*)"/)?.[1] ?? null;
    const etsMeta: EtsMetadataSource = {
      circuitName: etsSignals[0]?.name ?? null,
      // An explicit per-signal room always wins; a Schema Engine room extraction (e.g.
      // Schema 1's "Floor → Room → Device Name") fills in only when nothing more
      // specific said otherwise — never overrides real data with a guess.
      room: etsSignals[0]?.room ?? cluster.room ?? null,
      description: etsSignals[0]?.description ?? null,
    };

    const sources: MetadataSource[] = [
      { kind: "user", metadata: input.userOverrides?.[cluster.key] ?? {} },
      { kind: "knx_iot", metadata: semanticMetadataFromLinkFormatTitle(knxIotTitle) },
      { kind: "ets", metadata: semanticMetadataFromEts(etsMeta) },
      { kind: "grouping", metadata: { ...EMPTY_SEMANTIC_METADATA, deviceName: titleCase(cluster.key) } },
      { kind: "inference", metadata: inferredMetadata(deviceKind, cluster.key) },
    ];
    const merged = mergeMetadata(sources);
    const metadata = flattenMergedMetadata(merged);

    const communicationObjects: CommunicationObject[] = [
      ...etsSignals.map((s) => ({ id: s.id, name: s.name, source: "ets" as const })),
      ...iotSignals.map((s) => ({ id: s.host, name: knxIotTitle ?? s.host, source: "knx_iot" as const })),
    ];

    return {
      backendId: `knx-unified:${cluster.key}`,
      suggestedName: metadata.deviceName ?? cluster.key,
      capabilities,
      raw: {
        deviceKind,
        metadata,
        mergeExplanation: explainMerge(merged),
        sourceHrefs: [...matchedOn, ...functionalBlocks.map((b) => b.href)],
        groupingKey: cluster.key,
        communicationObjects,
      },
    };
  });
}

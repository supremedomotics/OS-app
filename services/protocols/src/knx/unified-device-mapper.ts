import { groupByCircuitName, type GroupingSignal } from "@supreme/domain-model";
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
}

export interface UnifiedKnxDevice extends DiscoveredDevice {
  raw: {
    deviceKind: KnxDeviceKind;
    metadata: SemanticMetadata;
    mergeExplanation: string[];
    sourceHrefs: string[];
    groupingKey: string;
  };
}

function inferredMetadata(deviceKind: KnxDeviceKind, groupingKey: string): Partial<SemanticMetadata> {
  if (deviceKind === "unknown") return {};
  const label = deviceKind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return { deviceName: `${groupingKey.replace(/\b\w/g, (c) => c.toUpperCase())} (${label})` };
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

  const clusters = groupByCircuitName(signals);
  const iotByHost = new Map((input.knxIot ?? []).map((d) => [`knx-iot:${d.host}`, d]));
  const etsById = new Map((input.ets ?? []).map((s) => [s.id, s]));

  return clusters.map((cluster) => {
    const iotSignals = cluster.signals.map((s) => iotByHost.get(s.id)).filter((d): d is KnxIotDiscoverySignal => d !== undefined);
    const etsSignals = cluster.signals.map((s) => etsById.get(s.id)).filter((s): s is NonNullable<typeof s> => s !== undefined);

    const functionalBlocks = iotSignals.flatMap((d) => d.functionalBlocks ?? []);
    const hints = functionalBlocks.length > 0
      ? functionalBlocks.map(classifyFunctionalBlock)
      : [classifyFromText(cluster.key)];
    const { capabilities, deviceKind, matchedOn } = mergeCapabilityHints(hints);

    const knxIotTitle = iotSignals[0]?.linkFormat.match(/title="([^"]*)"/)?.[1] ?? null;
    const etsMeta: EtsMetadataSource = {
      circuitName: etsSignals[0]?.name ?? null,
      room: etsSignals[0]?.room ?? null,
      description: etsSignals[0]?.description ?? null,
    };

    const sources: MetadataSource[] = [
      { kind: "user", metadata: input.userOverrides?.[cluster.key] ?? {} },
      { kind: "knx_iot", metadata: semanticMetadataFromLinkFormatTitle(knxIotTitle) },
      { kind: "ets", metadata: semanticMetadataFromEts(etsMeta) },
      { kind: "grouping", metadata: { ...EMPTY_SEMANTIC_METADATA, deviceName: cluster.key } },
      { kind: "inference", metadata: inferredMetadata(deviceKind, cluster.key) },
    ];
    const merged = mergeMetadata(sources);
    const metadata = flattenMergedMetadata(merged);

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
      },
    };
  });
}

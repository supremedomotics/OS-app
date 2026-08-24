import { classifyDevice, DEFAULT_OPERATION_WORDS, groupByCircuitName, type CapabilityKind, type DeviceClassification, type DeviceCluster, type GroupingSignal } from "@supreme/domain-model";
import type { DiscoveredDevice } from "@supreme/integration-layer";
import {
  classifyEtsSignal,
  classifyFromText,
  classifyFunctionalBlock,
  dptStructuralCategory,
  KNX_EXTRA_OPERATION_WORDS,
  mergeCapabilityHints,
  resolveDpt5001Semantic,
  roleOfEtsSignal,
  type CommunicationObjectRole,
  type EtsSignalRoleLink,
  type KnxDeviceKind,
} from "./capability-mapper.js";
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
  /** § Cross-Source Identity (Production KNX Driver 2.0) — the KNX individual address
   * this IoT device reports, WHEN it can be deterministically read from real KNX IoT
   * semantic/resource-model metadata. Left undefined today: `knx-iot-provider.ts`
   * registers only `discovery.metadata`/`discovery.functional_blocks` — semantic/
   * resource-model discovery (the KNX IoT capability that would actually expose a
   * device's individual address) is explicitly unregistered there (no live KNX IoT
   * device was available to validate a real GET/parse cycle against). The field exists
   * now so tier-2 identity matching (see `resolveKnownLink`) activates automatically,
   * with no mapper change, the moment that capability is implemented — never fabricated
   * in the meantime. */
  individualAddress?: string | null;
}

export interface UnifiedDeviceMapperInput {
  knxIot?: KnxIotDiscoverySignal[];
  /** ETS-derived circuit signals (group address + name) — same shape the generic
   * grouping engine already accepts, so no new signal format is invented. `dpt` is
   * optional (KNX IoT-only callers have no DPT concept) and, when present, drives
   * DPT-priority capability classification (§ classifyEtsSignal) ahead of name-based
   * keyword matching.
   *
   * `individualAddress`/`manufacturer`/`model`/`channel` (§ Production KNX Driver 2.0 —
   * Physical Device Identity) are additive and optional: real ETS device-tree data
   * (`knxSignalsFromModel`, `@supreme/commissioning`) supplies them; a flat ESF/GA-export
   * or a caller building signals by hand leaves them undefined, which behaves exactly as
   * it always has (circuit-name clustering — see `groupByPhysicalChannel` below).
   *
   * `links` (§ Command/Feedback Binding Architecture) is the real ETS `<Connectors>`
   * Send/Receive relationship data for this GA — every comm object that writes
   * (`role: "send"`) or reads (`role: "receive"`) it, across every device that
   * references it. Drives `roleOfEtsSignal`'s tier-1 command/feedback resolution ahead
   * of DPT/name heuristics. Absent/empty for KNX-IoT-only signals or a flat ESF/GA
   * export with no device tree — those fall through to the existing DPT/name-based
   * resolution unchanged. */
  ets?: (GroupingSignal & {
    room?: string | null;
    description?: string | null;
    dpt?: string | null;
    individualAddress?: string | null;
    manufacturer?: string | null;
    model?: string | null;
    channel?: number | null;
    /** § Rich ETS Communication-Object Semantic Context (eighth pass) — the owning comm
     * object's own function text (e.g. "Absolute Brightness Value"), distinct from
     * `name` (the GA's own name). Threaded straight from `@supreme/commissioning`'s
     * `KnxEtsSignal.comObjectText` — real ETS data, no fabrication, no second parser. */
    comObjectText?: string | null;
    links?: EtsSignalRoleLink[];
    /** § Naming Evidence (Pass 10) — the ETS Main/Middle Group this GA lives under
     * (`@supreme/commissioning`'s `KnxGroupAddressRecord.mainGroup`/`.middleGroup`,
     * threaded straight through — no re-parsing, no second hierarchy model). Used only
     * as MEDIUM-tier naming evidence (§ deriveDeviceNameEvidence) when no stronger
     * explicit circuit/device name exists; never invented when the source project has no
     * group-range hierarchy (flat GA-only exports leave these null/undefined). */
    mainGroup?: string | null;
    middleGroup?: string | null;
  })[];
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
  /** § Cross-Source Identity (Production KNX Driver 2.0) — explicit, installer/config-
   * confirmed correlation between a live KNX IoT device (by discovery host) and its ETS
   * physical individual address. This is tier-1 evidence in the identity hierarchy: the
   * ONLY source of "explicit shared physical identifier" available today, since neither
   * discovery source currently exposes a common id the mapper could match automatically
   * (see `KnxIotDiscoverySignal.individualAddress`'s own doc comment). Never inferred —
   * a human (or a config file a human wrote) has to have actually confirmed the two
   * discoveries found the same physical device. `channel` is optional: omit it to match
   * a single-channel device (the common case); a multi-channel physical device requires
   * naming which channel the KNX IoT device corresponds to, so an omitted channel never
   * silently fans a link out across several unrelated logical devices. */
  knownDeviceLinks?: { knxIotHost: string; individualAddress: string; channel?: number | null }[];
}

/** A single communication object contributing to this device — a KNX Ultimate group
 * address or a KNX IoT resource (§ Phase 4 Binding Engine input). Kept generic (id+name)
 * rather than protocol-typed so the Binding Engine decides, per-id, whether it looks like
 * a bindable classic group address (`n/n/n`) or an IoT-only resource reference.
 *
 * `capabilities`/`role` are which capability(ies) THIS SPECIFIC object serves and which
 * of that capability's write/status/step objects it is — populated from the same
 * per-signal classification `mapUnifiedDevices` already computes (§ production defect:
 * without this, a merged multi-capability device's Binding Engine had no way to tell a
 * brightness object from a color-temperature object and silently bound every capability
 * to whichever object happened to come first). Defaults to the device's full merged
 * capability list / `"primary"` when no finer-grained signal was available (a pure
 * functional-block or whole-cluster-keyword classification, same as before this field
 * existed) — never narrower than what was actually known. */
export interface CommunicationObject {
  id: string;
  name: string;
  source: "knx_iot" | "ets";
  capabilities: CapabilityKind[];
  role: CommunicationObjectRole;
  /** § Channel Synthesis (Pass 2) — which physical channel this SPECIFIC comm object
   * came from, preserved even when `mergeRelatedChannels` combined several channels
   * into one logical device (§13: "do not lose channel identity" — needed for
   * diagnostics, telegram tracing, and future per-sub-function configuration). Null for
   * a KNX IoT object or an ETS object whose text carries no channel token. */
  channel: number | null;
  /** § Binding Evidence Hierarchy (Pass 11.4) — true when this GA's own ETS `links[]`
   * name at most ONE distinct physical device (the SAME "is this GA shared across
   * multiple physical devices" test `attachSharedGaSignals` itself uses to decide
   * whether to fan a GA out at all — see that function's `distinctAddresses.size < 2`
   * check). A GA one device sends and a second/third device only receives (a central
   * "All Lights Off") is `local: false` for every device, INCLUDING the one that owns
   * it in `groupByPhysicalChannel`'s clustering — being the physical owner of a group
   * address is not the same as it being that device's own local circuit command, and
   * conflating the two was the actual bug (see the unit tests this field was added to
   * satisfy: a central GA that happens to share its physical/channel identity with a
   * real device must still rank below that device's own plain, unshared local switch).
   * Always `true` for a KNX IoT object or an ETS signal with no `links` at all (no
   * relationship data to prove sharing — never assumed shared). */
  local: boolean;
  /** § PASS 17 bug fix — the real ETS DPT for this SPECIFIC group address (normalized
   * "major.minor", e.g. "7.600" for an absolute colour-temperature object vs "232.600"
   * for RGB), preserved from the source signal all the way through to the binding
   * engine. Previously dropped at this exact object-construction step — `planBindings()`
   * (binding-engine.ts) had no way to know a `color`-capability object's REAL datapoint
   * type, so it always fell back to `defaultDpt("color")` (hardcoded RGB, DPT232.600)
   * even for a tunable-white fixture whose actual group address is a plain DPT7.600
   * Kelvin object — sending/decoding it as a 3-byte RGB payload instead of a 2-byte
   * Kelvin value. Null for a KNX IoT object (no DPT concept in that transport) or when
   * the source ETS signal genuinely didn't carry one. */
  dpt: string | null;
}

export interface UnifiedKnxDevice extends DiscoveredDevice {
  raw: {
    deviceKind: KnxDeviceKind;
    metadata: SemanticMetadata;
    mergeExplanation: string[];
    sourceHrefs: string[];
    groupingKey: string;
    communicationObjects: CommunicationObject[];
    /** Universal Device Intelligence Engine output (§ Universal Device Intelligence
     * Engine, `@supreme/domain-model`'s `classifyDevice`) — category/type/canonical page/
     * icon/confidence, computed from the SAME protocol-agnostic engine every other driver
     * uses, not a KNX-specific classification. Extends `deviceKind` (which exists for
     * capability/binding purposes) rather than replacing it. */
    classification: DeviceClassification;
    /** § Production KNX Driver 2.0 — Physical Device Identity (§28: preserved for
     * diagnostics/integrator mode). Null when no contributing signal carried real ETS
     * device-tree data (KNX-IoT-only discovery, or a flat ESF/GA export) — never
     * fabricated. See groupByPhysicalChannel's doc comment for exactly when this is
     * also the device's PRIMARY clustering key vs. purely descriptive metadata. */
    physicalDevice: {
      individualAddress: string | null;
      manufacturer: string | null;
      model: string | null;
      /** Primary/first channel — unchanged field, backward compatible with every
       * existing single-channel device. */
      channel: number | null;
      /** § Channel Synthesis (Pass 2) — every physical channel this ONE logical device
       * was synthesized from, sorted ascending. `[channel]` for the common single-
       * channel case; 2+ entries only when `mergeRelatedChannels` found real structural
       * evidence (a GA shared between comm objects on different channels of this SAME
       * device) that they form one functional circuit — e.g. a Main+Sheer curtain.
       * Never collapsed silently — see `CommunicationObject.channel` for which channel
       * each individual comm object came from. */
      channels: number[];
    } | null;
    /** § Control-Relationship Model (Pass 3) — every OTHER physical device whose own
     * comm object also references a GA this device uses (a keypad, a scene controller,
     * an automation trigger). Real relationship data, never fabricated — populated from
     * the SAME `links[]` this device's own capabilities/bindings were built from, just
     * filtered to entries whose `individualAddress` differs from this device's own.
     * These devices NEVER join `physicalDevice`/`channels` — participating in a shared
     * GA is evidence of a control relationship, not automatic logical-device membership
     * (§ SHARED GA PARTICIPATION ≠ AUTOMATIC LOGICAL DEVICE MEMBERSHIP). Empty when no
     * other device references any GA this device uses. */
    externalControls: { individualAddress: string; comObjectText: string; groupAddress: string }[];
    /** § Raw data preservation (fourth pass) — every accepted channel-merge decision
     * that produced this logical device, one entry per contributing signal, each
     * carrying its own evidence/confidence/reason (`evaluateChannelGroupingEvidence`).
     * Empty for a single-channel device (nothing to explain) — never fabricated. */
    groupingEvidence: ChannelGroupingEvidence[];
    /** § Naming Evidence (Pass 10) — why `suggestedName`/`metadata.deviceName` ended up
     * what it is, in confidence order, HIGH-first. Never influences capability/binding
     * classification (§9: naming must never influence command/feedback role resolution)
     * — this is purely descriptive/diagnostic. Always has at least one entry: even the
     * FALLBACK tier (bare physical identity, e.g. "1.1.49#1") is recorded rather than
     * silently applied. */
    namingEvidence: DeviceNameEvidence[];
  };
}

function titleCase(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** § Production KNX Driver 2.0 — Physical Device Identity: when EVERY ETS signal this
 * cycle carries a real individualAddress (a pure `.knxproj` device-tree import — not a
 * flat ESF/GA-only export), cluster ETS signals by PHYSICAL DEVICE + FUNCTIONAL CHANNEL
 * instead of circuit-name text. This is the anchor §7/§8/§25 require: "physical device
 * is the anchor," "multiple Group Objects on the same physical device/channel become ONE
 * logical device," "different channels on one physical device become separate logical
 * devices — a device with no channel token is one implicit channel, never split
 * further."
 *
 * § Cross-Source Identity (Production KNX Driver 2.0, second pass) — this now activates
 * for ETS signals REGARDLESS of whether KNX IoT signals are also present this cycle; the
 * previous pass's "any KNX IoT presence disables physical clustering for everything"
 * behavior is gone. KNX IoT signals cluster independently (see `mapUnifiedDevices`) and
 * merge into a matching physical cluster only via `resolveKnownLink`'s deterministic
 * identity evidence — never by falling back to weaker circuit-name matching just because
 * KNX IoT happened to also be discovered this cycle. Any signal missing
 * individualAddress at all (KNX-IoT-only discovery, or a flat export with no device
 * tree) still falls through to the existing, unchanged, already-tested circuit-name
 * clustering. Returns null (not an empty array) to signal "not eligible, use the
 * fallback," distinct from a legitimately empty cluster set.
 *
 * § Real-project validation (fifth pass) — clusters only the SUBSET of signals that
 * actually carry `individualAddress`; a real 1,718-signal project had 9 stray/orphan
 * signals with no device backlink at all (a scene GA, an unreferenced group address —
 * ETS is not always perfectly clean), and the previous "ANY signal missing
 * individualAddress disables physical clustering for the ENTIRE project" gate meant a
 * single such GA silently discarded physical-device identity for all 1,709 other,
 * correctly-identified signals — the opposite of this architecture's whole purpose.
 * Only returns null when NONE of the given signals have individualAddress at all (the
 * genuinely IoT-only/flat-export case this gate was designed for); the caller
 * (`mapUnifiedDevices`) is responsible for clustering the excluded orphan signals
 * through the existing name-based fallback, exactly as it already does for KNX IoT. */
function groupByPhysicalChannel(
  etsSignals: NonNullable<UnifiedDeviceMapperInput["ets"]>,
): DeviceCluster[] | null {
  const withAddress = etsSignals.filter((s) => s.individualAddress);
  if (withAddress.length === 0) return null;
  const byKey = new Map<string, GroupingSignal[]>();
  for (const s of withAddress) {
    const key = `${s.individualAddress}#${s.channel ?? 0}`;
    const list = byKey.get(key);
    if (list) list.push({ id: s.id, name: s.name });
    else byKey.set(key, [{ id: s.id, name: s.name }]);
  }
  return [...byKey.entries()].map(([key, signals]) => ({ key, signals }));
}

/** § Channel Synthesis (Pass 2/3) — "A CHANNEL IS NOT ALWAYS A DEVICE." Several channels
 * of ONE physical device sometimes form a single functional circuit (a Universal
 * Actuator's Channel 1 + Channel 2 driving one curtain's Main/Sheer motors) — merging
 * `groupByPhysicalChannel`'s one-cluster-per-channel output into ONE logical device for
 * those, while leaving genuinely independent channels (two unrelated curtains) as
 * separate devices.
 *
 * The evidence, never name similarity or channel adjacency: a Group Address that is
 * referenced by comm objects on TWO OR MORE DIFFERENT CHANNELS of the SAME physical
 * device (e.g. a "Main+Sheer" combined command GA that both the Main channel's and the
 * Sheer channel's own comm objects link to) is real, structural proof those channels
 * are wired together into one circuit. Union-find over cluster keys so evidence chains
 * transitively (three channels sharing a common combined GA merge into one group, not
 * three pairs).
 *
 * § SHARED GA PARTICIPATION ≠ AUTOMATIC LOGICAL DEVICE MEMBERSHIP (third pass) — a GA
 * can simultaneously be "these channels are one circuit" AND "an external keypad can
 * also trigger it." Those are different claims. Evidence is evaluated PER OWNING
 * DEVICE: does THIS device's own channels span 2+ of THIS device's channels via the
 * signal? If yes, that's merge evidence for THIS device, regardless of whether some
 * OTHER physical device (a keypad, a scene controller) ALSO references the same GA —
 * confirmed on a real project: a genuine "Curtain-1-Main+Sheer" combined command was
 * simultaneously wired to an external keypad device, and the previous pass's
 * "exclusively one device" requirement wrongly refused to merge the curtain's own two
 * channels just because that keypad also existed. The keypad reference is preserved
 * separately as an external control relationship (`externalControlsFor`, computed by
 * the caller from the SAME `links[]` data) — it never joins this device's physical
 * identity, and it never blocks the merge either.
 *
 * § Real-project validation finding — a cross-channel shared GA ALONE is not
 * sufficient evidence. Real ETS projects routinely carry convenience "operate these
 * channels together" macros on independent lighting circuits (confirmed on a real
 * 3-channel dimmer: an "Entry Right + Left" combined on/off GA touches exactly 2 of its
 * 3 genuinely-independent channels, structurally indistinguishable from a real
 * "Main+Sheer" curtain command using GA-relationship evidence alone — naively merging
 * on that evidence collapsed the already-validated 3-independent-device result from the
 * prior pass). Disclosed, deliberate scope narrowing, not silently dropped.
 *
 * § Capability-neutral grouping (fifth pass) — Pass 4 hardcoded a check for
 * `position`/`color`/`temperature` specifically. `evaluateChannelGroupingEvidence` now
 * asks the DPT's own STRUCTURAL category (`dptStructuralCategory`, `@supreme/
 * commissioning`'s single source of DPT truth) instead of a SupremeOS capability name —
 * still a curated list, but one level more general (industry-standard DPT categories,
 * not this codebase's own capability vocabulary), so a future capability this codebase
 * has no NAME for yet (a fan's speed split, say) still qualifies the moment its DPT is
 * one of these categories, with zero change to `capability-mapper.ts`.
 *
 * § A pure blacklist was tried and PROVEN UNSAFE by real-project validation — worth
 * recording here as a real, negative finding, not silently reverted. Excluding only the
 * two known convenience-macro categories (`binary_switch`, `scene_control`) and
 * accepting every other DPT category as evidence sounds maximally general, but real
 * ETS projects use MANY other generic/ambiguous categories (`percentage` for a
 * "brightness macro" GA touching several unrelated lighting channels; the `binary_generic`
 * fallback for countless miscellaneous relay toggles) just as liberally for the SAME
 * kind of convenience "operate together" relationship this architecture must reject.
 * Running the blacklist version against both real projects collapsed Nirma's validated
 * 3-independent-device dimmer down to 2, and Juhu's DALI gateway down to 5 channels
 * from 32 — a severe regression, caught by re-running the real fixtures, never shipped.
 * The allowlist below is therefore still curated, but expressed at the DPT-structural
 * level (movement, color, colour-temperature) rather than the SupremeOS-capability
 * level — the smallest change that stayed safe against both real projects. */
export interface ChannelGroupingEvidence {
  canMerge: boolean;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  reason: string;
}

/** DPT structural categories confirmed, across two real ETS projects, to represent a
 * genuine coordinated multi-object actuator sub-function (movement, RGB, tunable
 * white) — never a plain on/off, brightness, or scene convenience macro. Extending this
 * set is the ONE place a new coordinated-relationship DPT category needs registering;
 * no other file changes. */
const COORDINATING_DPT_CATEGORIES: ReadonlySet<string> = new Set([
  "binary_updown",
  "binary_openclose",
  "step_blind",
  "color_rgb",
  "color_rgbw",
  "color_temperature_kelvin",
]);

/** § Real-project validation (Showroom DALI gateway) — a genuinely coordinated multi-
 * object sub-function spans a SMALL, bounded set of channels: a Main+Sheer curtain pair
 * (2), an RGB/RGBW color group (3-4). A real ETS DALI/multi-circuit gateway also wires
 * many otherwise-independent lighting circuits to a handful of shared/common or broadcast
 * Group Addresses (e.g. a "common color" or "common relative dim" object every circuit's
 * module listens to) — those legitimately carry a COORDINATING_DPT_CATEGORIES DPT (color,
 * movement) too, but span the entire gateway's circuit count (confirmed on a real project:
 * one such shared GA spanned 14 channels of one physical DALI gateway device), not a
 * bounded functional group. Confirmed against every real fixture this architecture is
 * validated against (Nirma, Juhu, the curtain/RGB/RGBW unit tests below) that no genuine
 * coordinated relationship ever spans more than 4 channels — RGBW is the widest real case. */
const MAX_COORDINATING_CHANNEL_SPAN = 4;

/** § Confidence tiers (fifth pass, real three-tier model):
 *   - LOW: fewer than 2 channels span this GA, or the combining signal's DPT is not one
 *     of `COORDINATING_DPT_CATEGORIES` — a plain "operate these together" toggle,
 *     brightness macro, or scene trigger is NOT proof of a coordinated circuit
 *     (§ real-project false positives on both Nirma and Juhu). Never auto-merges.
 *   - MEDIUM: exactly ONE qualifying combining signal corroborates the channel span —
 *     real evidence, but only one independent source of it.
 *   - HIGH: TWO OR MORE independent qualifying signals corroborate the SAME channel
 *     span (e.g. a real project's combined "Up/Down" command AND its combined "Stop"
 *     command both wire the same two channels together) — multiple independent ETS
 *     relationships agreeing is the strongest evidence this architecture has access to.
 * MEDIUM and HIGH both auto-merge; only LOW is rejected. The HIGH upgrade is applied
 * once all evidence for a final group is known (see `mergeRelatedChannels` below) —
 * this function only ever returns "medium" for a single accepted signal, since it has
 * no visibility into corroborating signals evaluated elsewhere. */

/** Evaluates whether ONE combining signal, spanning `channels` (2+) of physical device
 * `address`, is real evidence those channels form one logical circuit. Never merges on
 * a shared GA alone (§ "shared GA participation ≠ automatic logical device
 * membership") — requires the signal's own DPT to NOT be a known convenience-macro
 * category. Exported for direct unit testing (§ "test new evidence engine"). */
export function evaluateChannelGroupingEvidence(
  signal: { dpt?: string | null; name: string; middleGroup?: string | null },
  address: string,
  channels: Set<number>,
  /** § GroupRange-scoped identity (real-project validation, Showroom DALI gateway —
   * Passage DL/Cove, Living DL/Projector Cove/Stretch Ceiling, Sample Led Strip/Track
   * Lights) — one entry per channel in `channels`, ONLY when every touched channel
   * already has its OWN independently-established "home" GroupRange (the middleGroup
   * shared by GAs that exclusively belong to that one channel — see
   * `mergeRelatedChannels`'s `channelHomeGroup`). Undefined/partial when that isn't
   * known for every channel — the caller never guesses. */
  channelHomeGroups?: readonly (string | undefined)[],
): ChannelGroupingEvidence {
  const evidence: string[] = [];
  if (channels.size < 2) {
    return { canMerge: false, confidence: "low", evidence, reason: "signal does not span 2+ channels of this physical device" };
  }
  const sortedChannels = [...channels].sort((a, b) => a - b);
  evidence.push(`shared Group Address referenced by communication objects on channels ${sortedChannels.join(", ")} of physical device ${address}`);

  // § GroupRange-scoped identity (real-project validation) — a channel's own local,
  // exclusive GAs are authoritative for its identity. Real confirmed evidence: Passage
  // Cove/Living Projector Cove/Living Stretch Ceiling/Sample Track Lights each already
  // have their OWN complete SW/Dimm/Abs Dim/Abs Col set under their OWN GroupRange
  // ("Passage Cove", "Living Projector Cove", …) — distinct from the sibling range they
  // were wrongly merging into ("Passage DL", "Living DL", …). The DALI gateway's "Abs
  // Col"/"Abs Col FB" feedback objects are ALSO wired to a small (2-3 channel) shared GA
  // living in a THIRD, room-level "common" GroupRange ("Entry & Passage Lights", "Living
  // Lights") that belongs to none of the sibling circuits — structurally identical to a
  // genuine RGBW color-temperature coordination (same DPT category, span within
  // `MAX_COORDINATING_CHANNEL_SPAN`) but for a totally different reason: it's a
  // convenience broadcast object, not one physical fixture's own sub-function. A GA whose
  // own GroupRange is NOT any touched channel's home range — while EVERY touched channel
  // already has its own DISTINCT home range — is exactly that signature: it must never
  // merge two clusters that already have independent, complete local identity. (A genuine
  // multi-channel single-fixture coordination, e.g. Main+Sheer curtain or a real RGBW
  // fixture, has both channels sharing the SAME home range — `distinctHomeGroups.size ===
  // 1` — so this check never fires for it.) Checked BEFORE span/DPT below: this is
  // stronger, more specific evidence than either.
  if (channelHomeGroups && channelHomeGroups.length === channels.size) {
    const definiteHomeGroups = channelHomeGroups.filter((g): g is string => !!g);
    if (definiteHomeGroups.length === channels.size) {
      const distinctHomeGroups = new Set(definiteHomeGroups);
      const signalGroup = signal.middleGroup?.trim();
      if (distinctHomeGroups.size > 1 && signalGroup && !distinctHomeGroups.has(signalGroup)) {
        return {
          canMerge: false,
          confidence: "low",
          evidence,
          reason: `each touched channel already has its own distinct, independently-established GroupRange (${[...distinctHomeGroups].sort().join(", ")}), and this combining signal's own GroupRange ("${signalGroup}") is a different, shared/common range that belongs to none of them — the signature of a room-level or gateway-wide broadcast/feedback object reused across sibling circuits, not a genuine single-fixture coordinated sub-function`,
        };
      }
    }
  }

  if (channels.size > MAX_COORDINATING_CHANNEL_SPAN) {
    return {
      canMerge: false,
      confidence: "low",
      evidence,
      reason: `signal spans ${channels.size} channels — wider than any genuine coordinated sub-function (Main+Sheer, RGB/RGBW) ever legitimately does; this is the signature of a shared/common or broadcast Group Address on a multi-circuit device (e.g. a DALI gateway's common color/dim object), not real evidence those channels form one circuit`,
    };
  }

  const category = dptStructuralCategory(signal.dpt);
  if (!COORDINATING_DPT_CATEGORIES.has(category)) {
    return {
      canMerge: false,
      confidence: "low",
      evidence,
      reason: `combining signal's DPT structurally classifies as "${category}" — not a confirmed coordinated-relationship category (movement/color/colour-temperature); real ETS projects use generic on/off, brightness, and scene DPTs liberally for mere convenience "operate together" macros (§ real-project false positives on both Nirma and Juhu), so same-device GA sharing alone is not sufficient evidence`,
    };
  }
  evidence.push(`combining signal's DPT (structural category "${category}") is a confirmed coordinated actuator sub-function`);
  return {
    canMerge: true,
    confidence: "medium",
    evidence,
    reason: `same physical device + shared Group Address spanning ${sortedChannels.length} channels + a coordinated-relationship DPT category ("${category}")`,
  };
}

function mergeRelatedChannels(
  clusters: DeviceCluster[],
  etsSignals: NonNullable<UnifiedDeviceMapperInput["ets"]>,
): (DeviceCluster & { groupingEvidence?: ChannelGroupingEvidence[] })[] {
  const parent = new Map<string, string>();
  for (const c of clusters) parent.set(c.key, c.key);
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = k;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  // § Raw data preservation (fourth pass) — every accepted merge's evidence, tagged by
  // the two channel keys it joined, so it can be attached to whichever final group both
  // channels end up in (never fabricated after the fact — this IS the evidence that
  // caused the merge).
  const acceptedEvidence: { channelKeys: string[]; evidence: ChannelGroupingEvidence }[] = [];

  // § GroupRange-scoped identity (real-project validation) — each physical channel's own
  // "home" GroupRange, established ONLY from signals that EXCLUSIVELY touch one channel
  // of one device (never a signal already shared across channels — that would beg the
  // question). Majority middleGroup wins when a channel's own local signals disagree
  // (rare; mirrors the same majority-tally pattern `deriveDeviceNameEvidence` already uses
  // for `middleGroup`). Feeds `evaluateChannelGroupingEvidence`'s GroupRange check below —
  // see that function's doc comment for the real-project evidence this exists to catch
  // (Passage DL/Cove, Living DL/Projector Cove/Stretch Ceiling, Sample Led Strip/Track
  // Lights all wrongly merging via a shared "Abs Col FB" object living in a third,
  // room-level GroupRange neither sibling circuit owns).
  const channelHomeGroup = new Map<string, string>();
  {
    const tally = new Map<string, Map<string, number>>();
    for (const s of etsSignals) {
      const mg = s.middleGroup?.trim();
      if (!mg || !s.links) continue;
      const byDevice = new Map<string, Set<number>>();
      for (const l of s.links) {
        if (!l.individualAddress || l.channel === null || l.channel === undefined) continue;
        const set = byDevice.get(l.individualAddress);
        if (set) set.add(l.channel);
        else byDevice.set(l.individualAddress, new Set([l.channel]));
      }
      for (const [address, channels] of byDevice) {
        if (channels.size !== 1) continue; // only an exclusive, single-channel signal establishes a "home"
        const channelKey = `${address}#${[...channels][0]}`;
        const counts = tally.get(channelKey) ?? new Map<string, number>();
        counts.set(mg, (counts.get(mg) ?? 0) + 1);
        tally.set(channelKey, counts);
      }
    }
    for (const [channelKey, counts] of tally) {
      const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      if (top) channelHomeGroup.set(channelKey, top[0]);
    }
  }

  for (const s of etsSignals) {
    const links = s.links;
    if (!links || links.length < 2) continue;
    // § SHARED GA PARTICIPATION ≠ AUTOMATIC LOGICAL DEVICE MEMBERSHIP (third pass) —
    // evaluate evidence PER OWNING DEVICE, not globally-exclusive. Some OTHER physical
    // device (a keypad) referencing this same GA is an external control relationship
    // (handled by the caller), never grounds to refuse merging THIS device's own
    // channels.
    const channelsByDevice = new Map<string, Set<number>>();
    for (const l of links) {
      if (!l.individualAddress || l.channel === null || l.channel === undefined) continue;
      const set = channelsByDevice.get(l.individualAddress);
      if (set) set.add(l.channel);
      else channelsByDevice.set(l.individualAddress, new Set([l.channel]));
    }
    for (const [address, channels] of channelsByDevice) {
      const homeGroups = [...channels].map((c) => channelHomeGroup.get(`${address}#${c}`));
      const result = evaluateChannelGroupingEvidence(s, address, channels, homeGroups);
      if (!result.canMerge) continue;
      const channelKeys = [...channels].map((c) => `${address}#${c}`).filter((k) => parent.has(k));
      // § Bug found via real-project validation — fewer than 2 SURVIVING channel keys
      // (e.g. this device's channels never became distinct clusters to begin with)
      // means no actual union happens here. Recording it anyway produced an empty
      // `channelKeys` array whose `.every(...)` is vacuously true for ANY group later,
      // spuriously attaching one device's evidence to a totally unrelated device's
      // report (confirmed on real data: a keypad's own coincidental 2-channel "Stop"
      // wiring leaked into an unrelated curtain's Grouping Evidence). Only record
      // evidence that actually performed a union.
      if (channelKeys.length < 2) continue;
      acceptedEvidence.push({ channelKeys, evidence: result });
      for (let i = 1; i < channelKeys.length; i++) union(channelKeys[0]!, channelKeys[i]!);
    }
  }

  const groups = new Map<string, { signals: GroupingSignal[]; channels: Set<number>; address: string; keys: Set<string> }>();
  for (const c of clusters) {
    const root = find(c.key);
    const [address, chStr] = c.key.split("#");
    const ch = Number(chStr);
    const existing = groups.get(root);
    if (existing) {
      existing.signals.push(...c.signals);
      existing.channels.add(ch);
      existing.keys.add(c.key);
    } else {
      groups.set(root, { signals: [...c.signals], channels: new Set([ch]), address: address!, keys: new Set([c.key]) });
    }
  }

  return [...groups.values()].flatMap((g) => {
    // § Real-project validation (Showroom DALI gateway/universal actuator) — pairwise
    // evidence is checked per-signal in `evaluateChannelGroupingEvidence` (never merges a
    // single signal spanning >4 channels), but a CHAIN of otherwise-valid small merges
    // (GA-A links channels 1+2, GA-B links 2+3, GA-C links 3+4, …) can still transitively
    // union many genuinely-independent channels of one large multi-function physical
    // device (a room controller wired to a curtain, a screen, a door lock, and several
    // lighting circuits) into one giant final group — confirmed on a real project, where
    // several shared/broadcast "All Lights"/generic command GAs chained an unrelated
    // curtain, screen, lock, and lighting circuits onto one device via a sequence of
    // individually-plausible pairwise unions. No genuine coordinated circuit (Main+Sheer,
    // RGB/RGBW) ever spans more than `MAX_COORDINATING_CHANNEL_SPAN` channels even after
    // full transitive closure — a final group wider than that is chaining, not one real
    // circuit, so it's undone here: each original channel cluster stands on its own again,
    // with no fabricated grouping evidence attached.
    if (g.channels.size > MAX_COORDINATING_CHANNEL_SPAN) {
      return clusters.filter((c) => g.keys.has(c.key));
    }
    const sortedChannels = [...g.channels].sort((a, b) => a - b);
    const key = sortedChannels.length > 1 ? `${g.address}#${sortedChannels.join("+")}` : `${g.address}#${sortedChannels[0]}`;
    const contributing = acceptedEvidence.filter((e) => e.channelKeys.every((k) => g.keys.has(k)));
    // § Confidence tiers — 2+ INDEPENDENT corroborating signals for the same final
    // group upgrade every entry from "medium" to "high" (§ real project: a curtain's
    // combined Up/Down AND combined Stop commands both wiring the same two channels).
    const groupingEvidence = contributing.map((e) =>
      contributing.length >= 2 ? { ...e.evidence, confidence: "high" as const } : e.evidence,
    );
    return [{ key, signals: g.signals, ...(groupingEvidence.length > 0 ? { groupingEvidence } : {}) }];
  });
}

/** § Cross-Source Identity (Production KNX Driver 2.0) — decides whether a
 * circuit-name-clustered group of KNX IoT signals is the SAME physical device as one of
 * the ETS physical-channel clusters, using ONLY deterministic evidence, per this
 * feature's own identity confidence hierarchy:
 *   1. An explicit, installer/config-confirmed link (`knownDeviceLinks`) — always tried
 *      first; a human has directly confirmed this correlation.
 *   2. The KNX IoT signal's own reported `individualAddress`, when present (not
 *      populated by the current provider — see `KnxIotDiscoverySignal`'s doc comment —
 *      but honored automatically the moment it is). Matched against a specific channel
 *      when the IoT signal carries one, or — when it doesn't — only when the physical
 *      device has exactly ONE channel cluster this cycle (an unambiguous single-channel
 *      device); a multi-channel device with no channel information from the IoT side is
 *      left unmatched rather than guessing which channel it belongs to.
 * Room/name/semantic similarity is DELIBERATELY not consulted here — matching on that
 * alone is exactly what this feature exists to stop doing for physical-identity
 * decisions (§ "never merge devices merely because their names are similar"). Returns
 * the matching ETS cluster's key, or null if no tier resolves a match — an unmatched IoT
 * cluster stands as its own, separate device. */
function resolveKnownLink(
  iotCluster: DeviceCluster,
  iotByHost: Map<string, KnxIotDiscoverySignal>,
  etsClusters: DeviceCluster[],
  knownDeviceLinks: NonNullable<UnifiedDeviceMapperInput["knownDeviceLinks"]>,
): string | null {
  for (const sig of iotCluster.signals) {
    const host = sig.id.replace(/^knx-iot:/, "");
    const iotSignal = iotByHost.get(host);
    if (!iotSignal) continue;

    // Tier 1: explicit installer-confirmed link.
    for (const link of knownDeviceLinks) {
      if (link.knxIotHost !== host) continue;
      const targetKey = `${link.individualAddress}#${link.channel ?? 0}`;
      if (etsClusters.some((c) => c.key === targetKey)) return targetKey;
    }

    // Tier 2: the IoT signal's own reported individual address.
    if (iotSignal.individualAddress) {
      const sameDevice = etsClusters.filter((c) => c.key.startsWith(`${iotSignal.individualAddress}#`));
      if (sameDevice.length === 1) return sameDevice[0]!.key; // unambiguous — single channel (or single matching cluster)
    }
  }
  return null;
}

/** § Shared GA runtime propagation (Production KNX Driver 2.0, fourth pass; made
 * relationship-specific in the fifth) — a shared Group Address referenced by several
 * physical devices (e.g. a central "All Lights OFF") is attributed by
 * `groupByPhysicalChannel` to only ONE owning cluster (the deterministic `owningLink`
 * chosen by `knxSignalsFromModel`). That's correct for identity (a GA is not a device,
 * and the signal still needs exactly one canonical name/room), but wrong for binding:
 * every OTHER physical device the GA's `links[]` names should get that same
 * communication object in ITS OWN cluster too, so its binding plan picks it up via the
 * existing `roleOfEtsSignal`/`planBindings` machinery — no new event system, just
 * discovery-time cluster membership.
 *
 * Fans out to every distinct `individualAddress` the signal's `links[]` names — SEND
 * relationships included, not just receive-only ones. This is safe (unlike the
 * fourth-pass version of this function, which deliberately excluded any signal with a
 * send link anywhere) because `roleOfEtsSignal` is now relationship-specific: called
 * with `forIndividualAddress` scoped to the cluster it's being tagged for, it resolves
 * "primary" only for the device whose OWN link says "send", and "status" for every
 * device whose own link only says "receive" — a mixed central-command GA (Device A
 * sends, B/C/D receive) is never mistagged writable for B/C/D just because A's send
 * relationship exists somewhere in the same links array. */
function attachSharedGaSignals(
  clusters: DeviceCluster[],
  etsSignals: NonNullable<UnifiedDeviceMapperInput["ets"]>,
): void {
  const byAddressPrefix = new Map<string, DeviceCluster[]>();
  for (const c of clusters) {
    const prefix = c.key.split("#")[0]!;
    const list = byAddressPrefix.get(prefix);
    if (list) list.push(c);
    else byAddressPrefix.set(prefix, [c]);
  }

  for (const s of etsSignals) {
    const links = s.links;
    if (!links || links.length === 0) continue;

    const distinctAddresses = new Set(links.map((l) => l.individualAddress).filter((a): a is string => !!a));
    if (distinctAddresses.size < 2) continue;

    for (const address of distinctAddresses) {
      // § Real-project validation (Showroom DALI gateway/universal actuator) — a big
      // multi-function physical device (a "logic"/room controller with several
      // genuinely independent circuits, each its own module/channel) has MULTIPLE
      // clusters sharing this same address prefix. Fanning a shared GA into EVERY one
      // of them — the previous behavior — polluted every unrelated circuit of that
      // device with every other circuit's shared/central signals (confirmed on a real
      // project: a curtain, a projector screen, a door lock, and several lighting
      // circuits on one physical device all absorbed each other's "Entry Door Light"/
      // "All Lights"/etc. central signals just for sharing a physical address). Only
      // fan into the cluster(s) whose OWN channel matches what THIS address's link(s)
      // actually report — real per-relationship channel evidence, already captured by
      // `KnxGroupAddressLink.channel`. Falls back to the old broad by-address fan-out
      // only when this address's own link carries no channel information at all (a
      // flat export with no module/channel data — nothing more specific to match on,
      // same behavior as before this fix for that case).
      const channelsForAddress = new Set(
        links.filter((l) => l.individualAddress === address).map((l) => l.channel).filter((c): c is number => c !== null && c !== undefined),
      );
      for (const cluster of byAddressPrefix.get(address) ?? []) {
        if (channelsForAddress.size > 0) {
          const clusterChannels = cluster.key.split("#")[1]?.split("+").map(Number) ?? [];
          if (!clusterChannels.some((ch) => channelsForAddress.has(ch))) continue;
        }
        if (!cluster.signals.some((sig) => sig.id === s.id)) {
          cluster.signals.push({ id: s.id, name: s.name });
        }
      }
    }
  }
}

function inferredMetadata(deviceKind: KnxDeviceKind, groupingKey: string): Partial<SemanticMetadata> {
  if (deviceKind === "unknown") return {};
  const label = titleCase(deviceKind.replace(/_/g, " "));
  return { deviceName: `${titleCase(groupingKey)} (${label})` };
}

/** § Naming Evidence (Pass 10). One naming candidate, ordered by confidence — see
 * {@link deriveDeviceNameEvidence}'s doc comment for the full hierarchy. */
export interface DeviceNameEvidence {
  source: "circuit_name" | "middle_group" | "ga_name" | "physical_identity";
  value: string;
  confidence: "high" | "medium" | "low" | "fallback";
  reason: string;
}

/** § Naming Evidence (Pass 10, extends the existing `groupByCircuitName` engine rather
 * than building a second naming layer — per this pass's own mandate). Only relevant when
 * `groupByPhysicalChannel` clustered this device (`cluster.key` is `address#channel`,
 * carrying zero human meaning) — the circuit-name clustering path already produces a
 * meaningful `cluster.key` and is left untouched (see `semanticMetadataFromEts`'s own
 * comment on why ETS circuit-name tiers exist at all).
 *
 * Confidence hierarchy, derived from what the two real ETS projects this architecture was
 * validated against actually provide (§ no invented tier a real project never exercises):
 *   - HIGH: `groupByCircuitName` — the SAME engine every fallback/no-physical-identity
 *     path already uses — run over this cluster's own raw ETS signal names strips a real
 *     trailing operation word (SW/DIM/ABS/ABS FB/STOP/UP-DOWN/…) and leaves a non-empty,
 *     non-degenerate circuit identity shared by 2+ signals. Two+ signals converging on
 *     the same stripped identity is real corroborating evidence, not one bare GA name.
 *   - MEDIUM: only ONE signal contributed (nothing to corroborate against), but its name
 *     still stripped a real operation word, OR the GA's own Main/Middle Group hierarchy
 *     (`mainGroup`/`middleGroup`, passed through from `@supreme/commissioning`'s
 *     `KnxGroupAddressRecord`) names a real circuit and functional evidence (a resolved,
 *     non-"unknown" `deviceKind`) already backs it.
 *   - LOW: nothing stripped at all — the raw GA name IS the circuit identity (no operation
 *     suffix present), used as-is.
 *   - FALLBACK: no ETS signal names existed at all (only a bare physical-identity key) —
 *     the address#channel string itself, exactly the `1.1.49#1`-style name this pass
 *     exists to reduce, but never hidden — recorded so a human reviewer can see exactly
 *     why. */
export function deriveDeviceNameEvidence(
  etsSignals: { name: string; middleGroup?: string | null; mainGroup?: string | null }[],
  physicalKey: string,
  deviceKind: KnxDeviceKind,
): DeviceNameEvidence[] {
  if (etsSignals.length === 0) {
    return [{ source: "physical_identity", value: physicalKey, confidence: "fallback", reason: "no ETS signal names available — only bare physical identity (individual address + channel)" }];
  }

  // § Real-project validation (Showroom DALI gateway) — must strip the SAME KNX operation
  // words `nameCluster` already does ("abs"/"dimm"/"rel"/"relative"/"col"/…). Omitting
  // `extraOperationWords` here let "Abs Dim"/"Abs Col"/"Relative Color" survive stripping
  // as if "Abs"/"Relative" were real circuit identity, when they're just KNX-standard
  // operation-word fragments — the generic domain-model stop-word list has no KNX
  // vocabulary of its own to catch them.
  const stripped = groupByCircuitName(etsSignals.map((s, i) => ({ id: String(i), name: s.name })), { extraOperationWords: KNX_EXTRA_OPERATION_WORDS });
  // § Naming Determinism (Pass 10.2). Equal-`signals.length` candidates used to fall through
  // to Array.prototype.sort's stability guarantee, silently picking whichever candidate
  // happened to appear first in the (uncanonicalized) input ETS signal order. Add an
  // explicit, order-independent tie-break — the normalized circuit key itself — so the
  // winner never depends on input array order. Only ties are affected; a genuine
  // evidence-count difference still wins exactly as before.
  const best = [...stripped].sort((a, b) => b.signals.length - a.signals.length || a.key.localeCompare(b.key))[0]!;
  const strippedSomething = best.key.length > 0 && best.signals.some((s) => s.name.toLowerCase().trim() !== best.key);
  // § Real-project validation (Showroom DALI gateway) — `groupByCircuitName` always keeps
  // AT LEAST one token so a bare "Switch" doesn't collapse to an empty key (see its own
  // doc comment) — but when a signal's name is composed ENTIRELY of operation/modifier
  // words ("Abs Dim", "Abs Col FB"), that one surviving token ("abs") is itself just
  // another operation-word fragment, not real circuit identity — confirmed on a real
  // project where every one of a circuit's own ETS signal names is a pure operation-word
  // combination (SW / Dimm / Abs Dim / Abs Col FB / Relative Color, …), so this tier
  // would otherwise "successfully" converge 30+ signals on the meaningless stem "Abs".
  // Never trusted as HIGH/MEDIUM evidence in that case — falls through to the
  // structurally stronger `middle_group` tier below instead.
  const knownOperationWords = new Set([...DEFAULT_OPERATION_WORDS, ...KNX_EXTRA_OPERATION_WORDS].map((w) => w.toLowerCase()));
  const survivorIsOperationWordOnly = best.key.split(/\s+/).every((t) => knownOperationWords.has(t));

  const evidence: DeviceNameEvidence[] = [];
  if (strippedSomething && !survivorIsOperationWordOnly && best.signals.length >= 2) {
    evidence.push({
      source: "circuit_name",
      value: titleCase(best.key),
      confidence: "high",
      reason: `${best.signals.length} ETS signal names converge on the same circuit identity after stripping their trailing operation word(s)`,
    });
  } else if (strippedSomething && !survivorIsOperationWordOnly) {
    evidence.push({
      source: "circuit_name",
      value: titleCase(best.key),
      confidence: "medium",
      reason: "a single ETS signal name stripped a real trailing operation word, leaving a non-trivial circuit identity",
    });
  }

  // § Determinism (Pass 10.3) — several genuinely different LOCAL signals of the same
  // physical device can legitimately share no channel token at all (e.g. two unrelated
  // channel-less GAs — a scene trigger, a plain downlight — both fall into
  // `groupByPhysicalChannel`'s "no channel token is one implicit channel" bucket), each
  // carrying its OWN Middle Group. A plain `.find()` for "the" Middle Group picked
  // whichever signal happened to be first in the caller's raw ETS array — confirmed via
  // real-project (Juhu) validation to flip the resolved name between "Scene" and
  // "Lightings" purely from input signal order. Tally every real Middle Group value
  // instead and pick the one MOST signals agree on (real corroborating evidence, same
  // spirit as the `circuit_name` tier above); ties broken alphabetically (§ Pass 10.2's
  // own precedent for an order-independent tie-break) — never by array position.
  const middleGroupTally = new Map<string, number>();
  for (const s of etsSignals) {
    const mg = s.middleGroup?.trim();
    if (mg) middleGroupTally.set(mg, (middleGroupTally.get(mg) ?? 0) + 1);
  }
  const middleGroup = middleGroupTally.size > 0
    ? [...middleGroupTally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0]
    : null;
  if (middleGroup && deviceKind !== "unknown") {
    evidence.push({
      source: "middle_group",
      value: titleCase(middleGroup),
      confidence: evidence.length > 0 ? "low" : "medium",
      reason: `ETS Middle Group "${middleGroup}" combined with a resolved device kind ("${deviceKind}")`,
    });
  }

  if (evidence.length === 0) {
    evidence.push({
      source: "ga_name",
      value: titleCase(best.key || etsSignals[0]!.name),
      confidence: "low",
      reason: "raw group-address name used as-is — no operation suffix to strip, no Middle Group hierarchy available",
    });
  }

  evidence.push({ source: "physical_identity", value: physicalKey, confidence: "fallback", reason: "bare physical identity (individual address + channel) — always recorded as the ultimate fallback" });
  return evidence;
}

/** Runs the full Unified Device Pipeline over whatever signals are available this cycle
 * — KNX IoT alone, ETS alone, or both together — and returns one canonical device per
 * cluster. When real ETS physical-device data is available, ETS clusters by physical
 * device + functional channel and KNX IoT signals merge in only where deterministic
 * cross-source identity evidence says so (`resolveKnownLink`) — never by name
 * similarity. Otherwise (no ETS device tree at all this cycle) falls back to the
 * original combined circuit-name clustering, where KNX IoT and ETS signals sharing a
 * circuit name merge into one cluster, exactly as before this feature existed. */
export function mapUnifiedDevices(input: UnifiedDeviceMapperInput): UnifiedKnxDevice[] {
  const signals: GroupingSignal[] = [
    ...(input.knxIot ?? []).map((d) => ({ id: `knx-iot:${d.host}`, name: d.linkFormat.match(/title="([^"]*)"/)?.[1] ?? d.host })),
    ...(input.ets ?? []).map((s) => ({ id: s.id, name: s.name })),
  ];
  if (signals.length === 0) return [];

  const etsSignalsAll = input.ets ?? [];
  const iotSignalsAll = input.knxIot ?? [];
  const iotAsGroupingSignals: GroupingSignal[] = iotSignalsAll.map((d) => ({ id: `knx-iot:${d.host}`, name: d.linkFormat.match(/title="([^"]*)"/)?.[1] ?? d.host }));
  const nameCluster = (sigs: GroupingSignal[]) => input.schemaId
    ? groupWithSchema(sigs, input.schemaId, {
        ...input.schemaOptions,
        stopWords: [...(input.schemaOptions?.stopWords ?? []), ...KNX_EXTRA_OPERATION_WORDS],
      })
    : groupByCircuitName(sigs, { extraOperationWords: KNX_EXTRA_OPERATION_WORDS });

  // § Production KNX Driver 2.0 — physical device + channel is the preferred clustering
  // key for ETS whenever it's available and unambiguous (see groupByPhysicalChannel's own
  // doc comment) — regardless of whether KNX IoT signals are ALSO present this cycle.
  const physicalChannelClusters = groupByPhysicalChannel(etsSignalsAll);
  // § Channel Synthesis (Pass 2) — merge channels of the SAME physical device that real
  // ETS relationship evidence proves are one functional circuit, before any downstream
  // KNX IoT merge / shared-GA fan-out / capability classification runs (§14's required
  // ordering: identify channels → identify relationships → group into logical devices →
  // THEN capabilities/binding).
  const physicalEtsClusters = physicalChannelClusters ? mergeRelatedChannels(physicalChannelClusters, etsSignalsAll) : null;

  let clusters: (DeviceCluster & { room?: string | null; circuitType?: string | null; operationType?: string | null })[];
  // § Naming Evidence — shared-GA immunity (Pass 10.1). Populated only on the
  // physical-channel-clustering path (the only path `attachSharedGaSignals` runs on);
  // stays undefined on the circuit-name-fallback path, where `namingEvidence` is empty
  // anyway (see below) so no local/fanned-in distinction is ever needed there.
  let localSignalIdsByClusterKey: Map<string, Set<string>> | undefined;
  if (physicalEtsClusters) {
    // § Cross-Source Identity — KNX IoT signals cluster independently (by name — the
    // only grouping evidence available for that source), then merge into a matching
    // physical ETS cluster ONLY where resolveKnownLink's deterministic evidence says so.
    // An IoT cluster with no such evidence stands as its own separate device — never
    // merged on name/room similarity alone.
    const iotClusters = iotSignalsAll.length > 0 ? nameCluster(iotAsGroupingSignals) : [];
    const iotByHostForMerge = new Map(iotSignalsAll.map((d) => [d.host, d]));
    const byKey = new Map(physicalEtsClusters.map((c) => [c.key, c]));
    const unmatchedIot: DeviceCluster[] = [];
    for (const iotCluster of iotClusters) {
      const matchKey = resolveKnownLink(iotCluster, iotByHostForMerge, physicalEtsClusters, input.knownDeviceLinks ?? []);
      if (matchKey !== null) {
        const target = byKey.get(matchKey)!;
        byKey.set(matchKey, { ...target, signals: [...target.signals, ...iotCluster.signals] });
      } else {
        unmatchedIot.push(iotCluster);
      }
    }
    clusters = [...byKey.values(), ...unmatchedIot];
    // § Real-project validation (fifth pass) — signals `groupByPhysicalChannel` excluded
    // for lacking `individualAddress` (stray/orphan GAs — e.g. an unreferenced scene
    // address) never disappear; they cluster via the same name-based fallback used when
    // no physical identity exists at all, exactly like an unmatched KNX IoT cluster.
    const orphanEtsSignals = etsSignalsAll.filter((s) => !s.individualAddress);
    if (orphanEtsSignals.length > 0) {
      clusters = [...clusters, ...nameCluster(orphanEtsSignals.map((s) => ({ id: s.id, name: s.name })))];
    }
    // § Naming Evidence — shared-GA immunity (Pass 10.1). Snapshot each cluster's own,
    // pre-fan-out signal ids BEFORE `attachSharedGaSignals` mutates `cluster.signals` by
    // pushing in copies of every shared/central GA this cluster also receives. Mirrors
    // the SAME local-vs-fanned-in distinction `channelsFromKey` already relies on
    // (derived from `cluster.key`, never from post-fan-out `cluster.signals`) — applied
    // here to naming instead of channel identity. Without this, `deriveDeviceNameEvidence`
    // ran on the contaminated post-fan-out signal set: multiple identical fanned-in copies
    // of a shared GA's name (e.g. "All On/Off") out-voted a device's own distinctly-worded
    // local circuit signal in `groupByCircuitName`'s largest-converging-group pick.
    localSignalIdsByClusterKey = new Map(clusters.map((c) => [c.key, new Set(c.signals.map((s) => s.id))]));
    // § Shared GA runtime propagation — a pure receive-only shared GA currently only
    // lives in its one deterministic owning cluster; fan it out to every other
    // physical device that also receives it, so ALL their binding plans pick up the
    // feedback address, not just the owner's.
    attachSharedGaSignals(clusters, etsSignalsAll);
  } else {
    // No physical ETS identity available at all this cycle (KNX-IoT-only discovery, or a
    // flat ESF/GA export with no device tree) — the original, unchanged combined
    // circuit-name clustering across every signal, exactly as before this feature
    // existed.
    clusters = nameCluster(signals);
  }

  const iotByHost = new Map((input.knxIot ?? []).map((d) => [`knx-iot:${d.host}`, d]));
  const etsById = new Map((input.ets ?? []).map((s) => [s.id, s]));

  const devices: UnifiedKnxDevice[] = clusters.map((cluster) => {
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
    // § Priority order: DPT, then name (production KNX import requirement) — classified
    // per COMMUNICATION OBJECT, not once for the whole blended circuit, so a Tunable
    // White circuit's absolute/relative/feedback color-temperature objects each
    // correctly contribute `color` regardless of what its switch/dimming objects
    // contribute. Functional blocks (richer KNX IoT signal) still take priority when
    // present; a functional-block-free KNX IoT cluster (no ETS signals at all) keeps the
    // original whole-cluster keyword classification unchanged.
    const hints = functionalBlocks.length > 0
      ? functionalBlocks.map(classifyFunctionalBlock)
      : etsSignals.length > 0
        ? etsSignals.map((s) => classifyEtsSignal(s.dpt ?? null, cluster.key, s.name))
        : [classifyFromText(cluster.key, ...rawNames)];
    // § DPT 5.001 Semantic Resolution — real ETS Communication-Object context (eighth
    // pass), properly isolated. `classifyEtsSignal` above deliberately still sees only
    // its original, narrow text pool (circuit key + GA name) — an attempt to thread
    // `comObjectText`/`model` through that SAME shared pool was tried and reverted (see
    // `classifyEtsSignal`'s own doc comment): it also feeds the step_dimming color-step
    // check and the generic `classifyFromText` fallback, so enriching it changed
    // classification for many UNRELATED signals project-wide (confirmed: real-project
    // capability counts shifted far beyond the intended 5.001-only scope). This loop
    // instead re-evaluates ONLY the specific per-signal hints whose DPT is exactly
    // "5.001", using the real `comObjectText`/`model` this cluster already has — and
    // only ever overrides a still-default `brightness` verdict with `position`, at
    // HIGH/MEDIUM confidence. Every other signal/hint is untouched.
    if (functionalBlocks.length === 0 && etsSignals.length > 0) {
      etsSignals.forEach((s, i) => {
        if ((s.dpt ?? "").trim() !== "5.001") return;
        if (hints[i]!.capabilities.length !== 1 || hints[i]!.capabilities[0] !== "brightness") return;
        const semantic = resolveDpt5001Semantic({ dpt: s.dpt, comObjectText: s.comObjectText ?? null, gaName: s.name, applicationProgramHint: s.model ?? null });
        if (semantic.semantic === "position" && (semantic.confidence === "high" || semantic.confidence === "medium")) {
          hints[i] = { capabilities: ["position"], deviceKind: "blind", matchedOn: [`dpt:${s.dpt}`, `dpt5001-semantic:${semantic.semantic}/${semantic.confidence}`] };
        }
      });
    }
    // § live-confirmed fix — same isolation discipline as the 5.001 semantic override
    // above (only ever replaces a still-default "brightness" verdict, touches nothing
    // else), but for stronger evidence: DPST-1-8 (Up/Down) and DPST-1-9 (Open/Close) are
    // structurally unambiguous cover controls — a distinct DPT subtype from a plain
    // switch, no name/comObjectText keyword needed at all — unlike DPT 5.001 (genuinely
    // overloaded between brightness/position/generic percentage). A real circuit named
    // with no cover keyword anywhere (confirmed live: one named just "Main") had its
    // OWN percentage position/feedback object defaulting to `brightness` even though an
    // up/down object on the SAME cluster already proves it's a cover.
    if (functionalBlocks.length === 0 && etsSignals.length > 0) {
      const hasUnambiguousCoverControl = etsSignals.some((s) => {
        const cat = dptStructuralCategory(s.dpt ?? null);
        return cat === "binary_updown" || cat === "binary_openclose";
      });
      if (hasUnambiguousCoverControl) {
        etsSignals.forEach((s, i) => {
          if (hints[i]!.capabilities.length !== 1 || hints[i]!.capabilities[0] !== "brightness") return;
          hints[i] = { capabilities: ["position"], deviceKind: "blind", matchedOn: [`dpt:${s.dpt}`, "cluster-has-unambiguous-updown-control"] };
        });
      }
    }
    const { capabilities, deviceKind, matchedOn } = mergeCapabilityHints(hints);

    // Per-signal capability/role tagging (§ Binding Engine input — see
    // `CommunicationObject`'s doc comment) — only available in the granular per-ETS-
    // signal classification branch above; every other branch (functional blocks, or a
    // whole-cluster keyword fallback) has no finer signal than "this object could serve
    // any of the device's capabilities", exactly the assumption binding already made
    // before this field existed, so those objects default to the full merged capability
    // list and `"primary"` — never claims more precision than was actually computed.
    // § Relationship-specific role resolution (fifth pass) — when this cluster came from
    // physical-device clustering, its key's address prefix IS the physical device this
    // signal's role must be resolved relative to (see `roleOfEtsSignal`'s doc comment).
    // A fallback circuit-name cluster has no such physical anchor, so role resolution
    // stays unscoped — exactly the pre-existing global behavior.
    const deviceAddressForRole = physicalEtsClusters ? cluster.key.split("#")[0]! : null;
    const etsTagById = new Map<string, { capabilities: CapabilityKind[]; role: CommunicationObjectRole }>();
    if (functionalBlocks.length === 0 && etsSignals.length > 0) {
      etsSignals.forEach((s, i) => {
        etsTagById.set(s.id, { capabilities: hints[i]!.capabilities, role: roleOfEtsSignal(s.dpt ?? null, s.name, s.links, deviceAddressForRole) });
      });
    }
    const fallbackTag = { capabilities, role: "primary" as CommunicationObjectRole };

    const knxIotTitle = iotSignals[0]?.linkFormat.match(/title="([^"]*)"/)?.[1] ?? null;
    const etsMeta: EtsMetadataSource = {
      circuitName: etsSignals[0]?.name ?? null,
      // An explicit per-signal room always wins; a Schema Engine room extraction (e.g.
      // Schema 1's "Floor → Room → Device Name") fills in only when nothing more
      // specific said otherwise — never overrides real data with a guess.
      room: etsSignals[0]?.room ?? cluster.room ?? null,
      description: etsSignals[0]?.description ?? null,
    };

    // § Naming Evidence (Pass 10) — a physical-channel cluster's own `cluster.key` is
    // `address#channel(s)` (e.g. "1.1.49#1"), carrying zero human meaning; the
    // circuit-name-clustered fallback path's `cluster.key` is already the real, stripped
    // circuit identity `groupByCircuitName` produced (unchanged — see that function's own
    // doc comment), so it's left as the "grouping" tier exactly as before this pass.
    // § Naming Evidence — shared-GA immunity (Pass 10.1). `etsSignals` here is the
    // POST-fan-out set (needed everywhere else in this function — capabilities, roles,
    // externalControls, communicationObjects — and must stay that way). Naming alone
    // gets the pre-fan-out LOCAL subset via `localSignalIdsByClusterKey`, so a fanned-in
    // shared/central GA (any name — never a hardcoded string) can't out-vote this
    // device's own local circuit signal in `deriveDeviceNameEvidence`. A device whose
    // ETS signals were ALL fanned in (none local) naturally falls through to
    // `deriveDeviceNameEvidence`'s existing empty-array fallback tier — no new tier
    // invented, shared evidence just never wins the primary naming slot.
    const localIds = localSignalIdsByClusterKey?.get(cluster.key);
    const localEtsSignals = localIds ? etsSignals.filter((s) => localIds.has(s.id)) : etsSignals;
    const namingEvidence = physicalEtsClusters
      ? deriveDeviceNameEvidence(localEtsSignals.map((s) => ({ name: s.name, middleGroup: s.middleGroup, mainGroup: s.mainGroup })), cluster.key, deviceKind)
      : [];
    const groupingTierName = physicalEtsClusters
      ? (namingEvidence.find((e) => e.confidence !== "fallback")?.value ?? namingEvidence[0]!.value)
      : titleCase(cluster.key);

    const sources: MetadataSource[] = [
      { kind: "user", metadata: input.userOverrides?.[cluster.key] ?? {} },
      { kind: "knx_iot", metadata: semanticMetadataFromLinkFormatTitle(knxIotTitle) },
      { kind: "ets", metadata: semanticMetadataFromEts(etsMeta) },
      { kind: "grouping", metadata: { ...EMPTY_SEMANTIC_METADATA, deviceName: groupingTierName } },
      { kind: "inference", metadata: inferredMetadata(deviceKind, cluster.key) },
    ];
    const merged = mergeMetadata(sources);
    const metadata = flattenMergedMetadata(merged);

    const isSharedAcrossDevices = (s: (typeof etsSignals)[number]) => {
      const addrs = new Set((s.links ?? []).map((l) => l.individualAddress).filter((a): a is string => !!a));
      return addrs.size >= 2;
    };
    const communicationObjects: CommunicationObject[] = [
      ...etsSignals.map((s) => ({ id: s.id, name: s.name, source: "ets" as const, channel: s.channel ?? null, local: !isSharedAcrossDevices(s), dpt: s.dpt ?? null, ...(etsTagById.get(s.id) ?? fallbackTag) })),
      ...iotSignals.map((s) => ({ id: s.host, name: knxIotTitle ?? s.host, source: "knx_iot" as const, channel: null, local: true, dpt: null, ...fallbackTag })),
    ];

    // Universal Device Intelligence Engine (§ Intelligence Priority): pool circuit name,
    // group/room text, raw communication-object names, and functional-block titles — the
    // same priority-ordered sources KNX already threads through this mapper, handed to the
    // protocol-agnostic engine instead of a KNX-specific classifier.
    const classification = classifyDevice({
      circuitName: etsSignals[0]?.name ?? cluster.key,
      groupName: etsMeta.room,
      communicationObjectNames: rawNames,
      functionalBlockTitles: functionalBlocks.map((b) => b.title).filter((t): t is string => Boolean(t)),
    });

    // § Production KNX Driver 2.0 — Physical Device Identity (§28: diagnostics must
    // preserve protocol/physical-address/manufacturer/model/channel). Populated whenever
    // ANY ets signal in this cluster carries it — true unconditionally when
    // groupByPhysicalChannel built the cluster, and best-effort even when the fallback
    // circuit-name clustering ran (e.g. a mixed ETS+KNX-IoT merge) so identity is never
    // silently dropped just because clustering fell back to name-based grouping. Null
    // when no ets signal in the cluster carries it — never fabricated.
    // § Determinism (Pass 10.3) — `etsSignals` here is the POST-fan-out set (needed
    // everywhere else in this function, see the comment on `localEtsSignals` above), so a
    // plain `.find()` picked whichever signal happened to be first in the caller's raw
    // ETS array — for a physical-channel cluster that could be a FANNED-IN shared GA
    // belonging to a DIFFERENT physical device (corrupting `individualAddress`/
    // `manufacturer`/`model`), or, for a merged multi-channel device, any one of its own
    // channels' signals in arbitrary order (making the legacy singular `channel` field
    // flip between them). Restrict to this cluster's OWN physical address (the `address`
    // half of `cluster.key` — exactly what `groupByPhysicalChannel` built the cluster
    // from, never a fanned-in relationship) first, then break ties on the lowest channel
    // number, then on GA id — all real ETS data, none of it insertion order.
    const ownPhysicalAddress = physicalEtsClusters ? cluster.key.split("#")[0]! : null;
    const physicalCandidates = ownPhysicalAddress
      ? etsSignals.filter((s) => s.individualAddress === ownPhysicalAddress)
      : etsSignals.filter((s) => s.individualAddress);
    const physicalSignal = physicalCandidates.length > 0
      ? [...physicalCandidates].sort((a, b) => (a.channel ?? -Infinity) - (b.channel ?? -Infinity) || a.id.localeCompare(b.id))[0]!
      : etsSignals.find((s) => s.individualAddress);
    // § Channel Synthesis (Pass 2) — `channels` must reflect ONLY the channels
    // `mergeRelatedChannels` actually fused into this ONE logical device, encoded in
    // `cluster.key` itself ("address#1+2"). Deriving it from every ETS signal in the
    // cluster instead would wrongly include channels belonging to OTHER devices whose
    // shared/central GA got fanned into this cluster by `attachSharedGaSignals` (a
    // central "All On/off" macro referencing channel 3 of this same physical device
    // does NOT mean this device — built from channel 1's own circuit — spans channel 3
    // too). Falls back to the best-effort per-signal derivation only for the circuit-
    // name-fallback clustering path, which has no such structured key.
    const channelsFromKey = physicalEtsClusters
      ? cluster.key.split("#")[1]?.split("+").map(Number).filter((n) => Number.isFinite(n))
      : undefined;
    const physicalDevice = physicalSignal
      ? {
          individualAddress: physicalSignal.individualAddress ?? null,
          manufacturer: physicalSignal.manufacturer ?? null,
          model: physicalSignal.model ?? null,
          channel: physicalSignal.channel ?? null,
          channels: channelsFromKey?.length
            ? channelsFromKey.sort((a, b) => a - b)
            : [...new Set(etsSignals.map((s) => s.channel).filter((c): c is number => c !== null && c !== undefined))].sort((a, b) => a - b),
        }
      : null;

    // § Control-Relationship Model (Pass 3) — every OTHER physical device referencing a
    // GA this device's OWN comm objects also use. Deliberately computed from the SAME
    // `links[]` already used for role/capability/merge evidence — no second data source.
    const externalControls = physicalDevice?.individualAddress
      ? (() => {
          const seen = new Set<string>();
          const result: { individualAddress: string; comObjectText: string; groupAddress: string }[] = [];
          for (const s of etsSignals) {
            for (const l of s.links ?? []) {
              if (!l.individualAddress || l.individualAddress === physicalDevice.individualAddress) continue;
              const dedupeKey = `${l.individualAddress}:${s.id}`;
              if (seen.has(dedupeKey)) continue;
              seen.add(dedupeKey);
              result.push({ individualAddress: l.individualAddress, comObjectText: l.comObjectText ?? "", groupAddress: s.id });
            }
          }
          return result;
        })()
      : [];

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
        classification,
        physicalDevice,
        externalControls,
        groupingEvidence: (cluster as { groupingEvidence?: ChannelGroupingEvidence[] }).groupingEvidence ?? [],
        namingEvidence,
      },
    };
  });

  // § Duplicate display names (Pass 10, §15) — two genuinely different physical
  // devices/circuits can land on the identical synthesized name (e.g. two "Ceiling
  // Light" circuits in two different, unresolved rooms). Logical identity is
  // `groupingKey`/`backendId`, already unique by construction — this ONLY appends a
  // deterministic, stable-ordered "(2)"/"(3)" suffix to `suggestedName` for display,
  // never touching identity, capabilities, or bindings. Ordered by `groupingKey` so the
  // same input always produces the same suffix assignment (§16 determinism).
  const nameCounts = new Map<string, number>();
  for (const d of devices) nameCounts.set(d.suggestedName, (nameCounts.get(d.suggestedName) ?? 0) + 1);
  const seenSoFar = new Map<string, number>();
  for (const d of [...devices].sort((a, b) => a.raw.groupingKey.localeCompare(b.raw.groupingKey))) {
    if ((nameCounts.get(d.suggestedName) ?? 0) < 2) continue;
    const n = (seenSoFar.get(d.suggestedName) ?? 0) + 1;
    seenSoFar.set(d.suggestedName, n);
    if (n > 1) d.suggestedName = `${d.suggestedName} (${n})`;
  }
  return devices;
}

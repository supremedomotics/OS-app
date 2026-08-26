import { generateDeviceCard } from "./device-card-generator.js";
import { recognizeDevices } from "./device-recognition-engine.js";
import { generateEntities, type CommissionableDevice } from "./entity-generator.js";
import { looksLikeEsf, parseEsf } from "./esf-parser.js";
import { parseEtsProject } from "./ets-parser.js";
import { parseGaExport } from "./ga-export-parser.js";
import { applyLearnedNames, type KnxLearnedName } from "./learning-store.js";
import { assignRooms } from "./room-assignment-engine.js";
import type { DeviceCardSpec, ImportWarning, KnxImportResultV2, KnxProjectModel, RecognizedDevice } from "./types.js";

/**
 * KNX Import Engine — orchestrator (§ Overall Workflow). Runs every stage in order —
 * parse → recognize → assign rooms → apply learned renames → detect cross-device
 * conflicts — and returns one `KnxImportResultV2` with the ready-to-review device list,
 * every non-fatal warning collected along the way, and import stats. This is the single
 * entry point the installer/gateway layer calls; it never touches raw XML/CSV itself.
 */

export type KnxImportSource =
  | { kind: "knxproj"; files: Map<string, Buffer> }
  | { kind: "text"; content: string };

export interface KnxImportOptions {
  /** Supreme's already-commissioned room names, for tier-4 name-based room matching. */
  existingRoomNames?: string[];
  /** Previously learned installer renames (see learning-store.ts), applied by fingerprint. */
  learnedNames?: KnxLearnedName[];
}

function parseSource(source: KnxImportSource): KnxProjectModel {
  if (source.kind === "knxproj") return parseEtsProject(source.files);
  return looksLikeEsf(source.content) ? parseEsf(source.content) : parseGaExport(source.content);
}

/** Public parse-only entry point (§ Unify ETS Import & Discovery Pipeline — "the ETS
 * parser should only parse, it must never commission devices directly"). Exposes the
 * SAME parsing this file has always used for `runKnxImport()`'s first stage — no new
 * parsing logic, just making the existing internal step callable on its own so the
 * Supreme KNX Driver's discovery pipeline can consume raw group addresses as signals
 * instead of this file's own recognition/room-assignment/commissioning stages. */
export function parseKnxSource(source: KnxImportSource): KnxProjectModel {
  return parseSource(source);
}

/** One channel-tagged word in a communication object's function text, e.g. "Channel 1
 * Switch" → 1. §25 (Production KNX Driver 2.0): a physical device with several
 * independent circuits (a 4-channel switch actuator) reports each circuit's comm
 * objects under a distinct channel number — the Unified Device Mapper uses this to
 * split them into separate logical devices instead of merging an entire multi-circuit
 * actuator into one. A device with no channel token in its comm-object text (the common
 * single-circuit case) returns null — treated as ONE implicit channel, never zero. */
function extractChannelNumber(text: string): number | null {
  // § Real ETS5 export compatibility — real application-program catalog text uses
  // "Output N" (e.g. "<Output 1> Relay Command") as its channel marker, not "Channel N"
  // (confirmed against a real 3-channel dimmer: FunctionText carries no channel token at
  // all, but Name does). "Output"/"Out" is standard KNX application-program vocabulary,
  // not a project-specific term — general to widen for.
  //
  // § Universal Actuator channel identifiers (Channel Synthesis pass) — some real
  // multi-relay/universal-actuator application programs label an output with a letter
  // block PLUS a number ("Output B1 | 01-02", "Output A15 | 15") rather than a bare
  // digit — the letter groups outputs into banks (A/B/…), the number is the position
  // within that bank. Both are structural, general KNX vocabulary (not this project's
  // invention), so both combine into one stable, deterministic channel number: bank
  // letter contributes a *1000 offset (so "B1" and "A1" never collide with each other or
  // with a bare "Output 1"), the trailing digit is the position. A bare "Output 1" (no
  // bank letter) keeps its original plain number — unchanged, backward compatible with
  // every project that never uses banked outputs. The trailing " | 01-02" GA-number
  // range some exports also append is NOT part of the channel identity — deliberately
  // not captured here.
  const m = /\b(?:ch(?:annel)?|out(?:put)?)\.?\s*([A-Za-z]?)\s*(\d+)/i.exec(text);
  if (m) {
    const bank = m[1] ? m[1]!.toUpperCase().charCodeAt(0) - 64 : 0; // 'A' → 1, 'B' → 2, … absent → 0
    return bank * 1000 + Number(m[2]);
  }
  // A leading "[N] …" marker (e.g. "[1] Sitting Center Dwn Light-1") — the per-light-
  // instance channel convention observed on a real KNX-DALI gateway's application
  // program, distinct from an actuator's "Output N" convention but equally general
  // (standard bracket-numbering, not this project's own vocabulary).
  const bracket = /^\[(\d+)\]/.exec(text.trim());
  return bracket ? Number(bracket[1]) : null;
}

/** § Module/Channel Identity — real ETS6 `ChannelId` (e.g. "MD-1_M-2_MI-1_CH-1"), the
 * structural per-circuit identity a module-based application program (DALI gateway,
 * parameterized universal actuator) carries — confirmed on a real ETS6 export with no
 * bundled application-program catalog and no per-instance comm-object `Text=` at all,
 * where `extractChannelNumber` (text-only) has nothing to work with and every one of the
 * device's genuinely independent lighting circuits collapsed onto the same "no channel
 * token" bucket. `MI-N` ("Module Instance N") is the real per-circuit counter; `MD-N`
 * ("Module Definition/bank N", e.g. two independent DALI lines off one gateway) offsets it
 * the same way the existing bank-letter convention above does, so instances under
 * different module banks never collide. Returns null when the id carries no MI token —
 * never fabricated. */
function channelFromChannelId(channelId: string | null): number | null {
  if (!channelId) return null;
  // Underscore is a `\w` character, so a plain `\bMI-` boundary never matches after the
  // preceding "..._MI-1..." underscore — match on the `_`/start delimiter explicitly.
  const mi = /(?:^|_)MI-(\d+)(?:_|$)/.exec(channelId);
  if (!mi) return null;
  // § Real-project validation — `MD-N` ("Module Definition bank") ALONE is not a unique
  // parent for `MI-N`: a real multi-function actuator (one physical device driving a
  // curtain AND a screen AND other unrelated outputs through several DIFFERENT catalog
  // module TYPES) restarts its own `MI-1` numbering independently PER module type
  // (`M-N`), so "MD-2_M-9_MI-1" (a curtain's own channel 1) and "MD-2_M-12_MI-1" (an
  // unrelated screen's own channel 1) share the same MD+MI pair and, without also
  // weighting in `M-N`, collapsed onto the identical synthesized channel number —
  // confirmed on a real project where this false collision fused a curtain, a projector
  // screen, a door lock, and several unrelated lighting circuits into one giant "device".
  // `M-N` is the real module-TYPE identity; both `MD-N` and `M-N` combine with `MI-N`
  // into one deterministic, real-evidence-only channel number — never fabricated beyond
  // what these three real ETS6 identifiers already say.
  const md = /(?:^|_)MD-(\d+)(?:_|$)/.exec(channelId);
  const module = /(?:^|_)M-(\d+)(?:_|$)/.exec(channelId);
  return (md ? Number(md[1]) : 0) * 1_000_000 + (module ? Number(module[1]) : 0) * 1_000 + Number(mi[1]);
}

/** § Critical Group Address Requirement (Production KNX Driver 2.0) — one comm-object's
 * relationship to a group address, preserved rather than discarded. A GA can legally be
 * referenced by several comm objects (on the same device or different devices) in a real
 * ETS project — a shared/central address, a command GA one actuator writes that another
 * device also reads, a scene trigger multiple actuators listen to. `role` distinguishes
 * a WRITE/command relationship (ETS `<Send>`) from a READ/feedback relationship (ETS
 * `<Receive>`) — see `KnxCommunicationObject`'s own doc comment for why this couldn't be
 * derived from the old flattened `groupAddressIds` alone. */
export interface KnxGroupAddressLink {
  deviceInstanceId: string;
  individualAddress: string | null;
  comObjectId: string;
  comObjectText: string;
  /** § Real ETS5 export compatibility — `"unknown"` covers a comm object linked to this
   * GA only via the flat `Links="GA-x GA-y"` attribute (no nested `<Connectors>`), which
   * carries no Send/Receive distinction at all. Real identity/grouping data, never
   * fabricated as a role — downstream role resolution (`roleOfEtsSignal`) treats it as
   * "no tier-1 evidence" and falls back to its existing DPT/name heuristics, exactly as
   * it already does for a signal with an empty `links[]`. */
  role: "send" | "receive" | "unknown";
  /** § Channel Synthesis (Pass 2) — which functional channel of `individualAddress` THIS
   * specific relationship belongs to (same extraction as the signal-level `channel`
   * field, computed per-link instead of once for the whole GA). Lets the mapper detect
   * when a single GA is referenced by comm objects on TWO DIFFERENT channels of the SAME
   * physical device — real structural evidence (not name similarity) that those channels
   * form one functional circuit (e.g. a "Main+Sheer" combined curtain command touched by
   * both the Main and Sheer channel's own comm objects). Null when the comm object's text
   * carries no channel token. */
  channel: number | null;
}

/** § Physical Device Identity (Production KNX Driver 2.0) — one ETS group address, plus
 * everything the Unified Device Mapper needs to cluster by physical device + functional
 * channel instead of by text-only circuit name: which DeviceInstance's communication
 * object links this GA (`individualAddress`/`manufacturer`/`model`), and which channel
 * that comm object's function text names (`channel`). Every field beyond the original
 * `{id,name,room,description,dpt}` is additive and optional — a flat ESF/GA-only export
 * (no device tree) still produces valid signals with these left null, falling back to
 * the same circuit-name clustering the mapper has always done for that case. */
export interface KnxEtsSignal {
  id: string;
  name: string;
  room: string | null;
  description: string | null;
  dpt: string | null;
  individualAddress: string | null;
  manufacturer: string | null;
  model: string | null;
  channel: number | null;
  /** § Rich ETS Communication-Object Semantic Context (eighth pass) — the OWNING comm
   * object's own function text (e.g. "Absolute Brightness Value", "Blind Position"),
   * distinct from `name` (the Group Address's own name). Real ETS data, from the same
   * `owningLink` already used to resolve `individualAddress`/`manufacturer`/`channel` —
   * no second parser, no fabricated text. Null when the owning link carries no comm-
   * object text (e.g. a flat export with no device tree at all). */
  comObjectText: string | null;
  /** § Naming Evidence (Pass 10) — the ETS Main/Middle Group this GA lives under
   * (`KnxGroupAddressRecord.mainGroup`/`.middleGroup`, populated by `ets-parser.ts`'s
   * group-range walk). Threaded straight through here — no re-parsing, no second
   * hierarchy model. Null when the source project has no group-range hierarchy at all
   * (flat GA-only exports) — never fabricated. */
  mainGroup: string | null;
  middleGroup: string | null;
  /** Every comm-object relationship this GA participates in, across every device that
   * references it — never discarded, even for a shared/central address (§ Critical
   * Group Address Requirement). Empty for a GA with no device-tree data at all. */
  links: KnxGroupAddressLink[];
  /** True when more than one distinct physical device references this GA — a shared/
   * central address, not one device's own private command/status pair. Consumers that
   * cluster by physical device should treat a shared GA's device/channel attribution
   * (below) as "the device this signal is ATTRIBUTED to for grouping purposes," not "the
   * only device that uses this address" — `links` has the complete picture. */
  isShared: boolean;
}

/** Every group address in a parsed project, as a room-annotated, physical-device-
 * annotated signal (§ Unified Device Model / § Production KNX Driver 2.0) — the exact
 * shape `mapUnifiedDevices`'s `ets` input already expects (`@supreme/protocols`), so ETS
 * becomes just another signal SOURCE into the same Unified Device Mapper live discovery
 * already uses, never a second commissioning path. Room prefers the owning
 * DeviceInstance's own Space placement (real ETS building-tree metadata — the highest-
 * confidence source per §19) over the Function/Space tree fallback used when no device
 * tree exists; both are only ever real ETS metadata, never guessed. */
export function knxSignalsFromModel(model: KnxProjectModel): KnxEtsSignal[] {
  const roomByGaId = new Map<string, string>();
  for (const fn of model.functions.values()) {
    const room = fn.spaceId ? model.spaces.get(fn.spaceId)?.name : undefined;
    if (!room) continue;
    for (const gaId of fn.groupAddressIds) roomByGaId.set(gaId, room);
  }

  // § Critical Group Address Requirement — collect EVERY comm-object relationship for
  // each GA (send AND receive, across every device), never just the first one seen.
  const linksByGaId = new Map<string, KnxGroupAddressLink[]>();
  for (const co of model.communicationObjects.values()) {
    const device = model.deviceInstances.get(co.deviceInstanceId);
    const pushLink = (gaId: string, role: "send" | "receive" | "unknown") => {
      const link: KnxGroupAddressLink = {
        deviceInstanceId: co.deviceInstanceId,
        individualAddress: device?.individualAddress ?? null,
        comObjectId: co.id,
        comObjectText: co.text,
        role,
        // § Module/Channel Identity — the structural ChannelId signal (when the export
        // carries it) is stronger evidence than a free-text heuristic; text extraction is
        // the fallback for exports that never used ETS6's module/channel schema at all.
        channel: channelFromChannelId(co.channelId) ?? extractChannelNumber(co.text),
      };
      const list = linksByGaId.get(gaId);
      if (list) list.push(link); else linksByGaId.set(gaId, [link]);
    };
    for (const gaId of co.sendGroupAddressIds) pushLink(gaId, "send");
    for (const gaId of co.receiveGroupAddressIds) pushLink(gaId, "receive");
    // § Real ETS5 export compatibility — a comm object linked via the flat `Links=`
    // attribute (no `<Connectors>`) has entries in `groupAddressIds` but NEITHER
    // send/receiveGroupAddressIds. Still real GA↔device association evidence (identity/
    // room/channel grouping) even though role is unknown — recorded as `"unknown"`
    // rather than silently dropped, which previously left every such GA with
    // `individualAddress: null` (confirmed against two real ETS5 projects: 0 of 1,718
    // and 0 of 438 signals resolved a physical device before this fix).
    if (co.sendGroupAddressIds.length === 0 && co.receiveGroupAddressIds.length === 0) {
      for (const gaId of co.groupAddressIds) pushLink(gaId, "unknown");
    }
  }

  return [...model.groupAddresses.values()].map((ga) => {
    const links = linksByGaId.get(ga.id) ?? [];
    // § Physical Device Identity — deterministic owning-device selection for clustering.
    // A GA this device WRITES (send/command) is a stronger ownership signal than one it
    // merely reads (receive/feedback) — a device's own command target is unambiguously
    // "its" GA, while a device that only listens to an address may just be a downstream
    // consumer of someone else's command (e.g. a display reading another device's
    // status). Prefer the first send-role link (stable iteration order — same
    // determinism guarantee §27's duplicate-prevention already depends on); fall back to
    // the first receive-role link when no device sends on this GA at all.
    const owningLink = links.find((l) => l.role === "send") ?? links[0];
    const distinctDevices = new Set(links.map((l) => l.deviceInstanceId));
    const device = owningLink ? model.deviceInstances.get(owningLink.deviceInstanceId) : undefined;
    const deviceRoom = device?.spaceId ? model.spaces.get(device.spaceId)?.name : undefined;
    // § Real ETS5 export compatibility — this export's `<GroupAddress>` elements carry no
    // `DatapointType` of their own at all (confirmed: every real GA in two real ETS5
    // projects had `ga.dpt === null`); the DPT only exists on the comm object that uses
    // the GA. Falling back to the owning comm object's DPT is what let DPT-first
    // capability classification work at all for these projects — without it, every
    // signal's classification fell through to name-only keyword matching, which
    // (confirmed on a real 3-channel dimmer) tagged switch AND dimming objects alike
    // with the SAME merged ["onoff","brightness"] capability set instead of each
    // object's own real DPT-backed capability.
    const owningComObject = owningLink ? model.communicationObjects.get(owningLink.comObjectId) : undefined;
    return {
      id: ga.address,
      name: ga.name,
      room: deviceRoom ?? roomByGaId.get(ga.id) ?? null,
      description: ga.description,
      dpt: ga.dpt ?? owningComObject?.dpt ?? null,
      individualAddress: owningLink?.individualAddress ?? null,
      manufacturer: device?.manufacturer ?? null,
      model: device?.product ?? null,
      channel: owningLink?.channel ?? null,
      comObjectText: owningLink?.comObjectText || null,
      mainGroup: ga.mainGroup,
      middleGroup: ga.middleGroup,
      links,
      isShared: distinctDevices.size > 1,
    };
  });
}

/** Detect two different recognized devices landing on the same (name, room) — a real
 * naming collision worth flagging (possibly the same physical circuit split by naming,
 * or just two coincidentally-identical names), never auto-merged since their group
 * addresses genuinely differ. */
function detectConflicts(devices: RecognizedDevice[], warnings: ImportWarning[]): void {
  const seen = new Map<string, RecognizedDevice>();
  for (const d of devices) {
    const key = `${d.room ?? ""}::${d.name.toLowerCase()}`;
    const prior = seen.get(key);
    if (prior && prior.fingerprint !== d.fingerprint) {
      warnings.push({
        code: "conflicting_device",
        message: `Two devices are both named "${d.name}" in ${d.room ?? "Unknown Room"} — verify they're not the same physical circuit split by naming.`,
        context: { name: d.name, room: d.room },
      });
    } else {
      seen.set(key, d);
    }
  }
}

export function runKnxImport(source: KnxImportSource, options: KnxImportOptions = {}): KnxImportResultV2 {
  const start = Date.now();
  const model = parseSource(source);
  const existingRoomNames = options.existingRoomNames ?? [];

  const { devices: recognized, warnings } = recognizeDevices(model, existingRoomNames);
  let devices = assignRooms(recognized, model, existingRoomNames);
  if (options.learnedNames?.length) devices = applyLearnedNames(devices, options.learnedNames);
  detectConflicts(devices, warnings);

  return {
    devices,
    warnings,
    stats: {
      groupAddressCount: model.groupAddresses.size,
      deviceInstanceCount: model.deviceInstances.size,
      recognizedDeviceCount: devices.length,
      roomsFound: new Set(devices.map((d) => d.room).filter((r): r is string => !!r && r !== "Unknown Room")).size,
      parseMs: Date.now() - start,
    },
  };
}

/** Commissioning-ready shape for one recognized device (entity bindings + card spec) —
 * the final step before {@link import("../index.js").CommissioningService.commission}. */
export interface KnxCommissionableDevice extends CommissionableDevice {
  card: DeviceCardSpec;
}

export function toCommissionable(device: RecognizedDevice): KnxCommissionableDevice {
  return { ...generateEntities(device), card: generateDeviceCard(device) };
}

export * from "./types.js";
export { classifyDpt, normalizeDpt, isReadonlyCategory, type DptCategory, type DptClassification } from "./dpt-analyzer.js";
export { humanizeName, humanizeSegment, splitNameSegments } from "./name-cleanup.js";
export { parseEtsProject } from "./ets-parser.js";
export { parseEsf, looksLikeEsf } from "./esf-parser.js";
export { parseGaExport } from "./ga-export-parser.js";
export { unzipKnxproj, addressFromInt } from "./zip-reader.js";
export { recognizeDevices, type RecognitionResult } from "./device-recognition-engine.js";
export { assignRooms } from "./room-assignment-engine.js";
export { generateEntities, type CommissionableBinding, type CommissionableDevice, type EntitySource } from "./entity-generator.js";
export { generateDeviceCard } from "./device-card-generator.js";
export {
  ConfigKnxLearningStore,
  applyLearnedNames,
  learnRenames,
  type IKnxLearningStore,
  type KnxLearnedName,
} from "./learning-store.js";

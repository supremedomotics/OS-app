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

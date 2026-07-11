import type { HomeId } from "@supreme/domain-model";
import type { IConfigStore } from "@supreme/home";
import { humanizeName } from "./name-cleanup.js";
import type { RecognizedDevice } from "./types.js";

/**
 * Learning Engine (§ Learning Engine). If the installer renames a recognized device
 * before saving ("Living Spot 1" → "Dining Spot"), that choice is remembered — a future
 * re-import of an updated ETS project preserves it instead of reverting to the raw
 * ETS-derived name, keyed by the device's stable {@link RecognizedDevice.fingerprint}
 * (its DeviceInstance id, or a hash of its source group addresses — see the recognition
 * engine), which survives most real-world project edits (adding an unrelated device,
 * re-exporting, minor GA renumbering) even though the exact name text might change.
 *
 * Persisted via the home's existing generic per-home config store (the same one scene
 * schedules / the climate program already use) — no dedicated store needed.
 */

const CONFIG_KEY = "knx_learned_device_names";

export interface KnxLearnedName {
  fingerprint: string;
  /** The installer-confirmed name to use going forward. */
  name: string;
  /** When this was learned — surfaced only for installer transparency/debugging. */
  learnedAt: string;
}

export interface IKnxLearningStore {
  get(homeId: HomeId): Promise<KnxLearnedName[]>;
  set(homeId: HomeId, names: KnxLearnedName[]): Promise<void>;
}

/** {@link IKnxLearningStore} backed by the home's generic config store. */
export class ConfigKnxLearningStore implements IKnxLearningStore {
  constructor(private readonly config: IConfigStore) {}

  async get(homeId: HomeId): Promise<KnxLearnedName[]> {
    const raw = await this.config.get(homeId, CONFIG_KEY);
    return Array.isArray(raw) ? (raw as KnxLearnedName[]) : [];
  }

  async set(homeId: HomeId, names: KnxLearnedName[]): Promise<void> {
    await this.config.set(homeId, CONFIG_KEY, names);
  }
}

/** Apply every learned rename to a freshly-recognized device list (the PREVIEW step —
 * nothing here is persisted). Devices with no learned entry are returned unchanged. */
export function applyLearnedNames(devices: RecognizedDevice[], learned: KnxLearnedName[]): RecognizedDevice[] {
  if (learned.length === 0) return devices;
  const byFingerprint = new Map(learned.map((l) => [l.fingerprint, l.name]));
  return devices.map((d) => {
    const learnedName = byFingerprint.get(d.fingerprint);
    return learnedName && learnedName !== d.name ? { ...d, name: learnedName } : d;
  });
}

/**
 * At COMMIT time, detect which saved devices carry an installer-chosen name different
 * from what fresh recognition would have produced from their own source name, and merge
 * those into the learned-name list (replacing any prior entry for the same fingerprint).
 * Devices saved with their recognized name as-is don't need a learned entry at all.
 */
export function learnRenames(
  saved: { fingerprint: string; name: string; sourceName: string }[],
  existing: KnxLearnedName[],
  now: string,
): KnxLearnedName[] {
  const byFingerprint = new Map(existing.map((l) => [l.fingerprint, l]));
  for (const d of saved) {
    const defaultName = humanizeName(d.sourceName);
    if (d.name.trim() && d.name !== defaultName) {
      byFingerprint.set(d.fingerprint, { fingerprint: d.fingerprint, name: d.name, learnedAt: now });
    }
  }
  return [...byFingerprint.values()];
}

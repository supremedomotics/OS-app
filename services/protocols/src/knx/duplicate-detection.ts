import type { UnifiedKnxDevice } from "./unified-device-mapper.js";

/**
 * Duplicate Detection (§ Unified Device Intelligence — Phase 4).
 *
 * Compares a freshly-discovered {@link UnifiedKnxDevice} against whatever this
 * installation already knows about (existing registry backendIds, existing protocol
 * bindings' addresses, existing circuit/grouping names) and decides what the installer
 * workflow should do with it — a pure, testable decision function. It does NOT read the
 * database itself: the gateway (which already owns the device registry — § Native Driver
 * Architecture) passes in whatever existing state is relevant, keeping this module
 * protocol-layer-only and reusable in tests without a real Postgres instance.
 */
export type DuplicateDecision = "new" | "merge" | "update" | "ignore" | "ask_installer";

export interface ExistingInstallationState {
  backendIds: Set<string>;
  /** Group addresses (or KNX IoT hosts) already bound to some device. */
  boundAddresses: Set<string>;
  /** Grouping keys of devices already approved in a previous discovery run. */
  groupingKeys: Set<string>;
}

export interface DuplicateCheckResult {
  decision: DuplicateDecision;
  reason: string;
  matchedOn: "backendId" | "communicationObject" | "groupingKey" | null;
}

/** A device is a candidate for auto-merge only when every one of its communication
 * objects already exists under the same grouping key — anything less certain gets
 * escalated to the installer rather than silently merged (§ "based on confidence"). */
export function checkDuplicate(device: UnifiedKnxDevice, existing: ExistingInstallationState): DuplicateCheckResult {
  if (existing.backendIds.has(device.backendId)) {
    return { decision: "update", reason: "this exact device was already registered — re-discovery reports the same backendId", matchedOn: "backendId" };
  }

  const objectIds = device.raw.communicationObjects.map((o) => o.id);
  const boundObjectCount = objectIds.filter((id) => existing.boundAddresses.has(id)).length;

  if (boundObjectCount === objectIds.length && objectIds.length > 0) {
    return { decision: "merge", reason: "every communication object this device would bind to is already bound to an existing device", matchedOn: "communicationObject" };
  }

  if (boundObjectCount > 0) {
    return { decision: "ask_installer", reason: `${boundObjectCount} of ${objectIds.length} communication objects overlap an existing device — ambiguous, needs installer judgment`, matchedOn: "communicationObject" };
  }

  if (existing.groupingKeys.has(device.raw.groupingKey)) {
    return { decision: "ask_installer", reason: "a device with the same circuit name already exists but shares no communication object — could be a rename or a genuine second device", matchedOn: "groupingKey" };
  }

  return { decision: "new", reason: "no overlap with any existing device", matchedOn: null };
}

/** Buckets a batch of discovery results the way the Discover Devices workspace's
 * sections are named (§ "Ready to Approve / Needs Review / Duplicates / Conflicts") —
 * pure grouping over {@link checkDuplicate} results, no I/O. */
export function bucketByDuplicateDecision(
  devices: UnifiedKnxDevice[],
  existing: ExistingInstallationState,
): Record<DuplicateDecision, { device: UnifiedKnxDevice; result: DuplicateCheckResult }[]> {
  const buckets: Record<DuplicateDecision, { device: UnifiedKnxDevice; result: DuplicateCheckResult }[]> = {
    new: [], merge: [], update: [], ignore: [], ask_installer: [],
  };
  for (const device of devices) {
    const result = checkDuplicate(device, existing);
    buckets[result.decision].push({ device, result });
  }
  return buckets;
}

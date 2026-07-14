import type { UnifiedKnxDevice } from "./unified-device-mapper.js";

/**
 * Room Assignment (§ Unified Device Intelligence — Phase 4).
 *
 * A dedicated, explainable priority chain for the ONE field the spec calls out
 * separately from the general metadata merge (§ Phase 3 `metadata-merge.ts`, which
 * already resolves `room` as part of a device's overall metadata via a 5-source order).
 * This chain adds two sources the general merge doesn't have: an installation's
 * EXISTING room mapping (a previously-approved device on the same circuit/host already
 * has a room) and an explicit "unassigned" terminal state — both meaningful only at
 * installer-review time, not during raw discovery.
 *
 * Priority: user override → KNX IoT metadata → ETS metadata → existing room mapping →
 * circuit intelligence (the grouping key itself) → AI inference → unassigned.
 */
export type RoomAssignmentSource =
  | "user" | "knx_iot" | "ets" | "existing_room_mapping" | "circuit_intelligence" | "ai_inference" | "unassigned";

export interface RoomAssignmentResult {
  room: string | null;
  source: RoomAssignmentSource;
  reason: string;
}

export interface RoomAssignmentInput {
  device: UnifiedKnxDevice;
  userOverrideRoom?: string | null;
  /** Rooms already assigned to previously-approved devices, keyed by the same
   * communication-object id this device shares one of (§ "Existing Room Mapping"). */
  existingRoomByObjectId?: Record<string, string>;
  /** Optional pluggable inference step (e.g. a future ML/LLM classifier) — absent by
   * default; never fabricated when not provided (§ "architected for future AI-assisted
   * assignment", Phase 1 KNX driver spec). */
  aiInference?: (device: UnifiedKnxDevice) => string | null;
}

/** Room already resolved by the Phase 3 metadata merge (KNX IoT title or ETS room) —
 * reused here rather than re-parsed, so this chain and the general merge never disagree
 * about what KNX IoT/ETS actually said. */
function mergedRoomSource(device: UnifiedKnxDevice): { room: string | null; source: "knx_iot" | "ets" | null } {
  const line = device.raw.mergeExplanation.find((e) => e.startsWith("room:"));
  if (!line) return { room: null, source: null };
  const match = line.match(/^room: "(.*)" ← (knx_iot|ets)$/);
  if (!match) return { room: null, source: null };
  return { room: match[1] ?? null, source: match[2] as "knx_iot" | "ets" };
}

export function assignRoom(input: RoomAssignmentInput): RoomAssignmentResult {
  const { device, userOverrideRoom, existingRoomByObjectId, aiInference } = input;

  if (userOverrideRoom) return { room: userOverrideRoom, source: "user", reason: "installer-entered room override" };

  const merged = mergedRoomSource(device);
  if (merged.room && merged.source) {
    return { room: merged.room, source: merged.source, reason: `reported by ${merged.source === "knx_iot" ? "KNX IoT device metadata" : "the ETS project"}` };
  }

  const existingMatch = device.raw.communicationObjects
    .map((o) => existingRoomByObjectId?.[o.id])
    .find((r): r is string => Boolean(r));
  if (existingMatch) {
    return { room: existingMatch, source: "existing_room_mapping", reason: "a previously-approved device sharing a communication object with this one is already in this room" };
  }

  if (device.raw.communicationObjects.length > 1) {
    return { room: null, source: "circuit_intelligence", reason: "circuit grouping found multiple related signals but none carried a room name" };
  }

  const inferred = aiInference?.(device) ?? null;
  if (inferred) return { room: inferred, source: "ai_inference", reason: "inferred by the pluggable AI room classifier" };

  return { room: null, source: "unassigned", reason: "no source provided a room — installer must assign one" };
}

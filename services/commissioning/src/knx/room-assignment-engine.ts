import { humanizeSegment, splitNameSegments } from "./name-cleanup.js";
import type { KnxProjectModel, KnxSpace, RecognizedDevice } from "./types.js";

/**
 * Room Assignment Engine (§ Automatic Room Assignment). Fills in `room`/`floor`/
 * `building` on every recognized device, in the documented priority order:
 *
 *   1. ETS Room       — the device (or its underlying Function) is directly placed in a
 *                        `<Space Type="Room">` in the project's own Buildings/Locations tree.
 *   2. Building structure — no direct placement, but the device's name matches a room the
 *                        ETS PROJECT itself defines (its own building's room vocabulary,
 *                        which may include rooms Supreme hasn't been told about yet).
 *   3. Device communication objects — the underlying DeviceInstance's own name (distinct
 *                        from the group-address name) carries a room hint the GA name didn't.
 *   4. Group-address name — substring match against Supreme's ALREADY-COMMISSIONED room
 *                        names, exactly the "Dining Hanging" → "Dining" style matching used
 *                        before ETS project data was available at all.
 *   5. Inferred from the name's own structure — a flat GA export with no building tree
 *                        and no matching existing room still very likely follows the
 *                        "Room - Device - Function" ETS naming convention; the leading
 *                        segment ("Garage - Ceiling Light - Switch" → "Garage") becomes a
 *                        newly-inferred room rather than falling straight to "Unknown Room".
 *
 * Nothing is ever discarded for lack of a room: a device that matches nothing at any tier
 * still gets `room: "Unknown Room"` rather than being dropped from the import.
 */

const ROOM_SPACE_TYPES = new Set(["room", "corridor", "stairway"]);

function nearestAncestorOfType(
  spaces: Map<string, KnxSpace>,
  startId: string | null,
  types: ReadonlySet<string>,
): KnxSpace | null {
  let id = startId;
  while (id) {
    const space = spaces.get(id);
    if (!space) return null;
    if (types.has(space.type)) return space;
    id = space.parentId;
  }
  return null;
}

/** Tier 1: direct placement via the device's own DeviceInstance, or (when it came from the
 * legacy `<Function>` fallback) any Function referencing the same source group addresses. */
function directPlacement(device: RecognizedDevice, model: KnxProjectModel): string | null {
  if (device.sourceDeviceInstanceId) {
    const di = model.deviceInstances.get(device.sourceDeviceInstanceId);
    if (di?.spaceId) return di.spaceId;
  }
  for (const gaId of device.sourceGroupAddressIds) {
    for (const fn of model.functions.values()) {
      if (fn.spaceId && fn.groupAddressIds.includes(gaId)) return fn.spaceId;
    }
  }
  return null;
}

interface RoomResolution {
  room: string;
  floor: string | null;
  building: string | null;
  source: "ets_room" | "building_structure" | "comm_object" | "name" | "unassigned";
}

function fromSpaceId(spaceId: string, model: KnxProjectModel, source: RoomResolution["source"]): RoomResolution {
  const roomSpace = nearestAncestorOfType(model.spaces, spaceId, ROOM_SPACE_TYPES) ?? model.spaces.get(spaceId) ?? null;
  const floorSpace = nearestAncestorOfType(model.spaces, spaceId, new Set(["floor"]));
  const buildingSpace = nearestAncestorOfType(model.spaces, spaceId, new Set(["building"]));
  return {
    room: roomSpace?.name || "Unknown Room",
    floor: floorSpace?.name ?? null,
    building: buildingSpace?.name ?? null,
    source,
  };
}

function etsRoomNames(model: KnxProjectModel): { raw: string; lc: string }[] {
  const names: { raw: string; lc: string }[] = [];
  for (const space of model.spaces.values()) {
    if (ROOM_SPACE_TYPES.has(space.type) && space.name) names.push({ raw: space.name, lc: space.name.toLowerCase() });
  }
  return names;
}

function matchRoomByText(text: string, rooms: { raw: string; lc: string }[]): string | null {
  const lc = text.toLowerCase();
  // Prefer the longest matching room name so "Master Bedroom" wins over a shorter
  // coincidental match like "Bedroom" when both are defined.
  let best: { raw: string; lc: string } | null = null;
  for (const r of rooms) {
    if (lc.includes(r.lc) && (!best || r.lc.length > best.lc.length)) best = r;
  }
  return best?.raw ?? null;
}

export function assignRooms(devices: RecognizedDevice[], model: KnxProjectModel, existingRoomNames: string[] = []): RecognizedDevice[] {
  const etsRooms = etsRoomNames(model);
  const knownRooms = existingRoomNames.map((r) => ({ raw: r, lc: r.toLowerCase() }));

  return devices.map((device) => {
    // Tier 1 — ETS room (direct placement).
    const spaceId = directPlacement(device, model);
    if (spaceId) {
      const resolved = fromSpaceId(spaceId, model, "ets_room");
      return { ...device, room: resolved.room, floor: resolved.floor, building: resolved.building };
    }

    const nameCandidates = [device.sourceName, device.name];
    if (device.sourceDeviceInstanceId) {
      const di = model.deviceInstances.get(device.sourceDeviceInstanceId);
      if (di?.name) nameCandidates.push(di.name);
    }

    // Tier 2 — the ETS project's OWN room vocabulary (may include rooms Supreme doesn't
    // have yet), matched against the device's name and its raw group-address segments.
    for (const candidate of nameCandidates) {
      const match = matchRoomByText(candidate, etsRooms);
      if (match) return { ...device, room: match, floor: null, building: null };
    }
    for (const gaId of device.sourceGroupAddressIds) {
      const ga = model.groupAddresses.get(gaId);
      if (!ga) continue;
      for (const segment of splitNameSegments(ga.name)) {
        const match = matchRoomByText(segment, etsRooms);
        if (match) return { ...device, room: match, floor: null, building: null };
      }
    }

    // Tier 3 — the underlying DeviceInstance's own name (comm-object source), matched
    // against Supreme's already-commissioned rooms too (an ETS project's device names
    // sometimes carry the install location even when its GA names are generic).
    if (device.sourceDeviceInstanceId) {
      const di = model.deviceInstances.get(device.sourceDeviceInstanceId);
      if (di?.name) {
        const match = matchRoomByText(di.name, knownRooms);
        if (match) return { ...device, room: match, floor: null, building: null };
      }
    }

    // Tier 4 — plain group-address name vs. Supreme's already-commissioned rooms.
    for (const candidate of nameCandidates) {
      const match = matchRoomByText(candidate, knownRooms);
      if (match) return { ...device, room: match, floor: null, building: null };
    }

    // Tier 5 — infer a brand-new room from the "Room - Device - Function" naming
    // convention itself when nothing above matched (a flat export with no building tree
    // and a room Supreme genuinely hasn't seen before yet). Reads the RAW group-address
    // name (not `sourceName`, which already had its function word stripped and rejoined
    // without the original separators) so the leading segment is still intact.
    const firstGa = device.sourceGroupAddressIds.map((id) => model.groupAddresses.get(id)).find((ga) => !!ga);
    const segments = splitNameSegments(firstGa?.name ?? device.sourceName);
    if (segments.length > 1) {
      return { ...device, room: humanizeSegment(segments[0]!), floor: null, building: null };
    }

    // Never discard — an unmatched device still gets a room, just an explicit "unknown" one.
    return { ...device, room: "Unknown Room", floor: null, building: null };
  });
}

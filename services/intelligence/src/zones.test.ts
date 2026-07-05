import { describe, expect, it } from "vitest";
import type { PresenceEstimate } from "./presence/fusion.js";
import { type Zone, ZoneOccupancyTracker, zoneOfRoom } from "./zones.js";

const ZONES: Zone[] = [
  { id: "z_ground", name: "Ground Floor", roomIds: ["room_lr", "room_kitchen"] },
  { id: "z_beds", name: "Bedroom Wing", roomIds: ["room_bed"] },
];

const est = (userId: string, present: boolean, roomId: string | null): PresenceEstimate => ({
  userId,
  status: present ? "present" : "away",
  present,
  confidence: present ? 0.95 : 0.05,
  roomId,
  contributingSources: [],
  ts: 0,
});

describe("zoneOfRoom", () => {
  it("maps a room to its zone, null when unmapped", () => {
    expect(zoneOfRoom(ZONES, "room_kitchen")).toBe("z_ground");
    expect(zoneOfRoom(ZONES, "room_unknown")).toBeNull();
    expect(zoneOfRoom(ZONES, null)).toBeNull();
  });
});

describe("ZoneOccupancyTracker", () => {
  it("reports who is in each zone and the house", () => {
    const t = new ZoneOccupancyTracker();
    const out = t.update(ZONES, [est("u1", true, "room_lr"), est("u2", true, "room_bed")], 0);
    expect(out.occupied).toBe(true);
    expect(out.present.sort()).toEqual(["u1", "u2"]);
    expect(out.zones.find((z) => z.zoneId === "z_ground")!.occupants).toEqual(["u1"]);
    expect(out.zones.find((z) => z.zoneId === "z_beds")!.occupants).toEqual(["u2"]);
  });

  it("tracks arrivals, departures and zone vacancy duration", () => {
    const t = new ZoneOccupancyTracker();
    t.update(ZONES, [est("u1", true, "room_lr")], 0); // u1 on ground floor
    const moved = t.update(ZONES, [est("u1", true, "room_bed")], 60_000); // u1 → bedroom wing
    const ground = moved.zones.find((z) => z.zoneId === "z_ground")!;
    const beds = moved.zones.find((z) => z.zoneId === "z_beds")!;
    expect(ground.departed).toEqual(["u1"]);
    expect(ground.occupied).toBe(false);
    expect(beds.arrived).toEqual(["u1"]);
    // 5 minutes later the ground floor is still empty → vacant for 5 min.
    const later = t.update(ZONES, [est("u1", true, "room_bed")], 6 * 60_000);
    expect(later.zones.find((z) => z.zoneId === "z_ground")!.vacantForMs).toBe(5 * 60_000);
  });

  it("tracks whole-house vacancy once everyone leaves", () => {
    const t = new ZoneOccupancyTracker();
    t.update(ZONES, [est("u1", true, "room_lr")], 0);
    const empty = t.update(ZONES, [est("u1", false, null)], 10 * 60_000); // u1 leaves
    expect(empty.occupied).toBe(false);
    expect(empty.departed).toEqual(["u1"]);
    expect(empty.vacantForMs).toBe(0); // just became vacant this tick
    const later = t.update(ZONES, [est("u1", false, null)], 25 * 60_000);
    expect(later.vacantForMs).toBe(15 * 60_000); // vacant since the 10-min mark
  });

  it("counts a present-but-unmapped room toward the house but no zone", () => {
    const t = new ZoneOccupancyTracker();
    const out = t.update(ZONES, [est("u1", true, "room_garage")], 0); // garage not in any zone
    expect(out.occupied).toBe(true);
    expect(out.zones.every((z) => z.occupants.length === 0)).toBe(true);
  });
});

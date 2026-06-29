/**
 * Zone presence. Rooms roll up into Zones (Ground Floor, Bedroom Wing, Garage, Outdoor, …). Given
 * the fused per-user presence estimates, the tracker answers the product's questions: who is in the
 * house, who is in each zone, who just arrived/left, and how long a zone (or the whole house) has
 * been vacant. Vacancy duration needs memory across ticks, so {@link ZoneOccupancyTracker} is a thin
 * stateful class over a pure diff; the zone→room mapping itself is pure config.
 */
import type { PresenceEstimate } from "./presence/fusion.js";

export interface Zone {
  id: string;
  name: string;
  /** Rooms that belong to this zone. */
  roomIds: string[];
}

/** The zone a room belongs to, or null if it isn't mapped to one. */
export function zoneOfRoom(zones: Zone[], roomId: string | null): string | null {
  if (!roomId) return null;
  for (const z of zones) if (z.roomIds.includes(roomId)) return z.id;
  return null;
}

export interface ZoneOccupancy {
  zoneId: string;
  name: string;
  occupants: string[];
  occupied: boolean;
  /** ms the zone has been continuously vacant (0 while occupied). */
  vacantForMs: number;
  /** Users who entered this zone since the previous update. */
  arrived: string[];
  /** Users who left this zone since the previous update. */
  departed: string[];
}

export interface HouseOccupancy {
  /** Users currently present anywhere in the home. */
  present: string[];
  occupied: boolean;
  vacantForMs: number;
  arrived: string[];
  departed: string[];
  zones: ZoneOccupancy[];
}

/** Which zone an estimate places a user in (present users only). */
function zoneForEstimate(zones: Zone[], e: PresenceEstimate): string | null {
  return e.present ? zoneOfRoom(zones, e.roomId) : null;
}

export class ZoneOccupancyTracker {
  /** zoneId → ms epoch it became vacant (null while occupied; absent = never seen). */
  private zoneVacantSince = new Map<string, number | null>();
  private houseVacantSince: number | null = null;
  private prevZoneOccupants = new Map<string, Set<string>>();
  private prevHouseOccupants = new Set<string>();
  private started = false;

  /**
   * Fold the latest presence estimates into zone + house occupancy. Call once per tick with the
   * current `now`. Returns the full occupancy snapshot including arrivals/departures and vacancy ages.
   */
  update(zones: Zone[], estimates: PresenceEstimate[], now: number): HouseOccupancy {
    // Bucket present users into zones (and an "unassigned" bucket for present-but-unmapped rooms).
    const zoneOccupants = new Map<string, Set<string>>();
    for (const z of zones) zoneOccupants.set(z.id, new Set());
    const housePresent = new Set<string>();
    for (const e of estimates) {
      if (!e.present) continue;
      housePresent.add(e.userId);
      const zid = zoneForEstimate(zones, e);
      if (zid) zoneOccupants.get(zid)!.add(e.userId);
    }

    const zoneOcc: ZoneOccupancy[] = zones.map((z) => {
      const occupants = zoneOccupants.get(z.id)!;
      const prev = this.prevZoneOccupants.get(z.id) ?? new Set<string>();
      const occupied = occupants.size > 0;

      // Maintain vacant-since: clear when occupied; stamp when it first goes (or starts) vacant.
      if (occupied) {
        this.zoneVacantSince.set(z.id, null);
      } else if (!this.zoneVacantSince.has(z.id) || this.zoneVacantSince.get(z.id) === null) {
        this.zoneVacantSince.set(z.id, now);
      }
      const since = this.zoneVacantSince.get(z.id) ?? null;
      const vacantForMs = occupied || since === null ? 0 : Math.max(0, now - since);

      const arrived = [...occupants].filter((u) => !prev.has(u));
      const departed = [...prev].filter((u) => !occupants.has(u));
      this.prevZoneOccupants.set(z.id, occupants);
      return { zoneId: z.id, name: z.name, occupants: [...occupants], occupied, vacantForMs, arrived, departed };
    });

    // House-level vacancy + transitions.
    const houseOccupied = housePresent.size > 0;
    if (houseOccupied) {
      this.houseVacantSince = null;
    } else if (this.houseVacantSince === null) {
      this.houseVacantSince = now;
    }
    const houseVacantForMs = houseOccupied || this.houseVacantSince === null ? 0 : Math.max(0, now - this.houseVacantSince);
    const arrived = [...housePresent].filter((u) => !this.prevHouseOccupants.has(u));
    const departed = [...this.prevHouseOccupants].filter((u) => !housePresent.has(u));
    this.prevHouseOccupants = housePresent;
    this.started = true;

    return { present: [...housePresent], occupied: houseOccupied, vacantForMs: houseVacantForMs, arrived, departed, zones: zoneOcc };
  }

  /** Whether the tracker has processed at least one update (so arrivals aren't all "new" on boot). */
  get initialized(): boolean {
    return this.started;
  }
}

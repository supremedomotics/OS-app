/**
 * Room hero imagery. A room's card/hero photo is, in priority order:
 *   1. the room's `heroImageUrl` — set once the hub has downloaded & STORED the photo locally
 *      (owner live photo, or an auto-pinned stock photo). Served from the hub, so it's identical on
 *      every page and every app (web / mobile / tablet) and works offline. A hub-relative path is
 *      resolved (with the access token) via `client.heroImageSrc`.
 *   2. a high-resolution stock photo chosen from the room's name/areaType, shown as a fallback
 *      WHILE the hub pins a local copy (see {@link ensureRoomHero}).
 *
 * Stock photos come from LoremFlickr (keyword-based, Creative-Commons) with a stable per-room `lock`
 * so the fallback doesn't reshuffle. If the network can't reach it, the card's dark gradient shows
 * through — graceful, never broken-looking.
 */
import type { SupremeClient } from "@supreme/sdk";
import type { RoomId } from "@supreme/domain-model";

export interface RoomLike {
  id?: string;
  name: string;
  areaType?: string | null;
  heroImageUrl?: string | null;
}

const AREA_KEYWORDS: Record<string, string> = {
  living: "living room",
  bedroom: "bedroom",
  kitchen: "kitchen",
  bathroom: "bathroom",
  office: "office",
  outdoor: "garden",
  utility: "laundry room",
  hallway: "hallway",
  other: "modern interior",
};

// Name-based overrides win over areaType — a "Conference" room shouldn't get a generic "other" photo.
const NAME_KEYWORDS: [RegExp, string][] = [
  [/conference|meeting|board\s?room/i, "conference room"],
  [/garage/i, "garage interior"],
  [/gym|fitness|workout/i, "home gym"],
  [/terrace|balcony/i, "terrace"],
  [/garden|yard|patio|outdoor/i, "garden"],
  [/dining/i, "dining room"],
  [/theat(er|re)|cinema|media/i, "home theater"],
  [/pool/i, "swimming pool"],
  [/kid|child|nursery/i, "kids room"],
  [/study|library|reading/i, "home library"],
  [/lobby|reception|foyer|entrance/i, "hotel lobby"],
  [/showroom/i, "showroom interior"],
  [/master\s?bed/i, "luxury bedroom"],
  [/living|lounge|family/i, "living room"],
  [/kitchen|pantry/i, "kitchen"],
];

/** Stable small hash of a string → positive int, used as the LoremFlickr `lock` (deterministic photo). */
function lockFor(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 100000;
}

function keywordFor(room: RoomLike): string {
  for (const [re, kw] of NAME_KEYWORDS) if (re.test(room.name)) return kw;
  return AREA_KEYWORDS[room.areaType ?? "other"] ?? AREA_KEYWORDS.other!;
}

/** The keyword-based stock photo URL (fallback shown until the hub has a local copy). */
function stockPhoto(room: RoomLike): string {
  const keyword = keywordFor(room);
  return `https://loremflickr.com/1200/800/${encodeURIComponent(keyword)}?lock=${lockFor(room.name + (room.areaType ?? ""))}`;
}

/**
 * The hero/card image URL for a room. If the hub has stored the photo locally (`heroImageUrl` set),
 * that hub-served image is used — identical everywhere. Otherwise a stock photo is shown as a
 * fallback. Pass the `client` so hub-relative paths resolve (with the access token).
 */
export function roomImage(room: RoomLike, client?: SupremeClient): string {
  const hero = room.heroImageUrl?.trim();
  if (hero) return (client?.heroImageSrc(hero) ?? hero) || stockPhoto(room);
  return stockPhoto(room);
}

// Rooms we've already asked the hub to pin, so we don't re-POST on every re-render.
const pinRequested = new Set<string>();

/**
 * Fire-and-forget: the first time a room without a stored hero is displayed, ask the hub to download
 * and store a stock photo locally. On success the next `home()` refresh returns a `heroImageUrl` and
 * every client then serves the identical local copy. Never throws — imagery is best-effort.
 */
export async function ensureRoomHero(client: SupremeClient, room: RoomLike): Promise<boolean> {
  if (!room.id || (room.heroImageUrl && room.heroImageUrl.trim()) || pinRequested.has(room.id)) return false;
  pinRequested.add(room.id);
  try {
    const res = await client.pinRoomHeroImage(room.id as RoomId);
    return res.pinned === true;
  } catch {
    pinRequested.delete(room.id);
    return false;
  }
}

/** Pin every room that has no stored hero yet; resolves true if any newly pinned (caller refreshes). */
export async function ensureRoomHeroes(client: SupremeClient, rooms: RoomLike[]): Promise<boolean> {
  const results = await Promise.all(rooms.map((r) => ensureRoomHero(client, r)));
  return results.some(Boolean);
}

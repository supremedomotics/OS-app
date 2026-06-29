/**
 * Room hero imagery. A room's card/hero photo is, in priority order:
 *   1. the owner-set `heroImageUrl` (future: a live photo they snap), else
 *   2. a high-resolution stock photo chosen from the room's name/areaType.
 *
 * The same function feeds the Home cards, the Rooms cards and the room detail hero, so a given room
 * looks identical everywhere. Stock photos come from LoremFlickr (keyword-based, Creative-Commons)
 * with a stable per-room `lock` so the image doesn't reshuffle on every load. If the network can't
 * reach it, the card's dark gradient simply shows through — graceful, never broken-looking.
 */
export interface RoomLike {
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

/** The hero/card image URL for a room (owner photo if set, else a curated stock photo by name). */
export function roomImage(room: RoomLike): string {
  if (room.heroImageUrl && room.heroImageUrl.trim()) return room.heroImageUrl;
  const keyword = keywordFor(room);
  return `https://loremflickr.com/1200/800/${encodeURIComponent(keyword)}?lock=${lockFor(room.name + (room.areaType ?? ""))}`;
}

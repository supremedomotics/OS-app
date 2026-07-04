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

/**
 * Luxury, Ovio-style palette + a subtle motif per room type, used to render a *designed* card
 * background when there's no photo yet — so a room never shows flat colour. Deep, moody two-tone
 * gradients (dark base → warm/cool accent) that read cleanly in both themes.
 */
const ROOM_STYLE: Record<string, { from: string; to: string; emoji: string }> = {
  "living room": { from: "#3a2a1c", to: "#12100e", emoji: "🛋" },
  "kitchen": { from: "#3a3320", to: "#121110", emoji: "🍽" },
  "bedroom": { from: "#2c2338", to: "#100f14", emoji: "🛏" },
  "luxury bedroom": { from: "#332740", to: "#110f16", emoji: "🛏" },
  "bathroom": { from: "#1e3336", to: "#0e1314", emoji: "🛁" },
  "office": { from: "#22303a", to: "#0e1114", emoji: "💼" },
  "home library": { from: "#2e2318", to: "#12100c", emoji: "📚" },
  "dining room": { from: "#3a2226", to: "#130f10", emoji: "🍷" },
  "home theater": { from: "#241f3a", to: "#0d0c14", emoji: "🎬" },
  "home gym": { from: "#1f3336", to: "#0d1213", emoji: "🏋" },
  "swimming pool": { from: "#153842", to: "#0b1417", emoji: "🏊" },
  "garden": { from: "#1f3324", to: "#0d130e", emoji: "🌿" },
  "terrace": { from: "#33301f", to: "#12110c", emoji: "🌆" },
  "garage interior": { from: "#2a2e33", to: "#101113", emoji: "🚗" },
  "kids room": { from: "#333a20", to: "#12130c", emoji: "🧸" },
  "hotel lobby": { from: "#332a1c", to: "#12100c", emoji: "🛎" },
  "conference room": { from: "#25303a", to: "#0e1013", emoji: "📊" },
  "showroom interior": { from: "#2f2a33", to: "#100f12", emoji: "✨" },
  "laundry room": { from: "#243033", to: "#0f1213", emoji: "🧺" },
  "hallway": { from: "#2c2a26", to: "#100f0e", emoji: "🚪" },
  "modern interior": { from: "#2a2a30", to: "#0f0f12", emoji: "🏠" },
};

/** A designed, deterministic background for a room with no photo (never flat colour). */
export function roomGradient(room: RoomLike): { backgroundImage: string; emoji: string } {
  const s = ROOM_STYLE[keywordFor(room)] ?? ROOM_STYLE["modern interior"]!;
  // A soft off-centre highlight + a diagonal deep gradient = a luxe, photographic feel.
  const angle = 120 + (lockFor(room.name) % 60);
  const backgroundImage =
    `radial-gradient(130% 110% at 78% 8%, ${s.from}cc, transparent 55%),` +
    `linear-gradient(${angle}deg, ${s.from} 0%, ${s.to} 78%)`;
  return { backgroundImage, emoji: s.emoji };
}

/**
 * The hero/card PHOTO url for a room, or `null` when there's no stored photo (the caller then paints
 * the {@link roomGradient}). A hub-stored photo (`heroImageUrl`) is resolved with the access token so
 * it's identical everywhere. We no longer point at an external stock CDN directly — an unreachable
 * URL just rendered as broken/flat colour; instead the hub fetches & stores the photo (see
 * {@link ensureRoomHero}) and the designed gradient covers the gap.
 */
export function roomImage(room: RoomLike, client?: SupremeClient): string | null {
  const hero = room.heroImageUrl?.trim();
  if (!hero) return null;
  return client?.heroImageSrc(hero) ?? hero;
}

/**
 * The background style for a room card/hero: a real photo (with a legibility scrim) when the hub has
 * one, else the designed gradient. `emoji` is the motif watermark to render only for the gradient
 * state. `scrim` controls how strong the bottom darkening is (heavier for the tall room hero).
 */
export function roomCardStyle(
  room: RoomLike,
  client?: SupremeClient,
  scrim = 0.72,
): { backgroundImage: string; backgroundSize: string; emoji: string | null } {
  const photo = roomImage(room, client);
  if (photo) {
    return { backgroundImage: `linear-gradient(180deg, transparent 38%, rgba(0,0,0,${scrim})), url("${photo}")`, backgroundSize: "cover", emoji: null };
  }
  const g = roomGradient(room);
  return { backgroundImage: g.backgroundImage, backgroundSize: "cover", emoji: g.emoji };
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

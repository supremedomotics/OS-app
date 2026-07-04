import type { Room } from "@supreme/domain-model";

/**
 * Server-side room hero imagery (§11). When a room has no owner-set photo, the hub picks a keyword
 * from the room's name/areaType, downloads ONE high-resolution stock photo, and stores the bytes
 * locally (in the durable home config) so every client — web, mobile, tablet — serves the identical
 * image from the hub, offline, forever. Mirrors the client keyword logic in
 * apps/web-homeowner/src/room-image.ts so a given room resolves to the same subject everywhere.
 */

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

// Name-based overrides win over areaType — a "Conference" room shouldn't get a generic photo.
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

/** Stable small hash → positive int, used as a deterministic photo `lock` per room name. */
function lockFor(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 100000;
}

export function heroKeyword(room: Pick<Room, "name" | "areaType">): string {
  for (const [re, kw] of NAME_KEYWORDS) if (re.test(room.name)) return kw;
  return AREA_KEYWORDS[room.areaType ?? "other"] ?? AREA_KEYWORDS.other!;
}

/** The external stock-photo source for a room (keyword-based, deterministic per room name). */
export function stockPhotoUrl(room: Pick<Room, "name" | "areaType">): string {
  const keyword = heroKeyword(room);
  return `https://loremflickr.com/1200/800/${encodeURIComponent(keyword)}?lock=${lockFor(room.name + (room.areaType ?? ""))}`;
}

/** A stored hero image: the raw bytes (base64) + content type + where it came from. */
export interface StoredHeroImage {
  contentType: string;
  /** base64-encoded image bytes. */
  dataBase64: string;
  /** "auto" (downloaded stock photo) or "upload" (owner-provided live photo). */
  source: "auto" | "upload";
  updatedAt: string;
}

export const heroImageKey = (roomId: string): string => `room_hero:${roomId}`;
export const heroImagePath = (roomId: string): string => `/v1/rooms/${roomId}/hero-image`;

const MAX_IMAGE_BYTES = 5_000_000; // 5 MB — generous for a 1200×800 JPEG, bounds config growth.

export class HeroImageError extends Error {}

/**
 * Download a keyword photo for the room and return it as a {@link StoredHeroImage}. Follows
 * redirects (LoremFlickr 302s to the chosen photo). Throws {@link HeroImageError} on any network /
 * size / type problem so the caller can leave the room's hero unset (clients then show the gradient
 * fallback) — imagery must never break room creation.
 */
export async function downloadHeroImage(
  room: Pick<Room, "name" | "areaType">,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<StoredHeroImage> {
  const url = stockPhotoUrl(room);
  let res: Response;
  try {
    res = await fetchImpl(url, { redirect: "follow" });
  } catch (err) {
    throw new HeroImageError(`hero image fetch failed: ${(err as Error).message}`);
  }
  if (!res.ok) throw new HeroImageError(`hero image fetch failed: ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  if (!contentType.startsWith("image/")) throw new HeroImageError(`unexpected content-type: ${contentType}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0) throw new HeroImageError("empty image body");
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new HeroImageError("image too large");
  return { contentType, dataBase64: buf.toString("base64"), source: "auto", updatedAt: now().toISOString() };
}

/** Validate + normalize an owner-uploaded hero image (base64 data or a data: URL). */
export function heroImageFromUpload(
  input: { dataBase64?: unknown; dataUrl?: unknown; contentType?: unknown },
  now: () => Date = () => new Date(),
): StoredHeroImage {
  let contentType = typeof input.contentType === "string" ? input.contentType : "image/jpeg";
  let b64: string;
  if (typeof input.dataUrl === "string" && input.dataUrl.startsWith("data:")) {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(input.dataUrl);
    if (!m) throw new HeroImageError("malformed data URL");
    contentType = m[1]!;
    b64 = m[2]!;
  } else if (typeof input.dataBase64 === "string" && input.dataBase64.length > 0) {
    b64 = input.dataBase64;
  } else {
    throw new HeroImageError("dataBase64 or dataUrl is required");
  }
  if (!contentType.startsWith("image/")) throw new HeroImageError("content-type must be an image");
  const buf = Buffer.from(b64, "base64");
  if (buf.byteLength === 0) throw new HeroImageError("empty image");
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new HeroImageError("image too large");
  return { contentType, dataBase64: buf.toString("base64"), source: "upload", updatedAt: now().toISOString() };
}

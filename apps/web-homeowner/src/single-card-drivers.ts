/**
 * Drivers whose commissioned devices are each their own installed instance (per-device encrypted
 * credentials) but that a homeowner should still see as ONE extension. Shared by the Extension
 * Center and the Discover page so both collapse the same keys the same way.
 */
export const SINGLE_CARD_KEYS: ReadonlySet<string> = new Set(["supreme-rtsp-camera"]);

/** Keeps the first entry of each SINGLE_CARD_KEYS driver; every other driver passes through
 * untouched (e.g. Casambi's genuinely separate networks). */
export function firstPerSingleCardKey<T extends { key: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((d) => {
    if (!SINGLE_CARD_KEYS.has(d.key)) return true;
    if (seen.has(d.key)) return false;
    seen.add(d.key);
    return true;
  });
}

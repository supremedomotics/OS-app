/**
 * Room Assignment Engine (§ Automatic Room Assignment, Universal AV Driver SDK) —
 * generic, protocol-agnostic confidence-based room resolution for live device
 * discovery. Every SupremeOS driver that can supply a location hint (a room/zone
 * name a device genuinely carries) feeds it through the SAME engine here; the engine
 * decides whether that hint is trustworthy enough to auto-create/auto-assign a room
 * without installer interaction, or whether the device should land in a clearly
 * labeled "Unassigned" bucket instead of a silent guess.
 *
 * This supersedes the narrower position in ADR 0015 §2.3 ("AVR discovery gives no
 * reliable room signal, so the installer always assigns the room") — that was true
 * for classic Denon/Marantz Telnet specifically (verified: no room concept anywhere
 * in the protocol), but not for every AVR/media protocol, and the product decision is
 * now to auto-assign wherever a hint is trustworthy enough, tier by tier, rather than
 * requiring installer action uniformly. Denon Telnet devices still end up Unassigned
 * exactly as before (§ tier below), because they genuinely have no hint to give.
 *
 * This is a DIFFERENT engine from `./knx/room-assignment-engine.ts` (`assignRooms`),
 * which resolves rooms from a parsed ETS **project file's** building/floor/room tree —
 * a wholly different input shape (an offline project document, not a live discovery
 * hint) serving a different job (KNX import review) with its own 5-tier logic already
 * tested and shipping. That engine is untouched; this one is the new, generic seam
 * for live discovery across every protocol (AVR/HEOS/Yamaha today; Matter/KNX/
 * Zigbee/Z-Wave/BLE live discovery can adopt it the same way in a future session
 * without any change here).
 *
 * ## Confidence tiers (fixed, not tunable per protocol — the SOURCE a driver declares
 * is what varies, not the number)
 *
 *   100  `explicit_attribute`         — the protocol itself carries a real room/floor/
 *                                        building attribute (KNX ETS room, Matter Room/
 *                                        Location cluster, a Supreme-stored user room
 *                                        mapping). Always auto-assign.
 *    90  `persistent_user_zone_name`  — a persistent, user-configurable zone/room name
 *                                        the homeowner/installer set during that
 *                                        protocol's own setup flow (a Yamaha MusicCast
 *                                        zone name, a HEOS player name) — not a bare
 *                                        model string. Always auto-assign.
 *    70  `friendly_name_heuristic`    — a generic device/friendly name (SSDP
 *                                        friendlyName, a co-located discovery hint)
 *                                        that, once normalized (brand/protocol/generic
 *                                        AV noise words stripped), still contains a
 *                                        real word — auto-assign the normalized name.
 *   <70  —                             normalization left nothing meaningful (only
 *                                        noise words, or a bare IP/id) — never guess;
 *                                        the device goes to "Unassigned Devices" with
 *                                        the raw hint surfaced for the installer.
 *
 * Nothing is ever silently dropped: every decision is either `assign` (with the room
 * name and whether it's a new room) or `unassigned` (with a suggested name, if any, for
 * the installer to confirm) — mirroring this codebase's "never fabricate, never
 * discard" convention already established in `knx/room-assignment-engine.ts`.
 */

export type LocationHintSource = "explicit_attribute" | "persistent_user_zone_name" | "friendly_name_heuristic";

/** A location signal one driver's discovery genuinely carries. `raw` is the untouched
 * string the protocol reported (a room name, a zone label, a friendlyName) — never
 * pre-normalized by the driver; normalization is this engine's job so every driver
 * gets identical treatment. */
export interface LocationHint {
  raw: string;
  source: LocationHintSource;
}

export type RoomAssignmentDecision =
  | {
      kind: "assign";
      /** The resolved room name — either an existing room's exact name (reused, not
       * duplicated) or a new name to create. */
      roomName: string;
      /** Whether `roomName` doesn't already exist and must be created. */
      isNewRoom: boolean;
      confidence: number;
      source: LocationHintSource;
    }
  | {
      kind: "unassigned";
      /** A best-effort name to show the installer as a one-tap confirmation, or null
       * when there was no hint at all (nothing to suggest). Never auto-applied. */
      suggestedRoomName: string | null;
      confidence: number;
    };

const CONFIDENCE: Record<LocationHintSource, number> = {
  explicit_attribute: 100,
  persistent_user_zone_name: 90,
  friendly_name_heuristic: 70,
};

/** The confidence floor below which a decision must be `unassigned` — matches the
 * product-specified "confidence below 70% ⇒ do not guess" rule exactly. */
const AUTO_ASSIGN_THRESHOLD = 70;

/** Brand/protocol names — never part of a room name, stripped whether they appear as a
 * leading prefix ("Yamaha Living Room") or trailing suffix ("Living Room Yamaha"). */
const BRAND_WORDS = new Set(["denon", "marantz", "yamaha", "heos", "musiccast", "sonos", "wiim", "devialet"]);

/** Generic AV device-category words — stripped whether leading ("AVR 192.168.1.50",
 * a real driver-generated fallback name, see avr-driver.ts's `discover()`) or trailing
 * ("Living Room AVR", "Bedroom Receiver"). Deliberately NOT the KNX abbreviation
 * dictionary (`knx/name-cleanup.ts`) — that expands installer shorthand in an ETS
 * project; this strips category words from a live device's own advertised name.
 * Case-insensitive, whole-token only (never a substring match — "Barnaby" must not be
 * mangled by a "bar" noise word). */
const CATEGORY_WORDS = new Set(["avr", "receiver", "amp", "amplifier", "speaker", "speakers", "tv", "projector", "bar", "soundbar", "player"]);

/** "Main" (as in "main zone") is noise ONLY at the end of a hint ("Living Room Main",
 * a bare "Main" suffix) — a LEADING "Main" is never stripped, since "Main Street
 * Loft"/"Main House" are legitimate room names and losing "Main" there would be wrong.
 * Kept separate from {@link CATEGORY_WORDS} specifically so it never joins the
 * leading-strip pass. */
const TRAILING_ONLY_WORDS = new Set(["main"]);

function isZoneToken(token: string): boolean {
  return /^zone\d*$/.test(token.toLowerCase()); // "Zone", "Zone2", "zone3"
}
function isTrailingNoise(token: string): boolean {
  const t = token.toLowerCase();
  return CATEGORY_WORDS.has(t) || BRAND_WORDS.has(t) || TRAILING_ONLY_WORDS.has(t) || isZoneToken(t);
}
function isLeadingNoise(token: string): boolean {
  const t = token.toLowerCase();
  return CATEGORY_WORDS.has(t) || BRAND_WORDS.has(t);
}

/**
 * Strip trailing generic-AV-category/zone/brand noise tokens and leading brand
 * tokens, matching the product's own examples exactly: "Living Room AVR" → "Living
 * Room", "Conference Zone2" → "Conference", "Bedroom Receiver" → "Bedroom", "Yamaha
 * Living Room" → "Living Room". A category word ("Main", "AVR", …) is only ever
 * stripped from the END, never the start, so a legitimate room name like "Main
 * Street Loft" is left untouched. Returns "" when every token was noise (nothing
 * meaningful left) — the caller treats that as no hint.
 */
export function normalizeLocationName(raw: string): string {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let start = 0;
  let end = tokens.length;
  while (end > start && isTrailingNoise(tokens[end - 1]!)) end--;
  while (end > start && isLeadingNoise(tokens[start]!)) start++;
  return tokens.slice(start, end).join(" ").trim();
}

/** True when a normalized candidate actually reads as a place name — has at least one
 * alphabetic character, so a bare IP ("192.168.1.50") or numeric id left over after
 * stripping noise words is correctly treated as "no real hint", not a room. */
function looksLikeAName(candidate: string): boolean {
  return /[a-zA-Z]/.test(candidate);
}

/**
 * Resolve a single discovered device's room assignment. `existingRoomNames` should be
 * every room already in the home (case-insensitive exact match reuses the existing
 * room rather than creating a near-duplicate — "Living Room" never becomes both
 * "Living Room" and "living room" as two separate rooms).
 */
export function resolveRoomAssignment(hint: LocationHint | null | undefined, existingRoomNames: readonly string[]): RoomAssignmentDecision {
  if (!hint || !hint.raw.trim()) return { kind: "unassigned", suggestedRoomName: null, confidence: 0 };

  const confidence = CONFIDENCE[hint.source];
  const candidateName = hint.source === "friendly_name_heuristic" ? normalizeLocationName(hint.raw) : hint.raw.trim();

  if (confidence < AUTO_ASSIGN_THRESHOLD || !candidateName || !looksLikeAName(candidateName)) {
    // Normalization ate everything (pure noise) or left a non-name (bare IP/id) —
    // still worth suggesting the RAW hint to the installer, just never auto-applied.
    return { kind: "unassigned", suggestedRoomName: hint.raw.trim() || null, confidence };
  }

  const existing = existingRoomNames.find((r) => r.toLowerCase() === candidateName.toLowerCase());
  return {
    kind: "assign",
    roomName: existing ?? candidateName,
    isNewRoom: !existing,
    confidence,
    source: hint.source,
  };
}

/** The fixed, well-known room every `unassigned` device lands in — created once per
 * home, reused thereafter, so a run of low-confidence discoveries doesn't spawn a
 * pile of individually-unnamed rooms. Matches the product spec's own naming
 * ("Media → Unassigned Devices"). */
export const UNASSIGNED_ROOM_NAME = "Unassigned Devices";

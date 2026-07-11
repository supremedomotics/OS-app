/**
 * Name Cleanup (§ Device Name Cleanup). ETS names are written by installers under time
 * pressure and are full of shorthand — this expands common abbreviations into readable
 * words ("MB" → "Master Bedroom", "Sp1" → "Spot 1") so imported device/room names read
 * naturally without any manual renaming.
 */

/** Token → expansion, matched case-insensitively against a whole token (not a substring). */
const ABBREVIATIONS: Record<string, string> = {
  // Rooms
  mb: "Master Bedroom",
  mbr: "Master Bedroom",
  mstr: "Master",
  lr: "Living Room",
  liv: "Living",
  dr: "Dining Room",
  din: "Dining",
  kit: "Kitchen",
  kthn: "Kitchen",
  bd: "Bedroom",
  br: "Bedroom",
  bdrm: "Bedroom",
  bth: "Bathroom",
  bath: "Bathroom",
  wc: "Toilet",
  pwd: "Powder Room",
  gst: "Guest",
  grg: "Garage",
  corr: "Corridor",
  hw: "Hallway",
  strg: "Storage",
  bsmt: "Basement",
  att: "Attic",
  terr: "Terrace",
  bal: "Balcony",
  pat: "Patio",
  util: "Utility",
  ldry: "Laundry",
  ent: "Entrance",
  ext: "Exterior",
  int: "Interior",
  rm: "Room",
  // Floors
  gf: "Ground Floor",
  ff: "First Floor",
  sf: "Second Floor",
  tf: "Third Floor",
  // Functions
  curt: "Curtain",
  crt: "Curtain",
  sp: "Spot",
  sw: "Switch",
  dim: "Dimmer",
  fb: "Feedback",
  fdbk: "Feedback",
  stat: "Status",
  temp: "Temperature",
  ctrl: "Control",
};

/** True for an all-caps/all-digit token with no dictionary entry — a deliberate acronym
 * ("AC", "TV", "AV", "AHU") that should be left exactly as the installer wrote it. */
function looksLikeDeliberateAcronym(token: string): boolean {
  return token.length > 1 && /^[A-Z0-9]+$/.test(token);
}

function titleCaseWord(w: string): string {
  if (looksLikeDeliberateAcronym(w)) return w;
  if (/^[a-z]/.test(w)) return w.charAt(0).toUpperCase() + w.slice(1);
  return w;
}

/** "Sp1" → { base: "Sp", suffix: "1" }; "Curtain" → { base: "Curtain", suffix: "" }. */
function splitTrailingNumber(token: string): { base: string; suffix: string } {
  const m = /^([A-Za-z]+)(\d+)$/.exec(token);
  if (m) return { base: m[1]!, suffix: m[2]! };
  return { base: token, suffix: "" };
}

function expandToken(token: string): string {
  const { base, suffix } = splitTrailingNumber(token);
  const expanded = ABBREVIATIONS[base.toLowerCase()];
  if (expanded) return suffix ? `${expanded} ${suffix}` : expanded;
  return titleCaseWord(token);
}

/** Expand every whitespace-separated token in a single name/room segment. */
export function humanizeSegment(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  return trimmed
    .split(/\s+/)
    .filter(Boolean)
    .map(expandToken)
    .join(" ");
}

/** Split an ETS name on its common hierarchical separators ("Master Bedroom - Sheer
 * Curtains - Position" → ["Master Bedroom", "Sheer Curtains", "Position"]), trimming and
 * dropping empty segments. Deliberately does NOT split on "/" — that character shows up
 * inside compound function words installers write as one unit ("Up/Down", "On/Off",
 * "Open/Close"), never as a hierarchical separator the way "-"/"–" are. Shared by room
 * assignment and device recognition so both read the same segmentation of a raw ETS name. */
export function splitNameSegments(raw: string): string[] {
  return raw
    .split(/\s*[\-–·:|]\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Humanize every segment of a full ETS name and rejoin with " — ". */
export function humanizeName(raw: string): string {
  const segments = splitNameSegments(raw);
  if (segments.length === 0) return raw.trim();
  return segments.map(humanizeSegment).join(" — ");
}

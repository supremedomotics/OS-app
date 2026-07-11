import type { CapabilityKind } from "@supreme/domain-model";

/**
 * ETS group-address import (§4) — turn an exported KNX group-address table into Supreme
 * device cards. KNX has no live discovery (devices live in the ETS project), so the
 * installer exports the group addresses (ETS "Export Group Addresses" → CSV or XML) and
 * this module:
 *   1. parses each group address (address, name, datapoint type),
 *   2. infers the Supreme capability from the DPT (refined by the name for ambiguous %),
 *   3. groups addresses that belong to the same device (by name, minus the function word),
 *   4. derives the room from the name (matched against the home's rooms).
 * The installer orchestrator then commissions each device into its room and binds every
 * capability to its group address. A real `.knxproj` importer can reuse steps 2–4.
 */

export interface KnxGroupAddress {
  address: string; // "1/1/3"
  name: string; // "Living Room Ceiling — Switch"
  dpt: string | null; // "1.001"
  /** The ETS Main Group name this address lives under, e.g. "Lighting" | "Curtain" |
   * "Scene" — the device-TYPE classification, read from the project's GroupRange tree
   * (or a "Main"/"Main Group" CSV column). Null when the source has no group hierarchy
   * (e.g. a flat GA list with only a combined Name column). */
  mainGroup?: string | null;
  /** The ETS Middle Group name, e.g. "Switching" | "Relative Dimming" | "Switching
   * Feedback" — the OPERATION classification (command vs. status/feedback, dimming
   * style, …). Same nullability as mainGroup. */
  middleGroup?: string | null;
}

export interface ImportedBinding {
  capability: CapabilityKind;
  address: string;
}

export interface ImportedDevice {
  name: string;
  room: string | null;
  bindings: ImportedBinding[];
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/** Parse an ETS group-address export — auto-detects the XML or CSV export format. */
export function parseKnxGroupExport(content: string): KnxGroupAddress[] {
  const text = content.trim();
  if (text.startsWith("<")) return parseXml(text);
  return parseCsv(text);
}

/**
 * ETS GA XML export: `<GroupAddress Name="…" Address="1/1/3" DPTs="DPST-1-1" />`, usually
 * nested inside `<GroupRange Name="…">` (Main Group) > `<GroupRange Name="…">` (Middle
 * Group) — the same hierarchy `.knxproj` files carry, so this tracks it the same way.
 */
function parseXml(text: string): KnxGroupAddress[] {
  const out: KnxGroupAddress[] = [];
  const groupRangeStack: string[] = [];
  const re = /<(\/?)(GroupRange|GroupAddress)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const close = m[1] === "/";
    const tag = m[2]!;
    const attrs = m[3] ?? "";
    const selfClose = m[4] === "/";

    if (tag === "GroupRange") {
      if (close) {
        if (groupRangeStack.length) groupRangeStack.pop();
      } else {
        groupRangeStack.push(attr(attrs, "Name") ?? "");
        if (selfClose) groupRangeStack.pop();
      }
      continue;
    }

    const address = attr(attrs, "Address");
    if (!address) continue;
    out.push({
      address,
      name: attr(attrs, "Name") ?? address,
      dpt: normalizeDpt(attr(attrs, "DPTs") ?? attr(attrs, "DatapointType")),
      mainGroup: groupRangeStack[0] || null,
      middleGroup: groupRangeStack[1] || null,
    });
  }
  return out;
}

function attr(s: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(s);
  return m ? (m[1] ?? null) : null;
}

/** ETS GA CSV export — flexible: auto-detects the separator and the name/address/DPT columns. */
function parseCsv(text: string): KnxGroupAddress[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const sep = pickSeparator(lines[0]!);
  const header = splitCsv(lines[0]!, sep).map((h) => h.toLowerCase().replace(/^"|"$/g, "").trim());
  const nameCol = header.findIndex((h) => h === "group name" || h === "name");
  const addrCol = header.findIndex((h) => h === "address" || h === "group address");
  const dptCol = header.findIndex((h) => h.includes("datapoint") || h === "dpt" || h.includes("data type"));
  // Some ETS CSV exports carry the Main/Middle group as their own columns instead of (or in
  // addition to) a combined path in the Name column.
  const mainCol = header.findIndex((h) => h === "main" || h === "main group");
  const middleCol = header.findIndex((h) => h === "middle" || h === "middle group");
  const hasHeader = addrCol >= 0;
  const rows = hasHeader ? lines.slice(1) : lines;
  const out: KnxGroupAddress[] = [];
  for (const line of rows) {
    const cells = splitCsv(line, sep).map((c) => c.replace(/^"|"$/g, "").trim());
    const address = (addrCol >= 0 ? cells[addrCol] : cells[1]) ?? "";
    if (!/^\d+\/\d+\/\d+$/.test(address)) continue; // only 3-level group addresses
    out.push({
      address,
      name: (nameCol >= 0 ? cells[nameCol] : cells[0]) || address,
      dpt: normalizeDpt(dptCol >= 0 ? cells[dptCol] ?? null : null),
      mainGroup: mainCol >= 0 ? cells[mainCol] || null : null,
      middleGroup: middleCol >= 0 ? cells[middleCol] || null : null,
    });
  }
  return out;
}

function pickSeparator(line: string): string {
  for (const s of [";", "\t", ","]) if (line.includes(s)) return s;
  return ";";
}
function splitCsv(line: string, sep: string): string[] {
  return line.split(sep);
}

/** Normalize an ETS DPT string ("DPST-1-1", "DPT-1", "1.001") to "major.minor" / "major". */
export function normalizeDpt(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = /DPST-(\d+)-(\d+)/i.exec(s);
  if (m) return `${m[1]}.${String(m[2]).padStart(3, "0")}`;
  m = /DPT-?(\d+)/i.exec(s);
  if (m && !s.includes(".")) return `${m[1]}`;
  m = /(\d+)\.(\d+)/.exec(s);
  if (m) return `${m[1]}.${m[2]}`;
  m = /^(\d+)$/.exec(s);
  return m ? m[1]! : null;
}

// ── Capability inference ───────────────────────────────────────────────────────

const FUNCTION_WORDS = [
  "switch", "toggle", "on/off", "onoff", "on off", "status", "state", "feedback",
  "dim", "dimming", "brightness", "value", "level",
  "blind", "blinds", "shutter", "shade", "shades", "cover", "covers", "position", "move", "up/down", "awning",
  "temperature", "temp", "setpoint", "set point", "current temp", "actual",
  "lock", "unlock",
  "rgb", "rgbw", "rgbww", "colour", "color", "colour temp", "color temp", "colour temperature",
  "color temperature", "cct", "tunable white", "warm white", "cool white",
];

/**
 * Infer the Supreme capability for a group address from its DPT (refined by the name, and
 * the ETS Main Group, for ambiguous DPTs). `mainGroup` is the address's ETS Main Group name
 * (e.g. "Lighting" | "Curtain" | "HVAC") when known — it disambiguates a bare DPT5.001
 * (used for both dimming % and cover position) more reliably than the name alone.
 */
export function inferCapability(dpt: string | null, name: string, mainGroup?: string | null): CapabilityKind | null {
  const major = dpt ? Number(dpt.split(".")[0]) : null;
  const minor = dpt?.includes(".") ? Number(dpt.split(".")[1]) : null;
  const n = name.toLowerCase();
  const g = (mainGroup ?? "").toLowerCase();
  const looksCover = /(blind|shutter|shade|cover|position|awning|curtain)/.test(n) || /(blind|shutter|shade|cover|curtain)/.test(g);
  const looksDim = /(dim|brightness|light|lamp|spot)/.test(n) || /(light|lighting|dim)/.test(g);

  switch (major) {
    case 232: // 232.600 RGB
    case 251: // 251.600 RGBW/RGBWW
      return "color";
    case 7: // 7.600 absolute colour temperature (Kelvin) — tunable white
      return minor === 600 ? "color" : "sensor";
    case 3: // 3.007/3.008 dimming control
      return "brightness";
    case 5: // 5.001 scaling 0..100% — brightness or position by name/group
      return looksCover ? "position" : "brightness";
    case 9: // 9.001 2-byte float (temperature etc.)
      return "temperature";
    case 1: // 1-bit boolean — switch, or blind up/down, or lock
      if (looksCover) return "position";
      if (/(lock|door)/.test(n)) return "lock";
      return "onoff";
    case 12:
    case 13:
    case 14:
      return "sensor";
    default:
      // No/unknown DPT: fall back to the name and Main Group.
      if (looksCover) return "position";
      if (/(rgbw|rgb|tunable|colou?r temp|cct|warm white|cool white)/.test(n)) return "color";
      if (looksDim) return "brightness";
      if (/(temp|climate|heating)/.test(n)) return "temperature";
      return major === null ? null : "onoff";
  }
}

/**
 * Classify the physical circuit a device's inferred bindings represent — purely a
 * human-facing label for the import review UI; it doesn't affect commissioning, which
 * only cares about the `bindings` capability list.
 */
export type KnxCircuitType = "onoff" | "dimmable" | "tunable_white" | "rgbww" | "cover" | "scene" | "climate" | "other";

export function classifyCircuit(bindings: ImportedBinding[]): KnxCircuitType {
  const caps = new Set(bindings.map((b) => b.capability));
  if (caps.has("color")) return caps.has("brightness") ? "tunable_white" : "rgbww";
  if (caps.has("position")) return "cover";
  if (caps.has("temperature")) return "climate";
  if (caps.has("brightness")) return "dimmable";
  if (caps.has("onoff")) return "onoff";
  return "other";
}

// ── Grouping into devices ───────────────────────────────────────────────────────

/**
 * Group flat group addresses into devices. The device name is the group-address name with
 * the trailing function word removed; the room is the matching known-room prefix (or the
 * first name segment). Status/feedback GAs merge into their device without duplicating a
 * capability.
 */
export function groupIntoDevices(addresses: KnxGroupAddress[], knownRooms: string[] = []): ImportedDevice[] {
  const rooms = knownRooms.map((r) => ({ raw: r, lc: r.toLowerCase() }));
  const byKey = new Map<string, ImportedDevice>();

  for (const ga of addresses) {
    const cap = inferCapability(ga.dpt, ga.name, ga.mainGroup);
    if (!cap) continue;
    const { device, room } = splitName(ga.name, rooms);
    const key = `${room ?? ""}::${device.toLowerCase()}`;
    let dev = byKey.get(key);
    if (!dev) {
      dev = { name: device || ga.name, room, bindings: [] };
      byKey.set(key, dev);
    }
    if (!dev.bindings.some((b) => b.capability === cap)) {
      dev.bindings.push({ capability: cap, address: ga.address });
    }
  }
  return [...byKey.values()].filter((d) => d.bindings.length > 0);
}

function splitName(name: string, rooms: { raw: string; lc: string }[]): { device: string; room: string | null } {
  // Tokenize on common ETS separators.
  const parts = name.split(/\s*[/\-–·:|]\s*/).map((p) => p.trim()).filter(Boolean);
  let room: string | null = null;

  // Room = a part (or prefix) that matches a known room name.
  const lcName = name.toLowerCase();
  for (const r of rooms) {
    if (lcName.includes(r.lc)) {
      room = r.raw;
      break;
    }
  }
  if (!room && parts.length > 1) room = parts[0]!; // fall back to first segment

  // Drop the trailing function word(s) and the room segment to get the device name.
  const deviceParts = parts.filter((p) => {
    const lc = p.toLowerCase();
    if (room && lc === room.toLowerCase()) return false;
    return !FUNCTION_WORDS.includes(lc);
  });
  const device = (deviceParts.length > 0 ? deviceParts : parts).join(" ").trim();
  return { device: device || name, room };
}

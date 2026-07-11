import { normalizeDpt } from "./dpt-analyzer.js";
import { emptyProjectModel, type KnxGroupAddressRecord, type KnxProjectModel } from "./types.js";

/**
 * Flat group-address export parser (§ Supported Import Formats — "ETS XML Export"). Some
 * installers export just the group-address table (ETS "Export Group Addresses" → CSV or a
 * standalone `<GroupAddress>` XML list) rather than a full `.knxproj`. There's no building
 * tree or communication-object detail in this shape, but the Main/Middle Group hierarchy
 * is still present (nested `<GroupRange>` in XML, or explicit Main/Middle CSV columns) and
 * is parsed the same way the full project parser does.
 */

function attr(s: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(s);
  return m ? (m[1] ?? null) : null;
}

function parseGaExportXml(text: string): KnxProjectModel {
  const model = emptyProjectModel(null);
  const groupRangeStack: string[] = [];
  const re = /<(\/?)(GroupRange|GroupAddress)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    const close = m[1] === "/";
    const tag = m[2]!;
    const a = m[3] ?? "";
    const selfClose = m[4] === "/";

    if (tag === "GroupRange") {
      if (close) {
        if (groupRangeStack.length) groupRangeStack.pop();
      } else {
        groupRangeStack.push(attr(a, "Name") ?? "");
        if (selfClose) groupRangeStack.pop();
      }
      continue;
    }

    const address = attr(a, "Address");
    if (!address) continue;
    n++;
    // Prefer the ETS-native Id; otherwise the ADDRESS itself is a far more stable
    // synthetic id than a positional counter — it's what the Learning Engine's
    // fingerprint is ultimately built from, and it stays the same across re-imports
    // even when row order in the export changes (unlike "ga-1", "ga-2", …).
    const id = attr(a, "Id") ?? `ga:${address}`;
    const record: KnxGroupAddressRecord = {
      id,
      address,
      name: attr(a, "Name") ?? address,
      description: attr(a, "Description"),
      comment: attr(a, "Comment"),
      dpt: normalizeDpt(attr(a, "DPTs") ?? attr(a, "DatapointType")),
      mainGroup: groupRangeStack[0] || null,
      middleGroup: groupRangeStack[1] || null,
      comObjectIds: [],
    };
    model.groupAddresses.set(id, record);
  }
  return model;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}
function pickSeparator(line: string): string {
  for (const s of [";", "\t", ","]) if (line.includes(s)) return s;
  return ";";
}

function parseGaExportCsv(text: string): KnxProjectModel {
  const model = emptyProjectModel(null);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return model;
  const sep = pickSeparator(lines[0]!);
  const header = lines[0]!.split(sep).map((h) => stripQuotes(h).toLowerCase());
  const nameCol = header.findIndex((h) => h === "group name" || h === "name");
  const addrCol = header.findIndex((h) => h === "address" || h === "group address");
  const dptCol = header.findIndex((h) => h.includes("datapoint") || h === "dpt" || h.includes("data type"));
  const descCol = header.findIndex((h) => h.startsWith("description"));
  const commentCol = header.findIndex((h) => h.startsWith("comment"));
  const mainCol = header.findIndex((h) => h === "main" || h === "main group");
  const middleCol = header.findIndex((h) => h === "middle" || h === "middle group");
  const hasHeader = addrCol >= 0;
  const rows = hasHeader ? lines.slice(1) : lines;

  for (const line of rows) {
    const cells = line.split(sep).map(stripQuotes);
    const address = (addrCol >= 0 ? cells[addrCol] : cells[1]) ?? "";
    if (!/^\d+\/\d+\/\d+$/.test(address)) continue; // only 3-level group addresses
    // The address itself is the stable id (see the XML path's comment above) — CSV
    // exports never carry a native ETS Id.
    const id = `ga:${address}`;
    model.groupAddresses.set(id, {
      id,
      address,
      name: (nameCol >= 0 ? cells[nameCol] : cells[0]) || address,
      description: descCol >= 0 ? cells[descCol] || null : null,
      comment: commentCol >= 0 ? cells[commentCol] || null : null,
      dpt: normalizeDpt(dptCol >= 0 ? cells[dptCol] ?? null : null),
      mainGroup: mainCol >= 0 ? cells[mainCol] || null : null,
      middleGroup: middleCol >= 0 ? cells[middleCol] || null : null,
      comObjectIds: [],
    });
  }
  return model;
}

/** Parse a flat ETS group-address export — auto-detects XML vs. CSV. */
export function parseGaExport(content: string): KnxProjectModel {
  const text = content.trim();
  if (text.startsWith("<")) return parseGaExportXml(text);
  return parseGaExportCsv(text);
}

import { emptyProjectModel, type KnxGroupAddressRecord, type KnxProjectModel } from "./types.js";

/**
 * `.esf` parser (§ Supported Import Formats). ESF ("ETS Sequence File" / "OPC export") is
 * ETS's tab-delimited group-address export for third-party BMS/OPC integration:
 *
 *   "Name"	"Address"	"Central"	"Unfiltered"	"Description"
 *   "Living Room Light Switch"	"1/1/1"	"1"	"0"	""
 *
 * It is a flatter format than `.knxproj`/ETS XML: no DPT, no building tree, no
 * communication-object flags — just a name, a 3-level group address, and an optional
 * description. Downstream recognition is expected to lean more on name/Main-Group signals
 * for ESF-sourced imports, since the datapoint type genuinely isn't present in the source
 * (never fabricated here).
 */

function stripQuotes(s: string): string {
  const t = s.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

function pickSeparator(line: string): string {
  if (line.includes("\t")) return "\t";
  for (const s of [";", ","]) if (line.includes(s)) return s;
  return "\t";
}

/** True for a 3-level KNX group address, e.g. "1/1/3". */
function isGroupAddress(s: string): boolean {
  return /^\d+\/\d+\/\d+$/.test(s);
}

export function parseEsf(text: string): KnxProjectModel {
  const model = emptyProjectModel(null);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return model;

  const sep = pickSeparator(lines[0]!);
  const header = lines[0]!.split(sep).map((h) => stripQuotes(h).toLowerCase().trim());
  const nameCol = header.findIndex((h) => h === "name");
  const addrCol = header.findIndex((h) => h === "address");
  const descCol = header.findIndex((h) => h.startsWith("description") || h.startsWith("comment"));
  const hasHeader = addrCol >= 0 || nameCol >= 0;
  const rows = hasHeader ? lines.slice(1) : lines;

  for (const line of rows) {
    const cells = line.split(sep).map(stripQuotes);
    // Without a header, find the first cell that looks like a group address; the name is
    // conventionally the first cell.
    const address = addrCol >= 0 ? cells[addrCol] ?? "" : (cells.find(isGroupAddress) ?? "");
    if (!isGroupAddress(address)) continue;
    const name = (nameCol >= 0 ? cells[nameCol] : cells[0]) || address;
    const description = descCol >= 0 ? cells[descCol] || null : null;

    // The address itself is a far more stable synthetic id than a positional counter —
    // it's what the Learning Engine's fingerprint is ultimately built from, and it stays
    // the same across re-imports even when row order in the export changes.
    const id = `ga:${address}`;
    const record: KnxGroupAddressRecord = {
      id,
      address,
      name,
      description,
      comment: null,
      // ESF genuinely carries no datapoint type — left null, not guessed, so downstream
      // recognition correctly falls back to name/Main-Group signals for this address.
      dpt: null,
      mainGroup: null,
      middleGroup: null,
      comObjectIds: [],
    };
    model.groupAddresses.set(id, record);
  }
  return model;
}

/** True when `text` looks like an `.esf` export (tab-delimited, or a Name/Address-only
 * header with no DatapointType column) rather than XML or the richer GA-export CSV. */
export function looksLikeEsf(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith("<")) return false;
  const firstLine = trimmed.split(/\r?\n/)[0] ?? "";
  if (firstLine.includes("\t")) return true;
  const fields = firstLine.split(/[;,]/).map((f) => stripQuotes(f).toLowerCase().trim());
  return fields.includes("name") && fields.includes("address") && !fields.some((f) => f.includes("datapoint"));
}

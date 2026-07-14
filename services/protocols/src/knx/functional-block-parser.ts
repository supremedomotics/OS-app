/**
 * Functional Block Parser (§ Unified Device Intelligence — Phase 3).
 *
 * Parses a CoAP Link-Format (RFC 6690) response body — the real wire format the KNX
 * IoT Point API returns from `/fb` and `/.well-known/core` — into a protocol-
 * independent model. This is a real RFC 6690 parser (comma-separated `<href>;attr=val`
 * entries), not a KNX-specific guess at binary layout.
 *
 * KNX IoT's own resource-type (`rt`) vocabulary for functional blocks is defined by the
 * Association's schema (Datapoint.json / functional block catalog) — this codebase has
 * not ingested that catalog (see the Compatibility Report), so datapoint
 * readable/writable/feedback classification below is a documented HEURISTIC over the
 * `if=` (interface) attribute's own well-known values (`if.s` sensor/readable,
 * `if.a` actuator/writable, `if.b`/`if.c` batch — mirroring the general CoAP/OCF
 * interface-description convention KNX IoT itself is built on), not the exact official
 * catalog. Never presented as more certain than that.
 */

export interface FunctionalBlock {
  href: string;
  /** Resource-type attribute values, e.g. `["urn:knx:fb.1"]` — raw, protocol-native. */
  resourceTypes: string[];
  /** Interface-description attribute values, e.g. `["if.s"]`. */
  interfaces: string[];
  title: string | null;
  contentFormat: string | null;
  readable: boolean;
  writable: boolean;
  /** True when this block's `if` marks it as a status/feedback resource (`if.s` alone,
   * no `if.a`) — i.e. it reports state but cannot be commanded. */
  feedbackOnly: boolean;
}

export interface ParsedFunctionalBlocks {
  blocks: FunctionalBlock[];
  readableHrefs: string[];
  writableHrefs: string[];
  feedbackHrefs: string[];
}

/** Splits a Link-Format value list on commas that are NOT inside a quoted string. */
function splitTopLevel(body: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === '"') depth = depth === 0 ? 1 : 0;
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

function parseAttrValue(raw: string): string[] {
  const trimmed = raw.trim().replace(/^"|"$/g, "");
  return trimmed.split(/\s+/).filter(Boolean);
}

/** Parses one Link-Format entry (`<href>;rt="...";if="...";title="...";ct=60`). */
function parseEntry(entry: string): FunctionalBlock | null {
  const hrefMatch = entry.match(/<([^>]*)>/);
  if (!hrefMatch) return null;
  const href = hrefMatch[1]!;
  const rest = entry.slice(entry.indexOf(">") + 1);

  let resourceTypes: string[] = [];
  let interfaces: string[] = [];
  let title: string | null = null;
  let contentFormat: string | null = null;

  for (const rawAttr of splitTopLevel(rest, ";")) {
    const attr = rawAttr.trim();
    if (!attr) continue;
    const eq = attr.indexOf("=");
    if (eq === -1) continue;
    const name = attr.slice(0, eq).trim();
    const value = attr.slice(eq + 1);
    if (name === "rt") resourceTypes = parseAttrValue(value);
    else if (name === "if") interfaces = parseAttrValue(value);
    else if (name === "title") title = value.trim().replace(/^"|"$/g, "");
    else if (name === "ct") contentFormat = value.trim().replace(/^"|"$/g, "");
  }

  const hasSensorIf = interfaces.some((i) => i === "if.s" || i.startsWith("if.s."));
  const hasActuatorIf = interfaces.some((i) => i === "if.a" || i.startsWith("if.a."));

  return {
    href,
    resourceTypes,
    interfaces,
    title,
    contentFormat,
    readable: hasSensorIf || hasActuatorIf || interfaces.length === 0,
    writable: hasActuatorIf,
    feedbackOnly: hasSensorIf && !hasActuatorIf,
  };
}

/** Parses a full Link-Format body into functional blocks, and buckets their hrefs by
 * readable/writable/feedback per the interface-description heuristic documented above. */
export function parseFunctionalBlocks(linkFormatBody: string): ParsedFunctionalBlocks {
  const blocks = splitTopLevel(linkFormatBody.trim(), ",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map(parseEntry)
    .filter((b): b is FunctionalBlock => b !== null);

  return {
    blocks,
    readableHrefs: blocks.filter((b) => b.readable).map((b) => b.href),
    writableHrefs: blocks.filter((b) => b.writable).map((b) => b.href),
    feedbackHrefs: blocks.filter((b) => b.feedbackOnly).map((b) => b.href),
  };
}

import type { RawCoolMasterUnitJson } from "./coolmaster-rest-protocol.js";
import { SUPREME_MODE_FROM_COOLMASTER } from "./coolmaster-constants.js";
import type {
  CoolMasterGatewayInfo,
  CoolMasterGroupInfo,
  CoolMasterLineInfo,
  CoolMasterMainControllerStatus,
  CoolMasterModeWord,
  CoolMasterTransportKind,
  CoolMasterUnitStatus,
  CoolMasterVentilationStatus,
  CoolMasterWaterHeaterStatus,
} from "./coolmaster-types.js";

/**
 * Parses both wire formats into CoolMasterUnitStatus / gateway / line models.
 *
 * CONFIDENCE LEVELS (§ "do not guess behavior when the documentation provides an
 * answer" — being explicit about which parts are which):
 *  - `ls2` line shape (uid/on-off/setpoint/room-temp/fan-speed/mode/exit-code) is HIGH
 *    confidence: it matches this codebase's PRIOR, test-validated driver exactly.
 *  - REST v2 JSON field names (uid/onoff/mode/st/rt/fspeed/filt/dmnd/fault) are HIGH
 *    confidence: given verbatim in docs/coolmaster/CoolMaster_Core_Reference_Part5_v1.0.txt §5/§11.
 *  - `swing`/`lock`/`inhibit` positions in either format are MEDIUM confidence: the
 *    commands exist and are documented by name (Part 4 §13/§22/§23), but neither
 *    reference source gives the exact ls2/JSON field that reports their CURRENT value,
 *    only how to SET them. Parsed defensively (tolerate presence or absence) and never
 *    assumed present — see parseUnitLine's/parseUnitJson's inline notes below.
 *  - `query`/`info`/`line` responses are LOW confidence on exact format: the docs name
 *    these commands and what they should expose but not their line syntax. Parsed as
 *    generic `key: value` / `key=value` / `key value` pairs (a common, low-risk pattern
 *    for line-oriented device protocols) rather than assuming a specific column layout.
 */

// ── UID ──────────────────────────────────────────────────────────────────────────

/** Matches the three UID shapes docs/coolmaster/CoolMaster_Core_Reference_v1.0.txt §6
 * names (plain, "UID Strict", "4-Digit UID") without committing to exactly one: a
 * leading letter (device-type/line prefix: L=indoor line, W=water heater, M=main
 * controller), one or more digit groups, dot-separated. */
const UID_PATTERN = /^[A-Za-z]\d+(?:\.\d+)+$/;

export function isCoolMasterUid(s: string): boolean {
  return UID_PATTERN.test(s.trim());
}

/** The HVAC line segment of a UID, e.g. "L1.100" -> "L1". */
export function lineOfUid(uid: string): string {
  const dot = uid.indexOf(".");
  return dot === -1 ? uid : uid.slice(0, dot);
}

// ── Temperature ──────────────────────────────────────────────────────────────────

/** Parses a temperature token that may carry an explicit unit suffix ("24.0C"/"75F") or
 * none (bare number, unit implied by the gateway's configured `set` temperature-units —
 * this driver assumes Celsius when no suffix is present, since Supreme's domain model is
 * Celsius-only; a Fahrenheit-configured gateway with no per-value suffix would need its
 * `set` output cross-checked, called out in docs/coolmaster/README.md Limitations). */
export function parseTemperatureToken(token: string): number | null {
  const m = /^(-?\d+(?:\.\d+)?)\s*([CF])?$/i.exec(token.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (Number.isNaN(n)) return null;
  return m[2]?.toUpperCase() === "F" ? Math.round(((n - 32) * 5) / 9 * 10) / 10 : n;
}

// ── Mode ─────────────────────────────────────────────────────────────────────────

const MODE_WORD_SET = new Set<string>(["cool", "heat", "auto", "dry", "fan"]);

function parseModeWord(word: string | undefined): CoolMasterModeWord | null {
  const lower = (word ?? "").toLowerCase();
  return MODE_WORD_SET.has(lower) ? (lower as CoolMasterModeWord) : null;
}

export function supremeModeFromCoolMaster(mode: CoolMasterModeWord | null, on: boolean): "off" | "heat" | "cool" | "auto" | "fan_only" {
  if (!on || !mode) return "off";
  return SUPREME_MODE_FROM_COOLMASTER[mode];
}

// ── ASCII ls2 line ───────────────────────────────────────────────────────────────

/** Parses one `ls2` response line. Real firmware has been observed (and this codebase's
 * prior driver validated) using whitespace-separated tokens; some configurations use
 * comma separation instead — tolerating either costs nothing and avoids a hard
 * dependency on one exact delimiter. Shape:
 * `<uid> <ON|OFF> <setC> <roomC> <fanSpeed> <mode> <exitCode> [extra...]` */
export function parseLs2Line(line: string, source: CoolMasterTransportKind = "ascii"): CoolMasterUnitStatus | null {
  const t = line.trim().split(/[\s,]+/).filter(Boolean);
  if (t.length < 6 || !isCoolMasterUid(t[0] ?? "")) return null;
  const uid = t[0]!;
  const on = (t[1] ?? "").toUpperCase() === "ON";
  const mode = parseModeWord(t[5]);
  return {
    uid,
    line: lineOfUid(uid),
    on,
    setpointC: parseTemperatureToken(t[2] ?? ""),
    roomC: parseTemperatureToken(t[3] ?? ""),
    mode,
    fanSpeed: t[4] ?? null,
    // Neither reference source documents ls2 carrying swing/lock/inhibit as a column —
    // only `query` is described as returning "detailed information" (Part 4 §18). Left
    // null here; populated from `query` where available (see mergeQueryDetail below).
    swing: null,
    filterWarning: null,
    demand: null,
    faultCode: null,
    locked: null,
    inhibited: null,
    exitCode: t[6] ?? "OK",
    source,
  };
}

/** Parses a whole `ls2` response block (all lines returned before the next prompt). */
export function parseLs2Block(lines: string[]): CoolMasterUnitStatus[] {
  return lines.map((l) => parseLs2Line(l)).filter((u): u is CoolMasterUnitStatus => u !== null);
}

/** Parses one `ls` (basic) response line — used only as a discovery fallback when `ls2`
 * is unavailable, since `ls` (Part 4 §16) is documented as a plain listing without the
 * richer fields `ls2` carries. */
export function parseLsLine(line: string): { uid: string; on: boolean } | null {
  const t = line.trim().split(/[\s,]+/).filter(Boolean);
  if (t.length < 2 || !isCoolMasterUid(t[0] ?? "")) return null;
  return { uid: t[0]!, on: (t[1] ?? "").toUpperCase() === "ON" };
}

// ── REST v2 JSON ─────────────────────────────────────────────────────────────────

function truthy(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toUpperCase() === "ON" || v === "1" || v.toLowerCase() === "true";
  if (typeof v === "number") return v !== 0;
  return null;
}

/** Parses one row of a REST v2 `ls`/`ls2` response using the field names given verbatim
 * in docs/coolmaster/CoolMaster_Core_Reference_Part5_v1.0.txt §5/§11: uid, onoff, mode,
 * st (setpoint), rt (room temp), fspeed, filt, dmnd, fault. `swing`/`lock`/`inhibit` are
 * read if present but their JSON key names are NOT documented (see module doc) — read
 * defensively under their most-likely names, never required. */
export function parseUnitJson(row: RawCoolMasterUnitJson): CoolMasterUnitStatus | null {
  const uid = typeof row.uid === "string" ? row.uid : null;
  if (!uid || !isCoolMasterUid(uid)) return null;
  const on = truthy(row.onoff) ?? false;
  const mode = typeof row.mode === "string" ? parseModeWord(row.mode) : null;
  return {
    uid,
    line: lineOfUid(uid),
    on,
    setpointC: typeof row.st === "number" ? row.st : parseTemperatureToken(String(row.st ?? "")),
    roomC: typeof row.rt === "number" ? row.rt : parseTemperatureToken(String(row.rt ?? "")),
    mode,
    fanSpeed: typeof row.fspeed === "string" ? row.fspeed : null,
    swing: typeof row.swing === "string" ? row.swing : null,
    filterWarning: "filt" in row ? truthy(row.filt) : null,
    demand: "dmnd" in row ? truthy(row.dmnd) : null,
    faultCode: row.fault != null && row.fault !== "" && row.fault !== 0 ? String(row.fault) : null,
    locked: "lock" in row ? truthy(row.lock) : null,
    inhibited: "inhibit" in row ? truthy(row.inhibit) : null,
    exitCode: "OK",
    source: "rest",
  };
}

export function parseUnitJsonList(rows: RawCoolMasterUnitJson[]): CoolMasterUnitStatus[] {
  return rows.map(parseUnitJson).filter((u): u is CoolMasterUnitStatus => u !== null);
}

// ── Generic key/value responses (query, info, line, set) ────────────────────────

/** Parses a response as generic key/value pairs — tolerant of "key: value", "key=value",
 * and "key value" (single space) forms, since `query`/`info`/`line`/`set` (Part 3 §1,
 * Part 4 §18) are documented by the FIELDS they should expose, not their exact line
 * syntax. Keys are lower-cased for case-insensitive lookup. */
export function parseKeyValueLines(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const m = /^([A-Za-z0-9_.\-]+)\s*[:=]?\s+(.+)$/.exec(line.trim());
    if (m?.[1] && m[2] !== undefined) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

/** Builds gateway info from a parsed `info` response. Field names ("serial",
 * "firmware"/"version", "application") are best-effort guesses at common labels — see
 * module doc; a gateway using different labels simply leaves those fields null rather
 * than throwing, since gateway identity (serial) is load-bearing for REST URL building
 * and must degrade gracefully, not crash discovery. */
export function parseGatewayInfo(lines: string[], host: string): CoolMasterGatewayInfo {
  const kv = parseKeyValueLines(lines);
  const serial = kv["serial"] ?? kv["serial number"] ?? kv["sn"] ?? kv["id"] ?? host;
  const firmwareVersion = kv["firmware"] ?? kv["firmware version"] ?? kv["version"] ?? kv["fw"] ?? "unknown";
  const application = kv["application"] ?? kv["app"] ?? kv["model"] ?? null;
  return { serial, firmwareVersion, application, host };
}

/** Builds HVAC line info from a parsed `line` response — one CoolMasterLineInfo per
 * line-shaped token found (e.g. "L1", "L2"), tolerant of however much detail this
 * gateway actually reports per line. */
export function parseLineInfo(lines: string[]): CoolMasterLineInfo[] {
  const out: CoolMasterLineInfo[] = [];
  for (const raw of lines) {
    const t = raw.trim().split(/[\s,]+/).filter(Boolean);
    const id = t[0];
    if (!id || !/^L\d+$/i.test(id)) continue;
    const kv = parseKeyValueLines([t.slice(1).join(" ")]);
    out.push({
      id: id.toUpperCase(),
      manufacturer: kv["manufacturer"] ?? kv["type"] ?? kv["brand"] ?? null,
      active: !/disabled|inactive|off/i.test(raw),
    });
  }
  return out;
}

/** Overlays `query <uid>`'s richer per-unit detail (filter/demand/fault/lock/inhibit —
 * the fields ls2 doesn't reliably carry, per this module's confidence notes) onto an
 * already-parsed unit status from ls2/ls. Missing keys leave the base value untouched. */
export function mergeQueryDetail(base: CoolMasterUnitStatus, queryLines: string[]): CoolMasterUnitStatus {
  const kv = parseKeyValueLines(queryLines);
  const boolField = (...keys: string[]): boolean | null => {
    for (const k of keys) {
      if (k in kv) return truthy(kv[k]) ?? /yes|on|true|1/i.test(kv[k] ?? "");
    }
    return null;
  };
  return {
    ...base,
    swing: kv["swing"] ?? base.swing,
    filterWarning: boolField("filter", "filt") ?? base.filterWarning,
    demand: boolField("demand", "dmnd") ?? base.demand,
    faultCode: kv["fault"] && kv["fault"] !== "0" && kv["fault"].toUpperCase() !== "OK" ? kv["fault"] : base.faultCode,
    locked: boolField("lock", "locked") ?? base.locked,
    inhibited: boolField("inhibit", "inhibited") ?? base.inhibited,
  };
}

// ── Secondary device types (water heater / ventilation / main controller / group) ──
//
// LOW confidence (see coolmaster-commands.ts's matching note): the reference docs name
// these commands without a bare-word "list" form being documented either way. These
// parsers assume a bare `wh`/`vam`/`main`/`group` response follows the SAME per-line
// shape as `ls`/`ls2` (uid first, then on/off, then type-specific fields) — the
// protocol's one consistent listing pattern — and are used ONLY inside try/catch'd
// discovery calls (coolmaster-discovery.ts) that treat any failure as "this gateway has
// none of this device type" rather than a driver error.

export function parseWaterHeaterLine(line: string): CoolMasterWaterHeaterStatus | null {
  const t = line.trim().split(/[\s,]+/).filter(Boolean);
  if (t.length < 2 || !isCoolMasterUid(t[0] ?? "")) return null;
  return {
    uid: t[0]!,
    on: (t[1] ?? "").toUpperCase() === "ON",
    setpointC: parseTemperatureToken(t[2] ?? ""),
    roomC: parseTemperatureToken(t[3] ?? ""),
    faultCode: t[4] && t[4].toUpperCase() !== "OK" ? t[4] : null,
  };
}

export function parseVentilationLine(line: string): CoolMasterVentilationStatus | null {
  const t = line.trim().split(/[\s,]+/).filter(Boolean);
  if (t.length < 2 || !isCoolMasterUid(t[0] ?? "")) return null;
  return {
    uid: t[0]!,
    on: (t[1] ?? "").toUpperCase() === "ON",
    fanSpeed: t[2] ?? null,
    faultCode: t[3] && t[3].toUpperCase() !== "OK" ? t[3] : null,
  };
}

export function parseMainControllerLine(line: string): CoolMasterMainControllerStatus | null {
  const t = line.trim().split(/[\s,]+/).filter(Boolean);
  if (t.length < 2 || !isCoolMasterUid(t[0] ?? "")) return null;
  return {
    uid: t[0]!,
    on: (t[1] ?? "").toUpperCase() === "ON",
    faultCode: t[2] && t[2].toUpperCase() !== "OK" ? t[2] : null,
  };
}

/** `<groupId> <label?> <memberUid> [memberUid...]` — inferred shape; a gateway that puts
 * the label elsewhere or omits it entirely still yields a usable group (id + members). */
export function parseGroupLine(line: string): CoolMasterGroupInfo | null {
  const t = line.trim().split(/[\s,]+/).filter(Boolean);
  if (t.length < 2) return null;
  const id = t[0]!;
  const memberUids = t.slice(1).filter(isCoolMasterUid);
  if (memberUids.length === 0) return null;
  const labelTokens = t.slice(1, t.length - memberUids.length);
  return { id, label: labelTokens.join(" ") || id, memberUids };
}

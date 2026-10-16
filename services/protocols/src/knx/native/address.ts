/**
 * KNX address model (§ Clean-room KNX stack — addressing). Group and individual
 * addresses are 16-bit values on the wire; this module is the single place that converts
 * between wire form and the canonical string form used everywhere else in SupremeOS.
 *
 * Canonical forms (what `format*` always emits, and what bindings/observers are keyed on):
 *   - group address:      3-level `main/middle/sub`  (5+3+8 bits), e.g. `1/2/3`
 *   - individual address: `area.line.device`         (4+4+8 bits), e.g. `1.1.15`
 * Parsers additionally accept the 2-level group form (`main/sub`, 5+11 bits) and a bare
 * 16-bit integer, then canonicalize — so an ETS project exported in 2-level style and a
 * bus telegram can never disagree on the key for the same address.
 */

export class KnxAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnxAddressError";
  }
}

const INT_RE = /^(0|[1-9]\d*)$/;

function part(text: string, max: number, label: string, whole: string): number {
  if (!INT_RE.test(text)) throw new KnxAddressError(`invalid ${label} "${text}" in "${whole}"`);
  const n = Number(text);
  if (n > max) throw new KnxAddressError(`${label} ${n} out of range 0..${max} in "${whole}"`);
  return n;
}

/** Parses `a/b/c`, `a/b` (2-level) or a decimal 16-bit raw value into the wire integer. */
export function parseGroupAddress(text: string): number {
  const s = text.trim();
  if (s.includes("/")) {
    const p = s.split("/");
    if (p.length === 3) {
      return (part(p[0]!, 31, "main group", s) << 11) | (part(p[1]!, 7, "middle group", s) << 8) | part(p[2]!, 255, "sub group", s);
    }
    if (p.length === 2) return (part(p[0]!, 31, "main group", s) << 11) | part(p[1]!, 2047, "sub group", s);
    throw new KnxAddressError(`group address "${s}" must have 2 or 3 levels`);
  }
  if (INT_RE.test(s)) return part(s, 0xffff, "raw group address", s);
  throw new KnxAddressError(`invalid group address "${s}"`);
}

export function formatGroupAddress(raw: number): string {
  assertU16(raw, "group address");
  return `${raw >> 11}/${(raw >> 8) & 0x07}/${raw & 0xff}`;
}

/** Canonicalizes any accepted group-address spelling to the 3-level string. */
export function canonicalGroupAddress(text: string): string {
  return formatGroupAddress(parseGroupAddress(text));
}

export function parseIndividualAddress(text: string): number {
  const s = text.trim();
  const p = s.split(".");
  if (p.length !== 3) throw new KnxAddressError(`individual address "${s}" must be area.line.device`);
  return (part(p[0]!, 15, "area", s) << 12) | (part(p[1]!, 15, "line", s) << 8) | part(p[2]!, 255, "device", s);
}

export function formatIndividualAddress(raw: number): string {
  assertU16(raw, "individual address");
  return `${raw >> 12}.${(raw >> 8) & 0x0f}.${raw & 0xff}`;
}

export function canonicalIndividualAddress(text: string): string {
  return formatIndividualAddress(parseIndividualAddress(text));
}

export function isValidGroupAddress(text: string): boolean {
  try { parseGroupAddress(text); return true; } catch { return false; }
}

export function isValidIndividualAddress(text: string): boolean {
  try { parseIndividualAddress(text); return true; } catch { return false; }
}

function assertU16(n: number, what: string): void {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new KnxAddressError(`${what} ${n} is not a 16-bit unsigned integer`);
}

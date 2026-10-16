/**
 * Datapoint-type codec (§ Clean-room KNX stack — DPT layer). Converts between the
 * {@link GroupData} carried by a cEMI group telegram and the decoded {@link KnxValue}
 * union SupremeOS already uses (`knx-codec.ts`). Written from the published KNX
 * Datapoint Types specification; nothing here knows about sockets, sessions or Supreme
 * capabilities.
 *
 * Supported main types are exactly those the deployed driver exercises (see
 * docs/architecture/knx-clean-room-parity-matrix.md): 1, 5, 6, 7, 8, 9, 12, 13, 14, 17,
 * 20, 22, 222, 232, 251. Every other DPT fails with `unsupported_dpt` — an explicit,
 * countable error, never a guessed decode and never a fallback to another library.
 *
 * Decoding is strict: a payload of the wrong size, a reserved bit pattern or an
 * "invalid data" marker throws {@link KnxDptError} so the caller can count it and keep
 * the last good state instead of publishing garbage as device state.
 */

import type { KnxRgb, KnxRgbw, KnxSetpoints, KnxValue } from "../../knx-codec.js";
import type { GroupData } from "./cemi.js";

export type DptErrorCode = "unsupported_dpt" | "invalid_value" | "bad_payload" | "invalid_data";

export class KnxDptError extends Error {
  constructor(readonly code: DptErrorCode, message: string) {
    super(message);
    this.name = "KnxDptError";
  }
}

export interface ParsedDpt {
  main: number;
  sub: number | null;
  /** Canonical `main.sub` (sub zero-padded to 3 digits) or just `main`. */
  id: string;
}

/** Accepts `1.001`, `DPT1.001`, `DPT 1.001`, `dpt-1.001` and a bare main number. */
export function parseDpt(text: string): ParsedDpt {
  const m = /^(?:dpt[\s_-]*)?(\d{1,3})(?:\.(\d{1,3}))?$/i.exec(text.trim());
  if (!m) throw new KnxDptError("unsupported_dpt", `unrecognized datapoint type "${text}"`);
  const main = Number(m[1]);
  const sub = m[2] === undefined ? null : Number(m[2]);
  return { main, sub, id: sub === null ? String(main) : `${main}.${String(sub).padStart(3, "0")}` };
}

/** Value reported for an F16 field carrying the 0x7FFF "invalid data" marker inside a
 * compound DPT (222). Matches the constant `knx-codec.ts` already treats as invalid. */
export const F16_INVALID_VALUE = 670760.96;

const SUPPORTED_MAINS: ReadonlySet<number> = new Set([1, 5, 6, 7, 8, 9, 12, 13, 14, 17, 20, 22, 222, 232, 251]);

export function isSupportedDpt(text: string): boolean {
  try { return SUPPORTED_MAINS.has(parseDpt(text).main); } catch { return false; }
}

export function supportedDptMains(): number[] {
  return [...SUPPORTED_MAINS].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------------------

function octets(data: GroupData, n: number, id: string): Buffer {
  if (data.kind !== "bytes" || data.bytes.length !== n) {
    const got = data.kind === "short" ? "a 6-bit short value" : `${data.bytes.length} octet(s)`;
    throw new KnxDptError("bad_payload", `DPT ${id} requires ${n} octet(s), received ${got}`);
  }
  return data.bytes;
}

function bytes(b: Buffer): GroupData {
  return { kind: "bytes", bytes: b };
}

function requireNumber(value: unknown, id: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new KnxDptError("invalid_value", `DPT ${id} needs a finite number, got ${String(value)}`);
  return value;
}

function requireInt(value: unknown, id: string, min: number, max: number): number {
  const n = requireNumber(value, id);
  if (!Number.isInteger(n) || n < min || n > max) throw new KnxDptError("invalid_value", `DPT ${id} value ${n} outside integer range ${min}..${max}`);
  return n;
}

// F16 (2-octet float, DPT 9): value = 0.01 * M * 2^E, M 12-bit two's complement, E 4-bit.
function decodeF16(raw: number): number {
  const exp = (raw >> 11) & 0x0f;
  let mant = raw & 0x07ff;
  if (raw & 0x8000) mant -= 2048;
  return (mant * 2 ** exp) / 100;
}

function encodeF16(value: number, id: string): number {
  requireNumber(value, id);
  let exp = 0;
  let mant = value * 100;
  while ((mant < -2048 || mant > 2047) && exp < 15) {
    mant /= 2;
    exp++;
  }
  let m = Math.round(mant);
  if ((m < -2048 || m > 2047) && exp < 15) { m = Math.round(mant / 2); exp++; }
  // 0x7FFF-equivalent (m=2047, e=15) is the reserved "invalid data" code; the largest
  // legal magnitude is one step below it.
  if (m < -2048 || m > 2047 || (exp === 15 && m === 2047)) throw new KnxDptError("invalid_value", `DPT ${id} value ${value} outside the F16 range`);
  return (exp << 11) | (m & 0x07ff) | (m < 0 ? 0x8000 : 0);
}

function u8(buf: Buffer, off = 0): number { return buf[off]!; }

/** Decodes a group telegram payload into a SupremeOS value for the given DPT. */
export function decodeDpt(dpt: string, data: GroupData): KnxValue {
  const { main, sub, id } = parseDpt(dpt);
  switch (main) {
    case 1: {
      // Spec form is the 6-bit short value; a few gateways emit a one-octet form instead.
      const v = data.kind === "short" ? data.value : data.bytes.length === 1 ? data.bytes[0]! : -1;
      if (v !== 0 && v !== 1) throw new KnxDptError("bad_payload", `DPT ${id} needs a single bit (0/1)`);
      return v === 1;
    }
    case 5: {
      const raw = u8(octets(data, 1, id));
      if (sub === 1) return Math.round((raw * 100) / 255);
      if (sub === 3) return Math.round((raw * 360) / 255);
      return raw;
    }
    case 6: return octets(data, 1, id).readInt8(0);
    case 7: return octets(data, 2, id).readUInt16BE(0);
    case 8: return octets(data, 2, id).readInt16BE(0);
    case 9: {
      const raw = octets(data, 2, id).readUInt16BE(0);
      if (raw === 0x7fff) throw new KnxDptError("invalid_data", `DPT ${id} carries the 0x7FFF invalid-data marker`);
      return decodeF16(raw);
    }
    case 12: return octets(data, 4, id).readUInt32BE(0);
    case 13: return octets(data, 4, id).readInt32BE(0);
    case 14: {
      const v = octets(data, 4, id).readFloatBE(0);
      if (!Number.isFinite(v)) throw new KnxDptError("invalid_data", `DPT ${id} decoded to a non-finite float`);
      return v;
    }
    case 17: {
      const raw = u8(octets(data, 1, id));
      if (raw > 0x3f) throw new KnxDptError("bad_payload", `DPT ${id} scene number ${raw} has reserved bits set`);
      return raw;
    }
    case 20: return u8(octets(data, 1, id));
    case 22: return octets(data, 2, id).readUInt16BE(0);
    case 222: {
      const b = octets(data, 6, id);
      const f = (off: number): number => {
        const raw = b.readUInt16BE(off);
        return raw === 0x7fff ? F16_INVALID_VALUE : decodeF16(raw);
      };
      const out: KnxSetpoints = { comfort: f(0), standby: f(2), economy: f(4) };
      return out;
    }
    case 232: {
      const b = octets(data, 3, id);
      const out: KnxRgb = { red: b[0]!, green: b[1]!, blue: b[2]! };
      return out;
    }
    case 251: {
      const b = octets(data, 6, id);
      const mask = b[5]! & 0x0f;
      const out: KnxRgbw = { red: b[0]!, green: b[1]!, blue: b[2]!, white: b[3]!, mR: (mask >> 3) & 1, mG: (mask >> 2) & 1, mB: (mask >> 1) & 1, mW: mask & 1 };
      return out;
    }
    default:
      throw new KnxDptError("unsupported_dpt", `DPT ${id} is not implemented by the native codec`);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Encodes a SupremeOS value into the group payload for the given DPT. */
export function encodeDpt(dpt: string, value: KnxValue): GroupData {
  const { main, sub, id } = parseDpt(dpt);
  switch (main) {
    case 1: {
      if (typeof value === "boolean") return { kind: "short", value: value ? 1 : 0 };
      if (value === 0 || value === 1) return { kind: "short", value };
      throw new KnxDptError("invalid_value", `DPT ${id} needs a boolean`);
    }
    case 5: {
      if (sub === 1) return bytes(Buffer.from([clampInt(Math.round((requireNumber(value, id) * 255) / 100), 0, 255, id)]));
      if (sub === 3) return bytes(Buffer.from([clampInt(Math.round((requireNumber(value, id) * 255) / 360), 0, 255, id)]));
      return bytes(Buffer.from([requireInt(value, id, 0, 255)]));
    }
    case 6: { const b = Buffer.alloc(1); b.writeInt8(requireInt(value, id, -128, 127)); return bytes(b); }
    case 7: { const b = Buffer.alloc(2); b.writeUInt16BE(requireInt(value, id, 0, 0xffff)); return bytes(b); }
    case 8: { const b = Buffer.alloc(2); b.writeInt16BE(requireInt(value, id, -32768, 32767)); return bytes(b); }
    case 9: { const b = Buffer.alloc(2); b.writeUInt16BE(encodeF16(requireNumber(value, id), id)); return bytes(b); }
    case 12: { const b = Buffer.alloc(4); b.writeUInt32BE(requireInt(value, id, 0, 0xffffffff)); return bytes(b); }
    case 13: { const b = Buffer.alloc(4); b.writeInt32BE(requireInt(value, id, -2147483648, 2147483647)); return bytes(b); }
    case 14: { const b = Buffer.alloc(4); b.writeFloatBE(requireNumber(value, id)); return bytes(b); }
    case 17: return bytes(Buffer.from([requireInt(value, id, 0, 63)]));
    case 20: return bytes(Buffer.from([requireInt(value, id, 0, 255)]));
    case 22: { const b = Buffer.alloc(2); b.writeUInt16BE(requireInt(value, id, 0, 0xffff)); return bytes(b); }
    case 222: {
      if (!isObject(value)) throw new KnxDptError("invalid_value", `DPT ${id} needs {comfort, standby, economy}`);
      const b = Buffer.alloc(6);
      (["comfort", "standby", "economy"] as const).forEach((k, i) => {
        const v = requireNumber(value[k], id);
        b.writeUInt16BE(v === F16_INVALID_VALUE ? 0x7fff : encodeF16(v, id), i * 2);
      });
      return bytes(b);
    }
    case 232: {
      if (!isObject(value)) throw new KnxDptError("invalid_value", `DPT ${id} needs {red, green, blue}`);
      return bytes(Buffer.from([requireInt(value.red, id, 0, 255), requireInt(value.green, id, 0, 255), requireInt(value.blue, id, 0, 255)]));
    }
    case 251: {
      if (!isObject(value)) throw new KnxDptError("invalid_value", `DPT ${id} needs {red, green, blue, white, mR, mG, mB, mW}`);
      const flag = (k: string): number => (requireInt(value[k], id, 0, 1));
      const mask = (flag("mR") << 3) | (flag("mG") << 2) | (flag("mB") << 1) | flag("mW");
      return bytes(Buffer.from([requireInt(value.red, id, 0, 255), requireInt(value.green, id, 0, 255), requireInt(value.blue, id, 0, 255), requireInt(value.white, id, 0, 255), 0x00, mask]));
    }
    default:
      throw new KnxDptError("unsupported_dpt", `DPT ${id} is not implemented by the native codec`);
  }
}

function clampInt(n: number, min: number, max: number, id: string): number {
  if (n < min || n > max) throw new KnxDptError("invalid_value", `DPT ${id} value out of range`);
  return n;
}

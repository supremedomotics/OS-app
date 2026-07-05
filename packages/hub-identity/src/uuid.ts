import { randomBytes } from "node:crypto";

/**
 * UUIDv7 — time-ordered (48-bit Unix-ms timestamp + version/variant + random). Time
 * ordering keeps hub ids index-friendly in the cloud registry. `nowMs` is injectable so
 * tests are deterministic.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  // 48-bit big-endian timestamp in the first 6 bytes.
  const ts = BigInt(Math.floor(nowMs));
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  // Version 7 in the high nibble of byte 6; variant (10xx) in the high bits of byte 8.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Validate a UUIDv7 string (version + variant nibbles checked). */
export function isUuidv7(value: string): boolean {
  return UUID_RE.test(value);
}

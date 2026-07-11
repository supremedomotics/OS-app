import { inflateRawSync } from "node:zlib";
import { decryptAesEntry, KnxDecryptError, type AesStrength } from "../knx-crypto.js";

/**
 * `.knxproj` zip access. An ETS project file is a ZIP of XML. This is a minimal zip
 * reader on `node:zlib` (no dependency), handling stored + deflated entries and, when a
 * `password` is given, WinZip-AES (method 99) entries — ETS6 can password-protect the
 * archive. Some protected projects nest an inner `.zip` per project; those are unzipped
 * recursively with the same password.
 */

/** Find the WinZip-AES (0x9901) extra field → [strength, realCompressionMethod]. */
function aesExtra(extra: Buffer): { strength: AesStrength; method: number } | null {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const size = extra.readUInt16LE(p + 2);
    if (id === 0x9901 && p + 4 + size <= extra.length && size >= 7) {
      const strength = extra.readUInt8(p + 4 + 4) as AesStrength; // skip version(2) + "AE"(2)
      const method = extra.readUInt16LE(p + 4 + 5);
      return { strength, method };
    }
    p += 4 + size;
  }
  return null;
}

function looksLikeZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
}

/**
 * Read a zip into a filename → bytes map. Handles stored + deflated entries and, when a
 * `password` is given, WinZip-AES (method 99) entries. Nested `.zip` members are flattened
 * in with their paths preserved so the project XML is found regardless of nesting depth.
 */
export function unzipKnxproj(buf: Buffer, password?: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  // Locate the End Of Central Directory record (search back from the end).
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    let method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    const cdExtra = buf.subarray(off + 46 + nameLen, off + 46 + nameLen + extraLen);
    const lhNameLen = buf.readUInt16LE(localOff + 26);
    const lhExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
    let data = buf.subarray(dataStart, dataStart + compSize);

    try {
      // WinZip-AES entry: decrypt first, then fall through to the real compression method.
      if (method === 99) {
        const aes = aesExtra(cdExtra);
        if (!aes) throw new KnxDecryptError("AES entry without 0x9901 extra field");
        if (!password) throw new KnxDecryptError("password required");
        data = decryptAesEntry(Buffer.from(data), aes.strength, password);
        method = aes.method;
      }
      const plain = method === 0 ? Buffer.from(data) : inflateRawSync(data);
      // Some protected projects wrap the real project in a nested zip — recurse into it.
      if (looksLikeZip(plain)) {
        for (const [inner, innerBuf] of unzipKnxproj(plain, password)) files.set(`${name}/${inner}`, innerBuf);
      } else {
        files.set(name, plain);
      }
    } catch (err) {
      // A wrong/missing password must surface (so the UI can prompt); skip only benign
      // inflate failures of optional entries.
      if (err instanceof KnxDecryptError) throw err;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** ETS stores group addresses as a 16-bit int; expand to main/middle/sub. */
export function addressFromInt(n: number): string {
  return `${(n >> 11) & 0x1f}/${(n >> 8) & 0x7}/${n & 0xff}`;
}

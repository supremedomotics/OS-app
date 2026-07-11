import { inflateRawSync } from "node:zlib";
import { decryptAesEntry, KnxDecryptError, type AesStrength } from "./knx-crypto.js";
import {
  groupIntoDevices,
  inferCapability,
  normalizeDpt,
  type ImportedDevice,
  type KnxGroupAddress,
} from "./knx-import.js";

/**
 * `.knxproj` direct import (§4). An ETS project file is a ZIP of XML. This reads it (a
 * minimal zip reader on node:zlib — no dependency) and parses the installation:
 *   • GroupAddresses (id → 3-level address, name, DPT),
 *   • the Buildings/Locations tree (Space/BuildingPart Type="Room") and the Functions
 *     inside each room, whose GroupAddressRefs tie group addresses to a device + room.
 * This yields device cards placed in their REAL ETS rooms (not name-inferred). When a
 * project has no Functions, it falls back to the name-based grouping used for GA exports.
 *
 * ETS6 can password-protect the archive (WinZip AES). Pass the project password and each
 * encrypted entry is decrypted (see knx-crypto.ts); a wrong password throws so the caller
 * can prompt for it. Some protected projects nest an inner `.zip` per project — those are
 * unzipped recursively with the same password.
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

function attr(s: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(s);
  return m ? (m[1] ?? null) : null;
}

/** Parse the unzipped project files into device cards (and the raw group addresses). */
export function parseKnxProject(files: Map<string, Buffer>): {
  devices: ImportedDevice[];
  addresses: KnxGroupAddress[];
} {
  let xml = "";
  for (const [name, buf] of files) if (name.toLowerCase().endsWith(".xml")) xml += `${buf.toString("utf8")}\n`;

  // 1. Group addresses by their Id, tracking the enclosing <GroupRange> names (the ETS
  // Main Group / Middle Group hierarchy, e.g. "Lighting" > "Switching") so each address
  // carries its device-type + operation classification, not just its raw name.
  const gaById = new Map<string, KnxGroupAddress>();
  const groupRangeStack: string[] = [];
  const gaRe = /<(\/?)(GroupRange|GroupAddress)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = gaRe.exec(xml))) {
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

    const id = attr(a, "Id");
    const addrRaw = attr(a, "Address");
    if (!id || !addrRaw) continue;
    const address = /^\d+\/\d+\/\d+$/.test(addrRaw) ? addrRaw : addressFromInt(Number(addrRaw));
    gaById.set(id, {
      address,
      name: attr(a, "Name") ?? address,
      dpt: normalizeDpt(attr(a, "DatapointType") ?? attr(a, "DPTs")),
      mainGroup: groupRangeStack[0] || null,
      middleGroup: groupRangeStack[1] || null,
    });
  }
  const addresses = [...gaById.values()];

  // 2. Walk the Buildings/Locations tree, mapping each Function (a device) to its room.
  const devices: ImportedDevice[] = [];
  const roomStack: string[] = [];
  let fn: { name: string; gaIds: string[] } | null = null;
  const tagRe = /<(\/?)(Space|BuildingPart|Function|GroupAddressRef)\b([^>]*?)(\/?)>/g;
  while ((m = tagRe.exec(xml))) {
    const close = m[1] === "/";
    const tag = m[2]!;
    const a = m[3] ?? "";
    const selfClose = m[4] === "/";

    if (tag === "Space" || tag === "BuildingPart") {
      const isRoom = /^(room|corridor|stairway)$/i.test(attr(a, "Type") ?? "");
      if (close) {
        if (roomStack.length) roomStack.pop();
      } else {
        roomStack.push(isRoom ? attr(a, "Name") ?? "" : "");
        if (selfClose) roomStack.pop();
      }
    } else if (tag === "Function") {
      if (close) {
        if (fn) emitFunction(fn, roomStack, gaById, devices);
        fn = null;
      } else {
        fn = { name: attr(a, "Name") ?? "Device", gaIds: [] };
        if (selfClose) { emitFunction(fn, roomStack, gaById, devices); fn = null; }
      }
    } else if (tag === "GroupAddressRef" && fn) {
      const ref = attr(a, "RefId");
      if (ref) fn.gaIds.push(ref);
    }
  }

  // 3. No Functions in the project → fall back to name-based grouping of the raw GAs.
  if (devices.length === 0) return { devices: groupIntoDevices(addresses), addresses };
  return { devices, addresses };
}

function emitFunction(
  fn: { name: string; gaIds: string[] },
  roomStack: string[],
  gaById: Map<string, KnxGroupAddress>,
  out: ImportedDevice[],
): void {
  const room = [...roomStack].reverse().find((r) => r.length > 0) ?? null;
  const bindings: ImportedDevice["bindings"] = [];
  for (const id of fn.gaIds) {
    const ga = gaById.get(id);
    if (!ga) continue;
    const cap = inferCapability(ga.dpt, `${fn.name} ${ga.name}`, ga.mainGroup);
    if (cap && !bindings.some((b) => b.capability === cap)) bindings.push({ capability: cap, address: ga.address });
  }
  if (bindings.length > 0) out.push({ name: fn.name, room, bindings });
}

import { inflateRawSync } from "node:zlib";
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
 * Note: ETS6 can password-protect the archive; this reads unprotected projects.
 */

/** Read a (stored or deflated) zip into a filename → bytes map. */
export function unzipKnxproj(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  // Locate the End Of Central Directory record (search back from the end).
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    const lhNameLen = buf.readUInt16LE(localOff + 26);
    const lhExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    try {
      files.set(name, method === 0 ? Buffer.from(data) : inflateRawSync(data));
    } catch {
      // skip entries we can't inflate (e.g. encrypted) rather than failing the whole import
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

  // 1. Group addresses by their Id.
  const gaById = new Map<string, KnxGroupAddress>();
  const gaRe = /<GroupAddress\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = gaRe.exec(xml))) {
    const a = m[1] ?? "";
    const id = attr(a, "Id");
    const addrRaw = attr(a, "Address");
    if (!id || !addrRaw) continue;
    const address = /^\d+\/\d+\/\d+$/.test(addrRaw) ? addrRaw : addressFromInt(Number(addrRaw));
    gaById.set(id, { address, name: attr(a, "Name") ?? address, dpt: normalizeDpt(attr(a, "DatapointType") ?? attr(a, "DPTs")) });
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
    const cap = inferCapability(ga.dpt, `${fn.name} ${ga.name}`);
    if (cap && !bindings.some((b) => b.capability === cap)) bindings.push({ capability: cap, address: ga.address });
  }
  if (bindings.length > 0) out.push({ name: fn.name, room, bindings });
}

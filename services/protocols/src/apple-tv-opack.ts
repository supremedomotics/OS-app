/**
 * OPACK serialization codec (§ Apple TV Phase 3 — Companion protocol). Apple's own
 * binary plist-like format, used by every Companion command payload (`_launchApp`,
 * `FetchLaunchableApplicationsEvent`, …). Every tag byte/length-encoding rule below is
 * copied field-for-field from pyatv's real, canonical implementation
 * (`pyatv/support/opack.py`, Apache-2.0), fetched and inspected directly during this
 * phase — not recalled from memory, not guessed.
 *
 * Decode supports OPACK's object-list back-reference compression (tags 0xA0-0xC4 —
 * "this value is the Nth previously-seen value") since a REAL Apple TV's own encoder may
 * use it; this module's own ENCODER never emits back-references (none of the small,
 * flat command payloads this driver sends need it — pyatv's own encoder only compresses
 * opportunistically too, never a protocol requirement).
 */

export type OpackValue = null | boolean | number | bigint | string | Buffer | OpackValue[] | { [key: string]: OpackValue };

export function opackPack(data: OpackValue): Buffer {
  return packValue(data, []);
}

function packValue(data: OpackValue, objectList: Buffer[]): Buffer {
  let packed: Buffer;
  if (data === null) {
    packed = Buffer.from([0x04]);
  } else if (typeof data === "boolean") {
    packed = Buffer.from([data ? 1 : 2]);
  } else if (typeof data === "bigint" || typeof data === "number") {
    packed = packNumber(data);
  } else if (typeof data === "string") {
    packed = packString(data);
  } else if (Buffer.isBuffer(data)) {
    packed = packBytes(data);
  } else if (Array.isArray(data)) {
    const parts = data.map((x) => packValue(x, objectList));
    const header = Buffer.from([0xd0 + Math.min(data.length, 0xf)]);
    packed = Buffer.concat([header, ...parts, ...(data.length >= 0xf ? [Buffer.from([0x03])] : [])]);
  } else {
    const entries = Object.entries(data);
    const parts = entries.flatMap(([k, v]) => [packValue(k, objectList), packValue(v, objectList)]);
    const header = Buffer.from([0xe0 + Math.min(entries.length, 0xf)]);
    packed = Buffer.concat([header, ...parts, ...(entries.length >= 0xf ? [Buffer.from([0x03])] : [])]);
  }
  return packed;
}

function packNumber(data: number | bigint): Buffer {
  const n = typeof data === "bigint" ? data : BigInt(Math.trunc(data));
  if (typeof data === "number" && !Number.isInteger(data)) {
    const b = Buffer.alloc(9);
    b[0] = 0x36;
    b.writeDoubleLE(data, 1);
    return b;
  }
  if (n < 0x28n) return Buffer.from([Number(n) + 8]);
  if (n <= 0xffn) return Buffer.concat([Buffer.from([0x30]), u(n, 1)]);
  if (n <= 0xffffn) return Buffer.concat([Buffer.from([0x31]), u(n, 2)]);
  if (n <= 0xffffffffn) return Buffer.concat([Buffer.from([0x32]), u(n, 4)]);
  return Buffer.concat([Buffer.from([0x33]), u(n, 8)]);
}

function u(n: bigint, bytes: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n & 0xffffffffffffffffn, 0);
  return b.subarray(0, bytes);
}

function packString(s: string): Buffer {
  const encoded = Buffer.from(s, "utf8");
  const len = encoded.length;
  if (len <= 0x20) return Buffer.concat([Buffer.from([0x40 + len]), encoded]);
  if (len <= 0xff) return Buffer.concat([Buffer.from([0x61]), u(BigInt(len), 1), encoded]);
  if (len <= 0xffff) return Buffer.concat([Buffer.from([0x62]), u(BigInt(len), 2), encoded]);
  if (len <= 0xffffff) return Buffer.concat([Buffer.from([0x63]), u(BigInt(len), 3), encoded]);
  return Buffer.concat([Buffer.from([0x64]), u(BigInt(len), 4), encoded]);
}

function packBytes(data: Buffer): Buffer {
  const len = data.length;
  if (len <= 0x20) return Buffer.concat([Buffer.from([0x70 + len]), data]);
  if (len <= 0xff) return Buffer.concat([Buffer.from([0x91]), u(BigInt(len), 1), data]);
  if (len <= 0xffff) return Buffer.concat([Buffer.from([0x92]), u(BigInt(len), 2), data]);
  if (len <= 0xffffffff) return Buffer.concat([Buffer.from([0x93]), u(BigInt(len), 4), data]);
  return Buffer.concat([Buffer.from([0x94]), u(BigInt(len), 8), data]);
}

export function opackUnpack(data: Buffer): [OpackValue, Buffer] {
  return unpackValue(data, []);
}

function unpackValue(data: Buffer, objectList: OpackValue[]): [OpackValue, Buffer] {
  if (data.length === 0) throw new Error("opack: unexpected end of data");
  const tag = data[0]!;
  let value: OpackValue;
  let remaining: Buffer;
  let addToObjectList = true;

  if (tag === 0x01) {
    value = true;
    remaining = data.subarray(1);
    addToObjectList = false;
  } else if (tag === 0x02) {
    value = false;
    remaining = data.subarray(1);
    addToObjectList = false;
  } else if (tag === 0x04) {
    value = null;
    remaining = data.subarray(1);
    addToObjectList = false;
  } else if (tag === 0x05) {
    value = data.subarray(1, 17); // UUID — kept as raw bytes (no UUID type needed here)
    remaining = data.subarray(17);
  } else if (tag === 0x06) {
    // Absolute-time: pyatv itself only decodes as a raw integer (pack unimplemented) — matched here.
    value = data.readIntLE(1, 8);
    remaining = data.subarray(9);
  } else if (tag >= 0x08 && tag <= 0x2f) {
    value = tag - 8;
    remaining = data.subarray(1);
    addToObjectList = false;
  } else if (tag === 0x35) {
    value = data.readFloatLE(1);
    remaining = data.subarray(5);
  } else if (tag === 0x36) {
    value = data.readDoubleLE(1);
    remaining = data.subarray(9);
  } else if ((tag & 0xf0) === 0x30) {
    const n = 2 ** (tag & 0xf);
    value = Number(data.readUIntLE(1, Math.min(n, 6))); // sizes used here are 1/2/4 bytes in practice
    if (n === 8) value = Number(data.readBigUInt64LE(1));
    remaining = data.subarray(1 + n);
  } else if (tag >= 0x40 && tag <= 0x60) {
    const len = tag - 0x40;
    value = data.subarray(1, 1 + len).toString("utf8");
    remaining = data.subarray(1 + len);
  } else if (tag > 0x60 && tag <= 0x64) {
    const noofBytes = tag & 0xf;
    const len = Number(data.readUIntLE(1, noofBytes));
    value = data.subarray(1 + noofBytes, 1 + noofBytes + len).toString("utf8");
    remaining = data.subarray(1 + noofBytes + len);
  } else if (tag >= 0x70 && tag <= 0x90) {
    const len = tag - 0x70;
    value = Buffer.from(data.subarray(1, 1 + len));
    remaining = data.subarray(1 + len);
  } else if (tag >= 0x91 && tag <= 0x94) {
    const noofBytes = 1 << ((tag & 0xf) - 1);
    const len = Number(data.readUIntLE(1, noofBytes));
    value = Buffer.from(data.subarray(1 + noofBytes, 1 + noofBytes + len));
    remaining = data.subarray(1 + noofBytes + len);
  } else if ((tag & 0xf0) === 0xd0) {
    const count = tag & 0xf;
    const output: OpackValue[] = [];
    let ptr = data.subarray(1);
    if (count === 0xf) {
      while (ptr[0] !== 0x03) {
        const [v, next] = unpackValue(ptr, objectList);
        output.push(v);
        ptr = next;
      }
      ptr = ptr.subarray(1);
    } else {
      for (let i = 0; i < count; i++) {
        const [v, next] = unpackValue(ptr, objectList);
        output.push(v);
        ptr = next;
      }
    }
    value = output;
    remaining = ptr;
    addToObjectList = false;
  } else if ((tag & 0xe0) === 0xe0) {
    const count = tag & 0xf;
    const output: Record<string, OpackValue> = {};
    let ptr = data.subarray(1);
    if (count === 0xf) {
      while (ptr[0] !== 0x03) {
        const [k, next1] = unpackValue(ptr, objectList);
        const [v, next2] = unpackValue(next1, objectList);
        output[String(k)] = v;
        ptr = next2;
      }
      ptr = ptr.subarray(1);
    } else {
      for (let i = 0; i < count; i++) {
        const [k, next1] = unpackValue(ptr, objectList);
        const [v, next2] = unpackValue(next1, objectList);
        output[String(k)] = v;
        ptr = next2;
      }
    }
    value = output;
    remaining = ptr;
    addToObjectList = false;
  } else if (tag >= 0xa0 && tag <= 0xc0) {
    const idx = tag - 0xa0;
    if (idx >= objectList.length) throw new Error(`opack: back-reference ${idx} out of range`);
    value = objectList[idx]!;
    remaining = data.subarray(1);
  } else if (tag >= 0xc1 && tag <= 0xc4) {
    const len = tag - 0xc0;
    const idx = Number(data.readUIntLE(1, len));
    if (idx >= objectList.length) throw new Error(`opack: back-reference ${idx} out of range`);
    value = objectList[idx]!;
    remaining = data.subarray(1 + len);
  } else {
    throw new Error(`opack: unknown tag 0x${tag.toString(16)}`);
  }

  if (addToObjectList) objectList.push(value);
  return [value, remaining];
}

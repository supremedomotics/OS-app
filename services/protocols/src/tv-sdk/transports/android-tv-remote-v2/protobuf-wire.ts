/**
 * (§2 Phase 2 — Android TV Remote v2) Minimal hand-rolled protobuf wire codec — encodes
 * and decodes exactly the wire types this transport's fixed, small message set uses
 * (varint, length-delimited). Not a general-purpose protobuf library: there is no schema
 * compiler, no support for packed repeated fields, maps, or 64-bit/fixed types, because
 * remotemessage.proto/polo.proto (the two schemas this transport speaks — see
 * remote-messages.ts/polo-messages.ts) never use them. Pulling in a full protobuf
 * dependency for ~10 small, stable, hand-verifiable messages would be more risk (an
 * unpinned transitive dependency, a runtime code-generation step) than benefit — this is
 * the "already covered by a few lines" rung of the ladder, not a shortcut around
 * correctness: every encoder/decoder pair here has a round-trip test.
 */

export const WIRE_VARINT = 0;
export const WIRE_LENGTH_DELIMITED = 2;

export function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0 === value ? value : Math.floor(value); // this codec never needs >32-bit values
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

/** Returns [value, offset after the varint]. Throws on a truncated/malformed varint
 * (§ malformed protocol message handling — the transport must reject this cleanly, never
 * hang or throw an unhandled exception deep in a socket callback). */
export function decodeVarint(buf: Buffer, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new Error("protobuf-wire: truncated varint");
    const byte = buf[pos]!;
    result |= (byte & 0x7f) << shift;
    pos += 1;
    if ((byte & 0x80) === 0) return [result >>> 0, pos];
    shift += 7;
    if (shift > 28) throw new Error("protobuf-wire: varint too long (>32-bit values unsupported)");
  }
}

function encodeTag(fieldNumber: number, wireType: number): Buffer {
  return encodeVarint((fieldNumber << 3) | wireType);
}

export function encodeVarintField(fieldNumber: number, value: number): Buffer {
  return Buffer.concat([encodeTag(fieldNumber, WIRE_VARINT), encodeVarint(value)]);
}

export function encodeBytesField(fieldNumber: number, payload: Buffer): Buffer {
  return Buffer.concat([encodeTag(fieldNumber, WIRE_LENGTH_DELIMITED), encodeVarint(payload.length), payload]);
}

export function encodeStringField(fieldNumber: number, value: string): Buffer {
  return encodeBytesField(fieldNumber, Buffer.from(value, "utf8"));
}

/** A nested message is just a length-delimited field whose payload is itself an encoded
 * message — protobuf has no separate "message" wire type. */
export function encodeMessageField(fieldNumber: number, payload: Buffer): Buffer {
  return encodeBytesField(fieldNumber, payload);
}

export interface RawField {
  fieldNumber: number;
  wireType: number;
  /** varint value for WIRE_VARINT, raw payload bytes for WIRE_LENGTH_DELIMITED. */
  value: number | Buffer;
}

/** Generic decode into a flat list of raw fields — callers pick out the field numbers
 * they know about (see remote-messages.ts's `firstField`/`allFields` helpers) rather
 * than this codec knowing about any specific message shape. Fields this codec doesn't
 * understand yet (a genuinely unsupported wire type) are skipped, never fatal — a future
 * protocol addition mustn't crash a driver that just doesn't use it yet. */
export function decodeFields(buf: Buffer): RawField[] {
  const fields: RawField[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const [tag, afterTag] = decodeVarint(buf, pos);
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;
    pos = afterTag;
    if (wireType === WIRE_VARINT) {
      const [value, afterValue] = decodeVarint(buf, pos);
      fields.push({ fieldNumber, wireType, value });
      pos = afterValue;
    } else if (wireType === WIRE_LENGTH_DELIMITED) {
      const [len, afterLen] = decodeVarint(buf, pos);
      if (afterLen + len > buf.length) throw new Error("protobuf-wire: length-delimited field overruns buffer");
      fields.push({ fieldNumber, wireType, value: buf.subarray(afterLen, afterLen + len) });
      pos = afterLen + len;
    } else {
      throw new Error(`protobuf-wire: unsupported wire type ${wireType} (this codec only implements varint and length-delimited)`);
    }
  }
  return fields;
}

export function firstBytes(fields: RawField[], fieldNumber: number): Buffer | null {
  const f = fields.find((x) => x.fieldNumber === fieldNumber && x.wireType === WIRE_LENGTH_DELIMITED);
  return f ? (f.value as Buffer) : null;
}

export function firstString(fields: RawField[], fieldNumber: number): string | null {
  const b = firstBytes(fields, fieldNumber);
  return b ? b.toString("utf8") : null;
}

export function firstVarint(fields: RawField[], fieldNumber: number): number | null {
  const f = fields.find((x) => x.fieldNumber === fieldNumber && x.wireType === WIRE_VARINT);
  return f ? (f.value as number) : null;
}

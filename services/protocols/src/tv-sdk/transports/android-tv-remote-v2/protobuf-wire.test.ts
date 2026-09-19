import { describe, expect, it } from "vitest";
import { decodeFields, decodeVarint, encodeVarint, encodeVarintField, encodeStringField, encodeBytesField, firstString, firstVarint } from "./protobuf-wire.js";

describe("protobuf-wire — varint round trip", () => {
  it.each([0, 1, 127, 128, 300, 16384, 2 ** 20, 2 ** 31 - 1])("round-trips %i", (n) => {
    const [decoded, offset] = decodeVarint(encodeVarint(n), 0);
    expect(decoded).toBe(n);
    expect(offset).toBe(encodeVarint(n).length);
  });

  it("throws on a truncated varint rather than reading garbage", () => {
    const truncated = Buffer.from([0x80]); // continuation bit set, no following byte
    expect(() => decodeVarint(truncated, 0)).toThrow(/truncated/);
  });
});

describe("protobuf-wire — field encode/decode round trip", () => {
  it("round-trips a varint field", () => {
    const buf = encodeVarintField(5, 42);
    const fields = decodeFields(buf);
    expect(firstVarint(fields, 5)).toBe(42);
  });

  it("round-trips a string field", () => {
    const buf = encodeStringField(2, "SupremeOS");
    const fields = decodeFields(buf);
    expect(firstString(fields, 2)).toBe("SupremeOS");
  });

  it("round-trips multiple fields concatenated in one message", () => {
    const buf = Buffer.concat([encodeVarintField(1, 7), encodeStringField(2, "hello"), encodeVarintField(3, 999)]);
    const fields = decodeFields(buf);
    expect(firstVarint(fields, 1)).toBe(7);
    expect(firstString(fields, 2)).toBe("hello");
    expect(firstVarint(fields, 3)).toBe(999);
  });

  it("§ malformed message: an oversized declared length throws rather than reading past the buffer", () => {
    const malformed = encodeBytesField(1, Buffer.alloc(5));
    malformed[1] = 0xff; // corrupt the length varint to claim far more bytes than exist
    expect(() => decodeFields(malformed)).toThrow();
  });

  it("an unknown/unrecognized field number is simply absent from lookups, never fatal", () => {
    const buf = encodeVarintField(99, 1);
    const fields = decodeFields(buf);
    expect(firstVarint(fields, 1)).toBeNull();
  });
});

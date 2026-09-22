import { describe, it, expect } from "vitest";
import { opackPack, opackUnpack } from "./apple-tv-opack.js";

describe("OPACK codec (verified against pyatv's opack.py)", () => {
  it("round-trips primitives: null, booleans, small/large ints, floats, strings", () => {
    for (const v of [null, true, false, 0, 1, 39, 40, 255, 256, 65535, 65536, 4294967296, 3.14, "", "hello", "x".repeat(40)]) {
      const [decoded, rest] = opackUnpack(opackPack(v as any));
      expect(decoded).toEqual(v);
      expect(rest.length).toBe(0);
    }
  });

  it("round-trips a long string requiring the extended-length encoding", () => {
    const long = "y".repeat(300);
    const [decoded] = opackUnpack(opackPack(long));
    expect(decoded).toBe(long);
  });

  it("round-trips byte buffers, short and long", () => {
    const short = Buffer.from([1, 2, 3]);
    const long = Buffer.alloc(300, 7);
    expect(opackUnpack(opackPack(short))[0]).toEqual(short);
    expect(opackUnpack(opackPack(long))[0]).toEqual(long);
  });

  it("round-trips arrays, including >=15 elements (endless-list terminator)", () => {
    const arr = [1, "two", true, null, 5];
    expect(opackUnpack(opackPack(arr))[0]).toEqual(arr);
    const big = Array.from({ length: 20 }, (_, i) => i);
    expect(opackUnpack(opackPack(big))[0]).toEqual(big);
  });

  it("round-trips a dict, including >=15 keys (endless-dict terminator)", () => {
    const obj = { a: 1, b: "two", c: [1, 2, 3] };
    expect(opackUnpack(opackPack(obj))[0]).toEqual(obj);
    const bigKeys: Record<string, number> = {};
    for (let i = 0; i < 20; i++) bigKeys[`k${i}`] = i;
    expect(opackUnpack(opackPack(bigKeys))[0]).toEqual(bigKeys);
  });

  it("round-trips a realistic Companion command payload shape", () => {
    const payload = { _launchApp: { _bundleID: "com.netflix.Netflix" } };
    const [decoded] = opackUnpack(opackPack(payload));
    expect(decoded).toEqual(payload);
  });

  it("decodes real object-list back-references (0xA0 short form) even though this encoder never emits them", () => {
    // Manually build: array of two identical short strings, encoded as [tag_array(2)]
    // [tag_str("hi")] [back-ref to entry 0]. Verifies decode-side compatibility with a
    // real Apple TV's own compressing encoder, per pyatv's documented behavior.
    const strTlv = Buffer.concat([Buffer.from([0x40 + 2]), Buffer.from("hi", "utf8")]);
    const arrayTlv = Buffer.concat([Buffer.from([0xd0 + 2]), strTlv, Buffer.from([0xa0])]);
    const [decoded, rest] = opackUnpack(arrayTlv);
    expect(decoded).toEqual(["hi", "hi"]);
    expect(rest.length).toBe(0);
  });

  it("throws (never crashes silently) on an unknown tag byte", () => {
    expect(() => opackUnpack(Buffer.from([0xff]))).toThrow();
  });
});

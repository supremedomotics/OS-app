import { describe, expect, it } from "vitest";
import { decodeDpt, encodeDpt, F16_INVALID_VALUE, isSupportedDpt, KnxDptError, parseDpt } from "./dpt.js";
import type { GroupData } from "./cemi.js";
import { makeRng } from "./test-support.js";

const b = (hex: string): GroupData => ({ kind: "bytes", bytes: Buffer.from(hex, "hex") });
const hexOf = (d: GroupData): string => (d.kind === "short" ? `short:${d.value}` : d.bytes.toString("hex"));
const code = (fn: () => unknown): string => { try { fn(); return "no-throw"; } catch (e) { return e instanceof KnxDptError ? e.code : `foreign:${String(e)}`; } };

describe("parseDpt", () => {
  it("normalizes spellings", () => {
    for (const s of ["1.001", "DPT1.001", "DPT 1.001", "dpt-1.001", " 1.001 "]) expect(parseDpt(s)).toEqual({ main: 1, sub: 1, id: "1.001" });
    expect(parseDpt("DPT232.600").id).toBe("232.600");
    expect(parseDpt("9").sub).toBeNull();
  });
  it("rejects junk", () => {
    for (const s of ["", "x", "1.", "1.0001", "1000.001", "DPT"]) expect(code(() => parseDpt(s)), s).toBe("unsupported_dpt");
  });
  it("reports support honestly", () => {
    expect(isSupportedDpt("DPT9.001")).toBe(true);
    expect(isSupportedDpt("16.001")).toBe(false); // string DPT: no consumer path yet
    expect(isSupportedDpt("3.007")).toBe(false);
    expect(code(() => decodeDpt("16.001", b("00")))).toBe("unsupported_dpt");
  });
});

describe("golden vectors (decode ⇄ encode)", () => {
  const cases: Array<[string, GroupData, unknown]> = [
    ["1.001", { kind: "short", value: 1 }, true],
    ["1.001", { kind: "short", value: 0 }, false],
    ["5.001", b("80"), 50],
    ["5.001", b("ff"), 100],
    ["5.001", b("00"), 0],
    ["5.003", b("ff"), 360],
    ["5.004", b("64"), 100],
    ["5.100", b("03"), 3],
    ["6.010", b("fe"), -2],
    ["7.600", b("0fa0"), 4000],
    ["8.001", b("ff38"), -200],
    ["9.001", b("0c1a"), 21],
    ["9.001", b("8a24"), -30],
    ["9.001", b("0000"), 0],
    ["9.001", b("07ff"), 20.47],
    ["9.001", b("8000"), -20.48],
    ["12.001", b("00000102"), 258],
    ["13.010", b("ffffff00"), -256],
    ["14.056", b("3f800000"), 1],
    ["17.001", b("05"), 5],
    ["20.102", b("03"), 3],
    ["22.101", b("0103"), 0x0103],
    ["222.100", b("0c1a0c9a0b00"), { comfort: 21, standby: 23.56, economy: 15.36 }],
    ["232.600", b("ff8000"), { red: 255, green: 128, blue: 0 }],
    ["251.600", b("ff800000000f"), { red: 255, green: 128, blue: 0, white: 0, mR: 1, mG: 1, mB: 1, mW: 1 }],
    ["251.600", b("ff8000000005"), { red: 255, green: 128, blue: 0, white: 0, mR: 0, mG: 1, mB: 0, mW: 1 }],
  ];
  for (const [dpt, data, value] of cases) {
    it(`DPT ${dpt} ${hexOf(data)} ⇄ ${JSON.stringify(value)}`, () => {
      expect(decodeDpt(dpt, data)).toEqual(value);
      // F16 has several encodings per value (exponent choice); canonical = finest exponent,
      // so compare encode via a re-decode for compounds that contain F16 fields.
      if (dpt === "222.100") expect(decodeDpt(dpt, encodeDpt(dpt, value as never))).toEqual(value);
      else expect(hexOf(encodeDpt(dpt, value as never))).toBe(hexOf(data));
    });
  }
  it("5.001 encode rounds to the nearest raw step", () => {
    expect(hexOf(encodeDpt("5.001", 50))).toBe("80");
    expect(hexOf(encodeDpt("5.001", 1))).toBe("03");
  });
  it("accepts the one-octet form of a DPT 1 value", () => {
    expect(decodeDpt("1.001", b("01"))).toBe(true);
    expect(decodeDpt("1.001", b("00"))).toBe(false);
  });
});

describe("round-trip properties", () => {
  it("DPT 5.001 percent survives encode→decode for every integer percent", () => {
    for (let v = 0; v <= 100; v++) expect(decodeDpt("5.001", encodeDpt("5.001", v))).toBe(v);
  });
  it("DPT 9 round-trips within half an LSB at the exponent the encoder chose", () => {
    const rng = makeRng(5);
    for (let i = 0; i < 5000; i++) {
      const v = (rng.next() - 0.5) * 2 * 10 ** rng.int(5); // up to ±10000
      const enc = encodeDpt("9.001", v);
      const raw = (enc as { bytes: Buffer }).bytes.readUInt16BE(0);
      const lsb = (0.01 * 2 ** ((raw >> 11) & 0x0f));
      expect(Math.abs((decodeDpt("9.001", enc) as number) - v)).toBeLessThanOrEqual(lsb / 2 + 1e-9);
    }
  });
  it("DPT 9 is exactly stable on its own output (idempotent)", () => {
    const rng = makeRng(6);
    for (let i = 0; i < 3000; i++) {
      const raw = rng.int(0x10000);
      if (raw === 0x7fff) continue;
      const v = decodeDpt("9.001", b(raw.toString(16).padStart(4, "0"))) as number;
      expect(decodeDpt("9.001", encodeDpt("9.001", v))).toBe(v);
    }
  });
  it("integer DPTs round-trip at their bounds", () => {
    const rt = (dpt: string, v: number): void => expect(decodeDpt(dpt, encodeDpt(dpt, v))).toBe(v);
    [-128, 127].forEach((v) => rt("6.001", v));
    [0, 65535].forEach((v) => rt("7.001", v));
    [-32768, 32767].forEach((v) => rt("8.001", v));
    [0, 4294967295].forEach((v) => rt("12.001", v));
    [-2147483648, 2147483647].forEach((v) => rt("13.001", v));
    [0, 63].forEach((v) => rt("17.001", v));
    [0, 255].forEach((v) => rt("20.102", v));
    [0, 0xffff].forEach((v) => rt("22.101", v));
  });
  it("RGB / RGBW / setpoint compounds round-trip", () => {
    const rgbw = { red: 1, green: 2, blue: 3, white: 4, mR: 1, mG: 0, mB: 1, mW: 0 };
    expect(decodeDpt("251.600", encodeDpt("251.600", rgbw))).toEqual(rgbw);
    const sp = { comfort: 21.5, standby: 19, economy: 17.5 };
    expect(decodeDpt("222.100", encodeDpt("222.100", sp))).toEqual(sp);
  });
});

describe("strictness and failure reporting", () => {
  it("rejects wrong payload sizes and forms", () => {
    expect(code(() => decodeDpt("5.001", { kind: "short", value: 1 }))).toBe("bad_payload");
    expect(code(() => decodeDpt("5.001", b("0000")))).toBe("bad_payload");
    expect(code(() => decodeDpt("9.001", b("00")))).toBe("bad_payload");
    expect(code(() => decodeDpt("232.600", b("ff80")))).toBe("bad_payload");
    expect(code(() => decodeDpt("1.001", b("0001")))).toBe("bad_payload");
    expect(code(() => decodeDpt("1.001", { kind: "short", value: 2 }))).toBe("bad_payload");
    expect(code(() => decodeDpt("17.001", b("ff")))).toBe("bad_payload");
  });
  it("surfaces invalid-data markers instead of publishing them as readings", () => {
    expect(code(() => decodeDpt("9.001", b("7fff")))).toBe("invalid_data");
    expect(code(() => decodeDpt("14.056", b("7fc00000")))).toBe("invalid_data");
    // inside a compound DPT the marker stays per-field, exactly what knx-codec expects
    expect(decodeDpt("222.100", b("7fff0c1a7fff"))).toEqual({ comfort: F16_INVALID_VALUE, standby: 21, economy: F16_INVALID_VALUE });
    expect(hexOf(encodeDpt("222.100", { comfort: F16_INVALID_VALUE, standby: 21, economy: F16_INVALID_VALUE }))).toBe("7fff0c1a7fff");
  });
  it("rejects invalid values to encode", () => {
    expect(code(() => encodeDpt("5.001", 101))).toBe("invalid_value");
    expect(code(() => encodeDpt("5.001", Number.NaN))).toBe("invalid_value");
    expect(code(() => encodeDpt("5.004", 1.5))).toBe("invalid_value");
    expect(code(() => encodeDpt("9.001", 700000))).toBe("invalid_value");
    expect(code(() => encodeDpt("9.001", Number.POSITIVE_INFINITY))).toBe("invalid_value");
    expect(code(() => encodeDpt("1.001", 2))).toBe("invalid_value");
    expect(code(() => encodeDpt("232.600", { red: 256, green: 0, blue: 0 }))).toBe("invalid_value");
    expect(code(() => encodeDpt("232.600", true))).toBe("invalid_value");
    expect(code(() => encodeDpt("17.001", 64))).toBe("invalid_value");
    expect(code(() => encodeDpt("3.007", 1))).toBe("unsupported_dpt");
  });
  it("decoding arbitrary payloads only throws KnxDptError", () => {
    const rng = makeRng(11);
    const dpts = ["1.001", "5.001", "6.010", "7.600", "8.001", "9.001", "12.001", "13.010", "14.056", "17.001", "20.102", "22.101", "222.100", "232.600", "251.600", "3.007", "16.001"];
    for (let i = 0; i < 4000; i++) {
      const data: GroupData = rng.int(4) === 0 ? { kind: "short", value: rng.int(64) } : { kind: "bytes", bytes: rng.bytes(1 + rng.int(14)) };
      for (const d of dpts) { try { decodeDpt(d, data); } catch (e) { expect(e, d).toBeInstanceOf(KnxDptError); } }
    }
  });
});

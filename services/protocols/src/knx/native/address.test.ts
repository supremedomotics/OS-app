import { describe, expect, it } from "vitest";
import {
  canonicalGroupAddress, canonicalIndividualAddress, formatGroupAddress, formatIndividualAddress,
  isValidGroupAddress, isValidIndividualAddress, parseGroupAddress, parseIndividualAddress,
} from "./address.js";

describe("group addresses", () => {
  it("round-trips the full 16-bit space in canonical 3-level form", () => {
    for (let raw = 0; raw <= 0xffff; raw += 7) expect(parseGroupAddress(formatGroupAddress(raw))).toBe(raw);
    expect(parseGroupAddress(formatGroupAddress(0xffff))).toBe(0xffff);
  });
  it("matches known wire values", () => {
    expect(parseGroupAddress("1/2/3")).toBe(0x0a03);
    expect(parseGroupAddress("31/7/255")).toBe(0xffff);
    expect(formatGroupAddress(0x0a03)).toBe("1/2/3");
  });
  it("canonicalizes 2-level, raw-integer and whitespace spellings to the same key", () => {
    expect(canonicalGroupAddress("1/515")).toBe("1/2/3"); // 2*256+3
    expect(canonicalGroupAddress("2563")).toBe("1/2/3");
    expect(canonicalGroupAddress(" 1/2/3 ")).toBe("1/2/3");
    expect(canonicalGroupAddress("01/2/3".replace("01", "1"))).toBe("1/2/3");
  });
  it("rejects out-of-range and malformed input", () => {
    for (const bad of ["32/0/0", "0/8/0", "0/0/256", "0/2048", "1/2/3/4", "a/b/c", "", "1/2/", "-1/0/0", "1//3", "65536", "01/2/3", "1.5/2/3"]) {
      expect(isValidGroupAddress(bad), bad).toBe(false);
    }
  });
});

describe("individual addresses", () => {
  it("round-trips and matches known wire values", () => {
    expect(parseIndividualAddress("1.1.15")).toBe(0x110f);
    expect(formatIndividualAddress(0x110f)).toBe("1.1.15");
    for (let raw = 0; raw <= 0xffff; raw += 11) expect(parseIndividualAddress(formatIndividualAddress(raw))).toBe(raw);
    expect(canonicalIndividualAddress("15.15.255")).toBe("15.15.255");
  });
  it("rejects out-of-range and malformed input", () => {
    for (const bad of ["16.0.0", "0.16.0", "0.0.256", "1.1", "1.1.1.1", "x.y.z", "", "1/1/1"]) expect(isValidIndividualAddress(bad), bad).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  generateSigningKeyPair,
  signPayload,
  signString,
  verifyPayload,
  verifyString,
} from "./index.js";

describe("ed25519 signing", () => {
  it("round-trips a string signature", () => {
    const { publicKey, privateKey } = generateSigningKeyPair();
    const sig = signString("hello supreme", privateKey);
    expect(verifyString("hello supreme", sig, publicKey)).toBe(true);
    expect(verifyString("tampered", sig, publicKey)).toBe(false);
  });

  it("verifies a canonicalized payload regardless of key order", () => {
    const { publicKey, privateKey } = generateSigningKeyPair();
    const sig = signPayload({ b: 2, a: 1, nested: { y: 1, x: 2 } }, privateKey);
    // Same logical object, different key order — still verifies.
    expect(verifyPayload({ nested: { x: 2, y: 1 }, a: 1, b: 2 }, sig, publicKey)).toBe(true);
    expect(verifyPayload({ a: 1, b: 3 }, sig, publicKey)).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const a = generateSigningKeyPair();
    const b = generateSigningKeyPair();
    const sig = signString("x", a.privateKey);
    expect(verifyString("x", sig, b.publicKey)).toBe(false);
  });

  it("canonical json sorts keys deterministically", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

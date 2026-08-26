import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  decryptSecret,
  encryptSecret,
  generateEncryptionKey,
  generateSigningKeyPair,
  isEncryptedSecret,
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

describe("aes-256-gcm secret encryption", () => {
  it("round-trips a plaintext value", () => {
    const key = generateEncryptionKey();
    const encrypted = encryptSecret("correct horse battery staple", key);
    expect(decryptSecret(encrypted, key)).toBe("correct horse battery staple");
  });

  it("produces a different ciphertext every call (random IV) even for the same plaintext", () => {
    const key = generateEncryptionKey();
    const a = encryptSecret("same value", key);
    const b = encryptSecret("same value", key);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, key)).toBe("same value");
    expect(decryptSecret(b, key)).toBe("same value");
  });

  it("isEncryptedSecret recognizes ciphertext and rejects plaintext", () => {
    const key = generateEncryptionKey();
    expect(isEncryptedSecret(encryptSecret("x", key))).toBe(true);
    expect(isEncryptedSecret("plain old password")).toBe(false);
    expect(isEncryptedSecret(undefined)).toBe(false);
    expect(isEncryptedSecret(42)).toBe(false);
  });

  it("fails to decrypt with the wrong key", () => {
    const a = generateEncryptionKey();
    const b = generateEncryptionKey();
    const encrypted = encryptSecret("secret", a);
    expect(() => decryptSecret(encrypted, b)).toThrow();
  });

  it("detects tampered ciphertext (auth tag mismatch)", () => {
    const key = generateEncryptionKey();
    const encrypted = encryptSecret("secret", key);
    const tampered = encrypted.slice(0, -4) + "abcd";
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it("rejects malformed ciphertext strings", () => {
    const key = generateEncryptionKey();
    expect(() => decryptSecret("enc:v1:not-enough-segments", key)).toThrow(/malformed/);
  });
});

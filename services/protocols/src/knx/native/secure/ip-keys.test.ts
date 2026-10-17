import { describe, expect, it } from "vitest";
import { deriveDeviceAuthenticationCode, deriveSessionKey, deriveUserPasswordHash, ecdhPublicFromPrivate, ecdhSharedSecret, generateEcdhKeyPair, KnxSecureKeyError, passwordSecret } from "./ip-keys.js";
import { Secret } from "../security/secret.js";

describe("IP Secure key derivation (independent, no licensed data)", () => {
  it("key agreement is symmetric and yields a 16-octet session key; shared secret is 32 octets", () => {
    const a = generateEcdhKeyPair(), b = generateEcdhKeyPair();
    expect(a.publicKey).toHaveLength(32);
    expect(ecdhPublicFromPrivate(a.privateKey).equals(a.publicKey)).toBe(true);
    const k1 = deriveSessionKey(a.privateKey, b.publicKey), k2 = deriveSessionKey(b.privateKey, a.publicKey);
    expect(k1.length).toBe(16);
    expect(k1.use((x) => k2.use((y) => x.equals(y)))).toBe(true);
    expect(ecdhSharedSecret(a.privateKey, b.publicKey).length).toBe(32);
  });
  it("every generated key pair is fresh (never reused across sessions)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(generateEcdhKeyPair().publicKey.toString("hex"));
    expect(seen.size).toBe(50);
  });
  it("different peers give different session keys", () => {
    const a = generateEcdhKeyPair(), b = generateEcdhKeyPair(), c = generateEcdhKeyPair();
    expect(deriveSessionKey(a.privateKey, b.publicKey).use((x) => deriveSessionKey(a.privateKey, c.publicKey).use((y) => x.equals(y)))).toBe(false);
  });
  it("rejects malformed and low-order peer public values (all-zero secret) rather than deriving a key", () => {
    const a = generateEcdhKeyPair();
    expect(() => deriveSessionKey(a.privateKey, Buffer.alloc(31, 1))).toThrow(KnxSecureKeyError);
    expect(() => deriveSessionKey(a.privateKey, Buffer.alloc(32))).toThrow(expect.objectContaining({ code: "invalid_public_key" }));
    const one = Buffer.alloc(32); one[0] = 1;                         // u = 1: a low-order point
    expect(() => deriveSessionKey(a.privateKey, one)).toThrow(KnxSecureKeyError);
    const lowOrder = Buffer.from("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800", "hex"); // known order-8 point
    expect(() => deriveSessionKey(a.privateKey, lowOrder)).toThrow(KnxSecureKeyError);
  });
  it("PBKDF2 derivations are 16 octets, deterministic, input-sensitive and domain-separated by salt", async () => {
    const p = passwordSecret("correct horse");
    const d1 = await deriveDeviceAuthenticationCode(p), d2 = await deriveDeviceAuthenticationCode(p), u = await deriveUserPasswordHash(p);
    expect(d1.length).toBe(16);
    expect(d1.use((x) => d2.use((y) => x.equals(y)))).toBe(true);
    expect(d1.use((x) => u.use((y) => x.equals(y)))).toBe(false);                         // same secret, different salt → different key
    const other = await deriveUserPasswordHash(passwordSecret("correct horsf"));
    expect(u.use((x) => other.use((y) => x.equals(y)))).toBe(false);
  });
  it("secrets never print", async () => {
    const k = await deriveUserPasswordHash(passwordSecret("hunter2"));
    const kp = generateEcdhKeyPair();
    for (const s of [k, kp.privateKey]) expect(`${s} ${JSON.stringify({ s })}`).not.toMatch(/[0-9a-f]{16}/);
  });
  it("refuses a wiped secret", async () => {
    const s = new Secret(Buffer.from("x")); s.wipe();
    await expect(deriveDeviceAuthenticationCode(s)).rejects.toBeInstanceOf(KnxSecureKeyError);
  });
});

import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyAuthentication } from "./webauthn.js";

const b64u = (b: Buffer) => b.toString("base64url");

/**
 * Verify the security-critical assertion path with a real P-256 key: build the exact bytes a browser
 * signs (authenticatorData || sha256(clientDataJSON)), sign with the private key, and confirm the
 * verifier accepts a good signature and rejects a tampered one / wrong challenge.
 */
describe("webauthn assertion verification (ES256)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  function assertion(challenge: string, origin = "https://hub.local") {
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin }));
    // authenticatorData: 32-byte rpIdHash + flags(0x05: UP+UV) + 4-byte signCount.
    const authData = Buffer.concat([Buffer.alloc(32, 1), Buffer.from([0x05]), Buffer.from([0, 0, 0, 7])]);
    const message = Buffer.concat([authData, createHash("sha256").update(clientData).digest()]);
    const signature = cryptoSign("sha256", message, privateKey); // DER ECDSA
    return {
      clientDataJSON: b64u(clientData),
      authenticatorData: b64u(authData),
      signature: b64u(signature),
      publicKeyPem,
      expectedChallenge: challenge,
      expectedOrigin: origin,
    };
  }

  it("accepts a valid assertion and returns the sign counter", () => {
    const res = verifyAuthentication(assertion("chal-abc"));
    expect(res.signCount).toBe(7);
  });

  it("rejects a challenge mismatch", () => {
    const a = assertion("chal-abc");
    expect(() => verifyAuthentication({ ...a, expectedChallenge: "different" })).toThrow(/challenge mismatch/);
  });

  it("rejects a tampered signature", () => {
    const a = assertion("chal-abc");
    const bad = Buffer.from(a.signature, "base64url");
    bad[bad.length - 1] ^= 0xff;
    expect(() => verifyAuthentication({ ...a, signature: bad.toString("base64url") })).toThrow(/signature verification failed/);
  });

  it("rejects an origin mismatch", () => {
    const a = assertion("chal-abc");
    expect(() => verifyAuthentication({ ...a, expectedOrigin: "https://evil.example" })).toThrow(/origin mismatch/);
  });
});

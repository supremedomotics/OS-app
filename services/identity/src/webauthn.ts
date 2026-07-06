import { createHash, createPublicKey, verify as cryptoVerify, randomBytes } from "node:crypto";

/**
 * A minimal, dependency-free WebAuthn / passkey core (§ Security Center — passkeys), scoped to the
 * ES256 (P-256) algorithm that platform authenticators use. It parses the CBOR attestation/COSE key
 * on registration and verifies the ECDSA assertion signature on authentication — the security-
 * critical part — against the stored public key. Attestation statements are not verified (fmt
 * "none"), which is standard for passkeys where the RP trusts the platform authenticator.
 */

// ── Minimal CBOR decoder (RFC 8949 subset used by WebAuthn) ───────────────────
type Cbor = number | bigint | Uint8Array | string | Cbor[] | Map<Cbor, Cbor>;

function decodeCbor(buf: Uint8Array, offset = 0): [Cbor, number] {
  const b = buf[offset]!;
  const major = b >> 5;
  const minor = b & 0x1f;
  let p = offset + 1;
  const readLen = (m: number): [number, number] => {
    if (m < 24) return [m, p];
    if (m === 24) return [buf[p]!, p + 1];
    if (m === 25) return [(buf[p]! << 8) | buf[p + 1]!, p + 2];
    if (m === 26) return [((buf[p]! << 24) | (buf[p + 1]! << 16) | (buf[p + 2]! << 8) | buf[p + 3]!) >>> 0, p + 4];
    throw new Error("cbor: unsupported length");
  };
  switch (major) {
    case 0: { const [v, np] = readLen(minor); return [v, np]; }
    case 1: { const [v, np] = readLen(minor); return [-1 - v, np]; }
    case 2: { const [len, np] = readLen(minor); return [buf.subarray(np, np + len), np + len]; }
    case 3: { const [len, np] = readLen(minor); return [Buffer.from(buf.subarray(np, np + len)).toString("utf8"), np + len]; }
    case 4: {
      const [len, np] = readLen(minor); p = np;
      const arr: Cbor[] = [];
      for (let i = 0; i < len; i++) { const [v, n2] = decodeCbor(buf, p); arr.push(v); p = n2; }
      return [arr, p];
    }
    case 5: {
      const [len, np] = readLen(minor); p = np;
      const map = new Map<Cbor, Cbor>();
      for (let i = 0; i < len; i++) {
        const [k, n1] = decodeCbor(buf, p); p = n1;
        const [v, n2] = decodeCbor(buf, p); p = n2;
        map.set(k, v);
      }
      return [map, p];
    }
    default:
      throw new Error(`cbor: unsupported major type ${major}`);
  }
}

// ── COSE EC2 (ES256) public key → Node KeyObject via JWK ──────────────────────
function coseToPublicKey(cose: Map<Cbor, Cbor>) {
  const kty = cose.get(1); // 2 = EC2
  const alg = cose.get(3); // -7 = ES256
  const crv = cose.get(-1); // 1 = P-256
  const x = cose.get(-2);
  const y = cose.get(-3);
  if (kty !== 2 || alg !== -7 || crv !== 1 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array)) {
    throw new Error("webauthn: only ES256 (P-256) passkeys are supported");
  }
  return createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: Buffer.from(x).toString("base64url"),
      y: Buffer.from(y).toString("base64url"),
    },
    format: "jwk",
  });
}

/** Parse authenticatorData: rpIdHash(32) + flags(1) + signCount(4) + [attested credential data]. */
function parseAuthData(authData: Uint8Array) {
  const rpIdHash = authData.subarray(0, 32);
  const flags = authData[32]!;
  const signCount = ((authData[33]! << 24) | (authData[34]! << 16) | (authData[35]! << 8) | authData[36]!) >>> 0;
  const result: { rpIdHash: Uint8Array; flags: number; signCount: number; credentialId?: Uint8Array; publicKeyPem?: string } = {
    rpIdHash, flags, signCount,
  };
  // AT (attested credential data) flag → parse credential + COSE key (registration only).
  if (flags & 0x40) {
    const credIdLen = (authData[53]! << 8) | authData[54]!;
    const credentialId = authData.subarray(55, 55 + credIdLen);
    const [cose] = decodeCbor(authData, 55 + credIdLen);
    const key = coseToPublicKey(cose as Map<Cbor, Cbor>);
    result.credentialId = credentialId;
    result.publicKeyPem = key.export({ type: "spki", format: "pem" }).toString();
  }
  return result;
}

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/** A fresh base64url challenge for a ceremony. */
export function newChallenge(): string {
  return randomBytes(32).toString("base64url");
}

export interface RegistrationResult {
  credentialId: string; // base64url
  publicKeyPem: string;
  signCount: number;
}

/**
 * Verify a registration (navigator.credentials.create) response and extract the credential to store.
 * `clientDataJSON` + `attestationObject` are base64url strings from the client.
 */
export function verifyRegistration(input: {
  clientDataJSON: string;
  attestationObject: string;
  expectedChallenge: string;
  expectedOrigin?: string;
}): RegistrationResult {
  const clientData = JSON.parse(b64urlToBuf(input.clientDataJSON).toString("utf8")) as { type: string; challenge: string; origin: string };
  if (clientData.type !== "webauthn.create") throw new Error("webauthn: unexpected ceremony type");
  if (clientData.challenge !== input.expectedChallenge) throw new Error("webauthn: challenge mismatch");
  if (input.expectedOrigin && clientData.origin !== input.expectedOrigin) throw new Error("webauthn: origin mismatch");

  const [att] = decodeCbor(b64urlToBuf(input.attestationObject));
  const authData = (att as Map<Cbor, Cbor>).get("authData");
  if (!(authData instanceof Uint8Array)) throw new Error("webauthn: missing authData");
  const parsed = parseAuthData(authData);
  if (!parsed.credentialId || !parsed.publicKeyPem) throw new Error("webauthn: no attested credential");
  return {
    credentialId: Buffer.from(parsed.credentialId).toString("base64url"),
    publicKeyPem: parsed.publicKeyPem,
    signCount: parsed.signCount,
  };
}

/**
 * Verify an authentication (navigator.credentials.get) assertion signature against the stored public
 * key. Returns the new signature counter. Throws on any mismatch.
 */
export function verifyAuthentication(input: {
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  publicKeyPem: string;
  expectedChallenge: string;
  expectedOrigin?: string;
}): { signCount: number } {
  const clientData = JSON.parse(b64urlToBuf(input.clientDataJSON).toString("utf8")) as { type: string; challenge: string; origin: string };
  if (clientData.type !== "webauthn.get") throw new Error("webauthn: unexpected ceremony type");
  if (clientData.challenge !== input.expectedChallenge) throw new Error("webauthn: challenge mismatch");
  if (input.expectedOrigin && clientData.origin !== input.expectedOrigin) throw new Error("webauthn: origin mismatch");

  const authData = b64urlToBuf(input.authenticatorData);
  const clientDataHash = createHash("sha256").update(b64urlToBuf(input.clientDataJSON)).digest();
  const signedMessage = Buffer.concat([authData, clientDataHash]);
  const ok = cryptoVerify("sha256", signedMessage, input.publicKeyPem, b64urlToBuf(input.signature));
  if (!ok) throw new Error("webauthn: signature verification failed");

  const parsed = parseAuthData(authData);
  return { signCount: parsed.signCount };
}

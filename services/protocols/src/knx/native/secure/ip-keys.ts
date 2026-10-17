/**
 * KNX IP Secure key material derivation (§ KNX Secure — IP layer). Written from 03_08_09 KNX IP Secure v01.01.02 AS:
 *   - Device Authentication Code  = PBKDF2(HMAC-SHA-256, secret,   "device-authentication-code.1.secure.ip.knx.org", 65 536, 128 bit)  §2.3.1.3.1
 *   - User password hash          = PBKDF2(HMAC-SHA-256, password, "user-password.1.secure.ip.knx.org",             65 536, 128 bit)  §2.3.1.4.1
 *   - Session key                 = first 16 octets of SHA-256( Curve25519(myPrivate, peerPublic) )  — shared secret as little-endian  §2.2.3.1.2
 *   - A new ECDH key pair for EVERY session, from a cryptographically secure source, never reused                                     §2.2.3.1.1
 * Everything secret is returned as a {@link Secret} (redacting, wipeable). Character encoding of a user-entered password is not
 * specified in the text read; UTF-8 is used (identical to ASCII for ASCII passwords, which is what the specification's examples use).
 */
import { createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, pbkdf2 } from "node:crypto";
import { promisify } from "node:util";
import { Secret } from "../security/secret.js";

const pbkdf2Async = promisify(pbkdf2);

export const SALT_DEVICE_AUTHENTICATION_CODE = "device-authentication-code.1.secure.ip.knx.org";
export const SALT_USER_PASSWORD = "user-password.1.secure.ip.knx.org";
export const PBKDF2_ITERATIONS = 65_536;
export const PBKDF2_KEY_BYTES = 16;

export class KnxSecureKeyError extends Error {
  constructor(readonly code: "invalid_public_key" | "weak_shared_secret" | "invalid_private_key" | "invalid_input", message: string) {
    super(message);
    this.name = "KnxSecureKeyError";
  }
}

async function derive(secret: Secret, salt: string): Promise<Secret> {
  if (secret.wiped) throw new KnxSecureKeyError("invalid_input", "secret has been wiped");
  const out = await secret.use((b) => pbkdf2Async(b, Buffer.from(salt, "utf8"), PBKDF2_ITERATIONS, PBKDF2_KEY_BYTES, "sha256"));
  const s = new Secret(out);
  out.fill(0);
  return s;
}

/** Device Authentication Code from the user-chosen shared secret (§2.3.1.3.1). Ex-factory the code is the FDSK itself (§2.3.1.3.3). */
export const deriveDeviceAuthenticationCode = (secret: Secret): Promise<Secret> => derive(secret, SALT_DEVICE_AUTHENTICATION_CODE);
/** Password hash for one user id (§2.3.1.4.1). */
export const deriveUserPasswordHash = (password: Secret): Promise<Secret> => derive(password, SALT_USER_PASSWORD);

export function passwordSecret(text: string): Secret {
  const b = Buffer.from(text, "utf8");
  const s = new Secret(b);
  b.fill(0);
  return s;
}

// DER prefixes for raw 32-octet X25519 keys (RFC 8410): PKCS#8 private and SPKI public.
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");

export interface EcdhKeyPair {
  /** 32-octet Curve25519 public value (X or Y on the wire). */
  publicKey: Buffer;
  privateKey: Secret;
}

/** Fresh random Curve25519 key pair from the platform CSPRNG (§2.2.3.1.1, §2.2.4.1). */
export function generateEcdhKeyPair(): EcdhKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const priv = privateKey.export({ format: "der", type: "pkcs8" });
  const pub = publicKey.export({ format: "der", type: "spki" });
  const raw = priv.subarray(priv.length - 32);
  const pair = { publicKey: Buffer.from(pub.subarray(pub.length - 32)), privateKey: new Secret(raw) };
  priv.fill(0);
  return pair;
}

/** Public value for a given raw private key (used to check test vectors and by the simulator server). */
export function ecdhPublicFromPrivate(privateKey: Secret): Buffer {
  return privateKey.use((raw) => {
    if (raw.length !== 32) throw new KnxSecureKeyError("invalid_private_key", "Curve25519 private key must be 32 octets");
    const k = createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: "der", type: "pkcs8" });
    const spki = createPublicKey(k).export({ format: "der", type: "spki" });
    return Buffer.from(spki.subarray(spki.length - 32));
  });
}

/** Raw X25519 shared secret (32 octets), refusing the all-zero result a low-order peer key produces. */
export function ecdhSharedSecret(privateKey: Secret, peerPublic: Buffer): Secret {
  if (peerPublic.length !== 32) throw new KnxSecureKeyError("invalid_public_key", "Curve25519 public value must be 32 octets");
  if (peerPublic.every((x) => x === 0)) throw new KnxSecureKeyError("invalid_public_key", "all-zero Curve25519 public value");
  const shared = privateKey.use((raw) => {
    const priv = createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: "der", type: "pkcs8" });
    const pub = createPublicKey({ key: Buffer.concat([SPKI_X25519, peerPublic]), format: "der", type: "spki" });
    try { return diffieHellman({ privateKey: priv, publicKey: pub }); } catch {
      throw new KnxSecureKeyError("weak_shared_secret", "key agreement failed (rejected peer public value)");
    }
  });
  if (shared.every((x) => x === 0)) { shared.fill(0); throw new KnxSecureKeyError("weak_shared_secret", "key agreement produced an all-zero secret"); }
  const s = new Secret(shared);
  shared.fill(0);
  return s;
}

/** Session key (§2.2.3.1.2): first 16 octets of SHA-256 of the shared secret. */
export function deriveSessionKey(privateKey: Secret, peerPublic: Buffer): Secret {
  const shared = ecdhSharedSecret(privateKey, peerPublic);
  const key = shared.use((b) => createHash("sha256").update(b).digest().subarray(0, 16));
  shared.wipe();
  const s = new Secret(key);
  key.fill(0);
  return s;
}

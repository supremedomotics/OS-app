import {
  createCipheriv,
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";

/**
 * @supreme/crypto — Ed25519 signing primitives (§9, §12, §13).
 *
 * Used wherever the hub must verify authenticity OFFLINE: signed driver bundles,
 * signed license tokens, and signed backups. Ed25519 is fast, small, and needs no
 * parameters, which suits an air-gapped appliance. Keys are exchanged as PEM so
 * they can live in config / sealed stores.
 */

export interface KeyPairPem {
  publicKey: string;
  privateKey: string;
}

/** Generate an Ed25519 keypair as PEM strings (SPKI public, PKCS8 private). */
export function generateSigningKeyPair(): KeyPairPem {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** Sign a UTF-8 string, returning a base64 signature. */
export function signString(data: string, privateKeyPem: string): string {
  return nodeSign(null, Buffer.from(data, "utf8"), privateKeyPem).toString("base64");
}

/** Verify a base64 signature over a UTF-8 string. Never throws. */
export function verifyString(data: string, signatureB64: string, publicKeyPem: string): boolean {
  try {
    return nodeVerify(null, Buffer.from(data, "utf8"), publicKeyPem, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/** SHA-256 of bytes/string, hex-encoded — used for bundle content digests. */
export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Canonical JSON stringify with sorted keys, so a signature over an object is
 * stable regardless of key order. Used to sign manifests / license payloads.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Sign a JSON-serializable payload (canonicalized) and return a base64 signature. */
export function signPayload(payload: unknown, privateKeyPem: string): string {
  return signString(canonicalJson(payload), privateKeyPem);
}

/** Verify a base64 signature over a canonicalized JSON payload. */
export function verifyPayload(payload: unknown, signatureB64: string, publicKeyPem: string): boolean {
  return verifyString(canonicalJson(payload), signatureB64, publicKeyPem);
}

// ---------------------------------------------------------------------------------------------
// Symmetric encryption-at-rest (§ Production Readiness Audit — driver/integration secrets stored
// as plaintext JSON at rest). AES-256-GCM: authenticated, so tampering with stored ciphertext is
// detected rather than silently decrypting to garbage.
// ---------------------------------------------------------------------------------------------

const SECRET_ALGORITHM = "aes-256-gcm";
const SECRET_PREFIX = "enc:v1:";

/** Generate a random 256-bit key for {@link encryptSecret}/{@link decryptSecret}, base64-encoded. */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString("base64");
}

/**
 * Encrypt a UTF-8 string with AES-256-GCM (fresh random 12-byte IV per call). Returns a
 * self-describing string (`enc:v1:<iv>:<authTag>:<ciphertext>`, each segment base64) so a
 * decryptor — or a re-encryption step — can recognize ciphertext on sight via
 * {@link isEncryptedSecret}, without a separate "is this field encrypted" flag anywhere else.
 */
export function encryptSecret(plaintext: string, keyB64: string): string {
  const key = Buffer.from(keyB64, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv(SECRET_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SECRET_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

/**
 * True when `value` is a string produced by {@link encryptSecret}. The one signal used to tell
 * real ciphertext apart from a legacy, never-yet-encrypted plaintext value, so encrypt/decrypt
 * can both be called unconditionally and idempotently — encrypting already-ciphertext, or
 * decrypting still-legacy-plaintext, are each a safe no-op rather than an error.
 */
export function isEncryptedSecret(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(SECRET_PREFIX);
}

/**
 * Decrypt a value produced by {@link encryptSecret}. Throws on real corruption/tampering (GCM
 * auth-tag mismatch, malformed segments, wrong key) — callers should check
 * {@link isEncryptedSecret} first to handle the legacy-plaintext-passthrough case; this function
 * always assumes its input is genuine ciphertext.
 */
export function decryptSecret(encoded: string, keyB64: string): string {
  const key = Buffer.from(keyB64, "base64");
  const rest = encoded.slice(SECRET_PREFIX.length);
  const [ivB64, tagB64, ciphertextB64] = rest.split(":");
  if (!ivB64 || !tagB64 || !ciphertextB64) {
    throw new Error("decryptSecret: malformed ciphertext");
  }
  const decipher = createDecipheriv(SECRET_ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
}

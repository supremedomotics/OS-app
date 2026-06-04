import {
  createHash,
  generateKeyPairSync,
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

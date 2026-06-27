import { createCipheriv, createHmac, pbkdf2Sync, timingSafeEqual } from "node:crypto";

/**
 * WinZip-AES decryption for password-protected `.knxproj` archives (§4).
 *
 * ETS6 protects a project by encrypting each zip entry with WinZip AES (the same scheme
 * 7-Zip/WinZip use): the entry's compression method becomes 99 and an extra field (id
 * 0x9901, "AE-x") records the AES strength and the *real* compression method. The entry
 * bytes are laid out as:
 *
 *   [ salt ][ 2-byte password verifier ][ ciphertext ][ 10-byte HMAC-SHA1 auth code ]
 *
 * Keys come from PBKDF2-HMAC-SHA1(password, salt, 1000) split into encKey ‖ authKey ‖
 * 2-byte verifier. The cipher is AES in CTR mode with a 16-byte LITTLE-ENDIAN counter that
 * starts at 1 — Node's `aes-*-ctr` counts big-endian, so we run AES-ECB over each counter
 * block ourselves and XOR. After decryption the plaintext is still deflated (or stored).
 */

/** AES strength byte from the 0x9901 extra field → key/salt sizes + ECB cipher. */
const STRENGTH = {
  1: { keyBytes: 16, saltBytes: 8, cipher: "aes-128-ecb" },
  2: { keyBytes: 24, saltBytes: 12, cipher: "aes-192-ecb" },
  3: { keyBytes: 32, saltBytes: 16, cipher: "aes-256-ecb" },
} as const;

export type AesStrength = keyof typeof STRENGTH;

export class KnxDecryptError extends Error {}

/** AES-CTR keystream with a little-endian counter starting at 1 (WinZip convention). */
function aesCtrLe(key: Buffer, cipher: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  const block = Buffer.alloc(16);
  let lo = 1n; // 128-bit counter as two 64-bit halves; sub-2^64 lengths never reach `hi`.
  let hi = 0n;
  for (let i = 0; i < data.length; i += 16) {
    block.writeBigUInt64LE(lo, 0);
    block.writeBigUInt64LE(hi, 8);
    // AES-ECB encryption of the counter block is the keystream for this 16-byte chunk.
    const ecb = createCipheriv(cipher, key, null);
    ecb.setAutoPadding(false);
    const ks = Buffer.concat([ecb.update(block), ecb.final()]);
    const end = Math.min(i + 16, data.length);
    for (let j = i; j < end; j++) out[j] = data[j]! ^ ks[j - i]!;
    lo += 1n;
    if (lo > 0xffffffffffffffffn) {
      lo = 0n;
      hi += 1n;
    }
  }
  return out;
}

/**
 * Decrypt one WinZip-AES entry body. `body` is the raw stored bytes for the entry
 * (salt … auth code). Returns the still-compressed plaintext. Throws on a wrong password
 * (verifier mismatch) or a corrupt entry (auth-code mismatch).
 */
export function decryptAesEntry(body: Buffer, strength: AesStrength, password: string): Buffer {
  const s = STRENGTH[strength];
  if (!s) throw new KnxDecryptError(`unsupported AES strength ${strength}`);
  if (body.length < s.saltBytes + 2 + 10) throw new KnxDecryptError("encrypted entry too short");

  const salt = body.subarray(0, s.saltBytes);
  const verifier = body.subarray(s.saltBytes, s.saltBytes + 2);
  const cipherText = body.subarray(s.saltBytes + 2, body.length - 10);
  const authCode = body.subarray(body.length - 10);

  // PBKDF2-HMAC-SHA1 → encKey ‖ authKey ‖ 2-byte verifier.
  const derived = pbkdf2Sync(Buffer.from(password, "utf8"), salt, 1000, s.keyBytes * 2 + 2, "sha1");
  const encKey = derived.subarray(0, s.keyBytes);
  const authKey = derived.subarray(s.keyBytes, s.keyBytes * 2);
  const derivedVerifier = derived.subarray(s.keyBytes * 2);
  if (!timingSafeEqual(verifier, derivedVerifier)) throw new KnxDecryptError("wrong password");

  // Authenticate the ciphertext (HMAC-SHA1 over ciphertext, truncated to 80 bits).
  const mac = createHmac("sha1", authKey).update(cipherText).digest().subarray(0, 10);
  if (!timingSafeEqual(mac, authCode)) throw new KnxDecryptError("authentication failed (corrupt archive)");

  return aesCtrLe(encKey, s.cipher, cipherText);
}

/**
 * (§4 Phase 2 — pairing secret derivation) VERIFIED 2026-09-12 against a direct read of
 * the upstream reference client's `pairing.py` (`_get_modulus_and_exponent` +
 * `async_finish_pairing`, github.com/tronikos/androidtvremote2). Algorithm: SHA-256 over
 * client RSA modulus bytes + client exponent bytes + server modulus bytes + server
 * exponent bytes + the last 4 hex digits (2 bytes) of the 6-hex-digit code shown on the
 * TV, where "bytes" means the minimal big-endian unsigned byte encoding of each integer
 * (RFC 7517 §9.3 JWK octet form — no leading zero byte). The first byte of the digest
 * must equal the code's first 2 hex digits before the secret is even sent (a cheap
 * client-side check that lets a wrong code fail fast, before wasting a round-trip on a
 * `SecretAck` failure).
 *
 * Upstream derives the same bytes from Python `int` values via `f"{n:X}"` (a NIBBLE-
 * minimal hex string, no leading zero nibble at all — e.g. exponent 65537 formats as
 * "10001", 5 hex digits) and prepends a literal "0" only to the exponent
 * (`f"0{exponent:X}"`) to make that odd-length nibble string byte-aligned again. That
 * "0" is a nibble-alignment patch specific to Python's unpadded formatting — applying it
 * a second time on top of already byte-aligned JWK hex (this module's `exponentHex`,
 * always an even number of hex digits) would double-pad into an odd-length string and
 * silently corrupt the derived secret (Node's `Buffer.from(hex)` drops the trailing
 * nibble of odd-length input rather than throwing). So this module intentionally does
 * NOT re-add that "0": `rsaPublicKeyParts()` already produces the same final byte
 * sequence upstream's prepend trick produces, for both modulus and exponent.
 */
import { createHash, type KeyObject } from "node:crypto";

export interface RsaPublicKeyParts {
  modulusHex: string;
  exponentHex: string;
}

/** Extracts the RSA public-key modulus/exponent as hex strings from a Node `KeyObject`
 * (via its JWK export, which is a stable, documented Node API — unlike the modulus/
 * exponent extraction, this part IS verified: JWK's `n`/`e` are base64url-encoded
 * big-endian integers per RFC 7517 §9.3, a public, unrelated-to-this-vendor spec). */
export function rsaPublicKeyParts(key: KeyObject): RsaPublicKeyParts {
  const jwk = key.export({ format: "jwk" }) as { n?: string; e?: string };
  if (!jwk.n || !jwk.e) throw new Error("pairing-secret: key has no RSA n/e components");
  return { modulusHex: base64UrlToHex(jwk.n), exponentHex: base64UrlToHex(jwk.e) };
}

function base64UrlToHex(b64url: string): string {
  const buf = Buffer.from(b64url.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  // Strip leading zero bytes the way a bignum's minimal hex representation would —
  // matches the paraphrased algorithm's "modulus as hex, no padding" description.
  let start = 0;
  while (start < buf.length - 1 && buf[start] === 0) start++;
  return buf.subarray(start).toString("hex");
}

export interface PairingSecretResult {
  digest: Buffer;
  /** True if the user-entered code's first 2 hex digits match the digest's first byte —
   * the cheap client-side sanity check the paraphrase describes. A caller should treat
   * `false` as "wrong code," not attempt the secret exchange at all. */
  codeMatchesDigest: boolean;
}

/**
 * @param code The alphanumeric/hex pairing code as shown on the TV and entered by the
 * installer (expected 6 hex characters per the verified `Options`/`Configuration`
 * exchange using `ENCODING_TYPE_HEXADECIMAL` + `symbol_length: 6`).
 */
export function derivePairingSecret(clientKey: RsaPublicKeyParts, serverKey: RsaPublicKeyParts, code: string): PairingSecretResult {
  const h = createHash("sha256");
  h.update(Buffer.from(clientKey.modulusHex, "hex"));
  h.update(Buffer.from(clientKey.exponentHex, "hex"));
  h.update(Buffer.from(serverKey.modulusHex, "hex"));
  h.update(Buffer.from(serverKey.exponentHex, "hex"));
  h.update(Buffer.from(code.slice(2), "hex"));
  const digest = h.digest();
  const expectedFirstByte = parseInt(code.slice(0, 2), 16);
  return { digest, codeMatchesDigest: digest[0] === expectedFirstByte };
}

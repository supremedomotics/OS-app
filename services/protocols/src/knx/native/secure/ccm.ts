/**
 * KNX use of CCM (AES-128 CBC-MAC + CTR) — § KNX Secure primitive shared by IP Secure and Data Secure.
 *
 * Source: 03_03_07 Application Layer v02.01.01 AS, Annex A "Use of CCM" (informative) A.2–A.3, with the KNX-specific block formats in
 * §5.1.3.2; and 03_08_09 KNX IP Secure v01.01.02 AS §2.2.1.3.2. This is NOT NIST/RFC-3610 CCM: B0 and the counter blocks are supplied
 * by the caller in the KNX layouts (no flags octet), and the MAC length is 4 octets (Data Secure) or 16 octets (IP Secure).
 *
 * Steps implemented (A.3):
 *   B1..Bn  = PAD16( a | A | P )                      a = len(A) as 2 octets
 *   Y0 = AES(B0);  Yi = AES(Y(i-1) xor Bi)
 *   Sj = AES(Ctrj), Ctrj = Ctr0 with last octet = j     (j = 0..255)
 *   keystream = Ssub0 | S1 | S2 …   where Ssub0 = the (16 - macLen) LAST octets of S0 (macLen 4 → "LSB96(S0)", macLen 16 → empty)
 *   C   = P xor keystream
 *   MAC = MSB(macLen)(Yn) xor MSB(macLen)(S0)
 * Verification re-derives P, recomputes the MAC and compares in constant time; no plaintext is released on mismatch.
 *
 * Correctness evidence is in secure/ccm.test.ts (independent CBC/CTR cross-check) and secure/ccm.vectors.test.ts (the specifications'
 * own worked examples, loaded from a local licensed-material path; skipped when absent).
 */
import { createCipheriv, timingSafeEqual } from "node:crypto";

export interface KnxCcmParams {
  /** AES-128 key (16 octets). */
  key: Buffer;
  /** First CBC-MAC block B0 (16 octets), built by the caller in the KNX layout. */
  b0: Buffer;
  /** Counter block Ctr0 (16 octets); its last octet must be 00h — the counter j occupies that octet. */
  ctr0: Buffer;
  /** Associated data A (authenticated, not encrypted). */
  aad: Buffer;
  /** 4 (Data Secure) or 16 (IP Secure). */
  macLength: 4 | 16;
}

export class KnxCcmError extends Error {
  constructor(readonly code: "invalid_parameter", message: string) {
    super(message);
    this.name = "KnxCcmError";
  }
}

const BLOCK = 16;

function check(p: KnxCcmParams, payloadLength: number): void {
  if (p.key.length !== 16) throw new KnxCcmError("invalid_parameter", "CCM key must be 16 octets");
  if (p.b0.length !== BLOCK || p.ctr0.length !== BLOCK) throw new KnxCcmError("invalid_parameter", "B0 and Ctr0 must be 16 octets");
  if (p.ctr0[15] !== 0) throw new KnxCcmError("invalid_parameter", "Ctr0 octet 15 (the block counter) must be 00h");
  if (p.macLength !== 4 && p.macLength !== 16) throw new KnxCcmError("invalid_parameter", "MAC length must be 4 or 16");
  if (p.aad.length > 0xffff) throw new KnxCcmError("invalid_parameter", "associated data longer than 65535 octets");
  // keystream: (16 - macLen) octets from S0, then S1..S255 (the counter is a single octet)
  const maxPayload = (BLOCK - p.macLength) + 255 * BLOCK;
  if (payloadLength > maxPayload) throw new KnxCcmError("invalid_parameter", `payload of ${payloadLength} octets exceeds the CCM counter limit of ${maxPayload}`);
}

function aesEcb(key: Buffer): (block: Buffer) => Buffer {
  const c = createCipheriv("aes-128-ecb", key, null);
  c.setAutoPadding(false);
  return (block) => {
    const out = c.update(block);
    if (out.length !== BLOCK) throw new KnxCcmError("invalid_parameter", "AES block operation returned an unexpected length");
    return out;
  };
}

function xorInto(dst: Buffer, a: Buffer, b: Buffer, n = dst.length): Buffer {
  for (let i = 0; i < n; i++) dst[i] = a[i]! ^ b[i]!;
  return dst;
}

/** Y_n of the CBC-MAC over B0 ‖ PAD16(a ‖ A ‖ P). */
function cbcMac(aes: (b: Buffer) => Buffer, p: KnxCcmParams, plaintext: Buffer): Buffer {
  const head = Buffer.alloc(2);
  head.writeUInt16BE(p.aad.length);
  const data = Buffer.concat([head, p.aad, plaintext]);
  const padded = Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK);
  data.copy(padded);
  let y = aes(Buffer.from(p.b0));
  const tmp = Buffer.alloc(BLOCK);
  for (let off = 0; off < padded.length; off += BLOCK) {
    xorInto(tmp, y, padded.subarray(off, off + BLOCK));
    y = aes(Buffer.from(tmp));
  }
  padded.fill(0);
  return y;
}

function counterBlock(ctr0: Buffer, j: number): Buffer {
  const b = Buffer.from(ctr0);
  b[15] = j;
  return b;
}

/** S0 and the keystream used for the payload (length = payloadLength). */
function keystream(aes: (b: Buffer) => Buffer, p: KnxCcmParams, payloadLength: number): { s0: Buffer; ks: Buffer } {
  const s0 = aes(counterBlock(p.ctr0, 0));
  const parts: Buffer[] = [s0.subarray(p.macLength)];
  let have = BLOCK - p.macLength;
  for (let j = 1; have < payloadLength; j++) { parts.push(aes(counterBlock(p.ctr0, j))); have += BLOCK; }
  return { s0, ks: Buffer.concat(parts).subarray(0, payloadLength) };
}

export function ccmSeal(p: KnxCcmParams, payload: Buffer): { ciphertext: Buffer; mac: Buffer } {
  check(p, payload.length);
  const aes = aesEcb(p.key);
  const y = cbcMac(aes, p, payload);
  const { s0, ks } = keystream(aes, p, payload.length);
  const ciphertext = xorInto(Buffer.alloc(payload.length), payload, ks);
  const mac = xorInto(Buffer.alloc(p.macLength), y, s0, p.macLength);
  ks.fill(0);
  return { ciphertext, mac };
}

/** Returns the plaintext, or `null` if the MAC does not verify (no plaintext is released in that case). */
export function ccmOpen(p: KnxCcmParams, ciphertext: Buffer, mac: Buffer): Buffer | null {
  check(p, ciphertext.length);
  if (mac.length !== p.macLength) return null;
  const aes = aesEcb(p.key);
  const { s0, ks } = keystream(aes, p, ciphertext.length);
  const plaintext = xorInto(Buffer.alloc(ciphertext.length), ciphertext, ks);
  ks.fill(0);
  const y = cbcMac(aes, p, plaintext);
  const expected = xorInto(Buffer.alloc(p.macLength), y, s0, p.macLength);
  const ok = timingSafeEqual(expected, mac);
  if (!ok) { plaintext.fill(0); return null; }
  return plaintext;
}

/** MAC-only helper (empty payload): the authenticate-only constructions of IP session frames and TIMER_NOTIFY. */
export function ccmMac(p: KnxCcmParams): Buffer {
  return ccmSeal(p, Buffer.alloc(0)).mac;
}
export function ccmVerifyMac(p: KnxCcmParams, mac: Buffer): boolean {
  return ccmOpen(p, Buffer.alloc(0), mac) !== null;
}

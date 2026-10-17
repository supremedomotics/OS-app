import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ccmMac, ccmOpen, ccmSeal, ccmVerifyMac, KnxCcmError, type KnxCcmParams } from "./ccm.js";
import { makeRng } from "../test-support.js";

/**
 * Independent cross-check, no licensed data: the CBC-MAC and CTR halves are recomputed with Node's OWN aes-128-cbc and aes-128-ctr
 * (different code path from ccm.ts, which only uses single-block ECB). If both agree with the primitive across random inputs, the
 * construction implements A.3 as written in the spec text (pad16(a|A|P) CBC chain from B0; counter block with last octet j).
 */
function referenceCcm(p: KnxCcmParams, payload: Buffer): { ciphertext: Buffer; mac: Buffer } {
  const head = Buffer.alloc(2); head.writeUInt16BE(p.aad.length);
  const data = Buffer.concat([head, p.aad, payload]);
  const padded = Buffer.concat([data, Buffer.alloc((16 - (data.length % 16)) % 16)]);
  // CBC-MAC = last ciphertext block of CBC(zero IV) over B0 ‖ B1..Bn
  const cbc = createCipheriv("aes-128-cbc", p.key, Buffer.alloc(16)); cbc.setAutoPadding(false);
  const chain = Buffer.concat([cbc.update(Buffer.concat([p.b0, padded])), cbc.final()]);
  const y = chain.subarray(chain.length - 16);
  // S0 and keystream via Node CTR: counter block Ctr0 → S0, then Ctr1.. → payload stream
  const ctr = createCipheriv("aes-128-ctr", p.key, p.ctr0);
  const s = ctr.update(Buffer.alloc(16 * 256));               // S0 ‖ S1 ‖ … S255
  const s0 = s.subarray(0, 16);
  const stream = Buffer.concat([s0.subarray(p.macLength), s.subarray(16)]).subarray(0, payload.length);
  const ciphertext = Buffer.from(payload.map((b, i) => b ^ stream[i]!));
  const mac = Buffer.from(y.subarray(0, p.macLength).map((b, i) => b ^ s0[i]!));
  return { ciphertext, mac };
}

const rng = makeRng(0xcc3);
const params = (macLength: 4 | 16, aadLen: number): KnxCcmParams => {
  const ctr0 = rng.bytes(16); ctr0[15] = 0;
  return { key: rng.bytes(16), b0: rng.bytes(16), ctr0, aad: rng.bytes(aadLen), macLength };
};

describe("KNX CCM primitive — independent cross-check against Node CBC/CTR", () => {
  it("matches the reference construction for both MAC lengths over random keys, blocks, AAD and payload sizes", () => {
    for (let i = 0; i < 600; i++) {
      const macLength = i % 2 === 0 ? 16 : 4;
      const p = params(macLength, rng.int(70));
      const payload = rng.bytes(rng.int(300));
      expect(ccmSeal(p, payload)).toEqual(referenceCcm(p, payload));
    }
  });
  it("covers payload boundaries around block multiples and the counter limit", () => {
    for (const macLength of [4, 16] as const) {
      const max = (16 - macLength) + 255 * 16;
      for (const n of [0, 1, 11, 12, 13, 15, 16, 17, 31, 32, 33, 255 * 16, max]) {
        const p = params(macLength, 8);
        const payload = rng.bytes(n);
        expect(ccmSeal(p, payload)).toEqual(referenceCcm(p, payload));
        expect(ccmOpen(p, ccmSeal(p, payload).ciphertext, ccmSeal(p, payload).mac)).toEqual(payload);
      }
      expect(() => ccmSeal(params(macLength, 8), Buffer.alloc(max + 1))).toThrow(KnxCcmError);
    }
  });
});

describe("KNX CCM primitive — properties", () => {
  it("open(seal(x)) round-trips; ciphertext has the payload length; output is deterministic", () => {
    for (let i = 0; i < 300; i++) {
      const p = params(i % 2 ? 4 : 16, rng.int(40));
      const x = rng.bytes(rng.int(120));
      const s1 = ccmSeal(p, x), s2 = ccmSeal(p, x);
      expect(s1).toEqual(s2);
      expect(s1.ciphertext).toHaveLength(x.length);
      expect(s1.mac).toHaveLength(p.macLength);
      expect(ccmOpen(p, s1.ciphertext, s1.mac)).toEqual(x);
    }
  });
  it("any single-bit change to ciphertext, MAC, AAD, B0, Ctr0 or key makes verification fail and releases no plaintext", () => {
    const p = params(16, 8);
    const x = rng.bytes(40);
    const { ciphertext, mac } = ccmSeal(p, x);
    const flip = (b: Buffer, bit: number): Buffer => { const c = Buffer.from(b); c[bit >> 3] = c[bit >> 3]! ^ (1 << (bit & 7)); return c; };
    for (let bit = 0; bit < ciphertext.length * 8; bit++) expect(ccmOpen(p, flip(ciphertext, bit), mac)).toBeNull();
    for (let bit = 0; bit < mac.length * 8; bit++) expect(ccmOpen(p, ciphertext, flip(mac, bit))).toBeNull();
    for (let bit = 0; bit < p.aad.length * 8; bit++) expect(ccmOpen({ ...p, aad: flip(p.aad, bit) }, ciphertext, mac)).toBeNull();
    for (let bit = 0; bit < 128; bit++) {
      expect(ccmOpen({ ...p, b0: flip(p.b0, bit) }, ciphertext, mac)).toBeNull();
      expect(ccmOpen({ ...p, key: flip(p.key, bit) }, ciphertext, mac)).toBeNull();
      if (bit !== 120) /* skip the counter octet bits: not part of Ctr0 input by contract */ { const c = flip(p.ctr0, bit); if (c[15] === 0) expect(ccmOpen({ ...p, ctr0: c }, ciphertext, mac)).toBeNull(); }
    }
    expect(ccmOpen(p, ciphertext.subarray(1), mac)).toBeNull();            // truncated
    expect(ccmOpen(p, ciphertext, mac.subarray(1))).toBeNull();            // short MAC
    expect(ccmOpen(p, Buffer.concat([ciphertext, Buffer.from([0])]), mac)).toBeNull(); // extended
  });
  it("a 4-octet and a 16-octet MAC of the same message differ in the keystream split, so they are not prefixes of each other's ciphertext", () => {
    const base = params(16, 4); const x = rng.bytes(32);
    const a = ccmSeal(base, x), b = ccmSeal({ ...base, macLength: 4 }, x);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });
  it("authenticate-only helpers agree with seal/open on an empty payload", () => {
    const p = params(16, 30);
    const mac = ccmMac(p);
    expect(mac).toEqual(ccmSeal(p, Buffer.alloc(0)).mac);
    expect(ccmVerifyMac(p, mac)).toBe(true);
    expect(ccmVerifyMac({ ...p, aad: Buffer.concat([p.aad, Buffer.from([1])]) }, mac)).toBe(false);
  });
  it("rejects malformed parameters instead of computing something", () => {
    const p = params(16, 4);
    expect(() => ccmSeal({ ...p, key: Buffer.alloc(15) }, Buffer.alloc(1))).toThrow(KnxCcmError);
    expect(() => ccmSeal({ ...p, b0: Buffer.alloc(15) }, Buffer.alloc(1))).toThrow(KnxCcmError);
    expect(() => ccmSeal({ ...p, ctr0: Buffer.alloc(17) }, Buffer.alloc(1))).toThrow(KnxCcmError);
    const bad = Buffer.from(p.ctr0); bad[15] = 1;
    expect(() => ccmSeal({ ...p, ctr0: bad }, Buffer.alloc(1))).toThrow(KnxCcmError);
    expect(() => ccmSeal({ ...p, macLength: 8 as 4 }, Buffer.alloc(1))).toThrow(KnxCcmError);
    expect(() => ccmSeal({ ...p, aad: Buffer.alloc(0x10000) }, Buffer.alloc(1))).toThrow(KnxCcmError);
  });
  it("does not mutate its inputs", () => {
    const p = params(16, 12); const x = rng.bytes(50);
    const snap = [Buffer.from(p.key), Buffer.from(p.b0), Buffer.from(p.ctr0), Buffer.from(p.aad), Buffer.from(x)];
    ccmSeal(p, x);
    expect([p.key, p.b0, p.ctr0, p.aad, x].map((b, i) => b.equals(snap[i]!))).toEqual([true, true, true, true, true]);
    void randomBytes;
  });
});

import { createCipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeSessionRequest, decodeSessionStatus, encodeSecureWrapper, encodeSessionAuthenticate, encodeSessionRequest, encodeSessionResponse, encodeSessionStatus, encodeTimerNotify,
  KnxSecureFrameError, openSecureWrapper, parseSecureWrapper, parseSessionAuthenticate, parseSessionResponse, parseTimerNotify, peekSecureService, SecureService, SEQUENCE_MAX,
  verifySessionAuthenticate, verifySessionResponse, verifyTimerNotify, WRAPPER_MAX_SIZE, WRAPPER_MIN_SIZE,
} from "./ip-frames.js";
import { generateEcdhKeyPair } from "./ip-keys.js";
import { Secret } from "../security/secret.js";
import { makeRng } from "../test-support.js";

const rng = makeRng(0x1952);
const key = () => new Secret(rng.bytes(16));
const code = (fn: () => unknown): string => { try { fn(); return "no-throw"; } catch (e) { return e instanceof KnxSecureFrameError ? e.code : `foreign:${String(e)}`; } };
const inner = (n = 22) => { const b = rng.bytes(n); b[0] = 6; b[1] = 0x10; b.writeUInt16BE(0x0420, 2); b.writeUInt16BE(n, 4); return b; };
const wrap = (k: Secret, seq = 7n, sid = 3, body = inner()) => encodeSecureWrapper({ sessionId: sid, sequence: seq, serial: rng.bytes(6), tag: rng.bytes(2), inner: body, key: k });

describe("SECURE_WRAPPER (independent, no licensed data)", () => {
  it("round-trips across random keys, sessions, sequence values and payload sizes, incl. the 48-bit boundaries", () => {
    for (let i = 0; i < 300; i++) {
      const k = key(), body = inner(6 + rng.int(500));
      const seq = [0n, 1n, SEQUENCE_MAX, SEQUENCE_MAX - 1n, BigInt(rng.int(2 ** 30)) * BigInt(rng.int(2 ** 17))][i % 5]!;
      const f = wrap(k, seq, rng.int(0x10000), body);
      expect(f).toHaveLength(body.length + 38);
      const p = parseSecureWrapper(f);
      expect(p.sequence).toBe(seq);
      expect(openSecureWrapper(p, k)).toEqual(body);
    }
  });
  it("authenticates every header, security-information and ciphertext octet: flipping ANY octet never yields plaintext", () => {
    const k = key(), body = inner(40), f = wrap(k, 99n, 5, body);
    for (let i = 0; i < f.length; i++) {
      const bad = Buffer.from(f); bad[i] = bad[i]! ^ 0x01;
      let outcome: string;
      try { outcome = openSecureWrapper(parseSecureWrapper(bad), k) === null ? "rejected" : "ACCEPTED"; } catch (e) { outcome = e instanceof KnxSecureFrameError ? "rejected" : "foreign"; }
      expect(outcome, `octet ${i}`).toBe("rejected");
    }
  });
  it("a wrong key, wrong session id in transit, or swapped sequence/serial/tag all fail the MAC", () => {
    const k = key(), f = wrap(k, 5n, 9);
    expect(openSecureWrapper(parseSecureWrapper(f), key())).toBeNull();
    const p = parseSecureWrapper(f);
    expect(openSecureWrapper({ ...p, sessionId: 10 }, k)).toBeNull();
    expect(openSecureWrapper({ ...p, sequence: 6n }, k)).toBeNull();
    expect(openSecureWrapper({ ...p, serial: Buffer.alloc(6, 1) }, k)).toBeNull();
    expect(openSecureWrapper({ ...p, tag: Buffer.alloc(2, 1) }, k)).toBeNull();
  });
  it("enforces the size and structure rules (IPS §2.2.1.3.3)", () => {
    const k = key(), f = wrap(k);
    expect(WRAPPER_MIN_SIZE).toBe(44);
    for (let n = 0; n < WRAPPER_MIN_SIZE; n++) expect(code(() => parseSecureWrapper(f.subarray(0, n)))).toBe(n < 6 ? "too_short" : "too_short");
    expect(code(() => parseSecureWrapper(f.subarray(0, f.length - 1)))).toBe("length_mismatch");
    expect(code(() => parseSecureWrapper(Buffer.concat([f, Buffer.from([0])])))).toBe("length_mismatch");
    const hdr = Buffer.from(f); hdr[0] = 5; expect(code(() => parseSecureWrapper(hdr))).toBe("bad_header");
    const ver = Buffer.from(f); ver[1] = 0x20; expect(code(() => parseSecureWrapper(ver))).toBe("bad_header");
    const svc = Buffer.from(f); svc.writeUInt16BE(0x0951, 2); expect(code(() => parseSecureWrapper(svc))).toBe("wrong_service");
    expect(code(() => encodeSecureWrapper({ sessionId: 1, sequence: SEQUENCE_MAX + 1n, serial: rng.bytes(6), tag: rng.bytes(2), inner: inner(), key: k }))).toBe("invalid_argument");
    expect(code(() => encodeSecureWrapper({ sessionId: 1, sequence: -1n, serial: rng.bytes(6), tag: rng.bytes(2), inner: inner(), key: k }))).toBe("invalid_argument");
    expect(code(() => encodeSecureWrapper({ sessionId: 1, sequence: 0n, serial: rng.bytes(5), tag: rng.bytes(2), inner: inner(), key: k }))).toBe("invalid_argument");
    expect(code(() => encodeSecureWrapper({ sessionId: 1, sequence: 0n, serial: rng.bytes(6), tag: rng.bytes(2), inner: Buffer.alloc(5), key: k }))).toBe("invalid_argument");
    expect(code(() => encodeSecureWrapper({ sessionId: 1, sequence: 0n, serial: rng.bytes(6), tag: rng.bytes(2), inner: Buffer.alloc(4081), key: k }))).toBe("invalid_argument");
  });
});

describe("session frames (independent)", () => {
  it("SESSION_REQUEST: exactly 46 octets, TCP route-back HPAI only", () => {
    const x = generateEcdhKeyPair().publicKey, f = encodeSessionRequest(x);
    expect(f).toHaveLength(46);
    expect(decodeSessionRequest(f).clientPublic).toEqual(x);
    const udp = Buffer.from(f); udp[7] = 0x01; expect(code(() => decodeSessionRequest(udp))).toBe("bad_structure");   // UDP HPAI → discard
    const nonRb = Buffer.from(f); nonRb[10] = 1; expect(code(() => decodeSessionRequest(nonRb))).toBe("bad_structure"); // not route-back
    expect(code(() => decodeSessionRequest(f.subarray(0, 45)))).toBe("length_mismatch");
    expect(code(() => encodeSessionRequest(Buffer.alloc(31)))).toBe("invalid_argument");
  });
  it("SESSION_RESPONSE: 56 octets; MAC binds device code, session id and both public values", () => {
    const c = generateEcdhKeyPair(), s = generateEcdhKeyPair(), dac = key();
    const f = encodeSessionResponse({ sessionId: 7, serverPublic: s.publicKey, clientPublic: c.publicKey, deviceAuthCode: dac });
    expect(f).toHaveLength(56);
    const p = parseSessionResponse(f);
    expect(verifySessionResponse(p, c.publicKey, dac)).toBe(true);
    expect(verifySessionResponse({ ...p, sessionId: 8 }, c.publicKey, dac)).toBe(false);
    expect(verifySessionResponse({ ...p, serverPublic: generateEcdhKeyPair().publicKey }, c.publicKey, dac)).toBe(false);
    expect(verifySessionResponse(p, generateEcdhKeyPair().publicKey, dac)).toBe(false);
    expect(verifySessionResponse(p, Buffer.alloc(31), dac)).toBe(false);
    expect(code(() => parseSessionResponse(f.subarray(0, 55)))).toBe("length_mismatch");
  });
  it("SESSION_AUTHENTICATE: 24 octets; reserved octet must be 00h; user id range 01h–7Fh; MAC binds user id and both public values", () => {
    const c = generateEcdhKeyPair(), s = generateEcdhKeyPair(), h = key();
    const f = encodeSessionAuthenticate({ userId: 2, clientPublic: c.publicKey, serverPublic: s.publicKey, passwordHash: h });
    expect(f).toHaveLength(24);
    const p = parseSessionAuthenticate(f);
    expect(p.userId).toBe(2);
    expect(verifySessionAuthenticate(p, c.publicKey, s.publicKey, h)).toBe(true);
    expect(verifySessionAuthenticate({ ...p, userId: 3 }, c.publicKey, s.publicKey, h)).toBe(false);
    expect(verifySessionAuthenticate(p, s.publicKey, c.publicKey, h)).toBe(true);        // X⊕Y is symmetric in the AAD — documented property of the spec's construction
    expect(verifySessionAuthenticate(p, c.publicKey, generateEcdhKeyPair().publicKey, h)).toBe(false);
    const rsv = Buffer.from(f); rsv[6] = 1; expect(code(() => parseSessionAuthenticate(rsv))).toBe("reserved_nonzero");
    for (const bad of [0, 0x80, 0xff, 0x100, -1]) expect(code(() => encodeSessionAuthenticate({ userId: bad, clientPublic: c.publicKey, serverPublic: s.publicKey, passwordHash: h })), `user ${bad}`).toBe("invalid_argument");
  });
  it("SESSION_STATUS: 8 octets, reserved octet zero", () => {
    for (let st = 0; st <= 5; st++) expect(decodeSessionStatus(encodeSessionStatus(st))).toBe(st);
    const f = encodeSessionStatus(5);
    expect(f).toHaveLength(8);
    const r = Buffer.from(f); r[7] = 1; expect(code(() => decodeSessionStatus(r))).toBe("reserved_nonzero");
    expect(code(() => decodeSessionStatus(f.subarray(0, 7)))).toBe("length_mismatch");
  });
  it("TIMER_NOTIFY: exactly 36 octets; MAC binds timer, serial and tag", () => {
    const k = key(), serial = rng.bytes(6), tag = rng.bytes(2);
    const f = encodeTimerNotify({ timer: 123456789n, serial, tag, key: k });
    expect(f).toHaveLength(36);
    const p = parseTimerNotify(f);
    expect(p.timer).toBe(123456789n);
    expect(verifyTimerNotify(p, k)).toBe(true);
    expect(verifyTimerNotify({ ...p, timer: 123456790n }, k)).toBe(false);
    expect(verifyTimerNotify({ ...p, serial: rng.bytes(6) }, k)).toBe(false);
    expect(verifyTimerNotify({ ...p, tag: rng.bytes(2) }, k)).toBe(false);
    expect(verifyTimerNotify(p, key())).toBe(false);
    expect(code(() => parseTimerNotify(Buffer.concat([f, Buffer.from([0])])))).toBe("length_mismatch");
  });
  it("peekSecureService identifies only the six secure services", () => {
    expect(peekSecureService(encodeSessionStatus(0))).toBe(SecureService.SESSION_STATUS);
    expect(peekSecureService(inner())).toBeNull();            // 0x0420 tunnelling
    expect(peekSecureService(Buffer.alloc(3))).toBeNull();
  });
});

describe("fuzz: decoders only ever throw KnxSecureFrameError", () => {
  it("random and mutated frames", () => {
    const k = key();
    const seeds = [wrap(k), encodeSessionStatus(0), encodeTimerNotify({ timer: 1n, serial: rng.bytes(6), tag: rng.bytes(2), key: k }), encodeSessionRequest(rng.bytes(32))];
    const fns: Array<(b: Buffer) => unknown> = [parseSecureWrapper, parseSessionResponse, parseSessionAuthenticate, decodeSessionStatus, parseTimerNotify, decodeSessionRequest];
    for (let i = 0; i < 6000; i++) {
      const b = i % 2 ? rng.bytes(rng.int(80)) : (() => { const m = Buffer.from(seeds[rng.int(seeds.length)]!); for (let j = 0, n = 1 + rng.int(3); j < n; j++) m[rng.int(m.length)] = rng.int(256); return m.subarray(0, rng.int(m.length) + 1); })();
      for (const fn of fns) { try { fn(b); } catch (e) { expect(e).toBeInstanceOf(KnxSecureFrameError); } }
    }
  });
});

// Blocker B8: the governing limit (IPS §2.2.1.3.2 note) applies to P = the ENCAPSULATED frame: 255 × 16 = 4 080 octets, which makes the
// complete SECURE_WRAPPER 6 + 16 + 4 080 + 16 = 4 118 octets. It does not apply to plain frames and is not the stream-deframer cap (8 192, decision I).
describe("wrapper size boundaries (B8)", () => {
  it("arithmetic: overhead 38, max payload 4080, max wrapper 4118", () => {
    expect(WRAPPER_MAX_SIZE).toBe(6 + 16 + 4080 + 16);
    expect(WRAPPER_MAX_SIZE).toBe(4118);
  });
  it("an encapsulated frame of exactly 4080 octets round-trips; 4081 is refused at encoding; 5 (below the 6-octet header) is refused", () => {
    const k = key();
    const body = inner(4080);
    const f = wrap(k, 5n, 2, body);
    expect(f).toHaveLength(WRAPPER_MAX_SIZE);
    expect(openSecureWrapper(parseSecureWrapper(f), k)!.equals(body)).toBe(true);
    expect(code(() => wrap(k, 5n, 2, inner(4081)))).toBe("invalid_argument");
    expect(code(() => wrap(k, 5n, 2, Buffer.alloc(5)))).toBe("invalid_argument");
  });
  it("the last keystream block (counter [j] = FFh) matches an independent AES-CTR computation", () => {
    const k = key(), body = inner(4080), serial = rng.bytes(6), tag = rng.bytes(2);
    const f = encodeSecureWrapper({ sessionId: 9, sequence: 0x0123456789abn, serial, tag, inner: body, key: k });
    const seq = Buffer.from("0123456789ab", "hex");
    const ctr1 = Buffer.concat([seq, serial, tag, Buffer.from([0xff, 0x01])]);
    const ks = k.use((kk) => { const c = createCipheriv("aes-128-ctr", kk, ctr1); return Buffer.concat([c.update(Buffer.alloc(4080)), c.final()]); });
    const expected = Buffer.from(body.map((x, i) => x ^ ks[i]!));
    expect(f.subarray(6 + 16, 6 + 16 + 4080).equals(expected)).toBe(true);
  });
  it("a received wrapper larger than 4118 octets can never open, even with a header that is internally consistent", () => {
    const k = key();
    const f = wrap(k, 1n, 2, inner(4080));
    const big = Buffer.concat([f, Buffer.alloc(16)]);
    big.writeUInt16BE(big.length, 4);
    expect(openSecureWrapper(parseSecureWrapper(big), k)).toBeNull();
  });
});

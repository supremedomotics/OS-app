/**
 * KNX IP Secure frame codecs (§ KNX Secure — IP layer): SESSION_REQUEST/RESPONSE/AUTHENTICATE/STATUS, SECURE_WRAPPER, TIMER_NOTIFY.
 * Source: 03_08_09 KNX IP Secure v01.01.02 AS §2.2.1.3, §2.2.2.4, §2.2.3.6–9; CCM per secure/ccm.ts.
 *
 * Pure functions, no I/O, no timers. Decoding is strict and total: any malformed input throws {@link KnxSecureFrameError} with a code;
 * frames that fail authentication are reported as `false` / `null` and NEVER yield plaintext. Size rules are the ones printed in the
 * specification ("shall be discarded"): wrapper ≥ 44, SESSION_REQUEST 46, SESSION_RESPONSE 56, SESSION_AUTHENTICATE 24,
 * SESSION_STATUS 8, TIMER_NOTIFY 36.
 */
import { ccmOpen, ccmSeal, ccmVerifyMac, type KnxCcmParams } from "./ccm.js";
import type { Secret } from "../security/secret.js";

export const SecureService = {
  SECURE_WRAPPER: 0x0950,
  SESSION_REQUEST: 0x0951,
  SESSION_RESPONSE: 0x0952,
  SESSION_AUTHENTICATE: 0x0953,
  SESSION_STATUS: 0x0954,
  TIMER_NOTIFY: 0x0955,
} as const;
export type SecureServiceCode = (typeof SecureService)[keyof typeof SecureService];

/** IPS §2.2.3.9.2 */
export const SessionStatus = {
  AUTHENTICATION_SUCCESS: 0x00,
  AUTHENTICATION_FAILED: 0x01,
  UNAUTHENTICATED: 0x02,
  TIMEOUT: 0x03,
  KEEPALIVE: 0x04,
  CLOSE: 0x05,
} as const;

export const WRAPPER_MIN_SIZE = 44;
export const WRAPPER_OVERHEAD = 6 + 16 + 16;           // header + security info + MAC
export const MAX_WRAPPED_PAYLOAD = 255 * 16;            // CCM counter limit (IPS §2.2.1.3.2 note: 4 080 octets)
/**
 * Largest possible SECURE_WRAPPER = header 6 + security info 16 + P + MAC 16 with P = the encapsulated KNXnet/IP frame ≤ 255×16 = 4 080 octets
 * (IPS §2.2.1.3.2 note: P is limited by B0 to 65 279 octets but "practically" by the one-octet block counter [j] to 4 080) ⇒ 4 118 octets.
 * Class N-derived: it bounds ONLY the outer SECURE_WRAPPER (P is the nested frame; the MAC is not part of P). It says nothing about plain frames.
 */
export const WRAPPER_MAX_SIZE = WRAPPER_OVERHEAD + MAX_WRAPPED_PAYLOAD;
export const SEQUENCE_MAX = (1n << 48n) - 1n;

export type SecureFrameErrorCode =
  | "too_short" | "bad_header" | "length_mismatch" | "wrong_service" | "bad_structure" | "reserved_nonzero" | "invalid_argument";

export class KnxSecureFrameError extends Error {
  constructor(readonly code: SecureFrameErrorCode, message: string) {
    super(message);
    this.name = "KnxSecureFrameError";
  }
}

const be16 = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const xorBuf = (a: Buffer, b: Buffer): Buffer => Buffer.from(a.map((x, i) => x ^ b[i]!));
const u48 = (n: bigint): Buffer => {
  if (n < 0n || n > SEQUENCE_MAX) throw new KnxSecureFrameError("invalid_argument", "48-bit value out of range");
  const b = Buffer.alloc(6); b.writeUIntBE(Number(n >> 24n), 0, 3); b.writeUIntBE(Number(n & 0xffffffn), 3, 3); return b;
};
const readU48 = (b: Buffer, off: number): bigint => (BigInt(b.readUIntBE(off, 3)) << 24n) | BigInt(b.readUIntBE(off + 3, 3));

function header(service: number, total: number): Buffer {
  const h = Buffer.alloc(6);
  h[0] = 0x06; h[1] = 0x10; h.writeUInt16BE(service, 2); h.writeUInt16BE(total, 4);
  return h;
}

/** Validates the 6-octet header and total length; returns the body. */
function openFrame(buf: Buffer, service: SecureServiceCode, expectedTotal?: number): Buffer {
  if (buf.length < 6) throw new KnxSecureFrameError("too_short", `${buf.length} octets is shorter than a KNXnet/IP header`);
  if (buf[0] !== 0x06 || buf[1] !== 0x10) throw new KnxSecureFrameError("bad_header", "header size / protocol version is not 06h / 10h");
  if (buf.readUInt16BE(2) !== service) throw new KnxSecureFrameError("wrong_service", `expected service 0x${service.toString(16)}, got 0x${buf.readUInt16BE(2).toString(16)}`);
  if (buf.readUInt16BE(4) !== buf.length) throw new KnxSecureFrameError("length_mismatch", `declared length ${buf.readUInt16BE(4)} != frame length ${buf.length}`);
  if (expectedTotal !== undefined && buf.length !== expectedTotal) throw new KnxSecureFrameError("length_mismatch", `${buf.length} octets, this service is fixed at ${expectedTotal}`);
  return buf.subarray(6);
}

/** Service type of a plausible secure frame header, or null (does not throw). */
export function peekSecureService(buf: Buffer): SecureServiceCode | null {
  if (buf.length < 6 || buf[0] !== 0x06 || buf[1] !== 0x10) return null;
  const s = buf.readUInt16BE(2);
  return (Object.values(SecureService) as number[]).includes(s) ? (s as SecureServiceCode) : null;
}

const ZERO14 = Buffer.alloc(14);
const sessionB0 = (): Buffer => Buffer.concat([ZERO14, be16(0)]);
const sessionCtr0 = (): Buffer => Buffer.concat([ZERO14, Buffer.from([0xff, 0x00])]);

function sessionMac(key: Secret, aad: Buffer): Buffer {
  return key.use((k) => ccmSeal({ key: k, b0: sessionB0(), ctr0: sessionCtr0(), aad, macLength: 16 }, Buffer.alloc(0)).mac);
}
function sessionMacOk(key: Secret, aad: Buffer, mac: Buffer): boolean {
  return key.use((k) => ccmVerifyMac({ key: k, b0: sessionB0(), ctr0: sessionCtr0(), aad, macLength: 16 }, mac));
}

// ---------------------------------------------------------------------------------------------------------------------
// SESSION_REQUEST (IPS §2.2.3.6): header · HPAI (TCP route-back) · client public value X                  46 octets

const TCP_ROUTE_BACK_HPAI = Buffer.from([0x08, 0x02, 0, 0, 0, 0, 0, 0]);

export function encodeSessionRequest(clientPublic: Buffer): Buffer {
  if (clientPublic.length !== 32) throw new KnxSecureFrameError("invalid_argument", "client public value must be 32 octets");
  return Buffer.concat([header(SecureService.SESSION_REQUEST, 46), TCP_ROUTE_BACK_HPAI, clientPublic]);
}

export function decodeSessionRequest(buf: Buffer): { clientPublic: Buffer } {
  const body = openFrame(buf, SecureService.SESSION_REQUEST, 46);
  // §2.2.3.6.4: only valid with a TCP route-back HPAI; any other HPAI → discard.
  if (!body.subarray(0, 8).equals(TCP_ROUTE_BACK_HPAI)) throw new KnxSecureFrameError("bad_structure", "SESSION_REQUEST HPAI is not a TCP route-back endpoint");
  return { clientPublic: Buffer.from(body.subarray(8, 40)) };
}

// ---------------------------------------------------------------------------------------------------------------------
// SESSION_RESPONSE (IPS §2.2.3.7): header · session id · server public value Y · MAC                       56 octets
// MAC: CCM, key = Device Authentication Code, A = header ‖ session id ‖ (X xor Y) (40), P empty.

export interface ParsedSessionResponse { sessionId: number; serverPublic: Buffer; mac: Buffer; header: Buffer }

export function encodeSessionResponse(a: { sessionId: number; serverPublic: Buffer; clientPublic: Buffer; deviceAuthCode: Secret }): Buffer {
  if (a.serverPublic.length !== 32 || a.clientPublic.length !== 32) throw new KnxSecureFrameError("invalid_argument", "public values must be 32 octets");
  if (!Number.isInteger(a.sessionId) || a.sessionId < 0 || a.sessionId > 0xffff) throw new KnxSecureFrameError("invalid_argument", "session id out of range");
  const h = header(SecureService.SESSION_RESPONSE, 56);
  const aad = Buffer.concat([h, be16(a.sessionId), xorBuf(a.clientPublic, a.serverPublic)]);
  return Buffer.concat([h, be16(a.sessionId), a.serverPublic, sessionMac(a.deviceAuthCode, aad)]);
}

export function parseSessionResponse(buf: Buffer): ParsedSessionResponse {
  const body = openFrame(buf, SecureService.SESSION_RESPONSE, 56);
  return { header: Buffer.from(buf.subarray(0, 6)), sessionId: body.readUInt16BE(0), serverPublic: Buffer.from(body.subarray(2, 34)), mac: Buffer.from(body.subarray(34, 50)) };
}

export function verifySessionResponse(p: ParsedSessionResponse, clientPublic: Buffer, deviceAuthCode: Secret): boolean {
  if (clientPublic.length !== 32) return false;
  const aad = Buffer.concat([p.header, be16(p.sessionId), xorBuf(clientPublic, p.serverPublic)]);
  return sessionMacOk(deviceAuthCode, aad, p.mac);
}

// ---------------------------------------------------------------------------------------------------------------------
// SESSION_AUTHENTICATE (IPS §2.2.3.8): header · reserved 00h · user id · MAC                                24 octets
// MAC: CCM, key = password hash, A = header ‖ 00h ‖ user id ‖ (X xor Y) (40), P empty.

export function encodeSessionAuthenticate(a: { userId: number; clientPublic: Buffer; serverPublic: Buffer; passwordHash: Secret }): Buffer {
  if (!Number.isInteger(a.userId) || a.userId < 0x01 || a.userId > 0x7f) throw new KnxSecureFrameError("invalid_argument", "user id must be 01h–7Fh (00h and 80h–FFh are reserved)");
  const h = header(SecureService.SESSION_AUTHENTICATE, 24);
  const aad = Buffer.concat([h, Buffer.from([0x00, a.userId]), xorBuf(a.clientPublic, a.serverPublic)]);
  return Buffer.concat([h, Buffer.from([0x00, a.userId]), sessionMac(a.passwordHash, aad)]);
}

export interface ParsedSessionAuthenticate { userId: number; mac: Buffer; header: Buffer }

export function parseSessionAuthenticate(buf: Buffer): ParsedSessionAuthenticate {
  const body = openFrame(buf, SecureService.SESSION_AUTHENTICATE, 24);
  if (body[0] !== 0x00) throw new KnxSecureFrameError("reserved_nonzero", "SESSION_AUTHENTICATE reserved octet must be 00h"); // §2.2.3.8.2
  return { header: Buffer.from(buf.subarray(0, 6)), userId: body[1]!, mac: Buffer.from(body.subarray(2, 18)) };
}

export function verifySessionAuthenticate(p: ParsedSessionAuthenticate, clientPublic: Buffer, serverPublic: Buffer, passwordHash: Secret): boolean {
  const aad = Buffer.concat([p.header, Buffer.from([0x00, p.userId]), xorBuf(clientPublic, serverPublic)]);
  return sessionMacOk(passwordHash, aad, p.mac);
}

// ---------------------------------------------------------------------------------------------------------------------
// SESSION_STATUS (IPS §2.2.3.9): header · status · reserved                                                  8 octets

export function encodeSessionStatus(status: number): Buffer {
  if (!Number.isInteger(status) || status < 0 || status > 0xff) throw new KnxSecureFrameError("invalid_argument", "status out of range");
  return Buffer.concat([header(SecureService.SESSION_STATUS, 8), Buffer.from([status, 0x00])]);
}

/** Returns the status code. A non-zero reserved octet makes the frame invalid (IPS §2.4.1: wrong reserved value → ignore). */
export function decodeSessionStatus(buf: Buffer): number {
  const body = openFrame(buf, SecureService.SESSION_STATUS, 8);
  if (body[1] !== 0x00) throw new KnxSecureFrameError("reserved_nonzero", "SESSION_STATUS reserved octet must be 00h");
  return body[0]!;
}

// ---------------------------------------------------------------------------------------------------------------------
// SECURE_WRAPPER (IPS §2.2.1.3): header · session id(2) · sequence info(6) · serial(6) · tag(2) · encrypted inner frame · MAC(16)
// CCM: key = session key (unicast) or Secure Backbone Key (multicast, session id 0000h); A = header ‖ session id (8);
//      P = inner frame; B0 = seq‖serial‖tag‖Q(2); Ctr0 = seq‖serial‖tag‖FFh‖00h.

export interface WrapperFields { sessionId: number; sequence: bigint; serial: Buffer; tag: Buffer }

function wrapperParams(key: Buffer, f: WrapperFields, aad: Buffer, q: number): KnxCcmParams {
  const seq = u48(f.sequence);
  return {
    key, aad, macLength: 16,
    b0: Buffer.concat([seq, f.serial, f.tag, be16(q)]),
    ctr0: Buffer.concat([seq, f.serial, f.tag, Buffer.from([0xff, 0x00])]),
  };
}

export function encodeSecureWrapper(a: WrapperFields & { inner: Buffer; key: Secret }): Buffer {
  if (a.serial.length !== 6 || a.tag.length !== 2) throw new KnxSecureFrameError("invalid_argument", "serial must be 6 and tag 2 octets");
  if (!Number.isInteger(a.sessionId) || a.sessionId < 0 || a.sessionId > 0xffff) throw new KnxSecureFrameError("invalid_argument", "session id out of range");
  if (a.inner.length < 6) throw new KnxSecureFrameError("invalid_argument", "the encapsulated frame includes at least a 6-octet KNXnet/IP header");
  if (a.inner.length > MAX_WRAPPED_PAYLOAD) throw new KnxSecureFrameError("invalid_argument", `encapsulated frame exceeds ${MAX_WRAPPED_PAYLOAD} octets`);
  const total = a.inner.length + WRAPPER_OVERHEAD;
  if (total > 0xffff) throw new KnxSecureFrameError("invalid_argument", "frame too large");
  const aad = Buffer.concat([header(SecureService.SECURE_WRAPPER, total), be16(a.sessionId)]);
  const { ciphertext, mac } = a.key.use((k) => ccmSeal(wrapperParams(k, a, aad, a.inner.length), a.inner));
  return Buffer.concat([aad, u48(a.sequence), a.serial, a.tag, ciphertext, mac]);
}

export interface ParsedWrapper extends WrapperFields { cipher: Buffer; mac: Buffer }

export function parseSecureWrapper(buf: Buffer): ParsedWrapper {
  if (buf.length < WRAPPER_MIN_SIZE) throw new KnxSecureFrameError("too_short", `SECURE_WRAPPER of ${buf.length} octets is below the 44-octet minimum`);
  const body = openFrame(buf, SecureService.SECURE_WRAPPER);
  return {
    sessionId: body.readUInt16BE(0), sequence: readU48(body, 2), serial: Buffer.from(body.subarray(8, 14)), tag: Buffer.from(body.subarray(14, 16)),
    cipher: Buffer.from(body.subarray(16, body.length - 16)), mac: Buffer.from(body.subarray(body.length - 16)),
  };
}

/** Decrypts and authenticates. Returns the encapsulated frame, or `null` if the MAC does not verify. */
export function openSecureWrapper(p: ParsedWrapper, key: Secret): Buffer | null {
  if (p.cipher.length < 6 || p.cipher.length > MAX_WRAPPED_PAYLOAD) return null;
  // The associated data is REBUILT from the parsed fields (header with the length implied by the ciphertext, then the session id),
  // so the authenticated bytes can never drift from the fields the caller acts on.
  const aad = Buffer.concat([header(SecureService.SECURE_WRAPPER, p.cipher.length + WRAPPER_OVERHEAD), be16(p.sessionId)]);
  return key.use((k) => ccmOpen(wrapperParams(k, p, aad, p.cipher.length), p.cipher, p.mac));
}

// ---------------------------------------------------------------------------------------------------------------------
// TIMER_NOTIFY (IPS §2.2.2.4): header · timer(6) · serial(6) · tag(2) · MAC(16)                              36 octets
// CCM: key = Secure Backbone Key; A = header (6); P empty; B0 = timer‖serial‖tag‖0000; Ctr0 = timer‖serial‖tag‖FFh‖00h.

export interface TimerNotifyFields { timer: bigint; serial: Buffer; tag: Buffer }

function timerParams(key: Buffer, f: TimerNotifyFields, aad: Buffer): KnxCcmParams {
  const t = u48(f.timer);
  return { key, aad, macLength: 16, b0: Buffer.concat([t, f.serial, f.tag, be16(0)]), ctr0: Buffer.concat([t, f.serial, f.tag, Buffer.from([0xff, 0x00])]) };
}

export function encodeTimerNotify(a: TimerNotifyFields & { key: Secret }): Buffer {
  if (a.serial.length !== 6 || a.tag.length !== 2) throw new KnxSecureFrameError("invalid_argument", "serial must be 6 and tag 2 octets");
  const h = header(SecureService.TIMER_NOTIFY, 36);
  const mac = a.key.use((k) => ccmSeal(timerParams(k, a, h), Buffer.alloc(0)).mac);
  return Buffer.concat([h, u48(a.timer), a.serial, a.tag, mac]);
}

export interface ParsedTimerNotify extends TimerNotifyFields { mac: Buffer; header: Buffer }

export function parseTimerNotify(buf: Buffer): ParsedTimerNotify {
  const body = openFrame(buf, SecureService.TIMER_NOTIFY, 36);
  return { header: Buffer.from(buf.subarray(0, 6)), timer: readU48(body, 0), serial: Buffer.from(body.subarray(6, 12)), tag: Buffer.from(body.subarray(12, 14)), mac: Buffer.from(body.subarray(14, 30)) };
}

export function verifyTimerNotify(p: ParsedTimerNotify, key: Secret): boolean {
  return key.use((k) => ccmVerifyMac(timerParams(k, p, p.header), p.mac));
}

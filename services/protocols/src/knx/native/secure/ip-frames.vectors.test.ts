import { describe, expect, it } from "vitest";
import {
  encodeSecureWrapper, encodeSessionAuthenticate, encodeSessionRequest, encodeSessionResponse, encodeSessionStatus, encodeTimerNotify, openSecureWrapper,
  parseSecureWrapper, parseSessionAuthenticate, parseSessionResponse, parseTimerNotify, SessionStatus, verifySessionAuthenticate, verifySessionResponse, verifyTimerNotify,
  decodeSessionRequest, decodeSessionStatus,
} from "./ip-frames.js";
import { Secret } from "../security/secret.js";
import { hasVectors, v } from "./spec-vectors.js";

const cat = (...b: Buffer[]) => Buffer.concat(b);
const hexb = (s: string) => Buffer.from(s, "hex");
const u48 = (b: Buffer) => BigInt("0x" + b.toString("hex"));
const S = (name: string) => new Secret(v(name));

/** Frames are compared with the binary examples of IP Secure Annex A (informative); header/structure bytes come from the normative clauses. */
describe.skipIf(!hasVectors)("IP Secure frame codecs reproduce the specification's binary examples", () => {
  const X = () => v("a1_client_public_X"), Y = () => v("a2_server_public_Y");

  it("A.1.2 SESSION_REQUEST", () => {
    const f = encodeSessionRequest(X());
    expect(f.toString("hex")).toBe(cat(hexb("06100951002e"), hexb("0802000000000000"), X()).toString("hex"));
    expect(decodeSessionRequest(f).clientPublic.equals(X())).toBe(true);
  });
  it("A.2.3 SESSION_RESPONSE (and client-side MAC verification with the Device Authentication Code)", () => {
    const dac = S("a2_device_auth_code");
    const f = encodeSessionResponse({ sessionId: 1, serverPublic: Y(), clientPublic: X(), deviceAuthCode: dac });
    expect(f.toString("hex")).toBe(v("a2_response_frame").toString("hex"));
    const p = parseSessionResponse(f);
    expect(p.sessionId).toBe(1);
    expect(verifySessionResponse(p, X(), dac)).toBe(true);
    expect(verifySessionResponse(p, X(), new Secret(Buffer.alloc(16, 7)))).toBe(false);          // wrong device authentication code
    const otherX = Buffer.from(X()); otherX[0] = otherX[0]! ^ 1;
    expect(verifySessionResponse(p, otherX, dac)).toBe(false);                                   // bound to the client's public value
  });
  it("A.3.2 SESSION_AUTHENTICATE", () => {
    const hash = S("a3_password_hash");
    const f = encodeSessionAuthenticate({ userId: 1, clientPublic: X(), serverPublic: Y(), passwordHash: hash });
    expect(f.toString("hex")).toBe(v("a3_auth_frame").toString("hex"));
    const p = parseSessionAuthenticate(f);
    expect(verifySessionAuthenticate(p, X(), Y(), hash)).toBe(true);
    expect(verifySessionAuthenticate(p, X(), Y(), new Secret(Buffer.alloc(16, 9)))).toBe(false);
    expect(verifySessionAuthenticate({ ...p, userId: 2 }, X(), Y(), hash)).toBe(false);          // user id is authenticated
  });
  it("A.3.4 SECURE_WRAPPER carrying SESSION_AUTHENTICATE", () => {
    const f = encodeSecureWrapper({ sessionId: 1, sequence: 0n, serial: v("a3_wrap_serial"), tag: v("a3_wrap_tag"), inner: v("a3_auth_frame"), key: S("a3_wrap_key") });
    expect(f.toString("hex")).toBe(cat(hexb("06100950003e"), hexb("0001"), Buffer.alloc(6), v("a3_wrap_serial"), v("a3_wrap_tag"), v("a3_wrap_cipher"), v("a3_wrap_mac")).toString("hex"));
    const p = parseSecureWrapper(f);
    expect(openSecureWrapper(p, S("a3_wrap_key"))?.toString("hex")).toBe(v("a3_auth_frame").toString("hex"));
  });
  it("A.4.3 SECURE_WRAPPER carrying SESSION_STATUS(AUTHENTICATION_SUCCESS)", () => {
    expect(encodeSessionStatus(SessionStatus.AUTHENTICATION_SUCCESS).toString("hex")).toBe(v("a4_inner").toString("hex"));
    const f = encodeSecureWrapper({ sessionId: 1, sequence: 0n, serial: v("a4_serial"), tag: v("a4_tag"), inner: v("a4_inner"), key: S("a4_key") });
    expect(f.toString("hex")).toBe(cat(hexb("06100950002e"), hexb("0001"), Buffer.alloc(6), v("a4_serial"), v("a4_tag"), v("a4_cipher"), v("a4_mac")).toString("hex"));
    expect(decodeSessionStatus(openSecureWrapper(parseSecureWrapper(f), S("a4_key"))!)).toBe(SessionStatus.AUTHENTICATION_SUCCESS);
  });
  it("A.5.3 multicast SECURE_WRAPPER carrying ROUTING_INDICATION (session id 0000h, Secure Backbone Key, timer as sequence information)", () => {
    const f = encodeSecureWrapper({ sessionId: 0, sequence: u48(v("a5_timer")), serial: v("a5_serial"), tag: v("a5_tag"), inner: v("a5_inner"), key: S("a5_key") });
    expect(f.toString("hex")).toBe(cat(hexb("061009500037"), hexb("0000"), v("a5_timer"), v("a5_serial"), v("a5_tag"), v("a5_cipher"), v("a5_mac")).toString("hex"));
    const p = parseSecureWrapper(f);
    expect(p.sequence).toBe(u48(v("a5_timer")));
    expect(openSecureWrapper(p, S("a5_key"))?.toString("hex")).toBe(v("a5_inner").toString("hex"));
  });
  it("A.6.2 TIMER_NOTIFY", () => {
    const f = encodeTimerNotify({ timer: u48(v("a6_timer")), serial: v("a6_serial"), tag: v("a6_tag"), key: S("a6_key") });
    expect(f.toString("hex")).toBe(cat(hexb("061009550024"), v("a6_timer"), v("a6_serial"), v("a6_tag"), v("a6_mac")).toString("hex"));
    expect(verifyTimerNotify(parseTimerNotify(f), S("a6_key"))).toBe(true);
  });
});

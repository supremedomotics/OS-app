import { describe, expect, it } from "vitest";
import { ccmOpen, ccmSeal, type KnxCcmParams } from "./ccm.js";
import { hasVectors, v, vp } from "./spec-vectors.js";

/**
 * Verifies the CCM primitive against the SPECIFICATIONS' OWN worked examples (informative annexes):
 *   IP Secure v01.01.02 Annex A.2–A.6   and   Application Layer v02.01.01 Annex C.1.1–C.1.4.
 * The block layouts below (B0/Ctr0) are transcribed from the NORMATIVE clauses (IPS §2.2.1.3.2 Fig. 8–9, §2.2.2.4.3, §2.2.3.7.4,
 * §2.2.3.8.4; AL §5.1.3.2 Fig. 100–102), not copied from the examples. Skipped unless KNX_SECURE_VECTORS points at the local file.
 */
const z = (n: number) => Buffer.alloc(n);
const cat = (...b: Buffer[]) => Buffer.concat(b);
const xor = (a: Buffer, b: Buffer) => Buffer.from(a.map((x, i) => x ^ b[i]!));
const be16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };

// IPS §2.2.3.7.4 / §2.2.3.8.4 / §2.2.2.4.3: B0 = 14×00 ‖ Q(2) ; Ctr0 = 14×00 ‖ FFh 00h   (session frames)
const sessionB0 = () => cat(z(14), be16(0));
const sessionCtr0 = () => cat(z(14), Buffer.from([0xff, 0x00]));
// IPS §2.2.1.3.2 Fig. 8–9 (wrapper) and §2.2.2.4.3 (timer notify): B0 = SeqInf‖Serial‖Tag‖Q(2) ; Ctr0 = SeqInf‖Serial‖Tag‖FFh‖00h
const wrapB0 = (seq: Buffer, serial: Buffer, tag: Buffer, q: number) => cat(seq, serial, tag, be16(q));
const wrapCtr0 = (seq: Buffer, serial: Buffer, tag: Buffer) => cat(seq, serial, tag, Buffer.from([0xff, 0x00]));
// AL §5.1.3.2 Fig. 100/102: B0 = SeqNr|Random ‖ SA ‖ DA ‖ 00h ‖ AT ‖ TPCI/APCISec ‖ 00h ‖ q ; Ctrj = … ‖ SA ‖ DA ‖ 00 00 00 00 01 ‖ [j]
const dsB0 = (first6: Buffer, sa: Buffer, da: Buffer, at: number, tpciApci: Buffer, q: number) => cat(first6, sa, da, Buffer.from([0x00, at]), tpciApci, Buffer.from([0x00, q]));
const dsCtr0 = (first6: Buffer, sa: Buffer, da: Buffer) => cat(first6, sa, da, Buffer.from([0, 0, 0, 0, 1, 0]));

describe.skipIf(!hasVectors)("KNX CCM vs the specifications' worked examples (IP Secure Annex A, Application Layer Annex C)", () => {
  const base = (key: Buffer, b0: Buffer, ctr0: Buffer, aad: Buffer, macLength: 4 | 16): KnxCcmParams => ({ key, b0, ctr0, aad, macLength });

  it("IPS A.2.2 SESSION_RESPONSE MAC (key = Device Authentication Code, authenticate-only)", () => {
    const X = v("a1_client_public_X"), Y = v("a2_server_public_Y");
    const aad = cat(Buffer.from("061009520038", "hex"), Buffer.from("0001", "hex"), xor(X, Y));
    expect(aad).toHaveLength(40);
    const { mac } = ccmSeal(base(v("a2_device_auth_code"), sessionB0(), sessionCtr0(), aad, 16), Buffer.alloc(0));
    expect(mac.toString("hex")).toBe(v("a2_mac").toString("hex"));
    // and the complete 56-octet frame the example shows
    expect(cat(Buffer.from("061009520038", "hex"), Buffer.from("0001", "hex"), Y, mac).toString("hex")).toBe(v("a2_response_frame").toString("hex"));
  });

  it("IPS A.3.1 SESSION_AUTHENTICATE MAC (key = password hash)", () => {
    const X = v("a1_client_public_X"), Y = v("a2_server_public_Y");
    const aad = cat(Buffer.from("061009530018", "hex"), Buffer.from([0x00, 0x01]), xor(X, Y));
    const { mac } = ccmSeal(base(v("a3_password_hash"), sessionB0(), sessionCtr0(), aad, 16), Buffer.alloc(0));
    expect(mac.toString("hex")).toBe(v("a3_auth_mac").toString("hex"));
    expect(cat(Buffer.from("061009530018", "hex"), Buffer.from([0x00, 0x01]), mac).toString("hex")).toBe(v("a3_auth_frame").toString("hex"));
  });

  it("IPS A.3.3 SECURE_WRAPPER carrying SESSION_AUTHENTICATE (confidentiality + 16-octet MAC)", () => {
    const inner = v("a3_auth_frame"), seq = z(6), serial = v("a3_wrap_serial"), tag = v("a3_wrap_tag");
    const aad = Buffer.from("061009500" + "03e0001", "hex");           // wrapper header (total length 3Eh) ‖ session id 0001
    const p = base(v("a3_wrap_key"), wrapB0(seq, serial, tag, inner.length), wrapCtr0(seq, serial, tag), aad, 16);
    const { ciphertext, mac } = ccmSeal(p, inner);
    expect(ciphertext.toString("hex")).toBe(v("a3_wrap_cipher").toString("hex"));
    expect(mac.toString("hex")).toBe(v("a3_wrap_mac").toString("hex"));
    expect(ccmOpen(p, ciphertext, mac)?.toString("hex")).toBe(inner.toString("hex"));
  });

  it("IPS A.4.2 SECURE_WRAPPER carrying SESSION_STATUS", () => {
    const inner = v("a4_inner"), seq = z(6), serial = v("a4_serial"), tag = v("a4_tag");
    const aad = Buffer.from("0610095000" + "2e0001", "hex");
    const p = base(v("a4_key"), wrapB0(seq, serial, tag, inner.length), wrapCtr0(seq, serial, tag), aad, 16);
    const { ciphertext, mac } = ccmSeal(p, inner);
    expect(ciphertext.toString("hex")).toBe(v("a4_cipher").toString("hex"));
    expect(mac.toString("hex")).toBe(v("a4_mac").toString("hex"));
  });

  it("IPS A.5.2 multicast SECURE_WRAPPER carrying ROUTING_INDICATION (Secure Backbone Key, session id 0000, timer as sequence info)", () => {
    const inner = v("a5_inner"), timer = v("a5_timer"), serial = v("a5_serial"), tag = v("a5_tag");
    const aad = Buffer.from("0610095000" + "370000", "hex");
    const p = base(v("a5_key"), wrapB0(timer, serial, tag, inner.length), wrapCtr0(timer, serial, tag), aad, 16);
    const { ciphertext, mac } = ccmSeal(p, inner);
    expect(cat(ciphertext).toString("hex")).toBe(v("a5_cipher").toString("hex"));
    expect(mac.toString("hex")).toBe(v("a5_mac").toString("hex"));
  });

  it("IPS A.6.1 TIMER_NOTIFY MAC (authenticate-only, A = 6-octet header)", () => {
    const timer = v("a6_timer"), serial = v("a6_serial"), tag = v("a6_tag");
    const p = base(v("a6_key"), wrapB0(timer, serial, tag, 0), wrapCtr0(timer, serial, tag), Buffer.from("061009550024", "hex"), 16);
    expect(ccmSeal(p, Buffer.alloc(0)).mac.toString("hex")).toBe(v("a6_mac").toString("hex"));
  });

  it("AL C.1.1 S-A_Data (Tool Key, authentication + confidentiality, 4-octet MAC)", () => {
    const x = vp("c1_params"), P = Buffer.from(x.P!, "hex");
    const sa = Buffer.from(x.SA!, "hex"), da = Buffer.from(x.DA!, "hex"), seq = Buffer.from(x.seq!, "hex");
    const p = base(v("c1_key"), dsB0(seq, sa, da, 0x00, Buffer.from(x.tpci_apci!, "hex"), P.length), dsCtr0(seq, sa, da), Buffer.from(x.scf!, "hex"), 4);
    const { ciphertext, mac } = ccmSeal(p, P);
    expect(cat(ciphertext, mac).toString("hex")).toBe(v("c1_C").toString("hex"));
    expect(ccmOpen(p, ciphertext, mac)?.toString("hex")).toBe(P.toString("hex"));
  });

  it("AL C.1.2 S-A_Data (response direction)", () => {
    const x = vp("c2_params"), P = Buffer.from(x.P!, "hex");
    const sa = Buffer.from(x.SA!, "hex"), da = Buffer.from(x.DA!, "hex"), seq = Buffer.from(x.seq!, "hex");
    const p = base(v("c2_key"), dsB0(seq, sa, da, 0x00, Buffer.from(x.tpci_apci!, "hex"), P.length), dsCtr0(seq, sa, da), Buffer.from(x.scf!, "hex"), 4);
    const { ciphertext, mac } = ccmSeal(p, P);
    expect(cat(ciphertext, mac).toString("hex")).toBe(v("c2_C").toString("hex"));
  });

  it("AL C.1.3 S-A_Sync_Req (A = SCF ‖ serial, P = challenge)", () => {
    const x = vp("c3_params"), P = Buffer.from(x.challenge!, "hex");
    const sa = Buffer.from(x.SA!, "hex"), da = Buffer.from(x.DA!, "hex"), seq = Buffer.from(x.seq_local!, "hex");
    const aad = cat(Buffer.from(x.scf!, "hex"), Buffer.from(x.serial!, "hex"));
    const p = base(v("c3_key"), dsB0(seq, sa, da, 0x00, Buffer.from(x.tpci_apci!, "hex"), P.length), dsCtr0(seq, sa, da), aad, 4);
    const { ciphertext, mac } = ccmSeal(p, P);
    expect(cat(ciphertext, mac).toString("hex")).toBe(v("c3_C").toString("hex"));
  });

  it("AL C.1.4 S-A_Sync_Res (first 6 octets of B0/Ctr = Random, P = SeqNr_remote ‖ SeqNr_local)", () => {
    const x = vp("c4_params"), P = cat(Buffer.from(x.seq_remote!, "hex"), Buffer.from(x.seq_local!, "hex"));
    const sa = Buffer.from(x.SA!, "hex"), da = Buffer.from(x.DA!, "hex"), rnd = Buffer.from(x.random!, "hex");
    const p = base(v("c4_key"), dsB0(rnd, sa, da, 0x00, Buffer.from(x.tpci_apci!, "hex"), P.length), dsCtr0(rnd, sa, da), Buffer.from(x.scf!, "hex"), 4);
    const { ciphertext, mac } = ccmSeal(p, P);
    expect(cat(ciphertext, mac).toString("hex")).toBe(v("c4_C").toString("hex"));
  });
});

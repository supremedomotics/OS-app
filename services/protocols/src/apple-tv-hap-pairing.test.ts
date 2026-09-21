import { describe, it, expect } from "vitest";
import { createHash, generateKeyPairSync, sign as edSign, verify as edVerify, hkdfSync, createCipheriv, createDecipheriv, diffieHellman, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { SRP, SrpServer } from "fast-srp-hap";
import { decodeTlv8, encodeTlv8, HapTlvTag } from "./apple-tv-hap-tlv8.js";
import { generateControllerIdentity, hapPairSetup, hapPairVerify, type HapExchange, type PairSetupResult } from "./apple-tv-hap-pairing.js";

// Verified against pyatv's mrp/protocol.py: SRP_SALT/SRP_OUTPUT_INFO/SRP_INPUT_INFO.
const MRP_SALT = "MediaRemote-Salt";
const MRP_WRITE_INFO = "MediaRemote-Write-Encryption-Key";
const MRP_READ_INFO = "MediaRemote-Read-Encryption-Key";

// A deterministic fake Apple TV accessory implementing the SERVER side of pair-setup and
// pair-verify, built from the same verified primitives the controller module uses. This
// is exactly the "protocol-client abstraction... deterministic fake Apple TV server"
// the Phase 2 spec asks for — no physical hardware, but a real, spec-shaped peer, not a
// canned response.
function fixedNonce(label: string): Buffer {
  const n = Buffer.alloc(12);
  Buffer.from(label, "utf8").copy(n, 4);
  return n;
}
function hkdf(salt: string, ikm: Buffer, info: string, length: number): Buffer {
  return Buffer.from(hkdfSync("sha512", ikm, Buffer.from(salt, "utf8"), Buffer.from(info, "utf8"), length));
}
function seal(key: Buffer, nonce: Buffer, pt: Buffer): Buffer {
  const c = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 } as any);
  const enc = Buffer.concat([c.update(pt), c.final()]);
  return Buffer.concat([enc, c.getAuthTag()]);
}
function open(key: Buffer, nonce: Buffer, sealed: Buffer): Buffer {
  const tag = sealed.subarray(sealed.length - 16);
  const ct = sealed.subarray(0, sealed.length - 16);
  const d = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 } as any);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
function ed25519PubFromRaw(raw: Buffer) {
  return createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
}

class FakeAppleTvAccessory {
  readonly pin = "3939";
  readonly pairingId = Buffer.from("fake-appletv-aaaa");
  private readonly ltKeyPair = generateKeyPairSync("ed25519");
  private readonly ltpk = (this.ltKeyPair.publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);
  private readonly ltPriv = this.ltKeyPair.privateKey;

  knownControllers = new Map<string, Buffer>(); // pairingId(hex) -> ltpk

  handlePairSetup(): HapExchange {
    let srpServer: SrpServer;
    let salt: Buffer;
    let sessionKey: Buffer;
    return async (incoming: Buffer): Promise<Buffer> => {
      const tlv = decodeTlv8(incoming);
      const state = tlv.get(HapTlvTag.SeqNo)![0];
      if (state === 1) {
        salt = randomBytes(16);
        // Must use the identity+salt+password constructor form (not the verifier-only
        // form) so the server captures _I/_s and computes the HAP-specific M1 (which
        // folds in identity+salt) to match SrpClient's hap=true M1 formula.
        srpServer = new SrpServer(SRP.params.hap, salt, Buffer.from("Pair-Setup"), Buffer.from(this.pin), await SRP.genKey());
        const B = srpServer.computeB();
        return encodeTlv8([[HapTlvTag.SeqNo, Buffer.from([2])], [HapTlvTag.Salt, salt], [HapTlvTag.PublicKey, B]]);
      }
      if (state === 3) {
        const A = tlv.get(HapTlvTag.PublicKey)!;
        const M1 = tlv.get(HapTlvTag.Proof)!;
        srpServer.setA(A);
        srpServer.checkM1(M1);
        sessionKey = srpServer.computeK();
        const M2 = srpServer.computeM2();
        return encodeTlv8([[HapTlvTag.SeqNo, Buffer.from([4])], [HapTlvTag.Proof, M2]]);
      }
      if (state === 5) {
        const encryptKey = hkdf("Pair-Setup-Encrypt-Salt", sessionKey, "Pair-Setup-Encrypt-Info", 32);
        const sealedM5 = tlv.get(HapTlvTag.EncryptedData)!;
        const inner = decodeTlv8(open(encryptKey, fixedNonce("PS-Msg05"), sealedM5));
        const ctrlId = inner.get(HapTlvTag.Identifier)!;
        const ctrlLtpk = inner.get(HapTlvTag.PublicKey)!;
        const ctrlSig = inner.get(HapTlvTag.Signature)!;
        const signSalt = hkdf("Pair-Setup-Controller-Sign-Salt", sessionKey, "Pair-Setup-Controller-Sign-Info", 32);
        const ok = edVerify(null, Buffer.concat([signSalt, ctrlId, ctrlLtpk]), ed25519PubFromRaw(ctrlLtpk), ctrlSig);
        if (!ok) throw new Error("fake accessory: bad controller signature");
        this.knownControllers.set(ctrlId.toString("hex"), ctrlLtpk);

        const accessorySignSalt = hkdf("Pair-Setup-Accessory-Sign-Salt", sessionKey, "Pair-Setup-Accessory-Sign-Info", 32);
        const accessorySig = edSign(null, Buffer.concat([accessorySignSalt, this.pairingId, this.ltpk]), this.ltPriv);
        const innerM6 = encodeTlv8([
          [HapTlvTag.Identifier, this.pairingId],
          [HapTlvTag.PublicKey, this.ltpk],
          [HapTlvTag.Signature, accessorySig],
        ]);
        const sealedM6 = seal(encryptKey, fixedNonce("PS-Msg06"), innerM6);
        return encodeTlv8([[HapTlvTag.SeqNo, Buffer.from([6])], [HapTlvTag.EncryptedData, sealedM6]]);
      }
      throw new Error(`fake accessory: unexpected pair-setup state ${state}`);
    };
  }

  lastSharedSecret: Buffer | null = null;

  handlePairVerify(): HapExchange {
    let sharedSecret: Buffer;
    let accessoryEphemeralPub: Buffer;
    let controllerEphemeralPub: Buffer;
    const { publicKey: ephPub, privateKey: ephPriv } = generateKeyPairSync("x25519");
    accessoryEphemeralPub = (ephPub.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);
    return async (incoming: Buffer): Promise<Buffer> => {
      const tlv = decodeTlv8(incoming);
      const state = tlv.get(HapTlvTag.SeqNo)![0];
      if (state === 1) {
        controllerEphemeralPub = tlv.get(HapTlvTag.PublicKey)!;
        const ctrlPubObj = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), controllerEphemeralPub]), format: "der", type: "spki" });
        sharedSecret = diffieHellman({ privateKey: ephPriv, publicKey: ctrlPubObj });
        this.lastSharedSecret = sharedSecret;
        const encryptKey = hkdf("Pair-Verify-Encrypt-Salt", sharedSecret, "Pair-Verify-Encrypt-Info", 32);
        const sig = edSign(null, Buffer.concat([accessoryEphemeralPub, this.pairingId, controllerEphemeralPub]), this.ltPriv);
        const inner = encodeTlv8([[HapTlvTag.Identifier, this.pairingId], [HapTlvTag.Signature, sig]]);
        const sealed = seal(encryptKey, fixedNonce("PV-Msg02"), inner);
        return encodeTlv8([
          [HapTlvTag.SeqNo, Buffer.from([2])],
          [HapTlvTag.PublicKey, accessoryEphemeralPub],
          [HapTlvTag.EncryptedData, sealed],
        ]);
      }
      if (state === 3) {
        const encryptKey = hkdf("Pair-Verify-Encrypt-Salt", sharedSecret, "Pair-Verify-Encrypt-Info", 32);
        const sealed = tlv.get(HapTlvTag.EncryptedData)!;
        const inner = decodeTlv8(open(encryptKey, fixedNonce("PV-Msg03"), sealed));
        const ctrlId = inner.get(HapTlvTag.Identifier)!;
        const ctrlSig = inner.get(HapTlvTag.Signature)!;
        const ctrlLtpk = this.knownControllers.get(ctrlId.toString("hex"));
        if (!ctrlLtpk) return encodeTlv8([[HapTlvTag.SeqNo, Buffer.from([4])], [HapTlvTag.Error, Buffer.from([2])]]);
        const ok = edVerify(null, Buffer.concat([controllerEphemeralPub, ctrlId, accessoryEphemeralPub]), ed25519PubFromRaw(ctrlLtpk), ctrlSig);
        if (!ok) return encodeTlv8([[HapTlvTag.SeqNo, Buffer.from([4])], [HapTlvTag.Error, Buffer.from([2])]]);
        return encodeTlv8([[HapTlvTag.SeqNo, Buffer.from([4])]]);
      }
      throw new Error(`fake accessory: unexpected pair-verify state ${state}`);
    };
  }

  /** The accessory's own view of the post-verify MRP session, to prove real 2-way
   * crypto — direction swapped relative to the controller (accessory's write is the
   * controller's read, and vice versa). */
  accessorySession(sharedSecretForTest: Buffer) {
    const writeKey = hkdf(MRP_SALT, sharedSecretForTest, MRP_READ_INFO, 32); // accessory write == controller read
    const readKey = hkdf(MRP_SALT, sharedSecretForTest, MRP_WRITE_INFO, 32); // accessory read == controller write
    return { writeKey, readKey };
  }
}

describe("Apple TV HAP pairing (real crypto, deterministic fake accessory peer)", () => {
  it("completes pair-setup end-to-end (mutual SRP auth + controller identity registered)", async () => {
    const accessory = new FakeAppleTvAccessory();
    const identity = generateControllerIdentity(Buffer.from("supremeos-controller-1"));
    const result = await hapPairSetup(accessory.pin, identity, accessory.handlePairSetup());

    expect(result.accessoryPairingId.equals(accessory.pairingId)).toBe(true);
    expect(accessory.knownControllers.has(identity.pairingId.toString("hex"))).toBe(true);
  });

  it("rejects pair-setup with the wrong PIN", async () => {
    const accessory = new FakeAppleTvAccessory();
    const identity = generateControllerIdentity(Buffer.from("supremeos-controller-1"));
    await expect(hapPairSetup("0000", identity, accessory.handlePairSetup())).rejects.toThrow();
  });

  it("completes pair-verify after pair-setup and establishes a working encrypted session", async () => {
    const accessory = new FakeAppleTvAccessory();
    const identity = generateControllerIdentity(Buffer.from("supremeos-controller-2"));
    const setupResult: PairSetupResult = await hapPairSetup(accessory.pin, identity, accessory.handlePairSetup());

    const channel = await hapPairVerify(setupResult, accessory.handlePairVerify());
    expect(accessory.lastSharedSecret).not.toBeNull();
    const session = channel.deriveSession(MRP_SALT, MRP_WRITE_INFO, MRP_READ_INFO);
    const accessorySide = accessory.accessorySession(accessory.lastSharedSecret!);

    // Controller -> accessory: sealed with the controller's derived write key, opened
    // with the accessory's independently-derived matching read key — proves the MRP
    // session-key derivation (verified salt/info strings) actually interops, not just
    // that encrypt()/decrypt() don't throw.
    const toAccessory = Buffer.from("hello apple tv");
    const sealedToAccessory = session.encrypt(toAccessory);
    const nonce0 = Buffer.alloc(12); // counter 0, same scheme as counterNonce8(0)
    const c = createDecipheriv("chacha20-poly1305", accessorySide.readKey, nonce0, { authTagLength: 16 } as any);
    const tag = sealedToAccessory.subarray(sealedToAccessory.length - 16);
    const ct = sealedToAccessory.subarray(0, sealedToAccessory.length - 16);
    c.setAuthTag(tag);
    const opened = Buffer.concat([c.update(ct), c.final()]);
    expect(opened.equals(toAccessory)).toBe(true);
  });

  it("pair-verify fails if the accessory's identity doesn't match persisted credentials", async () => {
    const accessoryA = new FakeAppleTvAccessory();
    const accessoryB = new FakeAppleTvAccessory();
    const identity = generateControllerIdentity(Buffer.from("supremeos-controller-3"));
    const setupResult = await hapPairSetup(accessoryA.pin, identity, accessoryA.handlePairSetup());

    await expect(hapPairVerify(setupResult, accessoryB.handlePairVerify())).rejects.toThrow();
  });
});

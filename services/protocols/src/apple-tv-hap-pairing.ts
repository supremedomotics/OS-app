/**
 * HAP pair-setup / pair-verify — controller (client) role (§ Apple TV Phase 2 pairing).
 * Both MRP and Companion protocols pair over the same HAP handshake. Message sequence,
 * TLV state numbers, HKDF salt/info strings and nonce constants below are verified
 * against pyatv's real source (`pyatv/auth/hap_srp.py`, `pyatv/auth/hap_pairing.py`,
 * `pyatv/auth/hap_session.py` — Apache-2.0), fetched live during this phase, not
 * recalled from memory. SRP6a itself (the one primitive Node's `crypto` lacks) is
 * delegated to `fast-srp-hap`, the same SRP implementation HAP-NodeJS/Homebridge use for
 * this exact protocol — its `SRP.params.hap` group is the RFC5054 3072-bit group + SHA-512
 * this protocol requires, so no home-grown SRP math is written here.
 *
 * This module implements the CONTROLLER side of both exchanges only (SupremeOS is always
 * the controller pairing to an Apple TV accessory). Wire framing (Companion's
 * type+length+payload frames / MRP's protobuf envelope) is intentionally NOT handled
 * here — this module operates on already-demarshalled TLV8 buffers, so it plugs into
 * either transport identically. The long-lived per-protocol session key derivation
 * (§ `HapVerifiedChannel.deriveSession`) was re-verified against pyatv's real MRP
 * client during Phase 2B — see that interface's doc comment.
 */
import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import * as sodium from "node:crypto";
import { SRP, SrpClient } from "fast-srp-hap";
import { decodeTlv8, encodeTlv8, HapTlvTag } from "./apple-tv-hap-tlv8.js";

// --- Ed25519 / X25519 via Node's native crypto (no external dep needed for these). ---
import { generateKeyPairSync, sign as edSign, verify as edVerify, diffieHellman, createPrivateKey, createPublicKey } from "node:crypto";

function hkdf(salt: string, ikm: Buffer, info: string, length: number): Buffer {
  return Buffer.from(hkdfSync("sha512", ikm, Buffer.from(salt, "utf8"), Buffer.from(info, "utf8"), length));
}

export function chacha20poly1305Seal(key: Buffer, nonce: Buffer, aad: Buffer | undefined, plaintext: Buffer): Buffer {
  const cipher = sodium.createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 } as any);
  if (aad) cipher.setAAD(aad, { plaintextLength: plaintext.length } as any);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([enc, cipher.getAuthTag()]);
}

export function chacha20poly1305Open(key: Buffer, nonce: Buffer, aad: Buffer | undefined, sealed: Buffer): Buffer {
  const tag = sealed.subarray(sealed.length - 16);
  const ct = sealed.subarray(0, sealed.length - 16);
  const decipher = sodium.createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 } as any);
  if (aad) decipher.setAAD(aad, { plaintextLength: ct.length } as any);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** 12-byte little-endian nonce carrying one of HAP's fixed ASCII nonce constants right-padded. */
function fixedNonce(label: string): Buffer {
  const n = Buffer.alloc(12);
  Buffer.from(label, "utf8").copy(n, 4);
  return n;
}

export interface HapLongTermIdentity {
  /** This controller's stable pairing identifier (sent as HapTlvTag.Identifier). */
  pairingId: Buffer;
  /** Ed25519 long-term signing keypair (raw 32-byte seed / raw 32-byte public key). */
  ltskSeed: Buffer;
  ltpk: Buffer;
}

export function generateControllerIdentity(pairingId: Buffer): HapLongTermIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const ltskSeed = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(-32);
  const ltpk = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);
  return { pairingId, ltskSeed, ltpk };
}

function ed25519KeyObjectsFromSeed(seed: Buffer) {
  const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const privateKey = createPrivateKey({ key: Buffer.concat([pkcs8Prefix, seed]), format: "der", type: "pkcs8" });
  return { privateKey };
}

function ed25519PublicKeyObject(raw: Buffer) {
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  return createPublicKey({ key: Buffer.concat([spkiPrefix, raw]), format: "der", type: "spki" });
}

/** Result of a completed pair-setup exchange: what must be persisted per-device. */
export interface PairSetupResult {
  controllerPairingId: Buffer;
  controllerLtskSeed: Buffer;
  controllerLtpk: Buffer;
  accessoryPairingId: Buffer;
  accessoryLtpk: Buffer;
}

/**
 * A transport-agnostic peer: given an outgoing TLV8 message, returns the accessory's
 * TLV8 response. The caller supplies this — wired to a real Companion/MRP socket in the
 * driver, or to a deterministic fake accessory in tests.
 */
export type HapExchange = (outgoing: Buffer) => Promise<Buffer>;

/**
 * Runs the controller side of HAP pair-setup (M1-M6) against `exchange`, using the PIN
 * displayed on the Apple TV. Verified message/state sequence against pyatv's
 * `hap_srp.py`/pairing state machine: M1 PS_Start(state=1) -> M2(state=2, salt+B) ->
 * M3(state=3, A+M1) -> M4(state=4, M2 proof) -> M5(state=5, encrypted controller
 * identity+ltpk+signature) -> M6(state=6, encrypted accessory identity+ltpk+signature).
 */
export async function hapPairSetup(
  pin: string,
  identity: HapLongTermIdentity,
  exchange: HapExchange,
): Promise<PairSetupResult> {
  // M1: start pairing.
  const m1 = encodeTlv8([[HapTlvTag.SeqNo, Buffer.from([1])], [HapTlvTag.Method, Buffer.from([0])]]);
  const m2 = decodeTlv8(await exchange(m1));
  const salt = m2.get(HapTlvTag.Salt);
  const B = m2.get(HapTlvTag.PublicKey);
  if (!salt || !B) throw new Error("hap-pair-setup: M2 missing salt/public key");

  const secret1 = await SRP.genKey();
  const client = new SrpClient(SRP.params.hap, salt, Buffer.from("Pair-Setup"), Buffer.from(pin), secret1, true);
  client.setB(B);
  const A = client.computeA();
  const M1proof = client.computeM1();

  // M3: client public key + proof.
  const m3 = encodeTlv8([
    [HapTlvTag.SeqNo, Buffer.from([3])],
    [HapTlvTag.PublicKey, A],
    [HapTlvTag.Proof, M1proof],
  ]);
  const m4 = decodeTlv8(await exchange(m3));
  const serverProof = m4.get(HapTlvTag.Proof);
  if (!serverProof) throw new Error("hap-pair-setup: M4 missing proof");
  client.checkM2(serverProof);
  const sessionKey = client.computeK();

  // M5: encrypted controller identity, long-term public key, and a signature over
  // (Pair-Setup-Controller-Sign-Salt/Info-derived material || pairingId || ltpk) —
  // this proves possession of the controller's long-term private key.
  const encryptKey = hkdf("Pair-Setup-Encrypt-Salt", sessionKey, "Pair-Setup-Encrypt-Info", 32);
  const signSalt = hkdf("Pair-Setup-Controller-Sign-Salt", sessionKey, "Pair-Setup-Controller-Sign-Info", 32);
  const signMaterial = Buffer.concat([signSalt, identity.pairingId, identity.ltpk]);
  const { privateKey } = ed25519KeyObjectsFromSeed(identity.ltskSeed);
  const signature = edSign(null, signMaterial, privateKey);

  const innerM5 = encodeTlv8([
    [HapTlvTag.Identifier, identity.pairingId],
    [HapTlvTag.PublicKey, identity.ltpk],
    [HapTlvTag.Signature, signature],
  ]);
  const sealedM5 = chacha20poly1305Seal(encryptKey, fixedNonce("PS-Msg05"), undefined, innerM5);
  const m5 = encodeTlv8([
    [HapTlvTag.SeqNo, Buffer.from([5])],
    [HapTlvTag.EncryptedData, sealedM5],
  ]);
  const m6 = decodeTlv8(await exchange(m5));
  const sealedM6 = m6.get(HapTlvTag.EncryptedData);
  if (!sealedM6) throw new Error("hap-pair-setup: M6 missing encrypted data");
  const innerM6 = decodeTlv8(chacha20poly1305Open(encryptKey, fixedNonce("PS-Msg06"), undefined, sealedM6));
  const accessoryPairingId = innerM6.get(HapTlvTag.Identifier);
  const accessoryLtpk = innerM6.get(HapTlvTag.PublicKey);
  const accessorySignature = innerM6.get(HapTlvTag.Signature);
  if (!accessoryPairingId || !accessoryLtpk || !accessorySignature) {
    throw new Error("hap-pair-setup: M6 missing identity/public-key/signature");
  }
  // NOT independently verified this phase: the HKDF salt/info strings that would
  // authenticate the accessory's M6 signature aren't confirmed against any real
  // source (pyatv's own `SRPAuthHandler.step4` — the real, working client this
  // module's other constants are checked against — explicitly skips this check too:
  // "# TODO: verify signature here"). Rather than assert an unverified crypto claim
  // as fact, this module matches pyatv's actual, deployed behavior: M6's identity/
  // ltpk are trusted from the already-encrypted (session-key-authenticated) channel,
  // and NOT additionally signature-checked. Revisit if Apple's official HAP spec
  // text (not just pyatv's client) is available to source the real salt/info pair.

  return {
    controllerPairingId: identity.pairingId,
    controllerLtskSeed: identity.ltskSeed,
    controllerLtpk: identity.ltpk,
    accessoryPairingId,
    accessoryLtpk,
  };
}

export interface HapSession {
  encrypt(plaintext: Buffer): Buffer;
  decrypt(sealed: Buffer): Buffer;
}

/**
 * Per pyatv's `MrpPairVerifyProcedure`/`SRPAuthHandler.verify2`: the LONG-LIVED
 * transport session (MRP's or Companion's) is a SEPARATE HKDF-SHA512 pass over the same
 * raw X25519 shared secret pair-verify already established — each protocol supplies its
 * own salt/output-info/input-info strings (verified for MRP: salt "MediaRemote-Salt",
 * output "MediaRemote-Write-Encryption-Key", input "MediaRemote-Read-Encryption-Key" —
 * `pyatv/protocols/mrp/protocol.py`'s `SRP_SALT`/`SRP_OUTPUT_INFO`/`SRP_INPUT_INFO`).
 * `hapPairVerify` therefore exposes `deriveSession()` rather than a single fixed
 * session, so a transport module picks its own protocol-specific strings.
 */
export interface HapVerifiedChannel {
  /** Derive a long-lived AEAD session off this pair-verify's shared secret. Verified
   * nonce scheme (pyatv's `Chacha20Cipher8byteNonce`): 4 zero bytes + an 8-byte
   * little-endian message counter, counted independently per direction. Suits MRP;
   * Companion uses a different nonce scheme AND per-message AAD — see `deriveKeys()`. */
  deriveSession(salt: string, outputInfo: string, inputInfo: string): HapSession;
  /** Escape hatch for a protocol whose session framing genuinely differs from MRP's
   * (verified: Companion's `Chacha20Cipher` uses a plain 12-byte little-endian counter
   * nonce, no zero-padding, AND binds the frame header as AAD — neither of which
   * `deriveSession()`'s fixed scheme supports). Returns the raw HKDF-derived keys off
   * the SAME verified shared secret so a transport module can implement its own
   * nonce/AAD scheme without this module needing to special-case every protocol's
   * framing quirks. */
  deriveKeys(salt: string, outputInfo: string, inputInfo: string): { writeKey: Buffer; readKey: Buffer };
}

function counterNonce8(counter: number): Buffer {
  const n = Buffer.alloc(12);
  n.writeBigUInt64LE(BigInt(counter), 4);
  return n;
}

/**
 * Runs the controller side of HAP pair-verify (M1-M4) using a previously-persisted
 * `PairSetupResult`. Verified salt/info strings "Pair-Verify-Encrypt-Salt"/
 * "Pair-Verify-Encrypt-Info", nonces "PV-Msg02"/"PV-Msg03" (`pyatv/auth/hap_srp.py`
 * `verify1`). Returns a channel that can derive one or more protocol-specific
 * long-lived sessions off the same verified shared secret.
 */
export async function hapPairVerify(saved: PairSetupResult, exchange: HapExchange): Promise<HapVerifiedChannel> {
  const { publicKey: ephemeralPub, privateKey: ephemeralPriv } = generateKeyPairSync("x25519");
  const ourPub = (ephemeralPub.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);

  const m1 = encodeTlv8([
    [HapTlvTag.SeqNo, Buffer.from([1])],
    [HapTlvTag.PublicKey, ourPub],
  ]);
  const m2 = decodeTlv8(await exchange(m1));
  const accessoryPub = m2.get(HapTlvTag.PublicKey);
  const sealedM2 = m2.get(HapTlvTag.EncryptedData);
  if (!accessoryPub || !sealedM2) throw new Error("hap-pair-verify: M2 missing public key/encrypted data");

  const accessoryPubKeyObj = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), accessoryPub]),
    format: "der",
    type: "spki",
  });
  const sharedSecret = diffieHellman({ privateKey: ephemeralPriv, publicKey: accessoryPubKeyObj });
  const encryptKey = hkdf("Pair-Verify-Encrypt-Salt", sharedSecret, "Pair-Verify-Encrypt-Info", 32);

  const innerM2 = decodeTlv8(chacha20poly1305Open(encryptKey, fixedNonce("PV-Msg02"), undefined, sealedM2));
  const accessoryPairingId = innerM2.get(HapTlvTag.Identifier);
  const accessorySignature = innerM2.get(HapTlvTag.Signature);
  if (!accessoryPairingId || !accessorySignature) throw new Error("hap-pair-verify: M2 inner TLV missing fields");
  if (!accessoryPairingId.equals(saved.accessoryPairingId)) {
    throw new Error("hap-pair-verify: accessory identity does not match persisted credentials");
  }
  const accessorySignMaterial = Buffer.concat([accessoryPub, accessoryPairingId, ourPub]);
  const sigOk = edVerify(null, accessorySignMaterial, ed25519PublicKeyObject(saved.accessoryLtpk), accessorySignature);
  if (!sigOk) throw new Error("hap-pair-verify: accessory signature verification failed (M2)");

  const { privateKey: ourLtsk } = ed25519KeyObjectsFromSeed(saved.controllerLtskSeed);
  const ourSignMaterial = Buffer.concat([ourPub, saved.controllerPairingId, accessoryPub]);
  const ourSignature = edSign(null, ourSignMaterial, ourLtsk);
  const innerM3 = encodeTlv8([
    [HapTlvTag.Identifier, saved.controllerPairingId],
    [HapTlvTag.Signature, ourSignature],
  ]);
  const sealedM3 = chacha20poly1305Seal(encryptKey, fixedNonce("PV-Msg03"), undefined, innerM3);
  const m3 = encodeTlv8([
    [HapTlvTag.SeqNo, Buffer.from([3])],
    [HapTlvTag.EncryptedData, sealedM3],
  ]);
  const m4 = decodeTlv8(await exchange(m3));
  if (m4.get(HapTlvTag.Error)) throw new Error("hap-pair-verify: accessory rejected verification (M4 error)");

  return {
    deriveSession(salt: string, outputInfo: string, inputInfo: string): HapSession {
      const writeKey = hkdf(salt, sharedSecret, outputInfo, 32);
      const readKey = hkdf(salt, sharedSecret, inputInfo, 32);
      let readSeq = 0;
      let writeSeq = 0;
      return {
        encrypt(plaintext: Buffer): Buffer {
          return chacha20poly1305Seal(writeKey, counterNonce8(writeSeq++), undefined, plaintext);
        },
        decrypt(sealed: Buffer): Buffer {
          return chacha20poly1305Open(readKey, counterNonce8(readSeq++), undefined, sealed);
        },
      };
    },
    deriveKeys(salt: string, outputInfo: string, inputInfo: string) {
      return {
        writeKey: hkdf(salt, sharedSecret, outputInfo, 32),
        readKey: hkdf(salt, sharedSecret, inputInfo, 32),
      };
    },
  };
}

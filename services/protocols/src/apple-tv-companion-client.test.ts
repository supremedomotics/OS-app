import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";
import { SRP, SrpServer } from "fast-srp-hap";
import { createDriverSecretCrypto } from "@supreme/drivers";
import type { DeviceId } from "@supreme/domain-model";
import { decodeTlv8, encodeTlv8, HapTlvTag } from "./apple-tv-hap-tlv8.js";
import { opackPack, opackUnpack, type OpackValue } from "./apple-tv-opack.js";
import { CompanionFrameType } from "./apple-tv-companion-transport.js";
import { pairAppleTvCompanion, connectAppleTvCompanion } from "./apple-tv-companion-client.js";
import { createAppleTvCredentialStore, createInMemoryCredentialKv } from "./apple-tv-credential-store.js";

const PAIRING_DATA_KEY = "_pd";
const COMPANION_SALT = "";
const COMPANION_WRITE_INFO = "ClientEncrypt-main";
const COMPANION_READ_INFO = "ServerEncrypt-main";

function hkdf(salt: string, ikm: Buffer, info: string, length: number): Buffer {
  return Buffer.from(hkdfSync("sha512", ikm, Buffer.from(salt, "utf8"), Buffer.from(info, "utf8"), length));
}
function seal(key: Buffer, nonce: Buffer, aad: Buffer | undefined, pt: Buffer): Buffer {
  const c = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 } as any);
  if (aad) c.setAAD(aad, { plaintextLength: pt.length } as any);
  const enc = Buffer.concat([c.update(pt), c.final()]);
  return Buffer.concat([enc, c.getAuthTag()]);
}
function open(key: Buffer, nonce: Buffer, aad: Buffer | undefined, sealed: Buffer): Buffer {
  const tag = sealed.subarray(sealed.length - 16);
  const ct = sealed.subarray(0, sealed.length - 16);
  const d = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 } as any);
  if (aad) d.setAAD(aad, { plaintextLength: ct.length } as any);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
function fixedNonce(label: string): Buffer {
  const n = Buffer.alloc(12);
  Buffer.from(label, "utf8").copy(n, 4);
  return n;
}
function counter12(seq: number): Buffer {
  const n = Buffer.alloc(12);
  n.writeUIntLE(seq, 0, 6);
  return n;
}
function ed25519PubFromRaw(raw: Buffer) {
  return createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
}

function realSecretCrypto() {
  return createDriverSecretCrypto(randomBytes(32).toString("base64"));
}

/**
 * A deterministic fake Companion Apple TV: real TCP, real [type][3-byte len] framing,
 * real OPACK, real SRP6a/Ed25519/X25519/ChaCha20-Poly1305 pairing + pair-verify +
 * AAD-bound session — built from the same verified primitives/constants the client
 * module uses.
 */
export class FakeCompanionAppleTv {
  readonly pin = "5678";
  readonly pairingId = Buffer.from("fake-companion-appletv");
  private readonly ltKeyPair: ReturnType<typeof generateKeyPairSync>;
  private readonly ltpk: Buffer;
  private readonly ltPriv: ReturnType<typeof generateKeyPairSync>["privateKey"];
  knownControllers = new Map<string, Buffer>();

  /** `reuseIdentity`: pass a PREVIOUSLY-CREATED `FakeCompanionAppleTv`'s long-term
   * identity to simulate "the SAME physical Apple TV" coming back on a fresh
   * connection/process — a genuinely different key here would (correctly) fail
   * pair-verify, since it would no longer be the accessory the controller paired with. */
  constructor(reuseIdentity?: FakeCompanionAppleTv) {
    if (reuseIdentity) {
      this.ltKeyPair = reuseIdentity.ltKeyPair;
      this.ltpk = reuseIdentity.ltpk;
      this.ltPriv = reuseIdentity.ltPriv;
    } else {
      this.ltKeyPair = generateKeyPairSync("ed25519");
      this.ltpk = (this.ltKeyPair.publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);
      this.ltPriv = this.ltKeyPair.privateKey;
    }
  }
  apps: Record<string, string> = { "com.netflix.Netflix": "Netflix", "com.google.ios.youtube": "YouTube" };
  /** Test-only: when set, sent verbatim instead of `apps` — for malformed-entry tests. */
  appListOverride: Record<string, OpackValue> | null = null;
  receivedLaunches: Array<Record<string, OpackValue>> = [];
  launchShouldFail = false;
  private readonly sockets = new Set<Socket>();

  /** Test convenience: forcibly severs every open connection (simulates the network
   * dropping this Companion endpoint out from under an already-connected client). */
  destroyAllConnections(): void {
    for (const s of this.sockets) s.destroy();
  }

  start(port = 0, retriesLeft = 20): Promise<{ server: Server; port: number }> {
    return new Promise((resolve, reject) => {
      const server = createServer((sock) => this.handleConnection(sock));
      server.once("error", (err: NodeJS.ErrnoException) => {
        server.close();
        // Rebinding to a just-closed port (test-only scenario: simulating a Companion
        // endpoint coming back) can hit a brief EADDRINUSE on some platforms while the
        // OS finishes releasing it — retry a few times rather than hang forever.
        if (err.code === "EADDRINUSE" && retriesLeft > 0 && port !== 0) {
          setTimeout(() => this.start(port, retriesLeft - 1).then(resolve, reject), 50);
        } else {
          reject(err);
        }
      });
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address();
        const boundPort = typeof addr === "object" && addr ? addr.port : 0;
        resolve({ server, port: boundPort });
      });
    });
  }

  private handleConnection(sock: Socket): void {
    this.sockets.add(sock);
    sock.on("close", () => this.sockets.delete(sock));
    let buffer = Buffer.alloc(0);
    let sharedSecret: Buffer | null = null;
    let srpServer: SrpServer | null = null;
    let srpSessionKey: Buffer | null = null;
    let controllerEphemeralPub: Buffer | null = null;
    let accessoryEphemeralPub: Buffer | null = null;
    let accessoryEphemeralPriv: ReturnType<typeof generateKeyPairSync>["privateKey"] | null = null;
    let sessionWriteKey: Buffer | null = null;
    let sessionReadKey: Buffer | null = null;
    let writeSeq = 0;
    let readSeq = 0;

    const send = (frameType: number, payload: Buffer) => {
      const payloadLen = sessionWriteKey && payload.length > 0 ? payload.length + 16 : payload.length;
      const header = Buffer.concat([Buffer.from([frameType]), lenBE3(payloadLen)]);
      const wire = sessionWriteKey && payload.length > 0 ? seal(sessionWriteKey, counter12(writeSeq++), header, payload) : payload;
      sock.write(Buffer.concat([header, wire]));
    };

    sock.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 4) return;
        const frameType = buffer[0]!;
        const length = buffer.readUIntBE(1, 3);
        if (buffer.length < 4 + length) return;
        const header = buffer.subarray(0, 4);
        const framePayload = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        const payload = sessionReadKey && framePayload.length > 0 ? open(sessionReadKey, counter12(readSeq++), header, framePayload) : framePayload;
        this.handleFrame(frameType, payload, {
          send,
          get sharedSecret() {
            return sharedSecret;
          },
          set sharedSecret(v) {
            sharedSecret = v;
          },
          get srpServer() {
            return srpServer;
          },
          set srpServer(v) {
            srpServer = v;
          },
          get srpSessionKey() {
            return srpSessionKey;
          },
          set srpSessionKey(v) {
            srpSessionKey = v;
          },
          get controllerEphemeralPub() {
            return controllerEphemeralPub;
          },
          set controllerEphemeralPub(v) {
            controllerEphemeralPub = v;
          },
          get accessoryEphemeralPub() {
            return accessoryEphemeralPub;
          },
          set accessoryEphemeralPub(v) {
            accessoryEphemeralPub = v;
          },
          get accessoryEphemeralPriv() {
            return accessoryEphemeralPriv;
          },
          set accessoryEphemeralPriv(v) {
            accessoryEphemeralPriv = v;
          },
          enableSession: (write: Buffer, read: Buffer) => {
            sessionWriteKey = write;
            sessionReadKey = read;
          },
        });
      }
    });
  }

  private handleFrame(frameType: number, payload: Buffer, ctx: any): void {
    if (frameType === CompanionFrameType.E_OPACK) {
      const [decoded] = opackUnpack(payload);
      const dict = decoded as Record<string, OpackValue>;
      this.handleCommand(dict, ctx);
      return;
    }
    // Pairing frames (PS_Start/PS_Next/PV_Start/PV_Next) all carry an OPACK dict with _pd.
    const [decoded] = opackUnpack(payload);
    const dict = decoded as Record<string, OpackValue>;
    const pd = dict[PAIRING_DATA_KEY];
    if (!Buffer.isBuffer(pd)) return;
    const tlv = decodeTlv8(pd);
    const state = tlv.get(HapTlvTag.SeqNo)?.[0];
    this.handlePairing(frameType, tlv, state, ctx);
  }

  private handleCommand(dict: Record<string, OpackValue>, ctx: any): void {
    const identifier = dict._i;
    const xid = dict._x;
    const content = (dict._c ?? {}) as Record<string, OpackValue>;
    let response: Record<string, OpackValue>;
    if (identifier === "FetchLaunchableApplicationsEvent") {
      response = { _t: 3, _x: xid, _c: this.appListOverride ?? { ...this.apps } };
    } else if (identifier === "_launchApp") {
      this.receivedLaunches.push(content);
      if (this.launchShouldFail) {
        response = { _t: 3, _x: xid, _em: "app not found" };
      } else {
        response = { _t: 3, _x: xid, _c: {} };
      }
    } else {
      response = { _t: 3, _x: xid, _em: `unknown command ${String(identifier)}` };
    }
    ctx.send(CompanionFrameType.E_OPACK, opackPack(response));
  }

  private handlePairing(frameType: number, tlv: Map<number, Buffer>, state: number | undefined, ctx: any): void {
    const respond = (respFrameType: number, tlvOut: Buffer) => {
      ctx.send(respFrameType, opackPack({ [PAIRING_DATA_KEY]: tlvOut }));
    };
    if (frameType === CompanionFrameType.PS_Start && state === 1) {
      const salt = randomBytes(16);
      ctx.srpServer = new SrpServer(SRP.params.hap, salt, Buffer.from("Pair-Setup"), Buffer.from(this.pin), randomBytes(32));
      const B = ctx.srpServer.computeB();
      respond(CompanionFrameType.PS_Next, encodeTlv8([[HapTlvTag.SeqNo, Buffer.from([2])], [HapTlvTag.Salt, salt], [HapTlvTag.PublicKey, B]]));
      return;
    }
    if (frameType === CompanionFrameType.PS_Next && state === 3) {
      const A = tlv.get(HapTlvTag.PublicKey)!;
      const M1 = tlv.get(HapTlvTag.Proof)!;
      ctx.srpServer.setA(A);
      ctx.srpServer.checkM1(M1);
      ctx.srpSessionKey = ctx.srpServer.computeK();
      const M2 = ctx.srpServer.computeM2();
      respond(CompanionFrameType.PS_Next, encodeTlv8([[HapTlvTag.SeqNo, Buffer.from([4])], [HapTlvTag.Proof, M2]]));
      return;
    }
    if (frameType === CompanionFrameType.PS_Next && state === 5) {
      const encryptKey = hkdf("Pair-Setup-Encrypt-Salt", ctx.srpSessionKey, "Pair-Setup-Encrypt-Info", 32);
      const sealedM5 = tlv.get(HapTlvTag.EncryptedData)!;
      const inner = decodeTlv8(open(encryptKey, fixedNonce("PS-Msg05"), undefined, sealedM5));
      const ctrlId = inner.get(HapTlvTag.Identifier)!;
      const ctrlLtpk = inner.get(HapTlvTag.PublicKey)!;
      this.knownControllers.set(ctrlId.toString("hex"), ctrlLtpk);
      const innerM6 = encodeTlv8([
        [HapTlvTag.Identifier, this.pairingId],
        [HapTlvTag.PublicKey, this.ltpk],
        [HapTlvTag.Signature, Buffer.alloc(64)],
      ]);
      const sealedM6 = seal(encryptKey, fixedNonce("PS-Msg06"), undefined, innerM6);
      respond(CompanionFrameType.PS_Next, encodeTlv8([[HapTlvTag.SeqNo, Buffer.from([6])], [HapTlvTag.EncryptedData, sealedM6]]));
      return;
    }
    if (frameType === CompanionFrameType.PV_Start && state === 1) {
      ctx.controllerEphemeralPub = tlv.get(HapTlvTag.PublicKey)!;
      const { publicKey, privateKey } = generateKeyPairSync("x25519");
      ctx.accessoryEphemeralPriv = privateKey;
      ctx.accessoryEphemeralPub = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);
      const ctrlPubObj = createPublicKey({
        key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), ctx.controllerEphemeralPub]),
        format: "der",
        type: "spki",
      });
      ctx.sharedSecret = diffieHellman({ privateKey: ctx.accessoryEphemeralPriv, publicKey: ctrlPubObj });
      const encryptKey = hkdf("Pair-Verify-Encrypt-Salt", ctx.sharedSecret, "Pair-Verify-Encrypt-Info", 32);
      const sig = edSign(null, Buffer.concat([ctx.accessoryEphemeralPub, this.pairingId, ctx.controllerEphemeralPub]), this.ltPriv);
      const inner = encodeTlv8([[HapTlvTag.Identifier, this.pairingId], [HapTlvTag.Signature, sig]]);
      const sealed = seal(encryptKey, fixedNonce("PV-Msg02"), undefined, inner);
      respond(
        CompanionFrameType.PV_Next,
        encodeTlv8([
          [HapTlvTag.SeqNo, Buffer.from([2])],
          [HapTlvTag.PublicKey, ctx.accessoryEphemeralPub],
          [HapTlvTag.EncryptedData, sealed],
        ]),
      );
      return;
    }
    if (frameType === CompanionFrameType.PV_Next && state === 3) {
      const encryptKey = hkdf("Pair-Verify-Encrypt-Salt", ctx.sharedSecret, "Pair-Verify-Encrypt-Info", 32);
      const sealed = tlv.get(HapTlvTag.EncryptedData)!;
      const inner = decodeTlv8(open(encryptKey, fixedNonce("PV-Msg03"), undefined, sealed));
      const ctrlId = inner.get(HapTlvTag.Identifier)!;
      const ctrlSig = inner.get(HapTlvTag.Signature)!;
      const ctrlLtpk = this.knownControllers.get(ctrlId.toString("hex"));
      if (!ctrlLtpk) {
        respond(CompanionFrameType.PV_Next, encodeTlv8([[HapTlvTag.SeqNo, Buffer.from([4])], [HapTlvTag.Error, Buffer.from([2])]]));
        return;
      }
      const ok = edVerify(null, Buffer.concat([ctx.controllerEphemeralPub, ctrlId, ctx.accessoryEphemeralPub]), ed25519PubFromRaw(ctrlLtpk), ctrlSig);
      if (!ok) {
        respond(CompanionFrameType.PV_Next, encodeTlv8([[HapTlvTag.SeqNo, Buffer.from([4])], [HapTlvTag.Error, Buffer.from([2])]]));
        return;
      }
      respond(CompanionFrameType.PV_Next, encodeTlv8([[HapTlvTag.SeqNo, Buffer.from([4])]]));
      const writeKey = hkdf(COMPANION_SALT, ctx.sharedSecret, COMPANION_READ_INFO, 32);
      const readKey = hkdf(COMPANION_SALT, ctx.sharedSecret, COMPANION_WRITE_INFO, 32);
      ctx.enableSession(writeKey, readKey);
      return;
    }
  }
}

function lenBE3(n: number): Buffer {
  const b = Buffer.alloc(3);
  b.writeUIntBE(n, 0, 3);
  return b;
}

describe("Apple TV Companion client (real TCP, real HAP pairing + OPACK, deterministic fake accessory)", () => {
  let server: Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  it("pairs (separately from MRP), fetches a real app list, and launches by bundle id", async () => {
    const fakeTv = new FakeCompanionAppleTv();
    const { server: s, port } = await fakeTv.start();
    server = s;
    const credentialStore = createAppleTvCredentialStore(realSecretCrypto(), createInMemoryCredentialKv());
    const deviceId = "appletv-companion-a" as DeviceId;
    const address = `127.0.0.1:${port}`;

    await pairAppleTvCompanion(address, deviceId, fakeTv.pin, { credentialStore });
    const client = await connectAppleTvCompanion(address, deviceId, { credentialStore });

    const apps = await client.getApplications();
    expect(apps.sort((a, b) => a.packageName.localeCompare(b.packageName))).toEqual([
      { packageName: "com.google.ios.youtube", applicationName: "YouTube", versionName: null, versionCode: null, launchable: true, installed: true, lastSeen: expect.any(String) },
      { packageName: "com.netflix.Netflix", applicationName: "Netflix", versionName: null, versionCode: null, launchable: true, installed: true, lastSeen: expect.any(String) },
    ]);

    await client.launchApplication("com.netflix.Netflix");
    expect(fakeTv.receivedLaunches).toEqual([{ _bundleID: "com.netflix.Netflix" }]);
    await client.close();
  });

  it("launches a deep link via _urlS, and surfaces a rejected launch as an error (never fake success)", async () => {
    const fakeTv = new FakeCompanionAppleTv();
    const { server: s, port } = await fakeTv.start();
    server = s;
    const credentialStore = createAppleTvCredentialStore(realSecretCrypto(), createInMemoryCredentialKv());
    const deviceId = "appletv-companion-b" as DeviceId;
    const address = `127.0.0.1:${port}`;
    await pairAppleTvCompanion(address, deviceId, fakeTv.pin, { credentialStore });
    const client = await connectAppleTvCompanion(address, deviceId, { credentialStore });

    await client.launchDeepLink("netflix://title/12345");
    expect(fakeTv.receivedLaunches).toEqual([{ _urlS: "netflix://title/12345" }]);

    fakeTv.launchShouldFail = true;
    await expect(client.launchApplication("com.unknown.App")).rejects.toThrow(/app not found/);
    await client.close();
  });

  it("throws PairingRequired with no stored credentials, and requires a SEPARATE pairing from MRP", async () => {
    const fakeTv = new FakeCompanionAppleTv();
    const { server: s, port } = await fakeTv.start();
    server = s;
    const credentialStore = createAppleTvCredentialStore(realSecretCrypto(), createInMemoryCredentialKv());
    await expect(
      connectAppleTvCompanion(`127.0.0.1:${port}`, "appletv-unpaired" as DeviceId, { credentialStore }),
    ).rejects.toThrow(/pairing/i);
  });

  it("keeps two Apple TVs' Companion sessions/app registries fully isolated", async () => {
    const tvA = new FakeCompanionAppleTv();
    tvA.apps = { "com.netflix.Netflix": "Netflix" };
    const tvB = new FakeCompanionAppleTv();
    tvB.apps = { "com.spotify.client": "Spotify" };
    const { server: serverA, port: portA } = await tvA.start();
    const { server: serverB, port: portB } = await tvB.start();
    const credentialStore = createAppleTvCredentialStore(realSecretCrypto(), createInMemoryCredentialKv());
    const deviceA = "appletv-comp-a" as DeviceId;
    const deviceB = "appletv-comp-b" as DeviceId;

    await pairAppleTvCompanion(`127.0.0.1:${portA}`, deviceA, tvA.pin, { credentialStore });
    await pairAppleTvCompanion(`127.0.0.1:${portB}`, deviceB, tvB.pin, { credentialStore });
    const clientA = await connectAppleTvCompanion(`127.0.0.1:${portA}`, deviceA, { credentialStore });
    const clientB = await connectAppleTvCompanion(`127.0.0.1:${portB}`, deviceB, { credentialStore });

    const appsA = await clientA.getApplications();
    const appsB = await clientB.getApplications();
    expect(appsA.map((a) => a.packageName)).toEqual(["com.netflix.Netflix"]);
    expect(appsB.map((a) => a.packageName)).toEqual(["com.spotify.client"]);

    await clientA.launchApplication("com.netflix.Netflix");
    expect(tvA.receivedLaunches.length).toBe(1);
    expect(tvB.receivedLaunches.length).toBe(0);

    await clientA.close();
    await clientB.close();
    serverA.close();
    serverB.close();
  });

  it("handles a malformed app-list entry (non-string name) without crashing — coerces to null, never fabricated", async () => {
    const fakeTv = new FakeCompanionAppleTv();
    fakeTv.appListOverride = { "com.weird.App": 12345 as any }; // not a string
    const { server: s, port } = await fakeTv.start();
    server = s;
    const credentialStore = createAppleTvCredentialStore(realSecretCrypto(), createInMemoryCredentialKv());
    const deviceId = "appletv-companion-malformed" as DeviceId;
    const address = `127.0.0.1:${port}`;
    await pairAppleTvCompanion(address, deviceId, fakeTv.pin, { credentialStore });
    const client = await connectAppleTvCompanion(address, deviceId, { credentialStore });

    const apps = await client.getApplications();
    expect(apps).toEqual([
      { packageName: "com.weird.App", applicationName: null, versionName: null, versionCode: null, launchable: true, installed: true, lastSeen: expect.any(String) },
    ]);
    await client.close();
  });

  it("empty app list returns an empty array, not an error", async () => {
    const fakeTv = new FakeCompanionAppleTv();
    fakeTv.apps = {};
    const { server: s, port } = await fakeTv.start();
    server = s;
    const credentialStore = createAppleTvCredentialStore(realSecretCrypto(), createInMemoryCredentialKv());
    const deviceId = "appletv-companion-empty" as DeviceId;
    const address = `127.0.0.1:${port}`;
    await pairAppleTvCompanion(address, deviceId, fakeTv.pin, { credentialStore });
    const client = await connectAppleTvCompanion(address, deviceId, { credentialStore });
    expect(await client.getApplications()).toEqual([]);
    await client.close();
  });
});

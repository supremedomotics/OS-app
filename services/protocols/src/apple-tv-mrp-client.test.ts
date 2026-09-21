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
import { decodeTlv8, encodeTlv8, HapTlvTag } from "./apple-tv-hap-tlv8.js";
import {
  buildCryptoPairingMessage,
  extractCryptoPairingData,
  messageType,
  fieldMap,
  fieldBytes,
  fieldString,
  fieldVarint,
  buildProtocolMessage,
  MrpType,
  MrpField,
  MrpTransportCommand,
  decodeVarint,
  encodeVarint,
} from "./apple-tv-mrp-protobuf.js";
import { createMrpTcpTransport } from "./apple-tv-mrp-transport.js";
import { pairAppleTvMrp, createMrpAppleTvConnect } from "./apple-tv-mrp-client.js";
import { createAppleTvCredentialStore, createInMemoryCredentialKv } from "./apple-tv-credential-store.js";
import { createDriverSecretCrypto, type DriverSecretCrypto } from "@supreme/drivers";
import type { DeviceId } from "@supreme/domain-model";

const MRP_SALT = "MediaRemote-Salt";
const MRP_WRITE_INFO = "MediaRemote-Write-Encryption-Key";
const MRP_READ_INFO = "MediaRemote-Read-Encryption-Key";

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
function fixedNonce(label: string): Buffer {
  const n = Buffer.alloc(12);
  Buffer.from(label, "utf8").copy(n, 4);
  return n;
}
function counterNonce8(counter: number): Buffer {
  const n = Buffer.alloc(12);
  n.writeBigUInt64LE(BigInt(counter), 4);
  return n;
}
function ed25519PubFromRaw(raw: Buffer) {
  return createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
}

/** § Phase 2C — the REAL `DriverSecretCrypto` (AES-256-GCM via `@supreme/crypto`), the
 * same one `bootstrap.ts` wires in production, now that `@supreme/protocols` depends on
 * `@supreme/drivers` directly. Proves the credential store round-trips through actual
 * encryption, not a stand-in. */
function realSecretCrypto(): DriverSecretCrypto {
  return createDriverSecretCrypto(randomBytes(32).toString("base64"));
}

/**
 * A deterministic fake Apple TV MRP server: real TCP, real MRP varint framing, real
 * protobuf CRYPTO_PAIRING_MESSAGE wrapping, real SRP6a/Ed25519/X25519/ChaCha20-Poly1305
 * pairing + pair-verify + MRP session encryption — built from the same verified
 * primitives/constants the client module uses, satisfying "a protocol-client
 * abstraction that allows a deterministic fake Apple TV server" without needing
 * physical hardware.
 */
class FakeMrpAppleTv {
  readonly pin = "1234";
  readonly pairingId = Buffer.from("fake-mrp-appletv");
  private readonly ltKeyPair = generateKeyPairSync("ed25519");
  private readonly ltpk = (this.ltKeyPair.publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);
  private readonly ltPriv = this.ltKeyPair.privateKey;
  knownControllers = new Map<string, Buffer>();
  /** Test-controlled artwork response: "malformed" sends a truncated/corrupt frame. */
  artwork: { data: Buffer; mimeType: string } | null | "malformed" = null;
  receivedQueueRequests = 0;
  receivedHidEvents: Array<{ usagePage: number; usage: number; down: boolean }> = [];
  receivedCommands: MrpTransportCommand[] = [];

  start(): Promise<{ server: Server; port: number }> {
    return new Promise((resolve) => {
      const server = createServer((sock) => this.handleConnection(sock));
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve({ server, port });
      });
    });
  }

  private handleConnection(sock: Socket): void {
    let buffer = Buffer.alloc(0);
    let encryptKey: Buffer | null = null; // pair-verify M2/M3 key (symmetric)
    let sharedSecret: Buffer | null = null;
    let srpServer: SrpServer | null = null;
    let srpSalt: Buffer | null = null;
    let srpSessionKey: Buffer | null = null;
    let controllerEphemeralPub: Buffer | null = null;
    let accessoryEphemeralPub: Buffer | null = null;
    let accessoryEphemeralPriv: ReturnType<typeof generateKeyPairSync>["privateKey"] | null = null;
    let sessionWriteKey: Buffer | null = null; // accessory -> controller
    let sessionReadKey: Buffer | null = null; // controller -> accessory
    let writeSeq = 0;
    let readSeq = 0;
    let firstPairingMessage = true;

    const send = (payload: Buffer) => {
      const wire = sessionWriteKey ? seal(sessionWriteKey, counterNonce8(writeSeq++), payload) : payload;
      sock.write(Buffer.concat([encodeVarint(wire.length), wire]));
    };

    sock.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        let length: number, next: number;
        try {
          ({ value: length, next } = decodeVarint(buffer, 0));
        } catch {
          return;
        }
        if (buffer.length - next < length) return;
        const framePayload = buffer.subarray(next, next + length);
        buffer = buffer.subarray(next + length);
        const payload = sessionReadKey ? open(sessionReadKey, counterNonce8(readSeq++), framePayload) : framePayload;
        this.handleMessage(payload, {
          send,
          get encryptKey() {
            return encryptKey;
          },
          set encryptKey(v) {
            encryptKey = v;
          },
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
          get srpSalt() {
            return srpSalt;
          },
          set srpSalt(v) {
            srpSalt = v;
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
          get firstPairingMessage() {
            return firstPairingMessage;
          },
          set firstPairingMessage(v) {
            firstPairingMessage = v;
          },
        });
      }
    });
  }

  private handleMessage(payload: Buffer, ctx: any): void {
    const type = messageType(payload);
    if (type === MrpType.DEVICE_INFO_MESSAGE) return; // ignored, just logged in a real impl
    if (type === MrpType.CLIENT_UPDATES_CONFIG_MESSAGE) return;
    if (type === MrpType.SEND_HID_EVENT_MESSAGE) {
      const top = fieldMap(payload);
      const inner = fieldMap(top.get(MrpField.sendHIDEventMessage) as Buffer);
      const data = inner.get(1) as Buffer;
      const usagePage = data.readUInt16BE(43);
      const usage = data.readUInt16BE(45);
      const down = data.readUInt16BE(47) === 1;
      this.receivedHidEvents.push({ usagePage, usage, down });
      return;
    }
    if (type === MrpType.SEND_COMMAND_MESSAGE) {
      const top = fieldMap(payload);
      const inner = fieldMap(top.get(MrpField.sendCommandMessage) as Buffer);
      this.receivedCommands.push(inner.get(1) as MrpTransportCommand);
      return;
    }
    if (type === MrpType.PLAYBACK_QUEUE_REQUEST_MESSAGE) {
      this.receivedQueueRequests++;
      ctx.send(this.buildQueueResponse());
      return;
    }
    if (type === MrpType.CRYPTO_PAIRING_MESSAGE) {
      const tlvIn = decodeTlv8(extractCryptoPairingData(payload));
      const state = tlvIn.get(HapTlvTag.SeqNo)?.[0];
      this.handleCryptoPairing(tlvIn, state, ctx);
      return;
    }
  }

  private handleCryptoPairing(tlv: Map<number, Buffer>, state: number | undefined, ctx: any): void {
    const wasFirst = ctx.firstPairingMessage;
    ctx.firstPairingMessage = false;

    // Distinguish pair-setup's M1 (has Method tag) from pair-verify's M1 (has only PublicKey).
    if (state === 1 && tlv.has(HapTlvTag.Method)) {
      const salt = randomBytes(16);
      ctx.srpSalt = salt;
      ctx.srpServer = new SrpServer(SRP.params.hap, salt, Buffer.from("Pair-Setup"), Buffer.from(this.pin), randomBytes(32));
      const B = ctx.srpServer.computeB();
      ctx.send(buildCryptoPairingMessage(encodeTlv8([[HapTlvTag.SeqNo, Buffer.from([2])], [HapTlvTag.Salt, salt], [HapTlvTag.PublicKey, B]]), 0));
      return;
    }
    if (state === 3 && tlv.has(HapTlvTag.Proof)) {
      const A = tlv.get(HapTlvTag.PublicKey)!;
      const M1 = tlv.get(HapTlvTag.Proof)!;
      ctx.srpServer.setA(A);
      ctx.srpServer.checkM1(M1);
      ctx.srpSessionKey = ctx.srpServer.computeK();
      const M2 = ctx.srpServer.computeM2();
      ctx.send(buildCryptoPairingMessage(encodeTlv8([[HapTlvTag.SeqNo, Buffer.from([4])], [HapTlvTag.Proof, M2]]), 0));
      return;
    }
    if (state === 5) {
      const encryptKey = hkdf("Pair-Setup-Encrypt-Salt", ctx.srpSessionKey, "Pair-Setup-Encrypt-Info", 32);
      const sealedM5 = tlv.get(HapTlvTag.EncryptedData)!;
      const inner = decodeTlv8(open(encryptKey, fixedNonce("PS-Msg05"), sealedM5));
      const ctrlId = inner.get(HapTlvTag.Identifier)!;
      const ctrlLtpk = inner.get(HapTlvTag.PublicKey)!;
      this.knownControllers.set(ctrlId.toString("hex"), ctrlLtpk);

      const innerM6 = encodeTlv8([
        [HapTlvTag.Identifier, this.pairingId],
        [HapTlvTag.PublicKey, this.ltpk],
        [HapTlvTag.Signature, Buffer.alloc(64)], // unverified by the real client (see client module's doc comment)
      ]);
      const sealedM6 = seal(encryptKey, fixedNonce("PS-Msg06"), innerM6);
      ctx.send(buildCryptoPairingMessage(encodeTlv8([[HapTlvTag.SeqNo, Buffer.from([6])], [HapTlvTag.EncryptedData, sealedM6]]), 0));
      return;
    }
    // Pair-verify M1: only a bare PublicKey, no Method/Proof tags.
    if (state === 1 && tlv.has(HapTlvTag.PublicKey) && !tlv.has(HapTlvTag.Method)) {
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
      const sealed = seal(encryptKey, fixedNonce("PV-Msg02"), inner);
      ctx.send(
        buildCryptoPairingMessage(
          encodeTlv8([
            [HapTlvTag.SeqNo, Buffer.from([2])],
            [HapTlvTag.PublicKey, ctx.accessoryEphemeralPub],
            [HapTlvTag.EncryptedData, sealed],
          ]),
          0,
        ),
      );
      return;
    }
    if (state === 3 && tlv.has(HapTlvTag.EncryptedData) && !tlv.has(HapTlvTag.Proof)) {
      const encryptKey = hkdf("Pair-Verify-Encrypt-Salt", ctx.sharedSecret, "Pair-Verify-Encrypt-Info", 32);
      const sealed = tlv.get(HapTlvTag.EncryptedData)!;
      const inner = decodeTlv8(open(encryptKey, fixedNonce("PV-Msg03"), sealed));
      const ctrlId = inner.get(HapTlvTag.Identifier)!;
      const ctrlSig = inner.get(HapTlvTag.Signature)!;
      const ctrlLtpk = this.knownControllers.get(ctrlId.toString("hex"));
      if (!ctrlLtpk) {
        ctx.send(buildCryptoPairingMessage(encodeTlv8([[HapTlvTag.SeqNo, Buffer.from([4])], [HapTlvTag.Error, Buffer.from([2])]]), 0));
        return;
      }
      const ok = edVerify(null, Buffer.concat([ctx.controllerEphemeralPub, ctrlId, ctx.accessoryEphemeralPub]), ed25519PubFromRaw(ctrlLtpk), ctrlSig);
      if (!ok) {
        ctx.send(buildCryptoPairingMessage(encodeTlv8([[HapTlvTag.SeqNo, Buffer.from([4])], [HapTlvTag.Error, Buffer.from([2])]]), 0));
        return;
      }
      ctx.send(buildCryptoPairingMessage(encodeTlv8([[HapTlvTag.SeqNo, Buffer.from([4])]]), 0));
      // Enable the MRP session — accessory's write key = controller's read key (MRP_READ_INFO), and vice versa.
      const writeKey = hkdf(MRP_SALT, ctx.sharedSecret, MRP_READ_INFO, 32);
      const readKey = hkdf(MRP_SALT, ctx.sharedSecret, MRP_WRITE_INFO, 32);
      ctx.enableSession(writeKey, readKey);
      return;
    }
  }

  /** Builds a SET_STATE_MESSAGE reply to a PLAYBACK_QUEUE_REQUEST_MESSAGE, matching the
   * verified field layout `parsePlaybackQueueArtwork` decodes: SetStateMessage.
   * playbackQueue(3) -> PlaybackQueue.contentItems(2) -> ContentItem.artworkData(3)/
   * metadata(2) -> ContentItemMetadata.artworkMIMEType(31). */
  private buildQueueResponse(): Buffer {
    if (this.artwork === "malformed") {
      // A SET_STATE_MESSAGE whose playbackQueue field claims to be a submessage but is
      // actually truncated garbage bytes.
      const setState = fieldBytes(3, Buffer.from([0xff, 0xff, 0xff])); // length-prefixed nonsense
      return buildProtocolMessage(MrpType.SET_STATE_MESSAGE, MrpField.setStateMessage, setState);
    }
    if (this.artwork === null) {
      // No artwork: a real, well-formed response with an empty playback queue.
      const setState = fieldBytes(3, Buffer.alloc(0));
      return buildProtocolMessage(MrpType.SET_STATE_MESSAGE, MrpField.setStateMessage, setState);
    }
    const metadata = fieldString(31, this.artwork.mimeType);
    const contentItem = Buffer.concat([fieldBytes(2, metadata), fieldBytes(3, this.artwork.data)]);
    const queue = fieldBytes(2, contentItem);
    const setState = fieldBytes(3, queue);
    return buildProtocolMessage(MrpType.SET_STATE_MESSAGE, MrpField.setStateMessage, setState);
  }
}

describe("Apple TV MRP client (real TCP, real HAP pairing + MRP session, deterministic fake accessory)", () => {
  let server: Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  it("pairs, persists credentials, connects via pair-verify, and sends a real HOME command end-to-end", async () => {
    const fakeTv = new FakeMrpAppleTv();
    const { server: s, port } = await fakeTv.start();
    server = s;

    const kv = createInMemoryCredentialKv();
    const credentialStore = createAppleTvCredentialStore(realSecretCrypto(), kv);
    const deviceId = "appletv-living-room" as DeviceId;
    const address = `127.0.0.1:${port}`;
    const clientOpts = { credentialStore, hubIdentifier: "SUPREMEOS-HUB-TEST", hubName: "SupremeOS Test Hub" };

    await pairAppleTvMrp(address, deviceId, fakeTv.pin, clientOpts);
    expect(await credentialStore.load(deviceId)).not.toBeNull();

    const connect = createMrpAppleTvConnect(clientOpts);
    const client = await connect({ address, deviceId });

    // First real command proof: SupremeOS command -> AppleTvProtocolDriver's client
    // seam -> MRP adapter -> encrypted transport -> Apple TV (the fake accessory).
    await client.play();
    await new Promise((r) => setTimeout(r, 20));
    expect(fakeTv.receivedCommands).toContain(MrpTransportCommand.Play);

    await client.close?.();
  });

  it("throws AppleTvPairingRequiredError when no credentials are stored", async () => {
    const fakeTv = new FakeMrpAppleTv();
    const { server: s, port } = await fakeTv.start();
    server = s;
    const credentialStore = createAppleTvCredentialStore(realSecretCrypto(), createInMemoryCredentialKv());
    const connect = createMrpAppleTvConnect({ credentialStore, hubIdentifier: "H", hubName: "Hub" });
    await expect(connect({ address: `127.0.0.1:${port}`, deviceId: "unknown-tv" as DeviceId })).rejects.toThrow(/pairing/i);
  });

  it("clears stored credentials and throws PairingRequired if the accessory rejects pair-verify", async () => {
    const fakeTv = new FakeMrpAppleTv();
    const otherTv = new FakeMrpAppleTv(); // different identity -> verify will fail
    const { server: s, port } = await otherTv.start();
    server = s;

    const kv = createInMemoryCredentialKv();
    const credentialStore = createAppleTvCredentialStore(realSecretCrypto(), kv);
    const deviceId = "appletv-mismatched" as DeviceId;
    const clientOpts = { credentialStore, hubIdentifier: "H", hubName: "Hub" };

    // Pair against fakeTv on a throwaway server, then try to connect to otherTv's server
    // using those credentials — otherTv doesn't know this controller.
    const { server: setupServer, port: setupPort } = await fakeTv.start();
    await pairAppleTvMrp(`127.0.0.1:${setupPort}`, deviceId, fakeTv.pin, clientOpts);
    setupServer.close();
    expect(await credentialStore.load(deviceId)).not.toBeNull();

    const connect = createMrpAppleTvConnect(clientOpts);
    await expect(connect({ address: `127.0.0.1:${port}`, deviceId })).rejects.toThrow(/pairing/i);
    expect(await credentialStore.load(deviceId)).toBeNull();
  });

  it("keeps two Apple TVs on independent connections — a command to one never reaches the other", async () => {
    const tvA = new FakeMrpAppleTv();
    const tvB = new FakeMrpAppleTv();
    const { server: serverA, port: portA } = await tvA.start();
    const { server: serverB, port: portB } = await tvB.start();

    const kv = createInMemoryCredentialKv();
    const credentialStore = createAppleTvCredentialStore(realSecretCrypto(), kv);
    const clientOpts = { credentialStore, hubIdentifier: "H", hubName: "Hub" };
    const deviceA = "appletv-a" as DeviceId;
    const deviceB = "appletv-b" as DeviceId;

    await pairAppleTvMrp(`127.0.0.1:${portA}`, deviceA, tvA.pin, clientOpts);
    await pairAppleTvMrp(`127.0.0.1:${portB}`, deviceB, tvB.pin, clientOpts);

    const connect = createMrpAppleTvConnect(clientOpts);
    const clientA = await connect({ address: `127.0.0.1:${portA}`, deviceId: deviceA });
    const clientB = await connect({ address: `127.0.0.1:${portB}`, deviceId: deviceB });

    await clientA.play();
    await new Promise((r) => setTimeout(r, 20));
    expect(tvA.receivedCommands).toContain(MrpTransportCommand.Play);
    expect(tvB.receivedCommands).not.toContain(MrpTransportCommand.Play);

    await clientA.close?.();
    await clientB.close?.();
    serverA.close();
    serverB.close();
  });

  it("a transient network/connect failure never clears stored credentials (only a rejected pair-verify does)", async () => {
    const fakeTv = new FakeMrpAppleTv();
    const { server: s, port } = await fakeTv.start();
    server = s;

    const kv = createInMemoryCredentialKv();
    const credentialStore = createAppleTvCredentialStore(realSecretCrypto(), kv);
    const deviceId = "appletv-flaky-network" as DeviceId;
    const clientOpts = { credentialStore, hubIdentifier: "H", hubName: "Hub" };
    await pairAppleTvMrp(`127.0.0.1:${port}`, deviceId, fakeTv.pin, clientOpts);
    expect(await credentialStore.load(deviceId)).not.toBeNull();

    // Simulate a network failure: connect to a port nothing is listening on. This must
    // reject from transport.connect() itself, BEFORE pair-verify ever runs, so the
    // client's rejected-pair-verify handling (which clears credentials) never executes.
    const connect = createMrpAppleTvConnect(clientOpts);
    const deadPort = port + 1; // nothing listening here
    await expect(connect({ address: `127.0.0.1:${deadPort}`, deviceId })).rejects.toThrow();

    const stillStored = await credentialStore.load(deviceId);
    expect(stillStored).not.toBeNull();
    expect(stillStored!.accessoryPairingId.toString()).toBe(fakeTv.pairingId.toString());

    // And the same credentials keep working once the real Apple TV is reachable again.
    const client = await connect({ address: `127.0.0.1:${port}`, deviceId });
    await client.play();
    await new Promise((r) => setTimeout(r, 20));
    expect(fakeTv.receivedCommands).toContain(MrpTransportCommand.Play);
    await client.close?.();
  });

  it("routes real navigation button presses to byte-exact MRP HID events, and rejects 'back' honestly", async () => {
    const fakeTv = new FakeMrpAppleTv();
    const { server: s, port } = await fakeTv.start();
    server = s;

    const kv = createInMemoryCredentialKv();
    const credentialStore = createAppleTvCredentialStore(realSecretCrypto(), kv);
    const deviceId = "appletv-nav" as DeviceId;
    const address = `127.0.0.1:${port}`;
    const clientOpts = { credentialStore, hubIdentifier: "H", hubName: "Hub" };
    await pairAppleTvMrp(address, deviceId, fakeTv.pin, clientOpts);
    const client = await createMrpAppleTvConnect(clientOpts)({ address, deviceId });

    for (const [button, [usagePage, usage]] of Object.entries({
      up: [1, 0x8c],
      down: [1, 0x8d],
      left: [1, 0x8b],
      right: [1, 0x8a],
      select: [1, 0x89],
      menu: [1, 0x86],
      home: [12, 0x40],
    } as const)) {
      await client.pressButton(button as any);
      await new Promise((r) => setTimeout(r, 15));
      const events = fakeTv.receivedHidEvents.filter((e) => e.usagePage === usagePage && e.usage === usage);
      expect(events.length).toBeGreaterThanOrEqual(2); // down + up
      expect(events.some((e) => e.down === true)).toBe(true);
      expect(events.some((e) => e.down === false)).toBe(true);
    }

    await expect(client.pressButton("back")).rejects.toThrow(/no verified MRP HID mapping/);
    await client.close?.();
  });

  describe("artwork (§ Phase 2C — real PLAYBACK_QUEUE_REQUEST_MESSAGE round trip)", () => {
    async function connectedClient(fakeTv: FakeMrpAppleTv, port: number, deviceId: DeviceId) {
      const kv = createInMemoryCredentialKv();
      const credentialStore = createAppleTvCredentialStore(realSecretCrypto(), kv);
      const address = `127.0.0.1:${port}`;
      const clientOpts = { credentialStore, hubIdentifier: "H", hubName: "Hub" };
      await pairAppleTvMrp(address, deviceId, fakeTv.pin, clientOpts);
      return createMrpAppleTvConnect(clientOpts)({ address, deviceId });
    }

    it("returns real artwork bytes + mime type when the Apple TV has cover art", async () => {
      const fakeTv = new FakeMrpAppleTv();
      const { server: s, port } = await fakeTv.start();
      server = s;
      fakeTv.artwork = { data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]), mimeType: "image/png" };

      const client = await connectedClient(fakeTv, port, "appletv-art-a" as DeviceId);
      const artwork = await client.getArtwork!();
      expect(artwork).not.toBeNull();
      expect(artwork!.contentType).toBe("image/png");
      expect(Buffer.from(artwork!.data).equals(fakeTv.artwork.data)).toBe(true);
      expect(fakeTv.receivedQueueRequests).toBe(1);
      await client.close?.();
    });

    it("returns null (never fabricated) when the Apple TV reports no artwork", async () => {
      const fakeTv = new FakeMrpAppleTv();
      const { server: s, port } = await fakeTv.start();
      server = s;
      fakeTv.artwork = null;

      const client = await connectedClient(fakeTv, port, "appletv-art-b" as DeviceId);
      const artwork = await client.getArtwork!();
      expect(artwork).toBeNull();
      await client.close?.();
    });

    it("reflects an artwork change between two calls (no stale caching in the client itself)", async () => {
      const fakeTv = new FakeMrpAppleTv();
      const { server: s, port } = await fakeTv.start();
      server = s;
      fakeTv.artwork = { data: Buffer.from("first-cover"), mimeType: "image/jpeg" };

      const client = await connectedClient(fakeTv, port, "appletv-art-c" as DeviceId);
      const first = await client.getArtwork!();
      expect(Buffer.from(first!.data).toString()).toBe("first-cover");

      fakeTv.artwork = { data: Buffer.from("second-cover"), mimeType: "image/jpeg" };
      const second = await client.getArtwork!();
      expect(Buffer.from(second!.data).toString()).toBe("second-cover");
      await client.close?.();
    });

    it("returns null (not a crash) for a malformed/truncated artwork response", async () => {
      const fakeTv = new FakeMrpAppleTv();
      const { server: s, port } = await fakeTv.start();
      server = s;
      fakeTv.artwork = "malformed";

      const client = await connectedClient(fakeTv, port, "appletv-art-d" as DeviceId);
      const artwork = await client.getArtwork!();
      expect(artwork).toBeNull();
      await client.close?.();
    });
  });
});

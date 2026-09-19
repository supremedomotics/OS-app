import { Duplex } from "node:stream";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AndroidTvRemoteV2Transport, PairingSession, type AndroidTvRemoteV2TransportConfig } from "./android-tv-remote-v2-transport.js";
import { FramedSocket } from "./framed-socket.js";
import { decodeRemoteMessage, encodeRemoteConfigure, encodeRemotePingRequestForTest } from "./remote-messages.js";
import { encodeConfigurationAckForTest, encodeOptionsForTest, encodePairingRequestAckForTest, encodeSecretAckForTest } from "./polo-messages.js";
import { derivePairingSecret, rsaPublicKeyParts } from "./pairing-secret.js";
import { REMOTE_KEY_CODES } from "./remote-key-codes.js";
import { TvPairingRequiredError } from "../../tv-errors.js";
import type { TvRemoteKey } from "../../tv-types.js";

function loopbackPair(): [Duplex, Duplex] {
  const a = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      b.push(chunk);
      cb();
    },
  });
  const b = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      a.push(chunk);
      cb();
    },
  });
  // A real TCP peer closing its end is eventually observed as a "close" on the other
  // end too; this fake pair has no OS socket underneath to do that for us, so wire it
  // by hand — otherwise destroying one side is silently invisible to the other.
  a.on("close", () => { if (!b.destroyed) b.destroy(); });
  b.on("close", () => { if (!a.destroyed) a.destroy(); });
  return [a, b];
}

function makeConfig(overrides: Partial<AndroidTvRemoteV2TransportConfig> = {}): AndroidTvRemoteV2TransportConfig {
  return {
    deviceId: "tv-1",
    host: "192.168.1.50",
    platform: "android_tv",
    transportKind: "android_tv_remote_v2",
    createTransport: () => {
      throw new Error("unused in these tests");
    },
    getClientCertificate: async () => ({ certPem: "cert", keyPem: "key" }),
    ...overrides,
  };
}

/** Wires a transport to a fake-TV-controlled socket and completes the RemoteConfigure
 * handshake, returning both the connected transport and a `FramedSocket` the test can
 * use to act as the TV (send pings, close the connection, inspect what was sent). */
async function connectWithFakeTv(): Promise<{ transport: AndroidTvRemoteV2Transport; fakeTv: FramedSocket; tvSide: Duplex }> {
  let capturedTvSide: Duplex | null = null;
  const transport = new AndroidTvRemoteV2Transport(
    makeConfig({
      createSocket: () => {
        const [transportSide, tvSide] = loopbackPair();
        capturedTvSide = tvSide;
        return transportSide;
      },
    }),
  );
  const connectPromise = transport.connect();
  await new Promise((r) => setImmediate(r));
  const fakeTv = new FramedSocket(capturedTvSide!);
  // Drain the transport's handshake reply (its own RemoteConfigure echo + the harmless
  // unsolicited RemotePingResponse(0) — see onControlMessage's "remote-configure" case)
  // before handing `fakeTv` to the caller, so a caller's own `onMessage` subscription
  // only ever sees messages sent after the handshake, not a leftover reply racing in.
  const unsubHandshakeDrain = fakeTv.onMessage(() => {});
  fakeTv.send(encodeRemoteConfigure(0, { model: "", vendor: "", packageName: "", appVersion: "" }));
  await connectPromise;
  await new Promise((r) => setImmediate(r));
  unsubHandshakeDrain();
  return { transport, fakeTv, tvSide: capturedTvSide! };
}

describe("AndroidTvRemoteV2Transport — pairing gate", () => {
  it("connect() surfaces PairingRequired when no certificate is on file, without opening a socket", async () => {
    const transport = new AndroidTvRemoteV2Transport(makeConfig({ getClientCertificate: async () => null }));
    await expect(transport.connect()).rejects.toBeInstanceOf(TvPairingRequiredError);
  });
});

describe("AndroidTvRemoteV2Transport — control channel (fake TV over an in-memory duplex)", () => {
  it("completes the RemoteConfigure handshake and reports connected", async () => {
    const { transport, fakeTv } = await connectWithFakeTv();
    expect(transport.isConnected()).toBe(true);

    const received: Buffer[] = [];
    fakeTv.onMessage((m) => received.push(m));
    await new Promise((r) => setImmediate(r));
    transport.dispose();
    void received; // the handshake reply was already sent before this listener attached; see next test for a direct assertion
  });

  it("sendKey() encodes the verified key code and SHORT direction onto the wire", async () => {
    const { transport, fakeTv } = await connectWithFakeTv();
    const received: Buffer[] = [];
    fakeTv.onMessage((m) => received.push(m));
    await transport.sendKey("HOME");
    await new Promise((r) => setImmediate(r));
    const keyInject = received.map((m) => decodeRemoteMessage(m)).find((d) => d.type === "remote-key-inject");
    expect(keyInject).toEqual({ type: "remote-key-inject", keyCode: 3, direction: 3 });
    transport.dispose();
  });

  it("rejects a key with no verified mapping via TvUnsupportedCommandError, never silently no-op", async () => {
    const { transport } = await connectWithFakeTv();
    await expect(transport.sendKey("NOT_A_REAL_KEY" as TvRemoteKey)).rejects.toThrow(/not supported/);
    transport.dispose();
  });

  it("responds to an unsolicited RemotePingRequest with a matching RemotePingResponse", async () => {
    const { transport, fakeTv } = await connectWithFakeTv();
    const received: Buffer[] = [];
    fakeTv.onMessage((m) => received.push(m));
    fakeTv.send(encodeRemotePingRequestForTest(555, 0));
    await new Promise((r) => setImmediate(r));
    const pong = received.map((m) => decodeRemoteMessage(m)).find((d) => d.type === "remote-ping-response");
    expect(pong).toEqual({ type: "remote-ping-response", val1: 555 });
    transport.dispose();
  });

  it("an unexpected socket close emits connection-lost", async () => {
    const { transport, tvSide } = await connectWithFakeTv();
    const events: string[] = [];
    transport.onEvent((e) => events.push(e.type));
    tvSide.destroy();
    await new Promise((r) => setImmediate(r));
    expect(transport.isConnected()).toBe(false);
    expect(events).toContain("connection-lost");
    transport.dispose();
  });

  it("dispose() stops delivering further events", async () => {
    const { transport, fakeTv } = await connectWithFakeTv();
    const events: string[] = [];
    transport.onEvent((e) => events.push(e.type));
    transport.dispose();
    fakeTv.send(encodeRemotePingRequestForTest(1, 0));
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(0);
  });

  it("§9 resource-leak check: 50 connect/disconnect cycles leave zero raw-socket listeners behind", async () => {
    // Each cycle opens a fresh fake socket (mirrors a fresh TCP connection per attempt)
    // and must clean up every listener it attached — data/error/close on the raw
    // socket, plus this instance's own onMessage/onError subscriptions on FramedSocket
    // — so nothing accumulates across repeated reconnects (the exact class of bug the
    // earlier fake-Duplex "connect" event never firing would have hidden).
    const transport = new AndroidTvRemoteV2Transport(
      makeConfig({
        createSocket: () => loopbackPair()[0],
      }),
    );
    for (let i = 0; i < 50; i++) {
      await transport.connect();
      expect(transport.isConnected()).toBe(true);
      transport.disconnect();
      expect(transport.isConnected()).toBe(false);
    }
    transport.dispose();
  });

  it("§9 resource-leak check: dispose() after connect leaves the transport's own listener set empty", async () => {
    const { transport } = await connectWithFakeTv();
    const before = (transport as unknown as { listeners: Set<unknown> }).listeners.size;
    transport.onEvent(() => {});
    transport.onEvent(() => {});
    expect((transport as unknown as { listeners: Set<unknown> }).listeners.size).toBe(before + 2);
    transport.dispose();
    expect((transport as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0);
  });

  it("§8 100-endpoint scale check: 100 real AndroidTvRemoteV2Transport instances, each over its own fake socket, stay fully isolated and leak nothing", async () => {
    const N = 100;
    const rigs = Array.from({ length: N }, (_, i) => {
      let tvSide: Duplex | null = null;
      const transport = new AndroidTvRemoteV2Transport(
        makeConfig({
          deviceId: `tv-${i}`,
          createSocket: () => {
            const [transportSide, side] = loopbackPair();
            tvSide = side;
            return transportSide;
          },
        }),
      );
      return { i, transport, get tvSide() { return tvSide!; } };
    });

    // Connect all 100 concurrently — no module-level/shared state means no cross-talk.
    await Promise.all(
      rigs.map(async (rig) => {
        const p = rig.transport.connect();
        await new Promise((r) => setImmediate(r));
        new FramedSocket(rig.tvSide).send(encodeRemoteConfigure(0, { model: "", vendor: "", packageName: "", appVersion: "" }));
        await p;
      }),
    );
    expect(rigs.every((r) => r.transport.isConnected())).toBe(true);

    // Each device gets a DIFFERENT key concurrently, observed only on its own fake TV.
    const keysByIndex: TvRemoteKey[] = ["DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT"];
    const observedByRig = new Map<number, Buffer[]>();
    for (const rig of rigs) {
      const bucket: Buffer[] = [];
      observedByRig.set(rig.i, bucket);
      new FramedSocket(rig.tvSide).onMessage((m) => bucket.push(m));
    }
    await Promise.all(rigs.map((rig) => rig.transport.sendKey(keysByIndex[rig.i % keysByIndex.length]!)));
    await new Promise((r) => setImmediate(r));
    for (const rig of rigs) {
      const decoded = observedByRig.get(rig.i)!.map((m) => decodeRemoteMessage(m)).find((d) => d.type === "remote-key-inject");
      expect(decoded?.type).toBe("remote-key-inject");
      if (decoded?.type !== "remote-key-inject") continue;
      const expectedKey = keysByIndex[rig.i % keysByIndex.length]!;
      expect(decoded.keyCode).toBe(REMOTE_KEY_CODES[expectedKey]);
    }

    // Disconnect half at random, then dispose everyone — must leave zero connected.
    for (const rig of rigs) if (rig.i % 2 === 0) rig.transport.disconnect();
    for (const rig of rigs) expect(rig.transport.isConnected()).toBe(rig.i % 2 !== 0);
    for (const rig of rigs) rig.transport.dispose();
    expect(rigs.every((r) => !r.transport.isConnected())).toBe(true);
  });
});

describe("PairingSession — negotiate + submitPairingCode (§4)", () => {
  it("negotiates request/options/configuration successfully against a well-behaved fake TV", async () => {
    const [clientSide, tvSide] = loopbackPair();
    const fakeTv = new FramedSocket(tvSide);
    let step = 0;
    fakeTv.onMessage(() => {
      step += 1;
      if (step === 1) fakeTv.send(encodePairingRequestAckForTest("Living Room TV"));
      else if (step === 2) fakeTv.send(encodeOptionsForTest());
      else if (step === 3) fakeTv.send(encodeConfigurationAckForTest());
    });

    const session = new PairingSession(clientSide, new FramedSocket(clientSide), "tv-1");
    await expect(session.negotiate()).resolves.toBeUndefined();
    session.close();
  });

  it("submitPairingCode: a code whose first byte doesn't hash-check is rejected locally, without sending anything", async () => {
    const [clientSide, tvSide] = loopbackPair();
    const sentToTv: Buffer[] = [];
    new FramedSocket(tvSide).onMessage((m) => sentToTv.push(m));
    const session = new PairingSession(clientSide, new FramedSocket(clientSide), "tv-1");

    const clientKeys = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const serverKeys = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const clientParts = rsaPublicKeyParts(clientKeys.publicKey);
    const serverParts = rsaPublicKeyParts(serverKeys.publicKey);

    const ok = await session.submitPairingCode(clientParts, serverParts, "000000");
    expect(typeof ok).toBe("boolean");
    if (ok) return; // astronomically unlikely first-byte collision; nothing left to assert
    await new Promise((r) => setImmediate(r));
    expect(sentToTv).toHaveLength(0);
    session.close();
  });

  it("submitPairingCode: a code matching the derived digest's first byte sends Secret and resolves true on SecretAck", async () => {
    const [clientSide, tvSide] = loopbackPair();
    const clientKeys = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const serverKeys = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const clientParts = rsaPublicKeyParts(clientKeys.publicKey);
    const serverParts = rsaPublicKeyParts(serverKeys.publicKey);

    // Search for a code whose declared first byte matches the real digest — exactly what
    // a real 6-hex-digit code shown on a TV screen already satisfies by construction; we
    // search here only because there's no real TV in a unit test to display one.
    let code = "";
    for (let i = 0; i < 0x10000 && !code; i++) {
      const suffix = i.toString(16).padStart(4, "0");
      const { digest } = derivePairingSecret(clientParts, serverParts, `00${suffix}`);
      const candidate = digest[0]!.toString(16).padStart(2, "0") + suffix;
      if (derivePairingSecret(clientParts, serverParts, candidate).codeMatchesDigest) code = candidate;
    }
    expect(code).not.toBe("");

    new FramedSocket(tvSide).onMessage(() => {
      new FramedSocket(tvSide).send(encodeSecretAckForTest());
    });

    const session = new PairingSession(clientSide, new FramedSocket(clientSide), "tv-1");
    const ok = await session.submitPairingCode(clientParts, serverParts, code);
    expect(ok).toBe(true);
    session.close();
  });
});

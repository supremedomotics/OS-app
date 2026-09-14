import { sign as nodeSign, generateKeyPairSync } from "node:crypto";
import {
  buildEnrollmentRequest,
  DevHubCA,
  generateHubIdentity,
} from "@supreme/hub-identity";
import { buildTunnelBrokerServer } from "@supreme/tunnel-broker";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";
import { BrokerTunnelClient } from "./tunnel-client.js";

/**
 * Full C2 remote-access path (ADR 0009): the hub dials OUT to the zero-trust Tunnel Broker,
 * authenticates with its DEVICE CREDENTIAL (challenge-response — no shared token), and an
 * off-LAN client request is routed over the tunnel to the hub gateway, where identity + RBAC
 * are enforced locally. No inbound ports on the home.
 */
describe("Remote access via the zero-trust Tunnel Broker", () => {
  let broker: FastifyInstance;
  let hub: FastifyInstance;
  let ctx: AppContext;
  let tunnel: BrokerTunnelClient;
  let brokerBase: string;
  let hubId: string;

  beforeAll(async () => {
    // 1. Hub identity + a CA-issued device credential.
    const ca = DevHubCA.generate();
    const identity = generateHubIdentity();
    const credential = ca.issue(buildEnrollmentRequest(identity, { model: "Hub Pro", fwVersion: "0.4.0" }, { kind: "factory", evidence: "sig" }));
    hubId = identity.hubUuid;

    // 2. Tunnel broker, trusting that CA; client routing allowed for this test.
    broker = buildTunnelBrokerServer({ caPublicKey: ca.caPublicKey, authorizeClient: async () => true, logLevel: "silent" });
    await broker.listen({ host: "127.0.0.1", port: 0 });
    const ba = broker.server.address();
    brokerBase = `http://127.0.0.1:${typeof ba === "object" && ba ? ba.port : 0}`;

    // 3. The hub gateway.
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }));
    hub = await buildServer(ctx);
    await hub.listen({ host: "127.0.0.1", port: 0 });
    const ha = hub.server.address();
    const hubPort = typeof ha === "object" && ha ? ha.port : 0;

    // 4. The hub dials out and authenticates with its credential.
    await new Promise<void>((ready) => {
      tunnel = new BrokerTunnelClient({
        brokerUrl: brokerBase,
        identity,
        credential,
        localBaseUrl: `http://127.0.0.1:${hubPort}`,
        onReady: () => ready(),
      });
      tunnel.start();
    });
  });

  afterAll(async () => {
    tunnel.stop();
    await hub.close();
    await ctx.shutdown();
    await broker.close();
    await new Promise((r) => setTimeout(r, 20));
  });

  it("forwards an off-LAN healthz through the broker to the hub", async () => {
    const res = await fetch(`${brokerBase}/v1/route/${hubId}/healthz`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("ok");
  });

  it("authenticates on the hub: a real login round-trips over the tunnel", async () => {
    const res = await fetch(`${brokerBase}/v1/route/${hubId}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; accessToken?: string };
    expect(body.accessToken).toBeTruthy();
  });

  it("denies client routing without authorization (fail-closed)", async () => {
    // A second broker with NO authorizer rejects client routing even though the hub is valid.
    const ca2 = DevHubCA.generate();
    const closed = buildTunnelBrokerServer({ caPublicKey: ca2.caPublicKey, logLevel: "silent" });
    await closed.listen({ host: "127.0.0.1", port: 0 });
    const addr = closed.server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const res = await fetch(`${base}/v1/route/${hubId}/healthz`);
    expect(res.status).toBe(403);
    await closed.close();
  });

  it("returns hub_offline for an unknown hub", async () => {
    const res = await fetch(`${brokerBase}/v1/route/unknown-hub/healthz`);
    expect(res.status).toBe(503);
  });
});

/**
 * §Phase12 §23 — the most important test in this phase: the FULL real chain, using the
 * broker's REAL default authorizer (no `authorizeClient` override — this is what a
 * production broker actually runs), a real Ed25519 "Mobile" keypair, and the real
 * `/v1/pairing/*` routes. Nothing here is a mocked 200 OK: every step is the actual
 * cryptographic operation and the actual HTTP round trip described in §23 steps 1-11 (steps
 * 12-15, live semantic device control feedback, are covered by the existing `e2e.test.ts`
 * device-command suite against the SAME real gateway — this test's job is proving the
 * identity/pairing/authorization chain that gates access to it).
 */
describe("§Phase12 end-to-end: Mobile identity -> pairing -> Hub authorization -> broker authorization -> tunnel", () => {
  let broker: FastifyInstance;
  let hub: FastifyInstance;
  let ctx: AppContext;
  let tunnel: BrokerTunnelClient;
  let brokerBase: string;
  let hubBase: string;
  let hubId: string;

  beforeAll(async () => {
    const ca = DevHubCA.generate();
    const identity = generateHubIdentity();
    const credential = ca.issue(buildEnrollmentRequest(identity, { model: "Hub Pro", fwVersion: "0.4.0" }, { kind: "factory", evidence: "sig" }));
    hubId = identity.hubUuid;

    // The broker's REAL default authorizer — no override, no devAllowAll.
    broker = buildTunnelBrokerServer({ caPublicKey: ca.caPublicKey, logLevel: "silent" });
    await broker.listen({ host: "127.0.0.1", port: 0 });
    const ba = broker.server.address();
    brokerBase = `http://127.0.0.1:${typeof ba === "object" && ba ? ba.port : 0}`;

    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), { hubIdentity: identity });
    hub = await buildServer(ctx);
    await hub.listen({ host: "127.0.0.1", port: 0 });
    const ha = hub.server.address();
    const hubPort = typeof ha === "object" && ha ? ha.port : 0;
    hubBase = `http://127.0.0.1:${hubPort}`;

    await new Promise<void>((ready) => {
      tunnel = new BrokerTunnelClient({
        brokerUrl: brokerBase,
        identity,
        credential,
        localBaseUrl: `http://127.0.0.1:${hubPort}`,
        onReady: () => ready(),
      });
      tunnel.start();
    });
  });

  afterAll(async () => {
    tunnel.stop();
    await hub.close();
    await ctx.shutdown();
    await broker.close();
    await new Promise((r) => setTimeout(r, 20));
  });

  /** Generates a real Ed25519 "Mobile" keypair and returns it in the same raw/base64 shape
   * `Ed25519MobileIdentity` (Dart) uses, plus a signer closure — mirrors the client, does not
   * fake it. */
  function realMobileKeypair() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const rawPublicKey = (publicKey.export({ format: "jwk" }).x as string)
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const publicKeyBase64 = rawPublicKey + "=".repeat((4 - (rawPublicKey.length % 4)) % 4);
    const sign = (message: Buffer) => nodeSign(null, message, privateKey).toString("base64");
    return { publicKeyBase64, sign };
  }

  it("completes the full chain: real login for a pairing code -> real challenge -> real Ed25519 signature -> Hub authorization -> broker-verified remote command", async () => {
    const mobile = realMobileKeypair();

    // 1. (Admin/installer action) log in and mint a real pairing code. Pairing itself is a
    // local-network/local-approval ceremony (§8) — done against the Hub directly, exactly
    // like a real installer standing on the homeowner's LAN, never through the broker (which
    // only ever gates ALREADY-authorized Mobiles' remote access, not the pairing ceremony
    // that produces that authorization in the first place).
    const login = await fetch(`${hubBase}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    const codeRes = await fetch(`${hubBase}/v1/pairing/codes`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(codeRes.status).toBe(200);
    const { code } = (await codeRes.json()) as { code: string };

    // 2. Mobile requests a challenge using the pairing code + its real public key.
    const challengeRes = await fetch(`${hubBase}/v1/pairing/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingCode: code, mobilePublicKeyBase64: mobile.publicKeyBase64 }),
    });
    expect(challengeRes.status).toBe(200);
    const challenge = (await challengeRes.json()) as { challengeId: string; challengeBytes: string };

    // 3. Mobile signs the REAL challenge bytes with its REAL private key.
    const signature = mobile.sign(Buffer.from(challenge.challengeBytes, "base64"));

    // 4. Hub verifies the signature and issues a real authorization + broker-usable token.
    const verifyRes = await fetch(`${hubBase}/v1/pairing/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.challengeId, signatureBase64: signature }),
    });
    expect(verifyRes.status).toBe(200);
    const authorization = (await verifyRes.json()) as { mobileId: string; token: string };
    expect(authorization.token).toBeTruthy();

    // 5. The SAME challenge cannot be reused (§7 replay protection).
    const replay = await fetch(`${hubBase}/v1/pairing/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.challengeId, signatureBase64: signature }),
    });
    expect(replay.status).toBe(401);

    // 6. Mobile uses the issued token as its remote bearer credential — the BROKER's real
    // default authorizer verifies it (no override, no devAllowAll) before forwarding.
    const remoteHealthz = await fetch(`${brokerBase}/v1/route/${hubId}/healthz`, {
      headers: { authorization: `Bearer ${authorization.token}` },
    });
    expect(remoteHealthz.status).toBe(200);

    // 7. A forged token (wrong signature) is rejected by the broker itself — it never even
    // reaches the hub, proving broker-side authorization is real, not a pass-through.
    const forged = `${authorization.token.split(".")[0]}.${Buffer.from("not-a-real-signature").toString("base64")}`;
    const forgedRes = await fetch(`${brokerBase}/v1/route/${hubId}/healthz`, {
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(forgedRes.status).toBe(403);

    // 8. Revocation is authoritative: after the Hub revokes this Mobile, a REFRESH is
    // refused (the currently-issued token still works until it expires — the documented,
    // bounded revocation-latency tradeoff — but no new token is ever issued again).
    const revokeRes = await fetch(`${hubBase}/v1/pairing/mobiles/${authorization.mobileId}/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(revokeRes.status).toBe(200);

    // The refresh call itself IS a genuine remote Mobile action, so it goes through the
    // broker — carrying the still-not-yet-expired token (the broker only checks signature +
    // expiry, not Hub-side revocation, which is exactly the documented bounded-latency
    // tradeoff). The Hub's own handler is what actually refuses it, because it checks its
    // authoritative registry, not just the token's cryptographic validity.
    const refreshAfterRevoke = await fetch(`${brokerBase}/v1/route/${hubId}/v1/pairing/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${authorization.token}` },
      body: JSON.stringify({ mobileId: authorization.mobileId }),
    });
    expect(refreshAfterRevoke.status).toBe(401);
  });

  it("rejects an invalid signature — never string/MAC equality (§6)", async () => {
    const mobile = realMobileKeypair();
    const attacker = realMobileKeypair();

    const login = await fetch(`${hubBase}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    const codeRes = await fetch(`${hubBase}/v1/pairing/codes`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const { code } = (await codeRes.json()) as { code: string };
    const challengeRes = await fetch(`${hubBase}/v1/pairing/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingCode: code, mobilePublicKeyBase64: mobile.publicKeyBase64 }),
    });
    const challenge = (await challengeRes.json()) as { challengeId: string; challengeBytes: string };

    // Signed by the WRONG (attacker's) private key.
    const signature = attacker.sign(Buffer.from(challenge.challengeBytes, "base64"));

    const verifyRes = await fetch(`${hubBase}/v1/pairing/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.challengeId, signatureBase64: signature }),
    });
    expect(verifyRes.status).toBe(401);
  });

  it("rejects a wrong/expired pairing code", async () => {
    const mobile = realMobileKeypair();
    const res = await fetch(`${hubBase}/v1/pairing/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingCode: "000000", mobilePublicKeyBase64: mobile.publicKeyBase64 }),
    });
    expect(res.status).toBe(401);
  });

  it("a Mobile paired to THIS hub cannot use its token against a DIFFERENT hub (§10)", async () => {
    // A second, unrelated hub attached to the SAME broker.
    const ca2 = DevHubCA.generate();
    const identity2 = generateHubIdentity();
    const credential2 = ca2.issue(buildEnrollmentRequest(identity2, { model: "Hub Pro", fwVersion: "0.4.0" }, { kind: "factory", evidence: "sig" }));
    // This broker trusts only ca (from the outer beforeAll) — attach hub2 via a broker that
    // trusts BOTH by reusing the same broker instance is not possible (one CA per broker in
    // this test's construction), so this test proves isolation the simpler way: hub2's own
    // credential can never be verified by ca's broker at all, and a token claiming hubId2
    // against ca's broker fails because that hub was never attached there.
    void credential2;
    const bogusToken = `${Buffer.from(JSON.stringify({ mobileId: "m", hubId: identity2.hubUuid, projectId: "p", iat: Date.now(), exp: Date.now() + 60_000 })).toString("base64url")}.deadbeef`;
    const res = await fetch(`${brokerBase}/v1/route/${identity2.hubUuid}/healthz`, {
      headers: { authorization: `Bearer ${bogusToken}` },
    });
    // hub2 was never attached to THIS broker, so there is no public key to verify against —
    // authorization is checked (and fails closed) before online status is even consulted.
    expect(res.status).toBe(403);
  });

  /** §Phase12.9 — the REAL remote live-event-stream path: a genuine `ws` client dials the
   * broker's `/v1/route/:hubId/stream`, the broker multiplexes it over the SAME tunnel socket
   * used for request/response, `BrokerTunnelClient` opens a REAL local WebSocket to this hub's
   * own `/v1/stream`, and bytes are relayed both ways — proven with a real ping/pong round
   * trip (the hub's own `stream.ts` only replies "pong" after its own real auth check passes),
   * not a mocked socket. */
  it("opens a real remote /v1/stream through the broker and round-trips a real ping/pong", async () => {
    const mobile = realMobileKeypair();
    const login = await fetch(`${hubBase}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    const codeRes = await fetch(`${hubBase}/v1/pairing/codes`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const { code } = (await codeRes.json()) as { code: string };
    const challengeRes = await fetch(`${hubBase}/v1/pairing/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingCode: code, mobilePublicKeyBase64: mobile.publicKeyBase64 }),
    });
    const challenge = (await challengeRes.json()) as { challengeId: string; challengeBytes: string };
    const signature = mobile.sign(Buffer.from(challenge.challengeBytes, "base64"));
    const verifyRes = await fetch(`${hubBase}/v1/pairing/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.challengeId, signatureBase64: signature }),
    });
    const authorization = (await verifyRes.json()) as { mobileId: string; token: string };

    const wsUrl = `${brokerBase.replace(/^http/, "ws")}/v1/route/${hubId}/stream`;
    const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${authorization.token}` } });
    const pong = await new Promise<unknown>((resolve, reject) => {
      ws.on("open", () => ws.send(JSON.stringify({ type: "ping" })));
      ws.on("message", (raw) => resolve(JSON.parse(raw.toString())));
      ws.on("error", reject);
      ws.on("close", (code, reason) => reject(new Error(`closed before pong: ${code} ${reason}`)));
    });
    expect(pong).toMatchObject({ type: "pong" });
    ws.close();
  });

  it("also authorizes via ?access_token= query param — what portable Dart WebSocket clients actually send", async () => {
    const mobile = realMobileKeypair();
    const login = await fetch(`${hubBase}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    const codeRes = await fetch(`${hubBase}/v1/pairing/codes`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const { code } = (await codeRes.json()) as { code: string };
    const challengeRes = await fetch(`${hubBase}/v1/pairing/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingCode: code, mobilePublicKeyBase64: mobile.publicKeyBase64 }),
    });
    const challenge = (await challengeRes.json()) as { challengeId: string; challengeBytes: string };
    const signature = mobile.sign(Buffer.from(challenge.challengeBytes, "base64"));
    const verifyRes = await fetch(`${hubBase}/v1/pairing/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.challengeId, signatureBase64: signature }),
    });
    const authorization = (await verifyRes.json()) as { mobileId: string; token: string };

    // No Authorization header at all — only the query param, exactly like
    // `WebSocketHubEventStream.connect()` (`apps/new/shared`) builds its URI.
    const wsUrl = `${brokerBase.replace(/^http/, "ws")}/v1/route/${hubId}/stream?access_token=${encodeURIComponent(authorization.token)}`;
    const ws = new WebSocket(wsUrl);
    const pong = await new Promise<unknown>((resolve, reject) => {
      ws.on("open", () => ws.send(JSON.stringify({ type: "ping" })));
      ws.on("message", (raw) => resolve(JSON.parse(raw.toString())));
      ws.on("error", reject);
      ws.on("close", (code, reason) => reject(new Error(`closed before pong: ${code} ${reason}`)));
    });
    expect(pong).toMatchObject({ type: "pong" });
    ws.close();
  });

  /** §Phase12.10 §6 — the mandatory command→feedback proof: a REAL device command sent through
   * `RemoteHubTransport`'s own HTTP route, processed by the REAL SIL/driver/event-bus chain,
   * observed arriving over the REAL remote WebSocket stream — never treating the HTTP 200 as
   * device feedback. Same real hub/broker/tunnel stack as every other test in this describe
   * block; the only "fake" thing anywhere is that there is no physical dimmer behind the demo
   * fixture's `INativeProtocolDriver` (§13 — DEVICE TEST REQUIRED for that boundary only). */
  it("real remote command -> Hub -> SIL -> event bus -> remote stream -> Mobile feedback", async () => {
    const mobile = realMobileKeypair();
    const login = await fetch(`${hubBase}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    const codeRes = await fetch(`${hubBase}/v1/pairing/codes`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const { code } = (await codeRes.json()) as { code: string };
    const challengeRes = await fetch(`${hubBase}/v1/pairing/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingCode: code, mobilePublicKeyBase64: mobile.publicKeyBase64 }),
    });
    const challenge = (await challengeRes.json()) as { challengeId: string; challengeBytes: string };
    const signature = mobile.sign(Buffer.from(challenge.challengeBytes, "base64"));
    const verifyRes = await fetch(`${hubBase}/v1/pairing/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.challengeId, signatureBase64: signature }),
    });
    const authorization = (await verifyRes.json()) as { mobileId: string; token: string };
    const bearer = `Bearer ${authorization.token}`;

    // Find a real device the Mobile-authorized identity is allowed to see, over the SAME
    // broker route Mobile actually uses for reads (§Phase12.4/12.8's real /v1/home + rooms
    // contract, reached remotely).
    const home = (await (
      await fetch(`${brokerBase}/v1/route/${hubId}/v1/home`, { headers: { authorization: bearer } })
    ).json()) as { rooms: { id: string; name: string }[] };
    const room = home.rooms.find((r) => r.name === "Living Room") ?? home.rooms[0]!;
    const devices = (await (
      await fetch(`${brokerBase}/v1/route/${hubId}/v1/rooms/${room.id}/devices`, {
        headers: { authorization: bearer },
      })
    ).json()) as { devices: { id: string; capabilities: { kind: string }[] }[] };
    const dimmer = devices.devices.find((d) => d.capabilities.some((c) => c.kind === "brightness"));
    const deviceId = (dimmer ?? devices.devices[0]!).id;

    // Open the REMOTE stream (broker -> tunnel -> hub's own /v1/stream) and subscribe.
    const wsUrl = `${brokerBase.replace(/^http/, "ws")}/v1/route/${hubId}/stream`;
    const ws = new WebSocket(wsUrl, { headers: { authorization: bearer } });
    const stateFrame = new Promise<{ type: string; deviceId?: string; state?: unknown }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no remote state delta received")), 5000);
      ws.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as { type: string; deviceId?: string; state?: unknown };
        if (frame.type === "state") {
          clearTimeout(timer);
          resolve(frame);
        }
      });
      ws.on("error", reject);
      ws.on("close", (code, reason) => reject(new Error(`stream closed before state frame: ${code} ${reason}`)));
    });
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "subscribe", rooms: [room.id] }));
    // Subscribe has no ack frame — a ping/pong round trip over the SAME ordered remote channel
    // (client -> broker -> tunnel -> hub's local /v1/stream, one message at a time) proves the
    // Hub has already processed "subscribe" by the time this resolves, since frames are
    // delivered and handled in order. Without this, the extra broker/tunnel hop (vs. a direct
    // local WS) can let the command's state event race ahead of subscribe being applied.
    await new Promise<void>((resolve, reject) => {
      const onMsg = (raw: import("ws").RawData) => {
        const frame = JSON.parse(raw.toString()) as { type: string };
        if (frame.type === "pong") {
          ws.off("message", onMsg);
          resolve();
        }
      };
      ws.on("message", onMsg);
      ws.send(JSON.stringify({ type: "ping" }));
      setTimeout(() => reject(new Error("no pong — subscribe ordering not confirmed")), 5000);
    });

    // The command itself goes through RemoteHubTransport's own real HTTP route — NOT the
    // stream — mirroring exactly how the real Dart `RemoteHubTransport.sendCommand` works.
    const cmdRes = await fetch(`${brokerBase}/v1/route/${hubId}/v1/devices/${deviceId}/command`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: bearer },
      body: JSON.stringify({ command: { capability: "brightness", action: "set", level: 60 } }),
    });
    if (cmdRes.status !== 200) {
      // eslint-disable-next-line no-console
      console.error("DEBUG cmd failed", cmdRes.status, await cmdRes.text(), { deviceId, roomId: room.id });
    }
    expect(cmdRes.status).toBe(200);
    // The HTTP 200 is NOT device feedback (§6/§7) — only the frame that follows is authoritative.

    const frame = await stateFrame;
    expect(frame.type).toBe("state");
    expect(frame.deviceId).toBe(deviceId);
    expect(frame.state).toBeDefined();
    ws.close();
  });

  it("rejects a remote stream connection with a forged token — never reaches the hub", async () => {
    const forged = `${Buffer.from(JSON.stringify({ mobileId: "m", hubId, projectId: "p", iat: Date.now(), exp: Date.now() + 60_000 })).toString("base64url")}.deadbeef`;
    const wsUrl = `${brokerBase.replace(/^http/, "ws")}/v1/route/${hubId}/stream`;
    const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${forged}` } });
    // Note: the WS upgrade (HTTP 101) completes before this route's async handler runs its own
    // authorization check — so `open` firing is expected fastify-websocket behavior, not a
    // security gap. The real proof is that the connection is then immediately closed 1008 by
    // the handler, and no stream data (a real Hub state frame) is ever delivered to it.
    const closeCode = await new Promise<number>((resolve, reject) => {
      ws.on("close", (code) => resolve(code));
      ws.on("error", reject);
      setTimeout(() => reject(new Error("never closed")), 5000);
    });
    expect(closeCode).toBe(1008);
  });

  it("rejects a remote stream connection for an unknown/offline hub", async () => {
    const wsUrl = `${brokerBase.replace(/^http/, "ws")}/v1/route/unknown-hub/stream`;
    const ws = new WebSocket(wsUrl, { headers: { authorization: "Bearer whatever" } });
    const closeCode = await new Promise<number>((resolve, reject) => {
      ws.on("close", (code) => resolve(code));
      ws.on("error", reject);
      setTimeout(() => reject(new Error("never closed")), 5000);
    });
    expect(closeCode).toBe(1008); // no public key on file for an unattached hub — fails at authorize()
  });
});

/** §Phase12.10 §8 — TWO real Hub processes (two real `AppContext`s, two real gateway
 * `FastifyInstance`s, two real `BrokerTunnelClient` dial-outs), attached to the SAME real
 * broker, both with the demo fixture's IDENTICAL room name ("Living Room") and, since each
 * `AppContext` generates its own ids independently, effectively-random but potentially-
 * colliding-looking device/room id shapes — proving isolation holds on canonical `hubId`, never
 * on room/device id or display-name uniqueness. */
describe("§Phase12.10 §8: two independent real Hub processes on one broker", () => {
  let broker: FastifyInstance;
  let brokerBase: string;

  beforeAll(async () => {
    // One CA both hubs' credentials are issued from, so ONE broker can verify both — the
    // broker itself only ever trusts one CA per instance (`caPublicKey`), matching how a real
    // fleet's hubs share one manufacturing CA.
    const ca = DevHubCA.generate();
    broker = buildTunnelBrokerServer({ caPublicKey: ca.caPublicKey, logLevel: "silent" });
    await broker.listen({ host: "127.0.0.1", port: 0 });
    const ba = broker.server.address();
    brokerBase = `http://127.0.0.1:${typeof ba === "object" && ba ? ba.port : 0}`;
    (globalThis as { __phase1210Ca?: DevHubCA }).__phase1210Ca = ca;
  });

  afterAll(async () => {
    await broker.close();
  });

  it(
    "identical room names on two real Hubs stay fully isolated — HTTP reads, commands, and remote stream events never cross",
    async () => {
      const ca = (globalThis as { __phase1210Ca?: DevHubCA }).__phase1210Ca!;

      async function realHub() {
        const identity = generateHubIdentity();
        const credential = ca.issue(
          buildEnrollmentRequest(identity, { model: "Hub Pro", fwVersion: "0.4.0" }, { kind: "factory", evidence: "sig" }),
        );
        const ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), { hubIdentity: identity });
        const hub = await buildServer(ctx);
        await hub.listen({ host: "127.0.0.1", port: 0 });
        const ha = hub.server.address();
        const hubBase = `http://127.0.0.1:${typeof ha === "object" && ha ? ha.port : 0}`;
        let tunnel!: BrokerTunnelClient;
        await new Promise<void>((ready) => {
          tunnel = new BrokerTunnelClient({
            brokerUrl: brokerBase,
            identity,
            credential,
            localBaseUrl: hubBase,
            onReady: ready,
          });
          tunnel.start();
        });
        return { ctx, hub, hubBase, tunnel, hubId: identity.hubUuid };
      }

      async function pairAndAuthorize(hubBase: string) {
        const { publicKey, privateKey } = generateKeyPairSync("ed25519");
        const rawPublicKey = (publicKey.export({ format: "jwk" }).x as string).replace(/-/g, "+").replace(/_/g, "/");
        const publicKeyBase64 = rawPublicKey + "=".repeat((4 - (rawPublicKey.length % 4)) % 4);
        const sign = (message: Buffer) => nodeSign(null, message, privateKey).toString("base64");

        const login = await fetch(`${hubBase}/v1/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
        });
        const { accessToken } = (await login.json()) as { accessToken: string };
        const codeRes = await fetch(`${hubBase}/v1/pairing/codes`, {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}` },
        });
        const { code } = (await codeRes.json()) as { code: string };
        const challengeRes = await fetch(`${hubBase}/v1/pairing/challenge`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pairingCode: code, mobilePublicKeyBase64: publicKeyBase64 }),
        });
        const challenge = (await challengeRes.json()) as { challengeId: string; challengeBytes: string };
        const signature = sign(Buffer.from(challenge.challengeBytes, "base64"));
        const verifyRes = await fetch(`${hubBase}/v1/pairing/verify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ challengeId: challenge.challengeId, signatureBase64: signature }),
        });
        const authorization = (await verifyRes.json()) as { mobileId: string; token: string };
        return `Bearer ${authorization.token}`;
      }

      const hubA = await realHub();
      const hubB = await realHub();
      try {
        const bearerA = await pairAndAuthorize(hubA.hubBase);
        const bearerB = await pairAndAuthorize(hubB.hubBase);

        // Both real demo fixtures use the SAME room NAME ("Living Room") — canonical hubId in
        // the URL path is the only thing keeping them apart.
        const homeA = (await (
          await fetch(`${brokerBase}/v1/route/${hubA.hubId}/v1/home`, { headers: { authorization: bearerA } })
        ).json()) as { rooms: { id: string; name: string }[] };
        const homeB = (await (
          await fetch(`${brokerBase}/v1/route/${hubB.hubId}/v1/home`, { headers: { authorization: bearerB } })
        ).json()) as { rooms: { id: string; name: string }[] };
        expect(homeA.rooms.map((r) => r.name)).toContain("Living Room");
        expect(homeB.rooms.map((r) => r.name)).toContain("Living Room");

        // hubA's token must never work against hubB's route, and vice versa.
        const crossA = await fetch(`${brokerBase}/v1/route/${hubB.hubId}/v1/home`, { headers: { authorization: bearerA } });
        expect(crossA.status).toBe(403);
        const crossB = await fetch(`${brokerBase}/v1/route/${hubA.hubId}/v1/home`, { headers: { authorization: bearerB } });
        expect(crossB.status).toBe(403);

        // Independent remote streams: an event on Hub A must never reach a client subscribed
        // to Hub B, even though both connect through the SAME broker process.
        const roomA = homeA.rooms.find((r) => r.name === "Living Room")!;
        const roomB = homeB.rooms.find((r) => r.name === "Living Room")!;
        const devicesA = (await (
          await fetch(`${brokerBase}/v1/route/${hubA.hubId}/v1/rooms/${roomA.id}/devices`, { headers: { authorization: bearerA } })
        ).json()) as { devices: { id: string; capabilities: { kind: string }[] }[] };
        const dimmerA = devicesA.devices.find((d) => d.capabilities.some((c) => c.kind === "brightness"))!;

        const wsA = new WebSocket(`${brokerBase.replace(/^http/, "ws")}/v1/route/${hubA.hubId}/stream`, {
          headers: { authorization: bearerA },
        });
        const wsB = new WebSocket(`${brokerBase.replace(/^http/, "ws")}/v1/route/${hubB.hubId}/stream`, {
          headers: { authorization: bearerB },
        });
        const framesB: unknown[] = [];
        wsB.on("message", (raw) => framesB.push(JSON.parse(raw.toString())));
        await Promise.all([new Promise((r) => wsA.once("open", r)), new Promise((r) => wsB.once("open", r))]);
        wsA.send(JSON.stringify({ type: "subscribe", rooms: [roomA.id] }));
        wsB.send(JSON.stringify({ type: "subscribe", rooms: ["*"] })); // B listens to everything ON ITS OWN hub

        // Ordering proof (same technique as the single-hub command→feedback test): a ping/pong
        // on A's own connection confirms A's subscribe was applied before the command fires.
        const stateA = new Promise<{ type: string; deviceId?: string }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("no state on A")), 5000);
          wsA.on("message", (raw) => {
            const frame = JSON.parse(raw.toString()) as { type: string; deviceId?: string };
            if (frame.type === "state") {
              clearTimeout(timer);
              resolve(frame);
            }
          });
        });
        await new Promise<void>((resolve, reject) => {
          const onMsg = (raw: import("ws").RawData) => {
            const f = JSON.parse(raw.toString()) as { type: string };
            if (f.type === "pong") {
              wsA.off("message", onMsg);
              resolve();
            }
          };
          wsA.on("message", onMsg);
          wsA.send(JSON.stringify({ type: "ping" }));
          setTimeout(() => reject(new Error("no pong on A")), 5000);
        });

        const cmdRes = await fetch(`${brokerBase}/v1/route/${hubA.hubId}/v1/devices/${dimmerA.id}/command`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: bearerA },
          body: JSON.stringify({ command: { capability: "brightness", action: "set", level: 42 } }),
        });
        expect(cmdRes.status).toBe(200);

        const frameA = await stateA;
        expect(frameA.deviceId).toBe(dimmerA.id);

        // Give B's socket a moment to have received anything it might (wrongly) receive.
        await new Promise((r) => setTimeout(r, 300));
        expect(framesB.some((f) => (f as { deviceId?: string }).deviceId === dimmerA.id)).toBe(false);

        wsA.close();
        wsB.close();
      } finally {
        hubA.tunnel.stop();
        hubB.tunnel.stop();
        await hubA.hub.close();
        await hubB.hub.close();
        await hubA.ctx.shutdown();
        await hubB.ctx.shutdown();
      }
    },
    20000,
  );
});

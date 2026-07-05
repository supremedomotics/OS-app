import {
  buildEnrollmentRequest,
  DevHubCA,
  generateHubIdentity,
} from "@supreme/hub-identity";
import { buildTunnelBrokerServer } from "@supreme/tunnel-broker";
import type { FastifyInstance } from "fastify";
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

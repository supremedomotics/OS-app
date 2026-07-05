import { generateHubCa, issueServerCert } from "@supreme/hub-pki";
import { buildHubRegistryServer } from "@supreme/hub-registry";
import { buildTunnelBrokerServer, createMtlsTunnelServer, MtlsTunnelClient, TunnelBroker, type MtlsTunnelServer, type TunnelRequest, type TunnelResponse } from "@supreme/tunnel-broker";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { HubAgent, type FetchLike } from "./hub-agent.js";
import { createSecretStore } from "./secrets.js";
import { buildServer } from "./server.js";

/**
 * FULL end-to-end mTLS path (ADR 0008/0009): a hub auto-enrolls and the Hub Registry issues it a
 * real X.509 device cert; the hub dials the broker's mTLS listener with that cert (outbound only);
 * and an off-LAN client routes a REAL login through the broker → over the mTLS tunnel → to the hub
 * gateway, which enforces identity locally. Proves the registry→hub→broker wiring end-to-end.
 */
describe("End-to-end mTLS tunnel (enroll → X.509 → broker → hub)", () => {
  let registry: FastifyInstance;
  let brokerHttp: FastifyInstance;
  let mtls: MtlsTunnelServer;
  let hub: FastifyInstance;
  let ctx: AppContext;
  let client: MtlsTunnelClient;
  let brokerHttpBase: string;
  let hubUuid: string;

  beforeAll(async () => {
    const ca = generateHubCa();
    // Server cert CN is a hostname (+ DNS SAN); we connect by IP but verify by SNI hostname, as in
    // production (avoids setting the TLS ServerName to an IP, which RFC 6066 disallows).
    const serverCert = issueServerCert(ca, { commonName: "broker.local" });
    const broker = new TunnelBroker({ caPublicKey: "" });

    // 1. mTLS listener (hubs dial in) — get its port to advertise as the mtls endpoint.
    mtls = createMtlsTunnelServer({ cert: serverCert.certPem, key: serverCert.keyPem, caCert: ca.caCertPem, broker, heartbeatMs: 1000 });
    const mtlsPort = await mtls.listen(0, "127.0.0.1");

    // 2. Hub Registry — issues a real X.509 device cert at enrollment and hands out the endpoint.
    registry = buildHubRegistryServer({ pkiCa: ca, mtlsEndpoint: `127.0.0.1:${mtlsPort}`, brokerEndpoint: "https://broker.test", logLevel: "silent" });
    await registry.ready();

    // 3. Broker HTTP surface (off-LAN client routing) over the same broker core.
    brokerHttp = buildTunnelBrokerServer({ caPublicKey: "", broker, authorizeClient: async () => true, logLevel: "silent" });
    await brokerHttp.listen({ host: "127.0.0.1", port: 0 });
    const ba = brokerHttp.server.address();
    brokerHttpBase = `http://127.0.0.1:${typeof ba === "object" && ba ? ba.port : 0}`;

    // 4. The hub gateway.
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }));
    hub = await buildServer(ctx);
    await hub.listen({ host: "127.0.0.1", port: 0 });
    const ha = hub.server.address();
    const hubPort = typeof ha === "object" && ha ? ha.port : 0;
    const localBaseUrl = `http://127.0.0.1:${hubPort}`;

    // 5. Hub agent enrolls against the registry (fetch routed via inject) → gets X.509 material.
    const fetchImpl: FetchLike = async (url, init) => {
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const res = await registry.inject({ method: init.method as "POST", url: path, headers: init.headers, payload: init.body });
      return { ok: res.statusCode < 400, status: res.statusCode, json: async () => JSON.parse(res.payload) };
    };
    const agent = new HubAgent({ store: createSecretStore(undefined), registryUrl: "https://reg.test", model: "Hub Pro", fwVersion: "0.4.0", fetchImpl });
    const state = await agent.ensureEnrolled();
    hubUuid = agent.hubUuid;
    expect(state.mtls).not.toBeNull();

    // 6. The hub dials the broker's mTLS listener with its device cert (outbound only).
    const proxyLocal = async (req: TunnelRequest): Promise<TunnelResponse> => {
      const res = await fetch(`${localBaseUrl}${req.path}`, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      });
      const headers: Record<string, string> = {};
      const ct = res.headers.get("content-type");
      if (ct) headers["content-type"] = ct;
      return { status: res.status, headers, body: await res.text() };
    };
    await new Promise<void>((ready) => {
      const [host, portStr] = state.mtls!.endpoint.split(":");
      client = new MtlsTunnelClient({
        host: host!, port: Number(portStr), servername: "broker.local",
        cert: state.mtls!.deviceCert, key: state.mtls!.deviceKey, caCert: state.mtls!.caCert,
        onRequest: proxyLocal, onReady: () => ready(),
      });
      client.start();
    });
  });

  afterAll(async () => {
    client.stop();
    await mtls.close();
    await brokerHttp.close();
    await registry.close();
    await hub.close();
    await ctx.shutdown();
    await new Promise((r) => setTimeout(r, 20));
  });

  it("routes an off-LAN healthz through the broker over the mTLS tunnel to the hub", async () => {
    const res = await fetch(`${brokerHttpBase}/v1/route/${hubUuid}/healthz`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("ok");
  });

  it("authenticates on the hub: a real login round-trips over the mTLS tunnel", async () => {
    const res = await fetch(`${brokerHttpBase}/v1/route/${hubUuid}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { accessToken?: string }).accessToken).toBeTruthy();
  });
});

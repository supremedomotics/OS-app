import { generateHubCa, issueDeviceCert, issueServerCert } from "@supreme/hub-pki";
import { createMtlsTunnelServer, MtlsTunnelClient, TunnelBroker, type MtlsTunnelServer, type TunnelRequest, type TunnelResponse } from "@supreme/tunnel-broker";
import { BrokerHubRouter, buildVoiceServer, OAuthProvider } from "@supreme/voice";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * CAPSTONE — the whole voice path with REAL components, no fakes between them:
 *   Alexa directive → cloud Voice server → Tunnel Broker (device-cert mTLS) → hub gateway → SIL →
 *   device, and the changed state read back through the gateway.
 * Only the device backend is the in-process mock (as on a hub with no hardware). This proves the
 * seams built this session (OAuth link, BrokerHubRouter, mTLS tunnel, command translation) compose.
 */
describe("Capstone: Alexa → Voice cloud → Broker(mTLS) → hub → device", () => {
  let mtls: MtlsTunnelServer;
  let hub: FastifyInstance;
  let ctx: AppContext;
  let voice: FastifyInstance;
  let client: MtlsTunnelClient;
  let ownerToken = "";
  let accessToken = "";
  let lightId = "";
  const redirectUri = "https://layla.amazon.com/cb";
  const hubUuid = "hub-capstone";

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pred()) return true;
      await sleep(20);
    }
    return pred();
  }

  beforeAll(async () => {
    const ca = generateHubCa();
    const serverCert = issueServerCert(ca, { commonName: "broker.local" });
    const broker = new TunnelBroker({ caPublicKey: "" });
    mtls = createMtlsTunnelServer({ cert: serverCert.certPem, key: serverCert.keyPem, caCert: ca.caCertPem, broker, heartbeatMs: 1000 });
    const mtlsPort = await mtls.listen(0, "127.0.0.1");

    // The hub gateway (in-process mock backend) with the seeded demo home.
    ctx = await AppContext.create(loadConfig({ SUPREME_PORT: "0", SUPREME_LOG_LEVEL: "silent" }));
    hub = await buildServer(ctx);
    await hub.listen({ host: "127.0.0.1", port: 0 });
    const ha = hub.server.address();
    const localBaseUrl = `http://127.0.0.1:${typeof ha === "object" && ha ? ha.port : 0}`;

    // The hub dials OUT to the broker with its device cert and proxies forwarded requests to itself.
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
    const dev = issueDeviceCert(ca, { hubUuid });
    await new Promise<void>((ready) => {
      client = new MtlsTunnelClient({
        host: "127.0.0.1", port: mtlsPort, servername: "broker.local",
        cert: dev.certPem, key: dev.keyPem, caCert: ca.caCertPem,
        onRequest: proxyLocal, onReady: () => ready(),
      });
      client.start();
    });
    await waitFor(() => broker.isOnline(hubUuid));

    // A real owner token (the hub-scoped token the cloud presents when forwarding directives).
    const login = await fetch(`${localBaseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    ownerToken = ((await login.json()) as { accessToken: string }).accessToken;
    const devices = (await (await fetch(`${localBaseUrl}/v1/devices`, { headers: { authorization: `Bearer ${ownerToken}` } })).json()) as {
      devices: { id: string; capabilities: { kind: string }[] }[];
    };
    lightId = devices.devices.find((d) => d.capabilities.some((c) => c.kind === "onoff"))!.id;

    // The cloud Voice server, routing to the hub over the SAME broker.
    const oauth = new OAuthProvider({ signingSecret: "capstone-secret", clients: [{ clientId: "alexa-client", clientSecret: "alexa-secret", assistant: "alexa", redirectUris: [redirectUri] }] });
    const code = oauth.issueCode({ clientId: "alexa-client", redirectUri, identity: { accountId: "acct-1", homeId: "home-1", hubToken: ownerToken } });
    accessToken = oauth.exchange({ grantType: "authorization_code", code, redirectUri, clientId: "alexa-client", clientSecret: "alexa-secret" }).access_token;
    const hubRouter = new BrokerHubRouter({ broker, resolveHubId: () => hubUuid });
    voice = buildVoiceServer({ oauth, hub: hubRouter, authenticateUser: async () => null, logLevel: "silent" });
    await voice.ready();
  });

  afterAll(async () => {
    client.stop();
    await voice.close();
    await mtls.close();
    await hub.close();
    await ctx.shutdown();
    await sleep(20);
  });

  function alexa(namespace: string, name: string, endpointId?: string) {
    const directive: Record<string, unknown> = {
      header: { namespace, name, payloadVersion: "3", messageId: "m", correlationToken: "ct" },
      payload: { scope: { type: "BearerToken", token: accessToken } },
    };
    if (endpointId) directive.endpoint = { endpointId, scope: { type: "BearerToken", token: accessToken } };
    return voice.inject({ method: "POST", url: "/voice/alexa", payload: { directive } });
  }

  it("Alexa Discovery enumerates the hub's devices over the mTLS tunnel", async () => {
    const res = await alexa("Alexa.Discovery", "Discover");
    const endpoints = res.json().event.payload.endpoints as { endpointId: string }[];
    expect(endpoints.length).toBeGreaterThan(0);
    expect(endpoints.some((e) => e.endpointId === lightId)).toBe(true);
  });

  it("Alexa TurnOn travels cloud → broker → hub and actually turns the device on", async () => {
    const res = await alexa("Alexa.PowerController", "TurnOn", lightId);
    expect(res.json().event.header.name).toBe("Response");

    // Read the real device state back through the hub — it changed.
    const device = await ctx.home.getDevice(lightId as never);
    expect((device?.state?.onoff as { on?: boolean } | undefined)?.on).toBe(true);
  });
});

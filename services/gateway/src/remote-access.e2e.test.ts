import { buildRelayServer } from "@supreme/relay";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";
import { RelayTunnelClient } from "./relay-tunnel.js";

/**
 * Full remote-access path (§8): the hub dials OUT to the cloud relay (no inbound
 * ports), and an off-LAN client request to the relay is forwarded over the tunnel to
 * the hub's gateway — identity is still enforced on the hub.
 */
describe("Remote access via the cloud relay", () => {
  const TOKEN = "hub-relay-secret";
  let relay: FastifyInstance;
  let hub: FastifyInstance;
  let ctx: AppContext;
  let tunnel: RelayTunnelClient;
  let relayBase: string;

  beforeAll(async () => {
    // 1. Cloud relay.
    relay = buildRelayServer({ hubAuthToken: TOKEN, logLevel: "silent" });
    await relay.listen({ host: "127.0.0.1", port: 0 });
    const ra = relay.server.address();
    const relayPort = typeof ra === "object" && ra ? ra.port : 0;
    relayBase = `http://127.0.0.1:${relayPort}`;

    // 2. The hub gateway.
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }));
    hub = await buildServer(ctx);
    await hub.listen({ host: "127.0.0.1", port: 0 });
    const ha = hub.server.address();
    const hubPort = typeof ha === "object" && ha ? ha.port : 0;

    // 3. The hub dials out to the relay (Node's global WebSocket).
    tunnel = new RelayTunnelClient({
      relayUrl: relayBase,
      homeId: ctx.homeId,
      token: TOKEN,
      localBaseUrl: `http://127.0.0.1:${hubPort}`,
    });
    tunnel.start();
    await new Promise((r) => setTimeout(r, 120)); // allow the tunnel to register
  });
  afterAll(async () => {
    tunnel.stop();
    await hub.close();
    await ctx.shutdown();
    await relay.close();
    await new Promise((r) => setTimeout(r, 20));
  });

  it("forwards an off-LAN request through the relay to the hub", async () => {
    const res = await fetch(`${relayBase}/v1/relay/${ctx.homeId}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("authenticates on the hub: a real login round-trips over the tunnel", async () => {
    const res = await fetch(`${relayBase}/v1/relay/${ctx.homeId}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; accessToken?: string };
    expect(body.status).toBe("ok");
    expect(body.accessToken).toBeTruthy();
  });
});

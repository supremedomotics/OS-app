import { connect as tlsConnect } from "node:tls";
import { generateHubCa, issueDeviceCert, issueServerCert } from "@supreme/hub-pki";
import { afterEach, describe, expect, it } from "vitest";
import { TunnelBroker } from "./broker.js";
import { createMtlsTunnelServer, MtlsTunnelClient, type MtlsTunnelServer } from "./mtls.js";

/**
 * Real device-cert mutual-TLS over the loopback: a hub dials OUT with its X.509 device cert, the
 * broker verifies it at the TLS layer and routes a client request over the held connection. Proves
 * mTLS auth (good cert accepted, untrusted/no cert rejected), presence, reconnect, and the
 * NAT-traversal property (the hub runs no inbound listener — the broker reaches it solely over the
 * hub-initiated outbound socket).
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * Poll a predicate until it holds or the deadline passes. CI runners are far slower than a laptop
 * (node-forge RSA-2048 keygen + the TLS handshake are CPU-heavy), so we wait on the actual condition
 * instead of a fixed sleep that can race the handshake under load.
 */
async function waitFor(pred: () => boolean, timeoutMs = 5000, stepMs = 10): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(stepMs);
  }
  return pred();
}

describe("mTLS tunnel transport", () => {
  const ca = generateHubCa();
  const serverCert = issueServerCert(ca, { commonName: "broker.supreme.example" });
  let server: MtlsTunnelServer | null = null;
  let client: MtlsTunnelClient | null = null;

  afterEach(async () => {
    client?.stop();
    await server?.close();
    server = null;
    client = null;
  });

  async function startServer(broker: TunnelBroker): Promise<number> {
    server = createMtlsTunnelServer({ cert: serverCert.certPem, key: serverCert.keyPem, caCert: ca.caCertPem, broker, heartbeatMs: 200 });
    return server.listen(0, "127.0.0.1");
  }

  function startHub(port: number, hubUuid: string, onRequest: Parameters<typeof makeClient>[3]) {
    const dev = issueDeviceCert(ca, { hubUuid });
    return makeClient(port, hubUuid, dev, onRequest);
  }
  function makeClient(port: number, _hubUuid: string, dev: { certPem: string; keyPem: string }, onRequest: (req: { method: string; path: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; headers: Record<string, string>; body: string }>) {
    return new Promise<MtlsTunnelClient>((ready) => {
      const c = new MtlsTunnelClient({
        host: "127.0.0.1", port, servername: "broker.supreme.example",
        cert: dev.certPem, key: dev.keyPem, caCert: ca.caCertPem,
        onRequest, onReady: () => ready(c),
      });
      c.start();
    });
  }

  it("authenticates a hub by its device cert and routes a request over the tunnel", async () => {
    const broker = new TunnelBroker({ caPublicKey: "" });
    const port = await startServer(broker);
    client = await startHub(port, "hub-1", async (req) => ({ status: 200, headers: {}, body: `pong:${req.path}` }));
    expect(await waitFor(() => broker.isOnline("hub-1"))).toBe(true); // presence
    const res = await broker.forward("hub-1", { method: "GET", path: "/v1/ping", headers: {} });
    expect(res.status).toBe(200);
    expect(res.body).toBe("pong:/v1/ping");
  });

  it("rejects a client whose cert is from a DIFFERENT CA (mTLS enforced)", async () => {
    const broker = new TunnelBroker({ caPublicKey: "" });
    const port = await startServer(broker);

    const rogueCa = generateHubCa();
    const rogue = issueDeviceCert(rogueCa, { hubUuid: "hub-evil" });
    expect(await probe(port, { cert: rogue.certPem, key: rogue.keyPem })).toBe("rejected");
    expect(broker.isOnline("hub-evil")).toBe(false);
  });

  it("rejects a client presenting NO certificate", async () => {
    const broker = new TunnelBroker({ caPublicKey: "" });
    const port = await startServer(broker);
    expect(await probe(port, {})).toBe("rejected");
  });

  // The server may finish the server→client half (so the client fires secureConnect) and only then
  // tear down for an unauthorized CLIENT cert. So "rejected" = the connection drops; "connected" =
  // it stays open past a short window.
  function probe(port: number, creds: { cert?: string; key?: string }): Promise<"connected" | "rejected"> {
    return new Promise((resolve) => {
      const s = tlsConnect({ host: "127.0.0.1", port, servername: "broker.supreme.example", ca: [ca.caCertPem], rejectUnauthorized: true, ...creds });
      let done = false;
      const finish = (v: "connected" | "rejected") => {
        if (done) return;
        done = true;
        s.destroy();
        resolve(v);
      };
      // A server-side mTLS rejection of the client cert surfaces as error/close (it can arrive AFTER
      // the client's own secureConnect, so we must NOT treat secureConnect as success). If neither
      // fires within the window, the handshake was accepted. The window is generous so a slow
      // rejection under CI load isn't misread as "connected" — the source of intermittent flakes.
      s.on("error", () => finish("rejected"));
      s.on("close", () => finish("rejected"));
      const t = setTimeout(() => finish("connected"), 1500);
      t.unref?.();
    });
  }

  it("works through NAT: the hub has no inbound listener; the broker reaches it outbound-only", async () => {
    // The hub side is purely an MtlsTunnelClient — it opens no server/port. A request initiated at
    // the broker travels back over the hub-initiated socket, which is exactly what survives NAT/CGNAT.
    const broker = new TunnelBroker({ caPublicKey: "" });
    const port = await startServer(broker);
    let sawRequest = false;
    client = await startHub(port, "hub-nat", async (req) => {
      sawRequest = true;
      return { status: 201, headers: { "x-served": "hub" }, body: `local:${req.method} ${req.path}` };
    });
    expect(await waitFor(() => broker.isOnline("hub-nat"))).toBe(true);

    const res = await broker.forward("hub-nat", { method: "POST", path: "/v1/devices/x/command", headers: {}, body: "{}" });
    expect(sawRequest).toBe(true);
    expect(res.status).toBe(201);
    expect(res.headers["x-served"]).toBe("hub");
  });

  it("reconnects automatically and restores presence after a drop", async () => {
    const broker = new TunnelBroker({ caPublicKey: "" });
    const port = await startServer(broker);
    let ready = 0;
    const dev = issueDeviceCert(ca, { hubUuid: "hub-rc" });
    client = new MtlsTunnelClient({
      host: "127.0.0.1", port, servername: "broker.supreme.example",
      cert: dev.certPem, key: dev.keyPem, caCert: ca.caCertPem,
      reconnectBaseMs: 20, reconnectMaxMs: 60,
      onRequest: async () => ({ status: 200, headers: {}, body: "ok" }),
      onReady: () => (ready += 1),
    });
    client.start();
    expect(await waitFor(() => broker.isOnline("hub-rc"))).toBe(true);
    expect(ready).toBe(1);

    // Drop the connection (broker restarts). The hub's socket closes → backoff reconnect kicks in.
    await server.close();
    expect(await waitFor(() => !broker.isOnline("hub-rc"))).toBe(true); // presence cleared on drop
    // Bring the broker back on the SAME port; the hub reconnects on its own and presence returns.
    server = createMtlsTunnelServer({ cert: serverCert.certPem, key: serverCert.keyPem, caCert: ca.caCertPem, broker, heartbeatMs: 200 });
    await server.listen(port, "127.0.0.1");
    expect(await waitFor(() => broker.isOnline("hub-rc"))).toBe(true); // reconnected
    expect(await waitFor(() => ready >= 2)).toBe(true);
  });
});

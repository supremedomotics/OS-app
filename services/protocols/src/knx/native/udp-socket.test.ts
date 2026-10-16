import { createSocket, type Socket } from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeConnectRequest, decodeDisconnectRequest, decodeFrame, encodeConnectResponse, encodeDisconnectResponse, ServiceType, StatusCode,
} from "./knxnetip-frame.js";
import { KnxTunnelClient } from "./tunnel-client.js";
import { createUdpSocketFactory } from "./udp-socket.js";

/**
 * Real `node:dgram` over 127.0.0.1: proves the production socket factory + client work over
 * an actual UDP path (the in-memory simulator cannot). The peer here is a minimal hand-rolled
 * responder, not a KNX implementation — gateway behaviour is covered by the simulator suite.
 */
let server: Socket | null = null;
afterEach(() => { server?.close(); server = null; });

function startGateway(): Promise<number> {
  return new Promise((resolve) => {
    server = createSocket("udp4");
    server.on("message", (msg, rinfo) => {
      const f = decodeFrame(msg);
      if (f.service === ServiceType.CONNECT_REQUEST) {
        decodeConnectRequest(f.body);
        server!.send(encodeConnectResponse({ channelId: 9, status: StatusCode.NO_ERROR, dataEndpoint: { protocol: 1, address: "127.0.0.1", port: server!.address().port }, assignedAddress: 0xff09 }), rinfo.port, rinfo.address);
      } else if (f.service === ServiceType.DISCONNECT_REQUEST) {
        const r = decodeDisconnectRequest(f.body);
        server!.send(encodeDisconnectResponse({ channelId: r.channelId, status: 0 }), rinfo.port, rinfo.address);
      }
    });
    server.bind(0, "127.0.0.1", () => resolve(server!.address().port));
  });
}

describe("native UDP transport (real sockets, loopback only)", () => {
  it("connects, learns the assigned address and disconnects over real UDP", async () => {
    const port = await startGateway();
    const c = new KnxTunnelClient({ host: "127.0.0.1", port, socketFactory: createUdpSocketFactory({ localAddress: "127.0.0.1" }) });
    await c.connect();
    expect(c.state).toBe("connected");
    expect(c.assignedAddress).toBe(0xff09);
    expect(c.diagnostics().connectLatencyMs).toBeLessThan(1000);
    await c.disconnect();
    expect(c.diagnostics().closedReason).toBe("local_disconnect");
  });
  it("times out against a silent peer and releases the socket", async () => {
    const silent = createSocket("udp4");
    await new Promise<void>((r) => silent.bind(0, "127.0.0.1", () => r()));
    const c = new KnxTunnelClient({ host: "127.0.0.1", port: silent.address().port, connectTimeoutMs: 150, socketFactory: createUdpSocketFactory({ localAddress: "127.0.0.1" }) });
    await expect(c.connect()).rejects.toMatchObject({ code: "connect_timeout" });
    silent.close();
  });
  it("reports a bind failure as socket_error instead of hanging", async () => {
    const c = new KnxTunnelClient({ host: "127.0.0.1", socketFactory: createUdpSocketFactory({ localAddress: "203.0.113.77" }) });
    await expect(c.connect()).rejects.toMatchObject({ code: "socket_error" });
  });
});

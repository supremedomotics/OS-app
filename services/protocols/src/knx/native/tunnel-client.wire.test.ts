import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseGroupAddress } from "./address.js";
import { encodeDpt } from "./dpt.js";
import { encodeConnectResponse, encodeTunnellingAck, HostProtocol, ServiceType, StatusCode, encodeConnectionStateResponse, decodeFrame } from "./knxnetip-frame.js";
import { KnxTunnelClient } from "./tunnel-client.js";
import type { TunnelLink, TunnelLinkHandlers } from "./tunnel-link.js";
import type { KnxDatagramSocket, RemoteInfo, SocketFactory, SocketHandlers } from "./transport.js";
import { ManualClock, VirtualActuator, VirtualKnxBus, VirtualKnxInterface, VirtualNetwork } from "./simulator/index.js";

/**
 * Characterisation of the classic UDP tunnel client's OBSERVABLE behaviour: every datagram it emits (time, destination, bytes) and the
 * decisions about where it sends. Written against the code BEFORE the transport extraction and kept unchanged afterwards: if the
 * extraction (or anything else) alters what goes on the wire, when, or to whom, this file fails. Nothing here is KNX conformance.
 */
const GW = "10.0.0.2";
const CMD = parseGroupAddress("1/1/1");
const FB = parseGroupAddress("1/1/2");
interface Sent { t: number; to: string; hex: string }

function logged(inner: SocketFactory, clock: ManualClock, log: Sent[]): SocketFactory {
  return async (h: SocketHandlers) => {
    const s = await inner(h);
    const wrapped: KnxDatagramSocket = {
      get localPort() { return s.localPort; },
      send: (d, port, address) => { log.push({ t: clock.now(), to: `${address}:${port}`, hex: d.toString("hex") }); s.send(d, port, address); },
      close: () => { log.push({ t: clock.now(), to: "close", hex: "" }); s.close(); },
    };
    return wrapped;
  };
}
const digest = (log: Sent[]) => createHash("sha256").update(log.map((x) => `${x.t}|${x.to}|${x.hex}`).join("\n")).digest("hex");

async function scenarioLifecycle(): Promise<Sent[]> {
  const clock = new ManualClock(), net = new VirtualNetwork(clock, 1), bus = new VirtualKnxBus(clock);
  const gw = new VirtualKnxInterface(net, bus, clock, { address: GW });
  bus.addDevice(new VirtualActuator({ individualAddress: 0x1101, commandGa: CMD, feedbackGa: FB, dpt: "1.001", initial: false }, clock));
  const log: Sent[] = [];
  const c = new KnxTunnelClient({ host: GW, socketFactory: logged(net.createSocketFactory("10.0.0.50"), clock, log), clock });
  const p = c.connect(); await clock.advance(5); await p;
  const a = c.sendGroup({ destination: CMD, service: "write", data: encodeDpt("1.001", true) }); await clock.advance(5); await a;
  gw.faults.dropAcks = true;                                                  // forces a retransmission with the same sequence
  const b = c.sendGroup({ destination: CMD, service: "write", data: encodeDpt("1.001", false) }); b.catch(() => undefined);
  await clock.advance(500); gw.faults.dropAcks = false; await clock.advance(700); await b.catch(() => undefined);
  await clock.advance(61_000);                                                // one heartbeat
  const d = c.disconnect(); await clock.advance(10); await d;
  gw.shutdown();
  return log;
}

async function scenarioAckTimeout(): Promise<Sent[]> {
  const clock = new ManualClock(), net = new VirtualNetwork(clock, 1), bus = new VirtualKnxBus(clock);
  const gw = new VirtualKnxInterface(net, bus, clock, { address: GW });
  const log: Sent[] = [];
  const c = new KnxTunnelClient({ host: GW, socketFactory: logged(net.createSocketFactory("10.0.0.50"), clock, log), clock });
  const p = c.connect(); await clock.advance(5); await p;
  gw.faults.dropAcks = true;
  const s = c.sendGroup({ destination: CMD, service: "write", data: encodeDpt("1.001", true) }); s.catch(() => undefined);
  await clock.advance(5_000); await s.catch(() => undefined);
  gw.shutdown();
  return log;
}

describe("classic UDP tunnel client: wire-level characterisation (must survive the transport extraction unchanged)", () => {
  it("lifecycle trace (connect, send, ACK lost → identical repeat, heartbeat, disconnect) is byte-for-byte and time-for-time stable", async () => {
    const log = await scenarioLifecycle();
    expect(log.map((x) => `${x.t}|${x.to}|${x.hex.slice(4, 8)}`)).toMatchInlineSnapshot(`
      [
        "0|10.0.0.2:3671|0205",
        "5|10.0.0.2:3671|0420",
        "7|10.0.0.2:3671|0421",
        "9|10.0.0.2:3671|0421",
        "10|10.0.0.2:3671|0420",
        "12|10.0.0.2:3671|0421",
        "14|10.0.0.2:3671|0421",
        "1010|10.0.0.2:3671|0420",
        "60002|10.0.0.2:3671|0207",
        "62210|10.0.0.2:3671|0209",
        "62212|close|",
      ]
    `);
    expect(digest(log)).toBe("d80a1fb9ddf506ebb34150f39ceea039f845d43b9dbd7916533e1050e4d2a827");
  });
  it("ACK-timeout trace (repeat, then DISCONNECT_REQUEST, then close) is stable", async () => {
    const log = await scenarioAckTimeout();
    expect(log.map((x) => `${x.t}|${x.to}|${x.hex.slice(4, 8)}`)).toMatchInlineSnapshot(`
      [
        "0|10.0.0.2:3671|0205",
        "5|10.0.0.2:3671|0420",
        "7|10.0.0.2:3671|0421",
        "1005|10.0.0.2:3671|0420",
        "2005|10.0.0.2:3671|0209",
        "2005|close|",
      ]
    `);
    expect(digest(log)).toBe("0f4654ffe2e046d0a40cb21c9dc435edde11684358194c65aca1180a93c50917");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Route-back addressing, driven by a hand-made socket so the response endpoint is under test control.
function fake(): { factory: SocketFactory; sent: Array<{ to: string; service: number }>; deliver(from: RemoteInfo, frame: Buffer): void; closed(): number; error(e: Error): void } {
  let handlers!: SocketHandlers; let closes = 0;
  const sent: Array<{ to: string; service: number }> = [];
  return {
    sent, closed: () => closes,
    deliver: (from, frame) => handlers.onMessage(frame, from),
    error: (e) => handlers.onError(e),
    factory: (h) => { handlers = h; return { localPort: 40000, send: (d, port, address) => { sent.push({ to: `${address}:${port}`, service: d.readUInt16BE(2) }); }, close: () => { closes++; } }; },
  };
}
const connectResp = (data: { address: string; port: number }) => encodeConnectResponse({ channelId: 7, status: StatusCode.NO_ERROR, dataEndpoint: { protocol: HostProtocol.UDP, ...data }, assignedAddress: 0xff01 });

describe("route-back addressing", () => {
  it("the CONNECT_REQUEST goes to the configured gateway endpoint", async () => {
    const f = fake(); const clock = new ManualClock();
    const c = new KnxTunnelClient({ host: GW, port: 3999, socketFactory: f.factory, clock });
    void c.connect().catch(() => undefined); await clock.advance(1);
    expect(f.sent).toEqual([{ to: `${GW}:3999`, service: ServiceType.CONNECT_REQUEST }]);
    void c.disconnect();
  });
  it("a zero announced data port ⇒ later frames go to where the response came from", async () => {
    const f = fake(); const clock = new ManualClock();
    const c = new KnxTunnelClient({ host: GW, socketFactory: f.factory, clock, heartbeatIntervalMs: 1000 });
    const p = c.connect(); await clock.advance(1);
    f.deliver({ address: GW, port: 3671 }, connectResp({ address: "0.0.0.0", port: 0 })); await p;
    await clock.advance(1000);
    expect(f.sent.at(-1)).toEqual({ to: `${GW}:3671`, service: ServiceType.CONNECTIONSTATE_REQUEST });
    void c.disconnect();
  });
  it("a concrete announced data port on the gateway's own address is used", async () => {
    const f = fake(); const clock = new ManualClock();
    const c = new KnxTunnelClient({ host: GW, socketFactory: f.factory, clock, heartbeatIntervalMs: 1000 });
    const p = c.connect(); await clock.advance(1);
    f.deliver({ address: GW, port: 3671 }, connectResp({ address: GW, port: 3672 })); await p;
    await clock.advance(1000);
    expect(f.sent.at(-1)).toEqual({ to: `${GW}:3672`, service: ServiceType.CONNECTIONSTATE_REQUEST });
    void c.disconnect();
  });
  it("an announced endpoint on a FOREIGN address is ignored (answer where the response came from, port included)", async () => {
    const f = fake(); const clock = new ManualClock();
    const c = new KnxTunnelClient({ host: GW, socketFactory: f.factory, clock, heartbeatIntervalMs: 1000 });
    const p = c.connect(); await clock.advance(1);
    f.deliver({ address: GW, port: 3680 }, connectResp({ address: "192.168.9.9", port: 3672 })); await p;
    await clock.advance(1000);
    expect(f.sent.at(-1)).toEqual({ to: `${GW}:3680`, service: ServiceType.CONNECTIONSTATE_REQUEST });
    void c.disconnect();
  });
  it("datagrams from another address are counted and never processed, including a forged CONNECT_RESPONSE", async () => {
    const f = fake(); const clock = new ManualClock();
    const c = new KnxTunnelClient({ host: GW, socketFactory: f.factory, clock, connectTimeoutMs: 50 });
    const p = c.connect(); p.catch(() => undefined); await clock.advance(1);
    f.deliver({ address: "10.9.9.9", port: 3671 }, connectResp({ address: "0.0.0.0", port: 0 }));
    expect(c.diagnostics().foreignDatagrams).toBe(1);
    expect(c.state).toBe("connecting");
    await clock.advance(100);
    await expect(p).rejects.toMatchObject({ code: "connect_timeout" });
  });
  it("after shutdown nothing is sent and the socket is closed exactly once; late datagrams are ignored", async () => {
    const f = fake(); const clock = new ManualClock();
    const c = new KnxTunnelClient({ host: GW, socketFactory: f.factory, clock });
    const p = c.connect(); await clock.advance(1);
    f.deliver({ address: GW, port: 3671 }, connectResp({ address: "0.0.0.0", port: 0 })); await p;
    const d = c.disconnect(); await clock.advance(1);
    f.deliver({ address: GW, port: 3671 }, (await import("./knxnetip-frame.js")).encodeDisconnectResponse({ channelId: 7, status: StatusCode.NO_ERROR })); await d;
    const n = f.sent.length;
    f.deliver({ address: GW, port: 3671 }, encodeTunnellingAck({ channelId: 7, sequence: 0, status: StatusCode.NO_ERROR }));
    f.deliver({ address: "10.9.9.9", port: 1 }, Buffer.alloc(6));
    expect(f.sent.length).toBe(n);
    expect(f.closed()).toBe(1);
    expect(c.diagnostics().foreignDatagrams).toBe(0);                          // closed ⇒ not even counted
  });
  it("a socket error ends the tunnel as socket_error and closes the socket once", async () => {
    const f = fake(); const clock = new ManualClock();
    const c = new KnxTunnelClient({ host: GW, socketFactory: f.factory, clock });
    const p = c.connect(); p.catch(() => undefined); await clock.advance(1);
    f.error(new Error("EPIPE"));
    await expect(p).rejects.toMatchObject({ code: "socket_error" });
    expect(f.closed()).toBe(1);
    void decodeFrame; void encodeConnectionStateResponse;
  });
});

describe("TunnelLink seam", () => {
  it("the client runs over an injected link and never needs a socket factory; route-back is delegated with the announced data endpoint", async () => {
    const calls: string[] = []; let h!: TunnelLinkHandlers; const clock = new ManualClock();
    const link: TunnelLink = {
      kind: "datagram",
      open: async (x) => { h = x; calls.push("open"); },
      send: (f) => calls.push(`send:${f.readUInt16BE(2).toString(16)}`),
      routeBack: (a) => calls.push(`routeBack:${a ? `${a.address}:${a.port}` : "none"}`),
      close: () => calls.push("close"),
    };
    const c = new KnxTunnelClient({ host: GW, link, clock });
    const p = c.connect(); await clock.advance(1);
    h.onFrame(connectResp({ address: GW, port: 3672 })); await p;
    const d = c.disconnect(); await clock.advance(1);
    h.onFrame((await import("./knxnetip-frame.js")).encodeDisconnectResponse({ channelId: 7, status: StatusCode.NO_ERROR })); await d;
    expect(calls).toEqual(["open", "send:205", `routeBack:${GW}:3672`, "send:209", "close"]);
  });
  it("requires a socket factory or a link", () => {
    expect(() => new KnxTunnelClient({ host: GW })).toThrow(expect.objectContaining({ code: "invalid_argument" }));
  });
});

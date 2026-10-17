import { createServer, type AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseGroupAddress } from "../address.js";
import { CemiMessageCode } from "../cemi.js";
import { encodeDpt } from "../dpt.js";
import { encodeConnectResponse, encodeFrame, encodeTunnellingAck, HostProtocol, ServiceType, StatusCode } from "../knxnetip-frame.js";
import { Secret } from "../security/secret.js";
import { ManualClock, VirtualSecureGateway, VirtualStreamNetwork, VirtualStreamTunnelServer, type ServerSession } from "../simulator/index.js";
import { createTcpStreamFactory } from "../tcp-socket.js";
import { makeRng } from "../test-support.js";
import { isSimulated, type SocketHandlers } from "../transport.js";
import { KnxTunnelClient, type TunnelClientOptions } from "../tunnel-client.js";
import { STREAM_RULES, unverifiedBlockers } from "../tunnel-rules.js";
import { SecureStreamTunnelLink } from "./secure-stream-link.js";
import type { SecureConnectionOptions } from "./secure-connection.js";

/**
 * Stream-mode tunnelling over the authenticated secure session — SIMULATOR ONLY. Verified rules: TUN v01.07.01 §2.6.2 (no TUNNELLING_ACK sent,
 * received ACKs ignored, receive sequence not evaluated). Everything else (HPAI, liveness, disconnect, status codes, partial frames) is blocked and
 * not exercised as a claim. A pass here shows internal consistency with a self-authored server, never interoperability.
 */
const rng = makeRng(0x7ec);
const GW = "10.0.0.2";
const CMD = parseGroupAddress("1/1/1");
const ON = { destination: CMD, service: "write" as const, data: encodeDpt("1.001", true) };

let clock: ManualClock; let net: VirtualStreamNetwork; let gw: VirtualSecureGateway; let srv: VirtualStreamTunnelServer;
let dac: Secret; let hash: Secret; let sessions: ServerSession[]; let inners: Buffer[]; let tunnels: KnxTunnelClient[];

beforeEach(() => {
  clock = new ManualClock(); net = new VirtualStreamNetwork(clock, 1);
  dac = new Secret(rng.bytes(16)); hash = new Secret(rng.bytes(16)); sessions = []; inners = []; tunnels = [];
  srv = new VirtualStreamTunnelServer();
  gw = new VirtualSecureGateway(net, clock, {
    address: GW, deviceAuthCode: dac, users: new Map([[1, hash]]), serialNumber: rng.bytes(6),
    onInner: (s, f) => { if (!sessions.includes(s)) sessions.push(s); inners.push(f); srv.onInner(s, f); },
  });
  srv.bind(gw);
});
afterEach(async () => {
  for (const t of tunnels) void t.disconnect();
  await clock.advance(5_000);
  gw.shutdown();
  await clock.advance(200_000);
  expect(net.openConnections).toBe(0);
  expect(gw.sessions.size).toBe(0);
  expect(clock.pendingTimers).toBe(0);
});

const linkOpts = (over: Partial<SecureConnectionOptions> = {}): SecureConnectionOptions =>
  ({ streamFactory: net.createStreamFactory("10.0.0.50", GW, 3671), clock, userId: 1, passwordHash: hash, deviceAuthCode: dac, serialNumber: rng.bytes(6), ...over });
function tunnel(over: Partial<SecureConnectionOptions> = {}, tc: Partial<TunnelClientOptions> = {}): KnxTunnelClient {
  const t = new KnxTunnelClient({ host: GW, link: new SecureStreamTunnelLink(linkOpts(over)), clock, ...tc });
  tunnels.push(t); return t;
}
async function up(over: Partial<SecureConnectionOptions> = {}, tc: Partial<TunnelClientOptions> = {}): Promise<KnxTunnelClient> {
  const t = tunnel(over, tc); const p = t.connect(); p.catch(() => undefined);
  await clock.advance(60); await p; return t;
}
const svcOf = (f: Buffer) => f.readUInt16BE(2);
const got = (t: KnxTunnelClient) => { const a: number[] = []; t.onTelegram((c) => a.push(c.destination)); return a; };

describe("verified stream rules (TUN v01.07.01 §2.6.2)", () => {
  it("connects over the authenticated session, learns its address and reports the stream link", async () => {
    const t = await up();
    expect(t.state).toBe("connected");
    expect(t.assignedAddress).toBe(0xff01);
    expect(t.diagnostics().link).toBe("secure-stream");
    expect(srv.received.connectRequests).toBe(1);
  });

  it("a valid tunnelling message is processed: it reaches the server, is bus-confirmed, and the receipt says there was no ACK", async () => {
    const t = await up();
    const p = t.sendGroup(ON); await clock.advance(10);
    const r = await p;
    expect(r).toMatchObject({ transportAck: "none", sequence: 0, ackedAt: null, ackLatencyMs: null, attempts: 1 });
    await expect(r.confirmation).resolves.toBe("confirmed");
    expect(srv.received.tunnellingRequests).toEqual([{ channelId: 5, sequence: 0, destination: CMD }]);
  });

  it("no TUNNELLING_ACK is ever emitted, however many requests (counter, zero, odd sequences) the server sends", async () => {
    const t = await up(); const seen = got(t);
    for (const seq of [0, 1, 2, 255, 17, 17]) srv.telegram(sessions[0]!, CemiMessageCode.L_DATA_IND, 0x1101, CMD, "write", encodeDpt("1.001", true), seq);
    await clock.advance(50);
    expect(seen).toHaveLength(6);
    expect(srv.received.acks).toBe(0);
    expect(inners.some((f) => svcOf(f) === ServiceType.TUNNELLING_ACK)).toBe(false);
  });

  it("received TUNNELLING_ACK frames are ignored: success, error status, wrong channel — no retry, no termination, no state change", async () => {
    const t = await up();
    srv.ack(sessions[0]!, 0); srv.ack(sessions[0]!, 0, 0x29); srv.ack(sessions[0]!, 9, StatusCode.NO_ERROR, 77);
    await clock.advance(50);
    const d = t.diagnostics();
    expect(d.ignoredAcks).toBe(3);
    expect(d.acksReceived).toBe(0); expect(d.staleAcks).toBe(0); expect(d.wrongChannel).toBe(0); expect(d.sendRetries).toBe(0);
    expect(t.state).toBe("connected");
    await t.sendGroup(ON); await clock.advance(10);
    expect(srv.received.tunnellingRequests).toHaveLength(1);
  });

  it("the receive sequence counter is NOT evaluated: duplicates, backwards and far-ahead values are all delivered once each", async () => {
    const t = await up(); const seen = got(t);
    for (const seq of [42, 42, 7, 0, 255, 1]) srv.telegram(sessions[0]!, CemiMessageCode.L_DATA_IND, 0x1101, CMD, "write", encodeDpt("1.001", true), seq);
    await clock.advance(50);
    expect(seen).toHaveLength(6);
    const d = t.diagnostics();
    expect(d.duplicateInbound).toBe(0); expect(d.outOfOrderInbound).toBe(0);
  });

  it("the sender uses sequence 0 for every request and does not wait for an ACK (back-to-back sends all complete)", async () => {
    const t = await up();
    const ps = Array.from({ length: 5 }, () => t.sendGroup(ON));
    await clock.advance(20);
    const rs = await Promise.all(ps);
    expect(rs.map((r) => r.sequence)).toEqual([0, 0, 0, 0, 0]);
    expect(srv.received.tunnellingRequests.map((x) => x.sequence)).toEqual([0, 0, 0, 0, 0]);
    expect(t.diagnostics().sendRetries).toBe(0);
  });

  it("a request for another channel is counted and not delivered", async () => {
    const t = await up(); const seen = got(t);
    srv.rawTunnelling(sessions[0]!, Buffer.from("2900bce0110111010101" + "0080", "hex"), 0, 99);
    await clock.advance(20);
    expect(seen).toHaveLength(0); expect(t.diagnostics().wrongChannel).toBe(1);
  });
});

describe("rules are scoped to stream mode — datagram behaviour is unchanged", () => {
  function udp() {
    let h!: SocketHandlers; const sent: number[] = [];
    const c = new KnxTunnelClient({ host: GW, clock, socketFactory: (x) => { h = x; return { localPort: 1, send: (d) => { sent.push(d.readUInt16BE(2)); }, close: () => undefined }; } });
    return { c, sent, deliver: (f: Buffer) => h.onMessage(f, { address: GW, port: 3671 }) };
  }
  const resp = () => encodeConnectResponse({ channelId: 5, status: StatusCode.NO_ERROR, dataEndpoint: { protocol: HostProtocol.UDP, address: "0.0.0.0", port: 0 }, assignedAddress: 0xff01 });
  const req = (seq: number) => encodeFrame(ServiceType.TUNNELLING_REQUEST, Buffer.concat([Buffer.from([4, 5, seq, 0]), Buffer.from("2900bce0110111010101" + "0080", "hex")]));

  it("UDP still evaluates the sequence, ACKs the expected frame, drops an out-of-order one silently and sends a real ACK", async () => {
    const u = udp(); const p = u.c.connect(); await clock.advance(1); u.deliver(resp()); await p;
    u.deliver(req(5));                                                       // expected 0 → ignored, no reply
    expect(u.c.diagnostics().outOfOrderInbound).toBe(1);
    expect(u.sent.filter((s) => s === ServiceType.TUNNELLING_ACK)).toHaveLength(0);
    u.deliver(req(0));                                                       // expected → ACK
    expect(u.sent.filter((s) => s === ServiceType.TUNNELLING_ACK)).toHaveLength(1);
    expect(u.c.diagnostics().link).toBe("datagram");
    void u.c.disconnect();
  });
  it("UDP still counts a received ACK for an unknown request as stale (not ignored wholesale)", async () => {
    const u = udp(); const p = u.c.connect(); await clock.advance(1); u.deliver(resp()); await p;
    u.deliver(encodeTunnellingAck({ channelId: 5, sequence: 0, status: StatusCode.NO_ERROR }));
    expect(u.c.diagnostics().staleAcks).toBe(1); expect(u.c.diagnostics().ignoredAcks).toBe(0);
    void u.c.disconnect();
  });
});

describe("blocked rules stay blocked (fail closed)", () => {
  it("the registry lists exactly the unresolved blockers", () => {
    expect(unverifiedBlockers(STREAM_RULES).sort()).toEqual(["B1", "B3", "B4", "B5", "B8"]);
    for (const k of ["sendTunnellingAck", "processReceivedAck", "evaluateReceiveSequence", "sendSequence"] as const) expect(STREAM_RULES[k]).toHaveProperty("source");
  });
  it("a stream tunnel over a REAL socket factory is refused at construction and opens nothing", async () => {
    const server = createServer(); let conns = 0; server.on("connection", () => conns++);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const real = createTcpStreamFactory({ host: "127.0.0.1", port });
    expect(isSimulated(real)).toBe(false);
    expect(() => new KnxTunnelClient({ host: GW, link: new SecureStreamTunnelLink(linkOpts({ streamFactory: real })), clock })).toThrow(/refused on a real transport.*B3/);
    await new Promise((r) => setTimeout(r, 30));
    expect(conns).toBe(0);
    await new Promise<void>((r) => server.close(() => r()));
  });
  it("an unmarked in-memory factory is refused too: only a factory created by the simulator network qualifies", () => {
    const home = net.createStreamFactory("10.0.0.50", GW, 3671);
    const lookalike = ((h: Parameters<typeof home>[0]) => home(h)) as typeof home;
    expect(isSimulated(home)).toBe(true); expect(isSimulated(lookalike)).toBe(false);
    expect(() => new KnxTunnelClient({ host: GW, link: new SecureStreamTunnelLink(linkOpts({ streamFactory: lookalike })), clock })).toThrow(/unverified rules/);
  });
  it("no KNX-level heartbeat, no DISCONNECT_REQUEST and no CONNECTIONSTATE_REQUEST are ever sent; the session's own KEEPALIVE holds the tunnel for minutes", async () => {
    const t = await up();
    await clock.advance(300_000);
    expect(t.state).toBe("connected");
    expect(srv.received.connectionState).toBe(0);
    expect(gw.counters.keepAlives).toBeGreaterThan(5);
    expect(t.diagnostics().heartbeat.sent).toBe(0);
  });
});

describe("malformed and invalid input", () => {
  it("malformed frames, truncated bodies and bad cEMI inside the session are counted and survived", async () => {
    const t = await up(); const seen = got(t);
    srv.raw(sessions[0]!, Buffer.from("0610042000ff", "hex"));                                 // length mismatch
    srv.raw(sessions[0]!, encodeFrame(ServiceType.TUNNELLING_REQUEST, Buffer.from([4, 5, 0])));  // truncated body
    srv.rawTunnelling(sessions[0]!, Buffer.from("2900", "hex"));                               // bad cEMI
    srv.raw(sessions[0]!, encodeFrame(0x0201, Buffer.alloc(8)));  // unexpected service in a tunnel
    await clock.advance(50);
    const d = t.diagnostics();
    expect(Object.values(d.malformedFrames).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2);
    expect(Object.values(d.malformedCemi).reduce((a, b) => a + b, 0)).toBe(1);
    expect(seen).toHaveLength(0); expect(t.state).toBe("connected");
    srv.telegram(sessions[0]!, CemiMessageCode.L_DATA_IND, 0x1101, CMD, "write", encodeDpt("1.001", true));
    await clock.advance(20);
    expect(seen).toHaveLength(1);                                                              // still working
  });
  it("invalid application input is rejected before anything is sent", async () => {
    const t = await up(); const before = inners.length;
    await expect(t.sendGroup({ destination: CMD, service: "read", data: encodeDpt("1.001", true) })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(t.sendGroup({ destination: 0x1ffff, service: "write", data: encodeDpt("1.001", true) })).rejects.toMatchObject({ code: "invalid_argument" });
    await clock.advance(10);
    expect(inners.length).toBe(before);
  });
  it("sending while not connected is rejected", async () => {
    const t = tunnel();
    await expect(t.sendGroup(ON)).rejects.toMatchObject({ code: "not_connected" });
  });
});

describe("secure-session failures stay fail-closed", () => {
  it("wrong user password: the tunnel never connects and no tunnel frame is ever produced", async () => {
    const t = tunnel({ passwordHash: new Secret(rng.bytes(16)) }); const p = t.connect(); const a = expect(p).rejects.toMatchObject({ code: "socket_error" });
    await clock.advance(100); await a;
    expect(t.state).toBe("closed");
    expect(srv.received.connectRequests).toBe(0);
    expect(inners).toHaveLength(0);                                    // not even a CONNECT_REQUEST was produced
    expect(gw.counters.authFailures).toBe(1);
  });
  it("impostor server (wrong Device Authentication Code): refused before any tunnel frame", async () => {
    gw.faults.wrongDeviceAuthCode = true;
    const t = tunnel(); const p = t.connect(); const a = expect(p).rejects.toMatchObject({ code: "socket_error" });
    await clock.advance(100); await a;
    expect(srv.received.connectRequests).toBe(0); expect(inners).toHaveLength(0);
  });
  it("no response to SESSION_REQUEST: handshake timeout, nothing sent in the clear afterwards", async () => {
    gw.faults.silent = true;
    const t = tunnel(); const p = t.connect(); const a = expect(p).rejects.toMatchObject({ code: "socket_error" });
    await clock.advance(11_000); await a;
    expect(t.state).toBe("closed");
  });
  it("a missing serial or Device Authentication Code is refused before TCP is opened", async () => {
    for (const bad of [{ serialNumber: Buffer.alloc(6) }, { deviceAuthCode: null }] as Array<Partial<SecureConnectionOptions>>) {
      const t = tunnel(bad); const p = t.connect(); const a = expect(p).rejects.toMatchObject({ code: "socket_error" });
      await clock.advance(10); await a;
    }
    expect(net.stats.connections).toBe(0);
  });
});

describe("termination and injected failures release everything exactly once", () => {
  it("orderly disconnect: only the secure session closes (STATUS_CLOSE); no DISCONNECT_REQUEST; server session and TCP freed", async () => {
    const t = await up();
    const pending = t.sendGroup(ON);
    await t.disconnect(); await clock.advance(20);
    await pending.catch(() => undefined);
    expect(t.state).toBe("closed");
    expect(srv.received.disconnectRequests).toBe(0);
    expect(gw.counters.closedByClient).toBe(1);
    expect(gw.sessions.size).toBe(0);
  });
  it("server ends the session (STATUS_TIMEOUT): tunnel closes as session_closed and rejects its pending confirmation", async () => {
    const t = await up(); const closed: string[] = []; t.onClosed((e) => closed.push(e.reason));
    gw.endWith(sessions[0]!, 3); await clock.advance(20);
    expect(t.state).toBe("closed"); expect(closed).toEqual(["session_closed"]);
    await expect(t.sendGroup(ON)).rejects.toMatchObject({ code: "not_connected" });
  });
  it("TCP reset: tunnel closes once, in-flight confirmations settle as not_confirmed", async () => {
    const t = await up(); const closed: string[] = []; t.onClosed((e) => closed.push(e.reason));
    srv.received.tunnellingRequests.length = 0;
    const r = await (async () => { const p = t.sendGroup(ON); await clock.advance(1); return p; })();
    sessions[0]!.conn.destroy(); await clock.advance(20);
    expect(closed).toEqual(["session_closed"]);
    await expect(r.confirmation).resolves.toBe("not_confirmed");   // the reset beat the L_Data.con; the promise settles exactly once
  });
  it("server-initiated DISCONNECT_REQUEST: tunnel closes as gateway_disconnect and sends NO response (B5 unverified)", async () => {
    const t = await up(); const before = inners.length;
    srv.disconnect(sessions[0]!); await clock.advance(20);
    expect(t.state).toBe("closed");
    expect(t.diagnostics().closedReason).toBe("gateway_disconnect");
    expect(srv.received.disconnectResponses).toBe(0);
    expect(inners.slice(before).every((f) => svcOf(f) !== ServiceType.DISCONNECT_RESPONSE)).toBe(true);
  });
  it("send counter exhaustion: the refused send rejects once, the tunnel closes as session_closed, nothing is sent after", async () => {
    const link = new SecureStreamTunnelLink(linkOpts());
    const t = new KnxTunnelClient({ host: GW, link, clock }); tunnels.push(t);
    const p = t.connect(); await clock.advance(60); await p;
    (link as unknown as { conn: { session: { unsafeSetSendSequenceForTest(n: bigint): void } } }).conn.session.unsafeSetSendSequenceForTest((1n << 48n));
    await expect(t.sendGroup(ON)).rejects.toMatchObject({ code: "session_closed" });
    expect(t.state).toBe("closed");
  });
  it("40 connect/disconnect cycles leave no timer, connection or server session (checked again by the global gate)", async () => {
    for (let i = 0; i < 40; i++) { const t = await up(); await t.sendGroup(ON).then(() => undefined); await t.disconnect(); await clock.advance(20); }
    expect(gw.sessions.size).toBe(0); expect(net.openConnections).toBe(0);
  });
});

describe("the simulator cannot reach a real network", () => {
  it("a virtual stream factory aimed at a REAL listening loopback server is refused and the server sees no connection", async () => {
    const server = createServer(); let conns = 0; server.on("connection", () => conns++);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const t = new KnxTunnelClient({ host: "127.0.0.1", clock, link: new SecureStreamTunnelLink(linkOpts({ streamFactory: net.createStreamFactory("10.0.0.50", "127.0.0.1", port) })) });
    tunnels.push(t);
    const p = t.connect(); const a = expect(p).rejects.toMatchObject({ code: "socket_error" });
    await clock.advance(50); await a;
    await new Promise((r) => setTimeout(r, 30));
    expect(conns).toBe(0); expect(net.stats.refused).toBe(1);
    await new Promise<void>((r) => server.close(() => r()));
  });
});

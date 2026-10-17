import { createServer, Socket, type AddressInfo, type Server } from "node:net";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecureSessionConnection } from "./secure/secure-connection.js";
import { KnxStreamDeframer } from "./secure/stream.js";
import { createTcpStreamFactory, TcpConnectError } from "./tcp-socket.js";
import { Secret } from "./security/secret.js";
import { ManualClock, VirtualSecureGateway, VirtualStreamNetwork } from "./simulator/index.js";
import type { ServerSide } from "./simulator/virtual-stream.js";
import { systemClock, type KnxStreamSocket } from "./transport.js";
import { makeRng } from "./test-support.js";

/**
 * REAL TCP on the loopback interface (127.0.0.1), no external host. What this proves: the socket layer behaves correctly on a real
 * kernel TCP stack (fragmentation, coalescing, reset, FIN, timeouts, cleanup) and that the secure session runs over it against the
 * simulator's gateway model. What it does NOT prove: anything about a real KNX IP Secure gateway.
 */
const rng = makeRng(0x7c9);
const LOOP = "127.0.0.1";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("condition not reached in time"); await sleep(5); }
}

let server: Server; let port: number; let accepted: Socket[];
let onConn: (s: Socket) => void;
beforeEach(async () => {
  accepted = []; onConn = () => undefined;
  server = createServer((s) => { accepted.push(s); s.on("error", () => undefined); onConn(s); });
  await new Promise<void>((r) => server.listen(0, LOOP, r));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  for (const s of accepted) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

const factory = (extra: Partial<Parameters<typeof createTcpStreamFactory>[0]> = {}) => createTcpStreamFactory({ host: LOOP, port, localAddress: LOOP, ...extra });
interface Rec { data: Buffer[]; closes: Array<Error | undefined> }
async function open(extra = {}): Promise<{ sock: KnxStreamSocket; rec: Rec }> {
  const rec: Rec = { data: [], closes: [] };
  const sock = await factory(extra)({ onData: (d) => rec.data.push(d), onClose: (e) => rec.closes.push(e) });
  return { sock, rec };
}
const frame = (n: number): Buffer => { const b = rng.bytes(n); b[0] = 6; b[1] = 0x10; b.writeUInt16BE(0x0420, 2); b.writeUInt16BE(n, 4); return b; };

describe("TCP stream factory on real loopback sockets", () => {
  it("round-trips bytes both ways", async () => {
    onConn = (s) => s.on("data", (d) => s.write(d));
    const { sock, rec } = await open();
    const f = frame(40); sock.write(f);
    await until(() => Buffer.concat(rec.data).length >= 40);
    expect(Buffer.concat(rec.data).equals(f)).toBe(true);
    sock.destroy();
  });

  it("stream fragmentation: a frame delivered one byte per segment is reassembled by the deframer", async () => {
    const f = frame(60);
    onConn = (s) => { s.setNoDelay(true); (async () => { for (const b of f) { s.write(Buffer.from([b])); await sleep(1); } })(); };
    const { sock, rec } = await open();
    const d = new KnxStreamDeframer(); const frames: Buffer[] = [];
    await until(() => { for (const c of rec.data.splice(0)) frames.push(...d.push(c)); return frames.length === 1; });
    expect(frames[0]!.equals(f)).toBe(true);
    sock.destroy();
  });

  it("stream coalescing: several frames written in one segment come out as separate frames", async () => {
    const fs = [frame(20), frame(33), frame(6)];
    onConn = (s) => { s.write(Buffer.concat(fs)); };
    const { sock, rec } = await open();
    const d = new KnxStreamDeframer(); const frames: Buffer[] = [];
    await until(() => { for (const c of rec.data.splice(0)) frames.push(...d.push(c)); return frames.length === 3; });
    expect(frames.map((x) => x.toString("hex"))).toEqual(fs.map((x) => x.toString("hex")));
    sock.destroy();
  });

  it("peer closure (FIN): onClose fires exactly once without an error", async () => {
    onConn = (s) => s.end();
    const { rec } = await open();
    await until(() => rec.closes.length > 0); await sleep(30);
    expect(rec.closes).toEqual([undefined]);
  });

  it("connection reset by the peer: onClose fires exactly once with an error", async () => {
    onConn = (s) => { s.once("data", () => s.resetAndDestroy()); };
    const { sock, rec } = await open();
    sock.write(Buffer.from([1]));
    await until(() => rec.closes.length > 0); await sleep(30);
    expect(rec.closes).toHaveLength(1);
    expect(rec.closes[0]).toBeInstanceOf(Error);
  });

  it("local destroy() never calls onClose and releases the descriptor on both ends", async () => {
    const { sock, rec } = await open();
    await until(() => accepted.length === 1);
    sock.destroy(); sock.destroy();
    await until(() => accepted[0]!.destroyed || accepted[0]!.readableEnded);
    await sleep(30);
    expect(rec.closes).toHaveLength(0);
  });

  it("end() is an orderly close; a peer that never answers our FIN is cut off after the linger bound", async () => {
    onConn = (s) => { s.pause(); s.on("end", () => undefined); (s as Socket & { allowHalfOpen: boolean }).allowHalfOpen = true; };
    const { sock, rec } = await open({ lingerMs: 80 });
    await until(() => accepted.length === 1);
    sock.end();
    await until(() => rec.closes.length === 1, 2000);
  });

  it("connection refused rejects with connect_failed (no hang, no leak)", async () => {
    const dead = createServer(); await new Promise<void>((r) => dead.listen(0, LOOP, r));
    const p = (dead.address() as AddressInfo).port; await new Promise<void>((r) => dead.close(() => r()));
    await expect(createTcpStreamFactory({ host: LOOP, port: p })({ onData: () => undefined, onClose: () => undefined })).rejects.toMatchObject({ code: "connect_failed" });
  });

  it("connect timeout rejects with connect_timeout and destroys the half-open socket", async () => {
    let made: Socket | undefined;
    const f = createTcpStreamFactory({ host: LOOP, port, connectTimeoutMs: 40, createSocket: () => { made = new Socket(); return made; } }); // never connects
    await expect(f({ onData: () => undefined, onClose: () => undefined })).rejects.toBeInstanceOf(TcpConnectError);
    expect(made!.destroyed).toBe(true);
  });

  it("a write queue above the bound resets the connection and reports it once", async () => {
    onConn = (s) => s.pause();
    const { sock, rec } = await open({ maxQueuedBytes: 64 * 1024 });
    sock.write(Buffer.alloc(64 * 1024 * 1024));
    await until(() => rec.closes.length === 1);
    expect(String(rec.closes[0]?.message)).toMatch(/write queue/);
  });

  it("an exception thrown by the data handler destroys the connection instead of crashing the process", async () => {
    onConn = (s) => { s.write(Buffer.from([1, 2, 3])); };
    const closes: Array<Error | undefined> = [];
    await factory()({ onData: () => { throw new Error("handler bug"); }, onClose: (e) => closes.push(e) });
    await until(() => closes.length === 1);
    expect(closes[0]?.message).toBe("handler bug");
  });

  it("rejects invalid endpoints up front", () => {
    expect(() => createTcpStreamFactory({ host: "", port: 3671 })).toThrow(TcpConnectError);
    expect(() => createTcpStreamFactory({ host: LOOP, port: 0 })).toThrow(TcpConnectError);
    expect(() => createTcpStreamFactory({ host: LOOP, port: 70000 })).toThrow(TcpConnectError);
  });
  it("applies no destination policy: any configured address is accepted by the factory (policy belongs to configuration, not the socket)", () => {
    expect(() => createTcpStreamFactory({ host: "192.168.1.50", port: 3671 })).not.toThrow();
    expect(() => createTcpStreamFactory({ host: "knx-gateway.example", port: 3671 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The KNX IP Secure session over a REAL TCP connection (gateway model bridged onto a real server socket).

function bridge(s: Socket): ServerSide {
  return {
    remote: { address: s.remoteAddress ?? "", port: s.remotePort ?? 0 },
    write: (d) => { if (!s.destroyed) s.write(d); }, end: () => s.end(), destroy: () => s.destroy(),
    onData: (fn) => { s.on("data", fn); }, onClose: (fn) => { s.on("close", () => fn()); },
  };
}

describe("secure session over real loopback TCP (simulated gateway model on the far end)", () => {
  let gw: VirtualSecureGateway; let dac: Secret; let hash: Secret;
  const mk = (over: Record<string, unknown> = {}) => new SecureSessionConnection({
    streamFactory: factory(), clock: systemClock, userId: 1, passwordHash: hash, deviceAuthCode: dac, serialNumber: rng.bytes(6),
    responseTimeoutMs: 400, authenticationTimeoutMs: 400, ...over,
  });
  beforeEach(() => {
    dac = new Secret(rng.bytes(16)); hash = new Secret(rng.bytes(16));
    gw = new VirtualSecureGateway(null, systemClock, { address: LOOP, deviceAuthCode: dac, users: new Map([[1, hash]]), serialNumber: rng.bytes(6), sessionTimeoutMs: 60_000 });
    onConn = (s) => gw.acceptConnection(bridge(s));
  });
  afterEach(() => { gw.shutdown(); });

  it("authenticates, exchanges wrapped frames and closes cleanly with the server session and socket released", async () => {
    const c = mk(); await c.connect();
    expect(c.diagnostics().state).toBe("authenticated");
    expect(c.diagnostics().serverAuthenticated).toBe(true);
    c.close();
    await c.whenClosed();
    await until(() => gw.sessions.size === 0 && accepted.every((s) => s.destroyed));
    expect(gw.counters.closedByClient).toBe(1);
  });

  it("a gateway that proves the wrong Device Authentication Code is rejected on the real stream", async () => {
    gw.faults.wrongDeviceAuthCode = true;
    const c = mk();
    await expect(c.connect()).rejects.toMatchObject({ code: "server_authentication_failed" });
    await until(() => accepted.every((s) => s.destroyed));
  });

  it("a silent server ends the session by response timeout and the socket is torn down", async () => {
    gw.faults.silent = true;
    const c = mk({ responseTimeoutMs: 120 });
    await expect(c.connect()).rejects.toMatchObject({ code: "response_timeout" });
    await until(() => accepted.every((s) => s.destroyed));
  });

  it("TCP reset in an authenticated session ends it as transport_closed", async () => {
    const c = mk(); await c.connect();
    accepted[0]!.resetAndDestroy();
    expect(await c.whenClosed()).toMatchObject({ reason: "transport_closed" });
  });

  it("a server that sends a malformed KNXnet/IP header is cut off (protocol_violation) and the socket is destroyed", async () => {
    onConn = (s) => { s.resume(); s.write(Buffer.from([0x07, 0x10, 0x09, 0x52, 0x00, 0x38])); };
    const c = mk();
    await expect(c.connect()).rejects.toMatchObject({ code: "protocol_violation" });
    await until(() => accepted.every((s) => s.destroyed || s.readableEnded));
  });

  it("an oversize length field is cut off without buffering the announced payload", async () => {
    onConn = (s) => { s.resume(); s.write(Buffer.from([0x06, 0x10, 0x09, 0x52, 0xff, 0xff])); };
    const c = mk();
    await expect(c.connect()).rejects.toMatchObject({ code: "protocol_violation" });
  });

  it("nothing is sent before the configuration is validated: an invalid option never opens a connection", async () => {
    const before = accepted.length;
    const c = mk({ serialNumber: Buffer.alloc(6) });
    await expect(c.connect()).rejects.toMatchObject({ code: "invalid_option" });
    await sleep(30);
    expect(accepted.length).toBe(before);
  });

  it("connect refused → transport_closed, and a secure session is never retried on a new connection by itself (single-use)", async () => {
    const dead = createServer(); await new Promise<void>((r) => dead.listen(0, LOOP, r));
    const p = (dead.address() as AddressInfo).port; await new Promise<void>((r) => dead.close(() => r()));
    const c = mk({ streamFactory: createTcpStreamFactory({ host: LOOP, port: p }) });
    await expect(c.connect()).rejects.toMatchObject({ code: "transport_closed" });
    await expect(c.connect()).rejects.toMatchObject({ code: "already_started" });
  });

  it("40 connect/close cycles leave no server session and no open server socket", async () => {
    for (let i = 0; i < 40; i++) { const c = mk(); await c.connect(); c.close(); await c.whenClosed(); }
    await until(() => gw.sessions.size === 0 && accepted.every((s) => s.destroyed), 4000);
    expect(accepted).toHaveLength(40);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The simulator must be incapable of reaching a real network.
describe("simulator isolation", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "simulator");
  it("no simulator source imports a network, DNS, TLS, HTTP or process-spawning module", () => {
    const banned = /from\s+["'](node:)?(net|dgram|tls|http|https|http2|dns|child_process|cluster|worker_threads)["']|require\(\s*["'](node:)?(net|dgram|tls|http|https|dns|child_process)["']\s*\)|\bimport\(\s*["'](node:)?(net|dgram|tls|http|https|dns|child_process)["']/;
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(banned.test(readFileSync(join(dir, f), "utf8")), f).toBe(false);
  });
  it("the virtual network refuses a real listening endpoint: only explicitly registered virtual listeners are reachable", async () => {
    const net = new VirtualStreamNetwork(new ManualClock());
    const f = net.createStreamFactory("10.0.0.50", LOOP, port);   // `port` is a REAL listening server above
    expect(() => f({ onData: () => undefined, onClose: () => undefined })).toThrow(/ECONNREFUSED/);
    expect(accepted).toHaveLength(0);
    expect(net.stats.refused).toBe(1);
  });
});

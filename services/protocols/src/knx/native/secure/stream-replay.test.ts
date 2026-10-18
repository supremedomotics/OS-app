import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseGroupAddress } from "../address.js";
import { CemiMessageCode } from "../cemi.js";
import { encodeDpt } from "../dpt.js";
import { Secret } from "../security/secret.js";
import { ManualClock, VirtualSecureGateway, VirtualStreamNetwork, VirtualStreamTunnelServer, type ServerSession, type VirtualConnection } from "../simulator/index.js";
import { makeRng } from "../test-support.js";
import { KnxTunnelClient } from "../tunnel-client.js";
import { generateEcdhKeyPair } from "./ip-keys.js";
import type { SecureConnectionOptions } from "./secure-connection.js";
import { SecureStreamTunnelLink } from "./secure-stream-link.js";

/**
 * Replay-safety matrix for stream-mode tunnelling (docs/architecture/knx-ip-secure-security-review.md §10). AUTHENTICATION ≠ REPLAY PREVENTION: a captured
 * wrapper is perfectly authentic; it is rejected only because (a) its sequence number is ≤ the last accepted one (IPS §2.2.1.3.3, §2.2.3.3, N) or
 * (b) it belongs to another session key (fresh ECDH pair per session, §2.2.3.1.1, N). Tunnel-layer sequence numbers play NO role here: TUN §2.6.2 says
 * the receiver must not evaluate them. Tests marked KNOWN LIMITATION characterise behaviour the specification does not prevent.
 * Simulator only: the server is self-authored, so server-side assertions show our model, not a device.
 */
const rng = makeRng(0x9e91);
const GW = "10.0.0.2";
const CMD = parseGroupAddress("1/1/1");
const ON = { destination: CMD, service: "write" as const, data: encodeDpt("1.001", true) };
const IND = (s: VirtualStreamTunnelServer, ses: ServerSession) => s.telegram(ses, CemiMessageCode.L_DATA_IND, 0x1101, CMD, "write", encodeDpt("1.001", true));
const isWrapper = (c: Buffer) => c.length >= 44 && c.readUInt16BE(2) === 0x0950;
const wrapperSeq = (c: Buffer) => c.readUIntBE(8, 6);

let clock: ManualClock; let net: VirtualStreamNetwork; let gw: VirtualSecureGateway; let srv: VirtualStreamTunnelServer;
let dac: Secret; let hash: Secret; let sessions: ServerSession[]; let tunnels: KnxTunnelClient[];

beforeEach(() => {
  clock = new ManualClock(); net = new VirtualStreamNetwork(clock, 1);
  dac = new Secret(rng.bytes(16)); hash = new Secret(rng.bytes(16)); sessions = []; tunnels = [];
  srv = new VirtualStreamTunnelServer();
  gw = new VirtualSecureGateway(net, clock, {
    address: GW, deviceAuthCode: dac, users: new Map([[1, hash]]), serialNumber: rng.bytes(6),
    onInner: (s, f) => { if (!sessions.includes(s)) sessions.push(s); srv.onInner(s, f); },
  });
  srv.bind(gw);
});
afterEach(async () => {
  for (const t of tunnels) void t.disconnect();
  await clock.advance(5_000); gw.shutdown(); await clock.advance(200_000);
  expect(net.openConnections).toBe(0); expect(gw.sessions.size).toBe(0); expect(clock.pendingTimers).toBe(0);
});

const opts = (over: Partial<SecureConnectionOptions> = {}): SecureConnectionOptions =>
  ({ streamFactory: net.createStreamFactory("10.0.0.50", GW, 3671), clock, userId: 1, passwordHash: hash, deviceAuthCode: dac, serialNumber: rng.bytes(6), ...over });
interface T { t: KnxTunnelClient; link: SecureStreamTunnelLink; got: number[] }
async function up(over: Partial<SecureConnectionOptions> = {}): Promise<T> {
  const link = new SecureStreamTunnelLink(opts(over));
  const t = new KnxTunnelClient({ host: GW, link, clock }); tunnels.push(t);
  const got: number[] = []; t.onTelegram((c) => got.push(c.destination));
  const p = t.connect(); p.catch(() => undefined); await clock.advance(60); await p;
  return { t, link, got };
}
const feed = (link: SecureStreamTunnelLink, frame: Buffer) => (link as unknown as { conn: { session: { receive(f: Buffer): void } } }).conn.session.receive(frame);
/** Taps: collects wrappers per direction after the handshake (the first two server→client frames are RESPONSE + STATUS). */
function capture() {
  const out = { s2c: [] as Buffer[], c2s: [] as Buffer[], responses: [] as Buffer[] };
  net.tap((dir, chunk) => {
    if (dir === "server->client" && chunk.length === 56 && chunk.readUInt16BE(2) === 0x0952) out.responses.push(Buffer.from(chunk));
    if (isWrapper(chunk)) (dir === "server->client" ? out.s2c : out.c2s).push(Buffer.from(chunk));
    return [chunk];
  });
  return out;
}

describe("A. duplicate network delivery (same wrapper delivered twice)", () => {
  it("server→client: every duplicated wrapper is discarded as a replay; each telegram is delivered exactly once", async () => {
    const { t, link, got } = await up();
    net.tap((dir, chunk) => (dir === "server->client" && isWrapper(chunk) ? [chunk, Buffer.from(chunk)] : [chunk]));
    for (let i = 0; i < 3; i++) IND(srv, sessions[0]!);
    await clock.advance(50);
    expect(got).toHaveLength(3);
    expect(link.sessionDiagnostics()!.discarded.replay).toBe(3);
    expect(t.state).toBe("connected");
  });
  it("client→server: a duplicated command wrapper executes once (server model drops the replay)", async () => {
    const { t } = await up();
    net.tap((dir, chunk) => (dir === "client->server" && isWrapper(chunk) ? [chunk, Buffer.from(chunk)] : [chunk]));
    await t.sendGroup(ON); await clock.advance(50);
    expect(srv.received.tunnellingRequests).toHaveLength(1);
    expect(gw.counters.replayDrops).toBeGreaterThanOrEqual(1);
  });
});

describe("B. repeated authenticated wrappers within one session", () => {
  it("a captured, genuinely authentic wrapper injected later is not processed again", async () => {
    const cap = capture(); const { link, got } = await up();
    IND(srv, sessions[0]!); await clock.advance(10);
    const w = cap.s2c.at(-1)!;
    IND(srv, sessions[0]!); IND(srv, sessions[0]!); await clock.advance(10);
    expect(got).toHaveLength(3);
    feed(link, w);
    expect(got).toHaveLength(3);
    expect(link.sessionDiagnostics()!.discarded.replay).toBe(1);
  });
  it("reordering: a wrapper that arrives after a newer one is dropped, never replayed (the telegram is LOST — TCP normally prevents this)", async () => {
    const { link, got } = await up(); let held: Buffer | null = null; let n = 0;
    net.tap((dir, chunk) => {
      if (dir !== "server->client" || !isWrapper(chunk)) return [chunk];
      if (n++ === 0) { held = Buffer.from(chunk); return []; }
      return n === 2 ? [chunk, held!] : [chunk];
    });
    IND(srv, sessions[0]!); IND(srv, sessions[0]!); await clock.advance(20);
    expect(got).toHaveLength(1);
    expect(link.sessionDiagnostics()!.discarded.replay).toBe(1);
  });
  it("KNOWN LIMITATION: a held-back TAIL frame is accepted whenever it is released while the session lives — unicast wrappers carry no freshness (no timestamp)", async () => {
    const { link, got } = await up(); let held: Buffer | null = null;
    net.tap((dir, chunk) => { if (dir === "server->client" && isWrapper(chunk)) { held = Buffer.from(chunk); return []; } return [chunk]; });
    IND(srv, sessions[0]!); await clock.advance(10);
    expect(got).toHaveLength(0);
    await clock.advance(240_000);                                           // the client has no inbound liveness check (F5/B4): still "authenticated"
    expect(link.sessionDiagnostics()!.state).toBe("authenticated");
    feed(link, held!);
    expect(got).toHaveLength(1);                                           // stale but authentic and newer than anything seen
  });
  it("client→server withholding is bounded by the server's 60 s session timeout: released frames reach a dead session and execute nothing", async () => {
    const { t } = await up(); const stash: Buffer[] = []; let conn: VirtualConnection | null = null;
    net.tap((dir, chunk, c) => { if (dir === "client->server" && isWrapper(chunk)) { conn = c; stash.push(Buffer.from(chunk)); return []; } return [chunk]; });
    await t.sendGroup(ON);                                                  // held on the wire
    await clock.advance(70_000);                                            // keep-alives are held too ⇒ server hears nothing valid
    expect(gw.counters.timeouts).toBeGreaterThanOrEqual(1);
    for (const w of stash) conn!._serverData(w);                           // attacker releases everything late
    await clock.advance(10);
    expect(srv.received.tunnellingRequests).toHaveLength(0);
    expect(gw.sessions.size).toBe(0);
  });
});

describe("C. legitimate application retry (a NEW wrapper): not a replay, not suppressed", () => {
  it("the same command sent twice by the application executes twice, under two distinct, increasing wrapper sequence numbers", async () => {
    const cap = capture(); const { t } = await up();
    await t.sendGroup(ON); await t.sendGroup(ON); await clock.advance(30);
    expect(srv.received.tunnellingRequests).toHaveLength(2);               // at-least-once: only the CALLER knows if a repeat is safe
    const seqs = cap.c2s.map(wrapperSeq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });
  it("the tunnel never retries by itself: with no confirmation and no ACK, 5 minutes later the server still saw exactly one request", async () => {
    srv = new VirtualStreamTunnelServer({ confirm: false }); srv.bind(gw);
    gw.shutdown(); gw = new VirtualSecureGateway(net, clock, { address: GW, deviceAuthCode: dac, users: new Map([[1, hash]]), serialNumber: rng.bytes(6), onInner: (s, f) => { if (!sessions.includes(s)) sessions.push(s); srv.onInner(s, f); } }); srv.bind(gw);
    const { t } = await up();
    const r = await t.sendGroup(ON);
    await clock.advance(300_000);
    expect(srv.received.tunnellingRequests).toHaveLength(1);
    expect(t.diagnostics().sendRetries).toBe(0);
    await expect(r.confirmation).resolves.toBe("not_confirmed");           // the honest answer: delivery UNKNOWN, not "failed"
  });
  it("identical telegrams from the server in two wrappers are delivered twice (tunnel sequence is not evaluated, TUN §2.6.2)", async () => {
    const { got } = await up();
    IND(srv, sessions[0]!); IND(srv, sessions[0]!); await clock.advance(20);
    expect(got).toHaveLength(2);
  });
});

describe("D. reconnect and new-session behaviour", () => {
  it("a wrapper captured in session A is rejected in session B with a different session id (wrongSession)", async () => {
    const cap = capture(); const a = await up();
    IND(srv, sessions[0]!); await clock.advance(10);
    const old = cap.s2c.at(-1)!;
    await a.t.disconnect(); await clock.advance(20);
    const b = await up();
    feed(b.link, old);
    expect(b.got).toHaveLength(0);
    expect(b.link.sessionDiagnostics()!.discarded.wrongSession).toBe(1);
  });
  it("…and with the SAME session id it fails the MAC, because B has a fresh key (replay prevention across sessions rests on the fresh ECDH pair)", async () => {
    const cap = capture(); const a = await up();
    IND(srv, sessions[0]!); await clock.advance(10);
    const old = cap.s2c.at(-1)!;
    await a.t.disconnect(); await clock.advance(20);
    (gw as unknown as { nextId: number }).nextId = 1;                      // the server hands out the same id again
    const b = await up();
    expect(b.link.sessionDiagnostics()!.sessionId).toBe(a.link.sessionDiagnostics()!.sessionId);
    IND(srv, sessions.at(-1)!); await clock.advance(10);                   // advance B's receive counter past A's value so only the key can reject
    feed(b.link, old);
    expect(b.got).toHaveLength(1);
    expect(b.link.sessionDiagnostics()!.discarded.macFailure + b.link.sessionDiagnostics()!.discarded.replay).toBeGreaterThanOrEqual(1);
  });
  it("a client command wrapper captured in session A cannot be replayed into session B's connection (server model)", async () => {
    const cap = capture(); const a = await up();
    await a.t.sendGroup(ON); await clock.advance(20);
    const old = cap.c2s.at(-1)!;
    expect(srv.received.tunnellingRequests).toHaveLength(1);
    await a.t.disconnect(); await clock.advance(20);
    await up();
    net.connections.at(-1)!._serverData(old);                               // other session id ⇒ ignored
    await clock.advance(10);
    expect(srv.received.tunnellingRequests).toHaveLength(1);
    await tunnels.at(-1)!.disconnect(); await clock.advance(20);
    (gw as unknown as { nextId: number }).nextId = 1;                      // same id again ⇒ the MAC (fresh key) must reject it
    await up();
    net.connections.at(-1)!._serverData(old);
    await clock.advance(10);
    expect(srv.received.tunnellingRequests).toHaveLength(1);
    expect(gw.counters.macDrops).toBeGreaterThanOrEqual(1);
  });
  it("a SESSION_RESPONSE captured in an earlier handshake is rejected in a new one (its MAC covers this handshake's client value X)", async () => {
    const cap = capture(); const a = await up();
    await a.t.disconnect(); await clock.advance(20);
    const old = cap.responses[0]!;
    net.tap((dir, chunk) => (dir === "server->client" && chunk.length === 56 && chunk.readUInt16BE(2) === 0x0952 ? [Buffer.from(old)] : [chunk]));
    const link = new SecureStreamTunnelLink(opts());
    const t = new KnxTunnelClient({ host: GW, link, clock }); tunnels.push(t);
    const p = t.connect(); const e = expect(p).rejects.toMatchObject({ code: "socket_error" });
    await clock.advance(100); await e;
    expect(link.sessionDiagnostics()!.closedReason).toBe("server_authentication_failed");
  });
  it("a client key pair may not be reused across sessions (IPS §2.2.3.1.1): the second session is refused and its TCP connection released", async () => {
    const kp = generateEcdhKeyPair(); const raw = kp.privateKey.use((b) => Buffer.from(b));
    const reuse = () => ({ publicKey: kp.publicKey, privateKey: new Secret(raw) });
    const a = await up({ unsafeGenerateKeyPairForTest: reuse }); await a.t.disconnect(); await clock.advance(20);
    const link = new SecureStreamTunnelLink(opts({ unsafeGenerateKeyPairForTest: reuse }));
    const t = new KnxTunnelClient({ host: GW, link, clock }); tunnels.push(t);
    const p = t.connect(); const e = expect(p).rejects.toMatchObject({ code: "socket_error" });
    await clock.advance(100); await e;
    expect(net.openConnections).toBe(0);
    expect(srv.received.connectRequests).toBe(1);
  });
});

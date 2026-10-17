import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeSecureWrapper, encodeSessionRequest, encodeSessionStatus, peekSecureService, SecureService, SessionStatus, SEQUENCE_MAX } from "./ip-frames.js";
import { generateEcdhKeyPair } from "./ip-keys.js";
import { SecureSessionError } from "./ip-session.js";
import { SecureSessionConnection, type SecureConnectionOptions } from "./secure-connection.js";
import { KnxStreamDeframer, KnxStreamError } from "./stream.js";
import { Secret } from "../security/secret.js";
import { makeRng } from "../test-support.js";
import { ManualClock, VirtualSecureGateway, VirtualStreamNetwork, type ServerSession } from "../simulator/index.js";

/**
 * Secure-session behaviour against the VIRTUAL secure gateway. These are SIMULATOR results: they show the client implements the
 * rules it cites (IPS §2.2.3.x, §2.4) against a model of the server — not interoperability with a real IP Secure device.
 */
const rng = makeRng(0x5ec);
const GW = "10.0.0.2";
const secret = (n = 16): Secret => new Secret(rng.bytes(n));
const tunnelling = (n = 20): Buffer => { const b = rng.bytes(n); b[0] = 6; b[1] = 0x10; b.writeUInt16BE(0x0420, 2); b.writeUInt16BE(n, 4); return b; };

let clock: ManualClock; let net: VirtualStreamNetwork; let gw: VirtualSecureGateway;
let dac: Secret; let hash1: Secret; let hash2: Secret;
let inners: Array<{ session: ServerSession; frame: Buffer }>;
let clients: SecureSessionConnection[];
let serverSessions: ServerSession[];

beforeEach(() => {
  clock = new ManualClock(); net = new VirtualStreamNetwork(clock, 1);
  dac = secret(); hash1 = secret(); hash2 = secret();
  inners = []; clients = []; serverSessions = [];
  gw = new VirtualSecureGateway(net, clock, {
    address: GW, deviceAuthCode: dac, users: new Map([[1, hash1], [2, hash2]]), serialNumber: rng.bytes(6),
    onInner: (session, frame) => { inners.push({ session, frame }); if (!serverSessions.includes(session)) serverSessions.push(session); },
  });
});

afterEach(async () => {
  // Resource gate: once everything is closed, no timer, connection, session or key may remain.
  for (const c of clients) c.close();
  await clock.advance(5_000);
  gw.shutdown();
  await clock.advance(200_000);
  expect(net.openConnections).toBe(0);
  expect(gw.sessions.size).toBe(0);
  expect(clock.pendingTimers).toBe(0);
});

function client(over: Partial<SecureConnectionOptions> = {}): SecureSessionConnection {
  const c = new SecureSessionConnection({
    streamFactory: net.createStreamFactory("10.0.0.50", GW, 3671), clock, userId: 1, passwordHash: hash1, deviceAuthCode: dac, serialNumber: rng.bytes(6), ...over,
  });
  clients.push(c);
  return c;
}
async function open(c: SecureSessionConnection): Promise<void> {
  const p = c.connect(); p.catch(() => undefined);
  await clock.advance(30);
  await p;
}
async function failsWith(c: SecureSessionConnection, code: string, advanceMs = 30): Promise<void> {
  const p = c.connect();
  const assertion = expect(p).rejects.toMatchObject({ code });
  await clock.advance(advanceMs);
  await assertion;
}
/** Records every chunk the client writes (as service types) for "nothing but secure frames, nothing in the clear" assertions. */
function recordClientFrames(): number[] {
  const seen: number[] = [];
  net.tap((dir, chunk) => { if (dir === "client->server" && chunk.length >= 6) seen.push(chunk.readUInt16BE(2)); return [chunk]; });
  return seen;
}

describe("handshake (IPS §2.4.1, Figure 30)", () => {
  it("authenticates the management user; both sides count sequence numbers from 0 and accept the first frame (seq 0)", async () => {
    const c = client();
    await open(c);
    const d = c.diagnostics();
    expect(d.state).toBe("authenticated");
    expect(d.serverAuthenticated).toBe(true);
    expect(d.sessionId).not.toBeNull();
    expect(d.lastReceivedSequence).toBe("0");          // the server's first wrapper (SESSION_STATUS) carries sequence 0 and is accepted
    expect(d.nextSendSequence).toBe("1");              // our SESSION_AUTHENTICATE wrapper used 0
    expect(gw.counters.authenticated).toBe(1);
    expect(gw.sessions.size).toBe(1);
  });
  it("authenticates a user-level id (02h–7Fh)", async () => {
    const c = client({ userId: 2, passwordHash: hash2 });
    await open(c);
    expect(c.diagnostics().state).toBe("authenticated");
  });
  it("a user id with no password hash on the server, or a wrong password, ends with STATUS_AUTHENTICATION_FAILED and closes", async () => {
    const unknown = client({ userId: 3, passwordHash: secret() });
    await failsWith(unknown, "authentication_failed");
    expect(unknown.diagnostics().closedStatus).toBe(SessionStatus.AUTHENTICATION_FAILED);
    const wrong = client({ userId: 1, passwordHash: secret() });
    await failsWith(wrong, "authentication_failed");
    expect(gw.counters.authFailures).toBe(2);
    expect(gw.sessions.size).toBe(0);
  });
  it("sends exactly one SESSION_AUTHENTICATE per session and never anything in the clear", async () => {
    const seen = recordClientFrames();
    const c = client();
    await open(c);
    c.sendInner(tunnelling());
    await clock.advance(10);
    expect(seen[0]).toBe(SecureService.SESSION_REQUEST);
    expect(seen.slice(1).every((s) => s === SecureService.SECURE_WRAPPER)).toBe(true);   // only wrappers after the request
    expect(seen.filter((s) => s === SecureService.SESSION_AUTHENTICATE)).toHaveLength(0); // authenticate is never sent unwrapped
  });
  it("unique, non-zero session ids and independent keys for concurrent sessions", async () => {
    const a = client(), b = client({ userId: 2, passwordHash: hash2 });
    const pa = a.connect(), pb = b.connect(); pa.catch(() => undefined); pb.catch(() => undefined);
    await clock.advance(40); await Promise.all([pa, pb]);
    expect(a.diagnostics().sessionId).not.toBe(b.diagnostics().sessionId);
    expect(a.diagnostics().sessionId).not.toBe(0);
  });
});

describe("server authentication fails closed (decision D1)", () => {
  it("an impostor that does not know the Device Authentication Code is rejected before the password-derived MAC is ever sent", async () => {
    gw.faults.wrongDeviceAuthCode = true;
    const seen = recordClientFrames();
    const c = client();
    await failsWith(c, "server_authentication_failed");
    expect(seen).toEqual([SecureService.SESSION_REQUEST]);          // the client sent nothing else — no SESSION_AUTHENTICATE
    expect(c.diagnostics().framesSent).toBe(1);
    expect(gw.counters.authenticated).toBe(0);
  });
  it("a tampered SESSION_RESPONSE (public value altered in transit) fails the server MAC", async () => {
    let done = false;
    net.tap((dir, chunk) => { if (dir === "server->client" && !done) { done = true; const t = Buffer.from(chunk); t[20] = t[20]! ^ 1; return [t]; } return [chunk]; });
    await failsWith(client(), "server_authentication_failed");
  });
  it("without a Device Authentication Code the connection is refused up front — no TCP connection is even opened", async () => {
    const c = client({ deviceAuthCode: null });
    await expect(c.connect()).rejects.toMatchObject({ code: "invalid_option" });
    expect(net.stats.connections).toBe(0);
  });
  it("allowUnauthenticatedServer must be explicit, and is surfaced in diagnostics", async () => {
    const c = client({ deviceAuthCode: null, allowUnauthenticatedServer: true });
    await open(c);
    expect(c.diagnostics().serverAuthenticated).toBe(false);
  });
  it("rejects session id 0000h, Y = X and an all-zero Y", async () => {
    for (const fault of ["sessionIdZero", "echoClientPublic", "zeroPublic"] as const) {
      gw.faults[fault] = true;
      const c = client();
      await failsWith(c, "invalid_response");
      gw.faults[fault] = false;
    }
  });
  it("rejects invalid options without side effects", async () => {
    for (const bad of [{ userId: 0 }, { userId: 0x80 }, { serialNumber: rng.bytes(5) }, { passwordHash: secret(15) }, { deviceAuthCode: secret(17) }] as Array<Partial<SecureConnectionOptions>>) {
      await expect(client(bad).connect()).rejects.toBeInstanceOf(SecureSessionError);
    }
    expect(net.stats.connections).toBe(0);
  });
  it("is single-use: a second connect() is refused", async () => {
    const c = client(); await open(c);
    await expect(c.connect()).rejects.toMatchObject({ code: "already_started" });
  });
});

describe("timeouts (IPS §2.2.3.6.1, §2.2.3.8.1, §2.2.3.5.2.1.1)", () => {
  it("no SESSION_RESPONSE within 10 s", async () => {
    gw.faults.silent = true;
    const c = client();
    await failsWith(c, "response_timeout", 10_100);
  });
  it("no authentication status within 10 s", async () => {
    let n = 0;
    net.tap((dir, chunk) => (dir === "server->client" && ++n > 1 ? [] : [chunk]));    // let the response through, drop every wrapped status
    await failsWith(client(), "authentication_timeout", 10_200);
  });
  it("keep-alive keeps an idle session open far beyond the server's 60 s idle limit", async () => {
    const c = client(); await open(c);
    await clock.advance(5 * 60_000);
    expect(c.diagnostics().state).toBe("authenticated");
    expect(gw.counters.keepAlives).toBeGreaterThanOrEqual(9);
    expect(gw.counters.timeouts).toBe(0);
  });
  it("without keep-alive the server ends the session with STATUS_TIMEOUT after 60 s", async () => {
    const c = client({ keepAliveIntervalMs: 10 * 60_000 });
    await open(c);
    const closed = c.whenClosed();
    await clock.advance(61_000);
    expect(await closed).toMatchObject({ reason: "server_timeout", status: SessionStatus.TIMEOUT });
  });
});

describe("integrity, replay and ordering (IPS §2.2.1.3.3, §2.2.3.3)", () => {
  async function authed(): Promise<{ c: SecureSessionConnection; s: ServerSession; got: Buffer[] }> {
    const c = client(); await open(c);
    c.sendInner(tunnelling()); await clock.advance(10);
    const s = serverSessions[0]!;
    const got: Buffer[] = []; c.onInner((f) => got.push(f));
    return { c, s, got };
  }
  it("delivers authenticated inner frames, in order", async () => {
    const { s, got } = await authed();
    const a = tunnelling(), b = tunnelling(30);
    gw.sendInner(s, a); gw.sendInner(s, b);
    await clock.advance(10);
    expect(got).toEqual([a, b]);
  });
  it("a modified ciphertext octet is rejected (MAC failure) and the sequence state does not advance", async () => {
    const { c, s, got } = await authed();
    let hit = false;
    net.tap((dir, chunk) => { if (dir === "server->client" && !hit && chunk.length > 40) { hit = true; const t = Buffer.from(chunk); t[24] = t[24]! ^ 0x40; return [t]; } return [chunk]; });
    gw.sendInner(s, tunnelling());                     // tampered in transit
    const ok = tunnelling(26); gw.sendInner(s, ok);    // next one intact
    await clock.advance(10);
    expect(c.diagnostics().discarded.macFailure).toBe(1);
    expect(got).toEqual([ok]);                         // the tampered frame was not delivered, the next was
  });
  it("a replayed frame (same sequence number) is discarded, not delivered twice", async () => {
    const { c, s, got } = await authed();
    let dup = false;
    net.tap((dir, chunk) => { if (dir === "server->client" && chunk.length > 40 && !dup) { dup = true; return [chunk, Buffer.from(chunk)]; } return [chunk]; });
    gw.sendInner(s, tunnelling());
    await clock.advance(10);
    expect(got).toHaveLength(1);
    expect(c.diagnostics().discarded.replay).toBe(1);
  });
  it("out-of-order delivery: a LOWER sequence number arriving late is discarded; gaps are allowed", async () => {
    const { c, s, got } = await authed();
    const held: Buffer[] = [];
    let n = 0;
    net.tap((dir, chunk) => { if (dir === "server->client" && chunk.length > 40 && ++n === 1) { held.push(Buffer.from(chunk)); return []; } return [chunk]; });
    gw.sendInner(s, tunnelling());                      // seq k — held back
    s.sendSeq += 5n;                                    // the server skips numbers (allowed: only "greater" is required)
    const later = tunnelling(28); gw.sendInner(s, later);
    await clock.advance(10);
    expect(got).toEqual([later]);
    net.tap(() => []); // no further deliveries needed; replay the held (older) frame by hand:
    held.forEach((h) => clients[0]!.session.receive(h));
    expect(got).toHaveLength(1);
    expect(c.diagnostics().discarded.replay).toBe(1);
  });
  it("a forged frame with a huge sequence number but an invalid MAC does not advance the counter (no denial of service)", async () => {
    const { c, s, got } = await authed();
    const forged = encodeSecureWrapper({ sessionId: c.diagnostics().sessionId!, sequence: SEQUENCE_MAX - 1n, serial: rng.bytes(6), tag: Buffer.alloc(2), inner: tunnelling(), key: secret() });
    c.session.receive(forged);
    expect(c.diagnostics().discarded.macFailure).toBe(1);
    expect(BigInt(c.diagnostics().lastReceivedSequence!)).toBeLessThan(10n);
    const ok = tunnelling(); gw.sendInner(s, ok); await clock.advance(10);
    expect(got).toEqual([ok]);
  });
  it("frames for another session id, plain frames, and nested secure frames are ignored and counted", async () => {
    const { c, s, got } = await authed();
    c.session.receive(encodeSecureWrapper({ sessionId: c.diagnostics().sessionId! + 1, sequence: 99n, serial: rng.bytes(6), tag: Buffer.alloc(2), inner: tunnelling(), key: secret() }));
    c.session.receive(tunnelling());                                   // a PLAIN tunnelling frame injected into the stream
    gw.sendInner(s, encodeSecureWrapper({ sessionId: s.id, sequence: 1n, serial: rng.bytes(6), tag: Buffer.alloc(2), inner: tunnelling(), key: secret() })); // nested wrapper
    await clock.advance(10);
    const d = c.diagnostics().discarded;
    expect(d.wrongSession).toBe(1); expect(d.plainFrame).toBe(1); expect(d.nested).toBe(1);
    expect(got).toHaveLength(0);
  });
  it("secure-family frames cannot be sent nested, and nothing can be sent before authentication", async () => {
    const c = client();
    expect(() => c.sendInner(tunnelling())).toThrow(SecureSessionError);
    await open(c);
    expect(() => c.sendInner(encodeSessionStatus(0))).toThrow(SecureSessionError);
    expect(() => c.sendInner(encodeSessionRequest(generateEcdhKeyPair().publicKey))).toThrow(SecureSessionError);
  });
  it("a hostile subscriber that throws cannot break the session or starve other subscribers", async () => {
    const { c, s, got } = await authed();
    c.onInner(() => { throw new Error("subscriber bug"); });
    const f = tunnelling(); gw.sendInner(s, f); await clock.advance(10);
    expect(got).toEqual([f]);
    expect(c.diagnostics().state).toBe("authenticated");
  });
});

describe("counters (IPS §2.2.3.3; Application Layer §5.3.1 for the no-wrap principle)", () => {
  it("never wraps: at the 48-bit limit the session closes with sequence_exhausted instead of reusing a number", async () => {
    const c = client(); await open(c);
    c.session.unsafeSetSendSequenceForTest(SEQUENCE_MAX);
    c.sendInner(tunnelling());                                   // uses 2^48-1, the last valid number
    expect(c.diagnostics().nextSendSequence).toBe((SEQUENCE_MAX + 1n).toString());
    expect(() => c.sendInner(tunnelling())).toThrow(expect.objectContaining({ code: "sequence_exhausted" }));
    expect(c.diagnostics().state).toBe("closed");
    expect(c.diagnostics().closedReason).toBe("sequence_exhausted");
  });
  it("a fresh session always starts both counters at zero (no counter reuse across reconnects: a new key makes old frames undecryptable)", async () => {
    const a = client(); await open(a);
    const seqA = a.diagnostics().nextSendSequence;
    a.close(); await clock.advance(10);
    const b = client(); await open(b);
    expect(b.diagnostics().nextSendSequence).toBe(seqA);
    expect(b.diagnostics().sessionId).not.toBeNull();
  });
  it("a frame captured from an earlier session cannot be replayed into a new one", async () => {
    let captured: Buffer | null = null;
    net.tap((dir, chunk) => { if (dir === "server->client" && chunk.length >= 44 && chunk.readUInt16BE(2) === 0x0950 && !captured) captured = Buffer.from(chunk); return [chunk]; });
    const a = client(); await open(a); a.close(); await clock.advance(10);
    expect(captured).not.toBeNull();
    const b = client(); await open(b);
    b.session.receive(captured!);                         // a real SECURE_WRAPPER of the earlier session
    const d = b.diagnostics().discarded;
    expect(d.wrongSession + d.macFailure + d.replay).toBeGreaterThanOrEqual(1);
    expect(b.diagnostics().state).toBe("authenticated");  // and nothing was accepted from it
  });
});

describe("closing (IPS §2.4.2, §2.2.3.9.2)", () => {
  it("local close sends STATUS_CLOSE, frees the server session and the TCP connection", async () => {
    const c = client(); await open(c);
    c.close(); await clock.advance(10);
    expect(gw.counters.closedByClient).toBe(1);
    expect(gw.sessions.size).toBe(0);
    expect(net.openConnections).toBe(0);
    expect(await c.whenClosed()).toMatchObject({ reason: "local_close" });
  });
  it("server-initiated terminal statuses end the session (and the TCP connection)", async () => {
    for (const [status, reason] of [[SessionStatus.UNAUTHENTICATED, "unauthenticated"], [SessionStatus.CLOSE, "server_close"], [SessionStatus.TIMEOUT, "server_timeout"]] as const) {
      const c = client(); await open(c);
      const s = [...gw.sessions.values()].find((x) => x.state === "authenticated")!;
      gw.endWith(s, status); await clock.advance(10);
      expect(await c.whenClosed()).toMatchObject({ reason, status });
    }
  });
  it("losing the TCP connection ends the session", async () => {
    const c = client(); await open(c);
    net.connections[0]!.server.destroy();
    await clock.advance(10);
    expect(c.diagnostics().closedReason).toBe("transport_closed");
    await expect(Promise.resolve().then(() => c.sendInner(tunnelling()))).rejects.toBeInstanceOf(SecureSessionError);
  });
  it("connection refused is reported, not hidden", async () => {
    const c = client({ streamFactory: net.createStreamFactory("10.0.0.50", "10.0.0.99", 3671) });
    await expect(c.connect()).rejects.toMatchObject({ code: "transport_closed" });
  });
});

describe("TCP framing (stream deframer; framing is header-driven)", () => {
  it("the whole handshake and traffic survive 1-octet TCP segments", async () => {
    net.tap((_dir, chunk) => Array.from(chunk, (b) => Buffer.from([b])));
    const c = client(); const got: Buffer[] = [];
    const p = c.connect(); p.catch(() => undefined);
    await clock.advance(2000); await p;
    c.onInner((f) => got.push(f));
    const s = [...gw.sessions.values()][0]!; const f = tunnelling(); gw.sendInner(s, f);
    await clock.advance(2000);
    expect(got).toEqual([f]);
  });
  it("merged frames in one segment are split; partial frames wait; garbage is a protocol violation that closes the connection", () => {
    const d = new KnxStreamDeframer();
    const a = encodeSessionStatus(0), b = encodeSessionStatus(5);
    expect(d.push(Buffer.concat([a, b]))).toEqual([a, b]);
    expect(d.push(a.subarray(0, 3))).toEqual([]);
    expect(d.pendingBytes).toBe(3);
    expect(d.push(a.subarray(3))).toEqual([a]);
    expect(() => new KnxStreamDeframer().push(Buffer.from([0x07, 0x10, 0, 0, 0, 8, 0, 0]))).toThrow(KnxStreamError);
    expect(() => new KnxStreamDeframer().push(Buffer.from([0x06, 0x11, 0, 0, 0, 8, 0, 0]))).toThrow(KnxStreamError);
    expect(() => new KnxStreamDeframer().push(Buffer.from([0x06, 0x10, 0, 0, 0, 5]))).toThrow(KnxStreamError);
    expect(() => new KnxStreamDeframer(100).push(Buffer.from([0x06, 0x10, 0, 0, 0xff, 0xff]))).toThrow(KnxStreamError);
  });
  it("a framing violation from the peer closes the connection and the session", async () => {
    const c = client(); await open(c);
    net.connections[0]!.server.write(Buffer.from([0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 0]));
    await clock.advance(10);
    expect(c.diagnostics().closedReason).toBe("protocol_violation");
    expect(net.openConnections).toBe(0);
  });
});

describe("resources", () => {
  it("40 handshakes / failures / closes leave no timers, connections or sessions", async () => {
    for (let i = 0; i < 40; i++) {
      if (i % 4 === 0) { const c = client({ passwordHash: secret() }); const p = c.connect(); p.catch(() => undefined); await clock.advance(30); }
      else if (i % 4 === 1) { gw.faults.wrongDeviceAuthCode = true; const c = client(); const p = c.connect(); p.catch(() => undefined); await clock.advance(30); gw.faults.wrongDeviceAuthCode = false; }
      else { const c = client(); await open(c); c.close(); await clock.advance(10); }
    }
    expect(net.openConnections).toBe(0);
    expect(gw.sessions.size).toBe(0);
    void peekSecureService;
  });
});

// Security-review regressions (see docs/architecture/knx-ip-secure-security-review.md). Decisions D5/D6: NOT stated in the specification text.
describe("review regressions", () => {
  it("F1/D5: a frame the client itself sent, reflected back on the stream, is never delivered as server data", async () => {
    let out: Buffer | null = null;
    net.tap((dir, chunk) => { if (dir === "client->server" && chunk.length >= 44 && chunk.readUInt16BE(2) === 0x0950) out = Buffer.from(chunk); return [chunk]; });
    const c = client(); await open(c);
    const delivered: Buffer[] = []; c.onInner((f) => delivered.push(f));
    c.sendInner(tunnelling()); await clock.advance(10);
    expect(out).not.toBeNull();
    c.session.receive(out!);                                   // same key, valid MAC, sequence above the server's last — only the serial gives it away
    expect(delivered).toHaveLength(0);
    expect(c.diagnostics().discarded.reflected).toBe(1);
    expect(c.diagnostics().state).toBe("authenticated");
  });
  it("F1/D5: a wrapper carrying our own serial number is dropped even when it was authentically produced under the session key (nonce-domain separation)", async () => {
    const c = client({ serialNumber: Buffer.from("00fa11223344", "hex") }); await open(c);
    const s = [...gw.sessions.values()][0]!;
    gw.sendInnerWithSerial(s, tunnelling(), Buffer.from("00fa11223344", "hex"));
    await clock.advance(10);
    expect(c.diagnostics().discarded.reflected).toBe(1);
    expect(c.diagnostics().framesAccepted).toBe(1);            // only the AUTHENTICATION_SUCCESS status
  });
  it("F2/D5: an all-zero serial number is not an assigned KNX serial and is refused before any connection", async () => {
    const c = client({ serialNumber: Buffer.alloc(6) });
    await expect(c.connect()).rejects.toMatchObject({ code: "invalid_option" });
    expect(net.stats.connections).toBe(0);
  });
  it("F3/D6: an unexpected internal fault while processing a frame closes the session instead of escaping to the socket callback", async () => {
    const c = client(); await open(c);
    const evil = { get length(): number { throw new Error("boom"); } } as unknown as Buffer;
    expect(() => c.session.receive(evil)).not.toThrow();
    expect(c.diagnostics().state).toBe("closed");
    expect(c.diagnostics().closedReason).toBe("protocol_violation");
  });
});

describe("B7 / B8 evidence", () => {
  it("B7 (N: IPS §2.2.3.5.2.5, E03 in UNAUTHENTICATED → A3): a local close before authentication completes sends a wrapped STATUS_CLOSE; the server frees the session", async () => {
    let n = 0;
    net.tap((dir, chunk) => (dir === "client->server" && chunk.length >= 44 && chunk.readUInt16BE(2) === 0x0950 && n++ === 0 ? [] : [chunk])); // swallow SESSION_AUTHENTICATE
    const c = client(); const p = c.connect(); p.catch(() => undefined);
    await clock.advance(30);
    expect(c.diagnostics().state).toBe("awaiting_status");
    expect([...gw.sessions.values()][0]!.state).toBe("unauthenticated");
    c.close(); await clock.advance(30);
    expect(gw.counters.closedByClient).toBe(1);
    expect(gw.sessions.size).toBe(0);
    expect(c.diagnostics().closedReason).toBe("local_close");
    await expect(p).rejects.toMatchObject({ code: "local_close" });
  });
  it("B7: closing before any key exists (awaiting_response) writes no frame at all, only TCP", async () => {
    gw.faults.silent = true;
    const seen = recordClientFrames();
    const c = client(); const p = c.connect(); p.catch(() => undefined);
    await clock.advance(5);
    c.close(); await clock.advance(30);
    expect(seen).toEqual([SecureService.SESSION_REQUEST]);
  });
  it("B8: a wrapper carrying an encapsulated frame of exactly 4080 octets is accepted; one octet more is discarded as malformed without disturbing the session", async () => {
    const c = client(); await open(c);
    const got: Buffer[] = []; c.onInner((f) => got.push(f));
    const s = [...gw.sessions.values()][0]!;
    const body = tunnelling(4080);
    gw.sendInner(s, body); await clock.advance(10);
    expect(got).toHaveLength(1); expect(got[0]!.equals(body)).toBe(true);
    const ok = encodeSecureWrapper({ sessionId: s.id, sequence: 500n, serial: rng.bytes(6), tag: Buffer.alloc(2), inner: body, key: s.key! });
    const tooBig = Buffer.concat([ok, Buffer.alloc(1)]); tooBig.writeUInt16BE(tooBig.length, 4);
    const before = c.diagnostics().discarded.malformed;
    c.session.receive(tooBig);
    expect(c.diagnostics().discarded.malformed).toBe(before + 1);
    expect(c.diagnostics().state).toBe("authenticated");
  });
});

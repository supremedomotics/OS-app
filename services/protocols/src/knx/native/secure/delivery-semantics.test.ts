import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseGroupAddress } from "../address.js";
import { encodeDpt } from "../dpt.js";
import { Secret } from "../security/secret.js";
import { ManualClock, VirtualSecureGateway, VirtualStreamNetwork, VirtualStreamTunnelServer, type ServerSession } from "../simulator/index.js";
import { makeRng } from "../test-support.js";
import { KnxTunnelClient } from "../tunnel-client.js";
import { generateEcdhKeyPair } from "./ip-keys.js";
import { SecureSessionClient } from "./ip-session.js";
import { SecureStreamTunnelLink } from "./secure-stream-link.js";

/**
 * Evidence levels (docs/architecture/knx-secure-retry-policy-design.md §2): session acceptance < gateway/interface confirmation < device state feedback.
 * These tests pin that nothing in SendReceipt or sessionDiagnostics() claims more than the layer actually knows. The simulated server has NO actuator, so
 * any "executed" claim derived from these signals would be false by construction.
 */
const rng = makeRng(0xde11);
const GW = "10.0.0.2";
const ON = { destination: parseGroupAddress("1/1/1"), service: "write" as const, data: encodeDpt("1.001", true) };
let clock: ManualClock; let net: VirtualStreamNetwork; let gw: VirtualSecureGateway; let srv: VirtualStreamTunnelServer; let dac: Secret; let hash: Secret; let tunnels: KnxTunnelClient[];

function boot(serverOpts = {}): void {
  srv = new VirtualStreamTunnelServer(serverOpts);
  gw = new VirtualSecureGateway(net, clock, { address: GW, deviceAuthCode: dac, users: new Map([[1, hash]]), serialNumber: rng.bytes(6), onInner: (s: ServerSession, f: Buffer) => srv.onInner(s, f) });
  srv.bind(gw);
}
beforeEach(() => { clock = new ManualClock(); net = new VirtualStreamNetwork(clock, 1); dac = new Secret(rng.bytes(16)); hash = new Secret(rng.bytes(16)); tunnels = []; boot(); });
afterEach(async () => { for (const t of tunnels) void t.disconnect(); await clock.advance(5_000); gw.shutdown(); await clock.advance(200_000); expect(clock.pendingTimers).toBe(0); expect(net.openConnections).toBe(0); });

async function up() {
  const link = new SecureStreamTunnelLink({ streamFactory: net.createStreamFactory("10.0.0.50", GW, 3671), clock, userId: 1, passwordHash: hash, deviceAuthCode: dac, serialNumber: rng.bytes(6) });
  const t = new KnxTunnelClient({ host: GW, link, clock }); tunnels.push(t);
  const p = t.connect(); p.catch(() => undefined); await clock.advance(60); await p;
  return { t, link };
}

describe("session acceptance is not execution", () => {
  it("a stream receipt carries exactly the session-level facts: no ACK time, no 'delivered'/'executed' claim", async () => {
    const { t } = await up();
    const r = await (async () => { const p = t.sendGroup(ON); await clock.advance(5); return p; })();
    expect(Object.keys(r).sort()).toEqual(["ackLatencyMs", "ackedAt", "attempts", "confirmation", "sequence", "transportAck"]);
    expect(r.transportAck).toBe("none"); expect(r.ackedAt).toBeNull(); expect(r.ackLatencyMs).toBeNull();
  });
  it("the receipt resolves even when the far end never processes the command (here: the server confirms nothing and no device exists)", async () => {
    gw.shutdown(); boot({ confirm: false });
    const { t } = await up();
    const r = await t.sendGroup(ON);                                       // resolved ⇒ "accepted by the session", nothing more
    await clock.advance(5_000);
    await expect(r.confirmation).resolves.toBe("not_confirmed");
  });
  it("'confirmed' is an interface-level L_Data.con; the simulated server has no device, so it cannot mean the device acted", async () => {
    const { t } = await up();
    const r = await (async () => { const p = t.sendGroup(ON); await clock.advance(5); return p; })();
    await expect(r.confirmation).resolves.toBe("confirmed");
    // there is no actuator anywhere in this setup: the only effect is the server's record of the request
    expect(srv.received.tunnellingRequests).toHaveLength(1);
  });
  it("sessionDiagnostics() counters move without any command and count protocol frames, so they are never delivery or execution evidence", async () => {
    const { t, link } = await up();
    const afterConnect = link.sessionDiagnostics()!;
    expect(afterConnect.framesSent).toBeGreaterThanOrEqual(2);              // SESSION_REQUEST/AUTHENTICATE/CONNECT_REQUEST with zero commands sent
    expect(srv.received.tunnellingRequests).toHaveLength(0);
    await clock.advance(31_000);                                            // a keep-alive is written with still no command
    expect(link.sessionDiagnostics()!.framesSent).toBeGreaterThan(afterConnect.framesSent);
    expect(srv.received.tunnellingRequests).toHaveLength(0);
    const before = link.sessionDiagnostics()!.framesSent;
    await t.sendGroup(ON);
    expect(link.sessionDiagnostics()!.framesSent).toBe(before + 1);
  });
  it("after the session ends, the final diagnostics say nothing about the fate of the last command", async () => {
    const { t, link } = await up();
    const r = await t.sendGroup(ON);
    await t.disconnect(); await clock.advance(20);
    const d = link.sessionDiagnostics()!;
    expect(d.state).toBe("closed");
    expect(Object.keys(d)).not.toContain("delivered"); expect(Object.keys(d)).not.toContain("executed");
    await expect(r.confirmation).resolves.toMatch(/^(confirmed|not_confirmed)$/);
  });
});

describe("an unknown outcome can resolve later without the receipt ever changing", () => {
  it("not_confirmed at the timeout, a late L_Data.con afterwards: the receipt stays not_confirmed, the late evidence is counted, and nothing is retried", async () => {
    gw.shutdown(); boot({ confirm: false });
    const { t } = await up();
    const sessions: ServerSession[] = [...gw.sessions.values()];
    const r = await t.sendGroup(ON);
    await clock.advance(4_000);                                            // confirmation window (3 s) is over
    await expect(r.confirmation).resolves.toBe("not_confirmed");
    srv.telegram(sessions[0]!, 0x2e, 0xff01, ON.destination, "write", ON.data);   // L_Data.con arrives late
    await clock.advance(20);
    await expect(r.confirmation).resolves.toBe("not_confirmed");           // promises settle once; the policy must consult diagnostics/feedback
    expect(t.diagnostics().unmatchedConfirmations).toBe(1);
    expect(srv.received.tunnellingRequests).toHaveLength(1);
    expect(t.diagnostics().sendRetries).toBe(0);
  });
});

describe("key-pair reuse guard: documented window", () => {
  const mk = (gen: () => ReturnType<typeof generateEcdhKeyPair>) => new SecureSessionClient({
    send: () => undefined, clock, userId: 1, passwordHash: hash, deviceAuthCode: dac, serialNumber: rng.bytes(6), unsafeGenerateKeyPairForTest: gen,
  });
  const copy = (kp: ReturnType<typeof generateEcdhKeyPair>) => () => ({ publicKey: kp.publicKey, privateKey: new Secret(kp.privateKey.use((b) => Buffer.from(b))) });
  it("refuses a repeat inside the window", () => {
    const kp = generateEcdhKeyPair(); const g = copy(kp);
    const a = mk(g); a.start(); a.close();
    expect(() => mk(g).start()).toThrow(/key pair reuse refused/);
  });
  it("a refused configuration does not consume the pair (the claim happens only when a session really starts)", () => {
    const kp = generateEcdhKeyPair(); const g = copy(kp);
    const bad = new SecureSessionClient({ send: () => undefined, clock, userId: 0, passwordHash: hash, deviceAuthCode: dac, serialNumber: rng.bytes(6), unsafeGenerateKeyPairForTest: g });
    expect(() => bad.start()).toThrow(/userId/);
    const ok = mk(g); expect(() => ok.start()).not.toThrow(); ok.close();
  });
  it("KNOWN LIMITATION: a repeat older than the 1024-session window is not detected — the guard is a tripwire, not a replacement for the platform CSPRNG", () => {
    const kp = generateEcdhKeyPair(); const g = copy(kp);
    const first = mk(g); first.start(); first.close();
    for (let i = 0; i < 1100; i++) { const c = mk(() => generateEcdhKeyPair()); c.start(); c.close(); }
    const again = mk(g);
    expect(() => again.start()).not.toThrow();
    again.close();
  });
});

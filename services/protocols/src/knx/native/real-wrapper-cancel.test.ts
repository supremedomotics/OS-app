import dgram from "node:dgram";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { KnxProtocolDriver, wrapKnxUltimate, type KnxConnection, type KnxUltimateClient, type KnxUltimateDptLib } from "../../knx-driver.js";
import {
  decodeConnectionStateRequest, decodeFrame, encodeConnectResponse, encodeConnectionStateResponse, encodeDisconnectResponse, ServiceType, StatusCode,
} from "./knxnetip-frame.js";

/**
 * REAL `knxultimate` 6.0.1 client + real wrapper (`wrapKnxUltimate`) over REAL loopback UDP sockets against a minimal in-process fake gateway
 * (this file). It exercises the installed library's actual connect/Disconnect code — but it is NOT a real gateway: the fake only answers
 * CONNECT / CONNECTIONSTATE / DISCONNECT, and timing uses real timers (the library waits ~1 s before its first CONNECT_REQUEST). It says nothing
 * about real KNX/IP interfaces. Findings from this file are recorded in docs/knx/knx-native-parity-evidence.md §6.
 */
type Lib = { KNXClient: new (o: unknown) => KnxUltimateClient & { listenerCount(e: string): number }; dptlib: KnxUltimateDptLib };
let lib: Lib | null = null;
try { lib = createRequire(import.meta.url)("knxultimate") as Lib; } catch { lib = null; }

interface FakeGateway { port: number; seen: number[]; mode: "silent" | "answer"; answerDelayMs: number; close(): Promise<void> }
const gateways: FakeGateway[] = [];
async function gateway(mode: "silent" | "answer", answerDelayMs = 0): Promise<FakeGateway> {
  const sock = dgram.createSocket("udp4");
  const g: FakeGateway = { port: 0, seen: [], mode, answerDelayMs, close: () => new Promise<void>((r) => { try { sock.close(() => r()); } catch { r(); } }) };
  sock.on("message", (m, rinfo) => {
    let f; try { f = decodeFrame(m); } catch { return; }
    g.seen.push(f.service);
    const reply = (b: Buffer): void => { const send = (): void => { try { sock.send(b, rinfo.port, rinfo.address); } catch { /* closed */ } }; if (g.answerDelayMs > 0) setTimeout(send, g.answerDelayMs); else send(); };
    if (g.mode === "silent") return;
    if (f.service === ServiceType.CONNECT_REQUEST) reply(encodeConnectResponse({ channelId: 1, status: StatusCode.NO_ERROR, dataEndpoint: { protocol: 1, address: "127.0.0.1", port: g.port }, assignedAddress: 0xff01 }));
    else if (f.service === ServiceType.CONNECTIONSTATE_REQUEST) reply(encodeConnectionStateResponse({ channelId: decodeConnectionStateRequest(f.body).channelId, status: StatusCode.NO_ERROR }));
    else if (f.service === ServiceType.DISCONNECT_REQUEST) reply(encodeDisconnectResponse({ channelId: 1, status: StatusCode.NO_ERROR }));
  });
  await new Promise<void>((r) => sock.bind(0, "127.0.0.1", r));
  g.port = (sock.address() as { port: number }).port;
  gateways.push(g);
  return g;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms: number): Promise<boolean> => { for (let t = 0; t < ms && !cond(); t += 20) await sleep(20); return cond(); };
const resources = (): { udp: number; timers: number } => { const r = process.getActiveResourcesInfo(); return { udp: r.filter((x) => x === "UDPWrap").length, timers: r.filter((x) => x === "Timeout").length }; };

afterEach(async () => { for (const g of gateways.splice(0)) await g.close(); });

describe.skipIf(lib === null)("REAL knxultimate wrapper: disconnect while connect() is in flight (loopback fake gateway; NOT hardware)", () => {
  const realConn = (port: number): { conn: KnxConnection; client: KnxUltimateClient & { listenerCount(e: string): number } } => {
    const client = new lib!.KNXClient({ hostProtocol: "TunnelUDP", ipAddr: "127.0.0.1", ipPort: port });
    return { conn: wrapKnxUltimate(client, lib!.dptlib), client };
  };

  it("FINDING: the wrapper's own connect() NEVER settles after Disconnect() mid-connect (waits for an event the library does not emit) — the driver must not depend on it", async () => {
    const g = await gateway("silent");
    const base = resources();
    const { conn, client } = realConn(g.port);
    const listenersBefore = client.listenerCount("connected") + client.listenerCount("error");
    let state = "pending";
    void conn.connect().then(() => { state = "resolved"; }, () => { state = "rejected"; });
    expect(await until(() => g.seen.includes(ServiceType.CONNECT_REQUEST), 4_000)).toBe(true);   // really in flight: the request reached the gateway
    await conn.disconnect();
    await sleep(1_500);
    expect(state).toBe("pending");                                                 // wedged, exactly as read in the wrapper source
    expect(client.listenerCount("connected") + client.listenerCount("error") - listenersBefore).toBe(2); // the wrapper's two listeners stay on the abandoned client; library-level residue on the abandoned client object (not a socket or timer)
    const now = resources();
    expect(now.udp).toBeLessThanOrEqual(base.udp);                                  // sockets released by Disconnect()
    expect(now.timers).toBeLessThanOrEqual(base.timers);                            // timers released
  }, 20_000);

  it("through KnxProtocolDriver: the waiting caller is released within a bound, nothing is kept, no socket/timer leaks, and a later connect() succeeds", async () => {
    const silent = await gateway("silent");
    const good = await gateway("answer");
    const base = resources();
    const made: Array<ReturnType<typeof realConn>> = [];
    let n = 0;
    const driver = new KnxProtocolDriver({ host: "127.0.0.1", createConnection: async () => { const c = realConn(n++ === 0 ? silent.port : good.port); made.push(c); return c.conn; } });
    const first = driver.connect().then(() => "connected", (e: Error) => e.message);
    expect(await until(() => silent.seen.includes(ServiceType.CONNECT_REQUEST), 4_000)).toBe(true);
    const t0 = Date.now();
    await driver.disconnect();
    expect(await first).toBe("knx: disconnected during connect");
    expect(Date.now() - t0).toBeLessThan(500);                                      // bounded: released by the driver, not by the library
    expect(driver.isConnected()).toBe(false);
    expect(driver.connectionState()).toBe("disconnected");
    await sleep(500);
    const afterCancel = resources();
    expect(afterCancel.udp).toBeLessThanOrEqual(base.udp);
    expect(afterCancel.timers).toBeLessThanOrEqual(base.timers);
    // a subsequent attempt (fresh client, responsive gateway) works and the driver then reports it
    const second = driver.connect().then(() => "connected", (e: Error) => e.message);
    expect(await second).toBe("connected");
    expect(driver.isConnected()).toBe(true);
    await driver.disconnect();
    await sleep(500);
    expect(resources().udp).toBeLessThanOrEqual(base.udp);
  }, 30_000);

  it("a LATE connection result cannot activate a disconnected driver: the gateway answers after the cancellation; the driver stays disconnected", async () => {
    const slow = await gateway("answer", 1_500);
    const base = resources();
    const driver = new KnxProtocolDriver({ host: "127.0.0.1", createConnection: async () => realConn(slow.port).conn });
    const first = driver.connect().then(() => "connected", (e: Error) => e.message);
    expect(await until(() => slow.seen.includes(ServiceType.CONNECT_REQUEST), 4_000)).toBe(true);
    await driver.disconnect();
    expect(await first).toBe("knx: disconnected during connect");
    await sleep(2_500);                                                            // the delayed CONNECT_RESPONSE has now been sent to a closed socket
    expect(driver.isConnected()).toBe(false);
    expect(driver.connectionState()).toBe("disconnected");
    expect(resources().udp).toBeLessThanOrEqual(base.udp);
    expect(resources().timers).toBeLessThanOrEqual(base.timers);
    // What this cannot show: the fake gateway had already allocated a channel when it saw the CONNECT_REQUEST. The library never learned its
    // channel id, so no DISCONNECT_REQUEST was sent — on a real one-slot gateway that channel would live until the interface's idle timeout (H-2).
    expect(slow.seen).not.toContain(ServiceType.DISCONNECT_REQUEST);
  }, 30_000);
});

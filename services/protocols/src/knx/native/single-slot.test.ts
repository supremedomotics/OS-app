import { afterEach, describe, expect, it } from "vitest";
import { KnxProtocolDriver } from "../../knx-driver.js";
import { ServiceType } from "./knxnetip-frame.js";
import { createWorld, type World } from "./simulator/test-world.js";
import { createSingleSlotConnectionFactory } from "./single-slot.js";

/** SIMULATOR ONLY: two KnxProtocolDriver instances for one gateway — the replacement scenario of the engine's unregister + register. */
let w: World;
afterEach(async () => { for (const c of w.connections) { const p = c.disconnect(); await w.clock.advance(100); await p.catch(() => undefined); } await w.clock.advance(300_000); w.iface.shutdown(); expect(w.leaks()).toEqual({ timers: 0, sockets: 0, channels: 0 }); });
const slow = (): void => { w.net.addRule({ match: (p) => p.service === ServiceType.CONNECT_RESPONSE, action: "delay", delayMs: 1_500, times: 1 }); };

describe("single-slot factory", () => {
  it("the driver now cancels its own in-flight connect: WITHOUT the factory the old caller is rejected and only one tunnel is left (it was two before the driver fix)", async () => {
    w = createWorld();
    const plain = (): Promise<never> => Promise.resolve(w.connection() as never);
    const a = new KnxProtocolDriver({ host: "10.0.0.2", createConnection: plain });
    const b = new KnxProtocolDriver({ host: "10.0.0.2", createConnection: plain });
    slow();
    const pa = a.connect().then(() => "connected", () => "cancelled"); await w.clock.advance(50);
    await a.disconnect();                                   // the engine's unregisterProtocol: previously a no-op because the driver had no connection object yet
    const pb = b.connect();
    expect(await w.until(Promise.all([pa, pb]), 3_000)).toEqual(["cancelled", undefined]);
    await w.clock.advance(3_000);
    expect(w.iface.activeChannels).toBe(1);
    expect(a.isConnected()).toBe(false);
    expect(b.isConnected()).toBe(true);
  });

  it("WITH it, creating the replacement cancels the predecessor: exactly one tunnel is ever left", async () => {
    w = createWorld();
    const factory = createSingleSlotConnectionFactory(() => w.connection());
    const a = new KnxProtocolDriver({ host: "10.0.0.2", createConnection: factory });
    const b = new KnxProtocolDriver({ host: "10.0.0.2", createConnection: factory });
    slow();
    const pa = a.connect().then(() => "connected", () => "cancelled");
    await w.clock.advance(50);
    await a.disconnect();
    const pb = b.connect();
    expect(await w.until(Promise.all([pa, pb]), 3_000)).toEqual(["cancelled", undefined]);
    await w.clock.advance(3_000);
    expect(w.iface.activeChannels).toBe(1);
    expect(a.isConnected()).toBe(false);
    expect(b.isConnected()).toBe(true);
  });

  it("a live predecessor is closed when its successor is created", async () => {
    w = createWorld();
    const factory = createSingleSlotConnectionFactory(() => w.connection());
    const a = new KnxProtocolDriver({ host: "10.0.0.2", createConnection: factory });
    await w.until(a.connect());
    expect(w.iface.activeChannels).toBe(1);
    const b = new KnxProtocolDriver({ host: "10.0.0.2", createConnection: factory });
    await w.until(b.connect());
    await w.clock.advance(100);
    expect(w.iface.activeChannels).toBe(1);
  });
});

/**
 * SIMULATOR ONLY. The replacement race on a gateway with EXACTLY ONE tunnel slot (`maxTunnels: 1`; the default world has four, which hides it).
 * The predecessor's CONNECT_REQUEST has been answered by the gateway (slot allocated) but the client has not yet received the response, so it
 * does not know its channel id and cannot close the channel. Cancelling the predecessor returns to its caller at once; the replacement must not
 * race that unfinished handshake. Hardware item H-2 (real gateways) is NOT covered by these results.
 */
describe("one tunnel slot (maxTunnels = 1): replacement races the predecessor's unfinished handshake", () => {
  const NO_MORE = 0x24;
  const oneSlot = (): void => { w = createWorld({ interface: { maxTunnels: 1 } }); };
  const outcome = <T>(p: Promise<T>): Promise<"connected" | string> => p.then(() => "connected", (e: { code?: string; message?: string }) => e.code ?? e.message ?? "rejected");
  const drivers = (settleTimeoutMs?: number) => {
    const factory = createSingleSlotConnectionFactory(() => w.connection(), settleTimeoutMs === undefined ? undefined : { settleTimeoutMs });
    return [new KnxProtocolDriver({ host: "10.0.0.2", createConnection: factory }), new KnxProtocolDriver({ host: "10.0.0.2", createConnection: factory })] as const;
  };
  /** Advances 1 ms at a time, recording the gateway slot count and open client sockets after every step. */
  const probe = () => {
    const seen = { peakChannels: 0, peakSockets: 0, elapsed: 0 };
    const step = async (ms: number): Promise<void> => {
      for (let i = 0; i < ms; i++) {
        await w.clock.advance(1); seen.elapsed++;
        seen.peakChannels = Math.max(seen.peakChannels, w.iface.activeChannels);
        seen.peakSockets = Math.max(seen.peakSockets, w.net.openClientSockets);
      }
    };
    return { seen, step };
  };
  const at = <T>(p: Promise<T>, seen: { elapsed: number }): { when: number | null; result: Promise<"connected" | string> } => {
    const r = { when: null as number | null, result: outcome(p) };
    void r.result.then(() => { r.when = seen.elapsed; });
    return r;
  };

  it("late CONNECT_RESPONSE: the predecessor's caller is released promptly, the replacement waits for the slot and then connects (no refusal, no orphan)", async () => {
    oneSlot();
    const [a, b] = drivers();
    w.net.addRule({ match: (p) => p.service === ServiceType.CONNECT_RESPONSE, action: "delay", delayMs: 1_500, times: 1 });
    const { seen, step } = probe();
    const pa = at(a.connect(), seen);
    await step(50);
    expect(w.iface.activeChannels).toBe(1);                       // slot allocated, client has no response yet
    expect(w.tunnels[0]!.state).toBe("connecting");
    const pb = at(b.connect(), seen);                             // replacement: the factory cancels the predecessor
    await step(20);
    expect(pa.when).not.toBeNull();                               // cancellation returned to the old caller long before the response (t=1 500)
    expect(pa.when!).toBeLessThan(100);
    expect(await pa.result).toBe("closed");
    expect(pb.when).toBeNull();                                   // the replacement has NOT raced ahead of the predecessor's cleanup
    expect(w.iface.counters.refusedConnects).toBe(0);
    await step(3_000);
    expect(await pb.result).toBe("connected");
    expect(pb.when!).toBeGreaterThanOrEqual(1_500);
    expect(seen.peakChannels).toBe(1);                            // never two channels on a one-slot gateway
    expect(seen.peakSockets).toBeLessThanOrEqual(2);              // predecessor's socket only until its orderly DISCONNECT completed
    expect(w.iface.counters.refusedConnects).toBe(0);
    expect(w.iface.counters.connects).toBe(2);
    expect(w.iface.counters.disconnects).toBe(1);                 // the predecessor's channel was closed orderly, not left to the idle timeout
    expect(w.iface.counters.idleDrops).toBe(0);
    expect(w.iface.activeChannels).toBe(1);
    expect(w.net.openClientSockets).toBe(1);
    expect([w.tunnels[0]!.state, w.tunnels[1]!.state]).toEqual(["closed", "connected"]);
    expect(a.isConnected()).toBe(false);
    expect(b.isConnected()).toBe(true);
  });

  it("refused predecessor (delayed refusal): no slot was taken; the replacement still ends up as the only tunnel", async () => {
    oneSlot();
    const [a, b] = drivers();
    w.net.addRule({ match: (p) => p.service === ServiceType.CONNECT_RESPONSE, action: "delay", delayMs: 1_500, times: 1 });
    w.iface.faults.refuseConnectStatus = NO_MORE;
    const { seen, step } = probe();
    const pa = at(a.connect(), seen);
    await step(50);
    w.iface.faults.refuseConnectStatus = null;                    // the gateway has recovered by the time the replacement connects
    expect(w.iface.activeChannels).toBe(0);
    const pb = at(b.connect(), seen);
    await step(3_000);
    expect(await pa.result).toBe("closed");
    expect(await pb.result).toBe("connected");
    expect(seen.peakChannels).toBe(1);
    expect(w.iface.counters.refusedConnects).toBe(1);             // only the predecessor's
    expect(w.iface.activeChannels).toBe(1);
    expect(b.isConnected()).toBe(true);
  });

  it("lost CONNECT_RESPONSE (timeout): the gateway slot is orphaned and cannot be closed by anyone; the replacement fails retryably, then connects once the gateway drops it", async () => {
    oneSlot();
    const [a, b] = drivers();
    w.net.addRule({ match: (p) => p.service === ServiceType.CONNECT_RESPONSE, action: "drop", times: 1 });
    const { seen, step } = probe();
    const pa = at(a.connect(), seen);
    await step(50);
    expect(w.iface.activeChannels).toBe(1);
    const pb = at(b.connect(), seen);
    await step(6_000);                                            // predecessor's connect timeout (5 s in the test world) bounds the wait
    expect(await pa.result).toBe("closed");
    expect(await pb.result).toBe("connect_rejected");             // the protocol offers no way to close a channel whose id was never received
    expect(b.isConnected()).toBe(false);
    expect(w.iface.activeChannels).toBe(1);                       // the orphan, owned by nobody on the client side
    expect(w.net.openClientSockets).toBe(0);                      // but no client socket and no client timer is left behind
    // The caller's own retry (the gateway's 60 s reconcile in production) is refused again while the orphan lives, and accepted after the
    // gateway's 120 s idle timeout dropped it. (Long idle stretches are advanced in one jump: nothing else happens in them.)
    await w.clock.advance(30_000);
    const early = outcome(b.connect());
    await step(3_000);
    expect(await early).toBe("connect_rejected");
    await w.clock.advance(100_000);
    const retry = outcome(b.connect());
    await step(3_000);
    expect(await retry).toBe("connected");
    expect(w.iface.counters.idleDrops).toBe(1);                   // the orphan expired by itself
    expect(seen.peakChannels).toBe(1);
    expect(w.iface.activeChannels).toBe(1);
    expect(b.isConnected()).toBe(true);
  });

  it("settlement is BOUNDED: a response later than settleTimeoutMs does not hold the replacement; the late tunnel is still closed orderly", async () => {
    oneSlot();
    const [a, b] = drivers(500);
    w.net.addRule({ match: (p) => p.service === ServiceType.CONNECT_RESPONSE, action: "delay", delayMs: 3_000, times: 1 });
    const { seen, step } = probe();
    const pa = at(a.connect(), seen);
    await step(50);
    const pb = at(b.connect(), seen);
    await step(700);
    expect(await pa.result).toBe("closed");
    expect(pb.when).not.toBeNull();                               // the replacement was released at the bound (≈ 550 ms), not at 3 000 ms
    expect(pb.when!).toBeLessThan(1_000);
    expect(await pb.result).toBe("connect_rejected");             // slot still held by the predecessor's unfinished handshake: retryable
    await step(3_000);                                            // the late response arrives; the predecessor discards its tunnel with DISCONNECT
    expect(w.iface.activeChannels).toBe(0);
    expect(w.iface.counters.disconnects).toBe(1);
    const retry = outcome(b.connect());
    await step(3_000);
    expect(await retry).toBe("connected");
    expect(seen.peakChannels).toBe(1);
    expect(w.iface.counters.idleDrops).toBe(0);
  });

  it("shutdown while the replacement waits for the predecessor: nothing is left behind and the driver stays disconnected", async () => {
    oneSlot();
    const [a, b] = drivers();
    w.net.addRule({ match: (p) => p.service === ServiceType.CONNECT_RESPONSE, action: "delay", delayMs: 1_500, times: 1 });
    const { seen, step } = probe();
    const pa = at(a.connect(), seen);
    await step(50);
    const pb = at(b.connect(), seen);
    await step(100);
    await b.disconnect();                                         // the engine unregisters the replacement before it ever connected
    await a.disconnect();
    await step(8_000);
    expect(await pa.result).toBe("closed");
    expect(await pb.result).not.toBe("connected");
    expect(b.isConnected()).toBe(false);
    expect(a.isConnected()).toBe(false);
    expect(w.iface.activeChannels).toBe(0);
    expect(w.net.openClientSockets).toBe(0);
    expect(seen.peakChannels).toBe(1);
    expect(w.iface.counters.idleDrops).toBe(0);
  });
});

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
  it("WITHOUT it, a replaced driver whose connect was still in flight leaves a second tunnel on the gateway (the hazard)", async () => {
    w = createWorld();
    const plain = (): Promise<never> => Promise.resolve(w.connection() as never);
    const a = new KnxProtocolDriver({ host: "10.0.0.2", createConnection: plain });
    const b = new KnxProtocolDriver({ host: "10.0.0.2", createConnection: plain });
    slow();
    const pa = a.connect(); await w.clock.advance(50);
    await a.disconnect();                                   // the engine's unregisterProtocol: a no-op, the driver has no connection object yet
    const pb = b.connect();
    await w.until(Promise.all([pa, pb]), 3_000);
    expect(w.iface.activeChannels).toBe(2);
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

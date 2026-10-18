import { afterEach, describe, expect, it } from "vitest";
import { ServiceType } from "../native/knxnetip-frame.js";
import { createWorld, GW, type World } from "../native/simulator/test-world.js";
import { KnxHealthService } from "./health-service.js";

/** SIMULATOR ONLY: cancellation of KnxHealthService while a connection attempt is in flight (reconnect-ownership rule 5). */
let w: World;
let svc: KnxHealthService;
const make = (): KnxHealthService => new KnxHealthService({ clock: w.clock, gateway: { host: GW }, createTunnel: w.createTunnel, reconnect: { minBackoffMs: 2_000, maxBackoffMs: 20_000, random: () => 0.5 } });
afterEach(async () => { await svc.stop(); await w.clock.advance(600_000); w.iface.shutdown(); });

/** The gateway answers CONNECT_REQUESTs, but 1.5 s late — long enough for stop() to run first, short of the 5 s connect timeout. */
const slowConnectResponse = (): void => { w.net.addRule({ match: (p) => p.service === ServiceType.CONNECT_RESPONSE, action: "delay", delayMs: 1_500 }); };

describe("KnxHealthService stop() while a connection attempt is in flight", () => {
  it("never leaves a connected tunnel, an attached feed or a running monitor behind", async () => {
    w = createWorld(); svc = make(); slowConnectResponse();
    const started = svc.start();
    await w.clock.advance(100);                       // CONNECT_REQUEST sent, response still in the network
    await svc.stop();
    await w.clock.advance(3_000);                     // the late CONNECT_RESPONSE arrives
    await started.catch(() => undefined);
    expect(w.iface.activeChannels).toBe(0);
    expect(svc.monitor.isRunning).toBe(false);
    expect(svc.diagnostics().connection).toMatchObject({ attachedTunnels: 0, monitorRunning: false });
    await w.clock.advance(600_000);
    expect(w.iface.counters.connects).toBeLessThanOrEqual(1);
    expect(w.leaks()).toEqual({ timers: 0, sockets: 0, channels: 0 });
  });

  it("stop() during a RECOVERY attempt behaves the same", async () => {
    w = createWorld(); svc = make();
    const first = svc.start(); await w.until(first);
    w.iface.kickChannel(w.tunnels[0]!.diagnostics().channelId!);
    await w.clock.advance(500);                       // link down, reconnect timer pending
    slowConnectResponse();
    await w.clock.advance(2_000);                     // attempt in flight
    await svc.stop();
    await w.clock.advance(3_000);
    expect(w.iface.activeChannels).toBe(0);
    expect(svc.monitor.isRunning).toBe(false);
    await w.clock.advance(600_000);
    expect(w.leaks()).toEqual({ timers: 0, sockets: 0, channels: 0 });
  });
});

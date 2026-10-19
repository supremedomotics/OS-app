import { afterEach, describe, expect, it } from "vitest";
import { ServiceType } from "../native/knxnetip-frame.js";
import { createSingleSlotConnectionFactory } from "../native/single-slot.js";
import { createWorld, GA, IA, type World } from "../native/simulator/test-world.js";
import type { HealthConfig } from "./health-model.js";
import { NativeKnxHealthAttachment } from "./native-health-attachment.js";
import { createNativeConnectionWithHealth, type NativeConnectionWithHealth } from "./native-health-factory.js";

/** SIMULATOR ONLY. Lifecycle contract of the connection + health pair (see native-health-factory.ts). Not wired into any production path. */
const HCFG: Partial<HealthConfig> = { checkIntervalMs: 30_000, passiveFreshnessMs: 60_000, activeFreshnessMs: 120_000, responseTimeoutMs: 3_000, retryDelayMs: 1_000 };
let w: World;
const pairs: NativeConnectionWithHealth[] = [];
afterEach(async () => {
  for (const p of pairs.splice(0)) { const d = p.dispose(); await w.clock.advance(100); await d.catch(() => undefined); }
  for (const c of w.connections) { const d = c.disconnect(); await w.clock.advance(100); await d.catch(() => undefined); }
  await w.clock.advance(300_000); w.iface.shutdown();
  expect(w.leaks()).toEqual({ timers: 0, sockets: 0, channels: 0 });
});
const make = (extra: Record<string, unknown> = {}): NativeConnectionWithHealth => {
  const p = createNativeConnectionWithHealth({ createTunnel: w.createTunnel, clock: w.clock, health: HCFG, reconnect: { minBackoffMs: 2_000, maxBackoffMs: 20_000, random: () => 0.5 }, ...extra });
  p.health.monitor.registerDevice({ deviceId: "a", individualAddress: IA("1.1.10"), statusGroups: [GA("1/0/2")], activeCheck: "allowed" });
  pairs.push(p); w.connections.push(p.connection);
  return p;
};
const state = (p: NativeConnectionWithHealth) => ({ ...p.health.diagnostics(), subs: p.connection.diagnostics().bus.activeSubscriptions });

describe("native connection + health pair", () => {
  it("refuses a caller-supplied onLinkUp instead of silently replacing it", () => {
    w = createWorld();
    expect(() => createNativeConnectionWithHealth({ createTunnel: w.createTunnel, clock: w.clock, onLinkUp: () => undefined } as never)).toThrow(/owns the onLinkUp hook/);
  });

  it("failed startup: the hook never ran, nothing is attached or running, dispose is clean and idempotent", async () => {
    w = createWorld({ interface: { maxTunnels: 1 } });
    w.iface.faults.refuseConnectStatus = 0x24;
    const p = make();
    const r = p.connection.connect().then(() => "up", (e: { code?: string }) => e.code);
    expect(await w.until(r, 2_000)).toBe("connect_rejected");
    expect(state(p)).toMatchObject({ attached: false, linkUps: 0, subscriptions: 0, monitorRunning: false, subs: 0 });
    await w.until(p.dispose(), 2_000);
    await w.until(p.dispose(), 2_000);
    expect(w.leaks()).toEqual({ timers: 0, sockets: 0, channels: 0 });
  });

  it("dispose() during an in-flight connect: the late tunnel is closed orderly and the attachment never attaches", async () => {
    w = createWorld({ interface: { maxTunnels: 1 } });
    w.net.addRule({ match: (x) => x.service === ServiceType.CONNECT_RESPONSE, action: "delay", delayMs: 1_500, times: 1 });
    const p = make();
    const r = p.connection.connect().then(() => "up", (e: { code?: string }) => e.code);
    await w.clock.advance(50);
    const d = p.dispose();
    expect(await w.until(r, 100)).toBe("closed");
    await w.until(d, 6_000);
    await w.clock.advance(5_000);
    expect(state(p)).toMatchObject({ attached: false, linkUps: 0, subscriptions: 0, monitorRunning: false });
    expect(w.iface.activeChannels).toBe(0);
  });

  it("reconnects: one subscription and one monitor loop after each of three outages; budget and tunnel are the connection's", async () => {
    w = createWorld({ interface: { maxTunnels: 1 } });
    w.actuator("1.1.10", "1/0/1", "1/0/2");
    const p = make();
    await w.until(p.connection.connect(), 2_000);
    for (let i = 1; i <= 3; i++) {
      w.iface.reboot(30_000);
      await w.clock.advance(28_000);
      expect(state(p)).toMatchObject({ attached: false, subscriptions: 0, monitorRunning: false, subs: 0 });
      await w.clock.advance(60_000);
      expect(state(p)).toMatchObject({ attached: true, subscriptions: 1, monitorRunning: true, subs: 1, linkUps: i + 1, linkDowns: i });
    }
    expect(w.iface.counters.refusedConnects).toBe(0);
    expect(p.connection.diagnostics().readBudget.healthStartedLastMinute).toBeLessThanOrEqual(p.connection.diagnostics().readBudget.startedLastMinute);
  });

  it("shutdown: dispose() releases subscription, monitor and tunnel, is idempotent, and a disposed attachment never re-attaches", async () => {
    w = createWorld({ interface: { maxTunnels: 1 } });
    const p = make();
    await w.until(p.connection.connect(), 2_000);
    await w.clock.advance(40_000);
    await w.until(p.dispose(), 6_000);
    await w.until(p.dispose(), 6_000);
    expect(state(p)).toMatchObject({ attached: false, subscriptions: 0, monitorRunning: false });
    expect(p.health.onLinkUp({ tunnel: null as never, bus: p.connection.bus, reads: null as never })).toBeUndefined();
    expect(p.health.diagnostics().attached).toBe(false);
    expect(w.iface.activeChannels).toBe(0);
  });

  it("replacement through the single-slot factory: the predecessor's pair is cleaned up by its link-down, the successor's attaches, one tunnel throughout", async () => {
    w = createWorld({ interface: { maxTunnels: 1 } });
    const factory = createSingleSlotConnectionFactory(() => make().connection);
    const c1 = await factory({ host: "10.0.0.2", port: 3671 });
    await w.until(c1.connect(), 2_000);
    const first = pairs[0]!;
    expect(first.health.diagnostics().attached).toBe(true);
    const c2p = factory({ host: "10.0.0.2", port: 3671 });
    const c2 = await w.until(c2p, 8_000);
    await w.until(c2.connect(), 3_000);
    const second = pairs[1]!;
    expect(first.health.diagnostics()).toMatchObject({ attached: false, subscriptions: 0, monitorRunning: false });
    expect(second.health.diagnostics()).toMatchObject({ attached: true, subscriptions: 1, monitorRunning: true });
    expect(w.iface.counters.refusedConnects).toBe(0);
    expect(w.iface.activeChannels).toBe(1);
  });
});

describe("one attachment hooked to two connections (misuse): a stale cleanup cannot tear down the newer link", () => {
  it("disconnecting the older connection leaves the newer one monitored", async () => {
    w = createWorld({ interface: { maxTunnels: 4 } });
    const health = new NativeKnxHealthAttachment({ clock: w.clock, health: HCFG });
    const c1 = w.connection({ onLinkUp: health.onLinkUp });
    const c2 = w.connection({ onLinkUp: health.onLinkUp });
    await w.until(c1.connect(), 2_000);
    await w.until(c2.connect(), 2_000);
    expect(health.diagnostics()).toMatchObject({ attached: true, subscriptions: 1, monitorRunning: true, linkUps: 2 });
    await w.until(c1.disconnect(), 6_000);                      // c1's cleanup is stale: the attachment now belongs to c2
    expect(health.diagnostics()).toMatchObject({ attached: true, subscriptions: 1, monitorRunning: true });
    await w.until(c2.disconnect(), 6_000);
    expect(health.diagnostics()).toMatchObject({ attached: false, subscriptions: 0, monitorRunning: false });
  });
});

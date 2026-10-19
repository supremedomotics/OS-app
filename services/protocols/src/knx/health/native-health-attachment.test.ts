import { afterEach, describe, expect, it } from "vitest";
import { createWorld, GA, IA, type World } from "../native/simulator/test-world.js";
import type { BusTelegram } from "../native/simulator/virtual-bus.js";
import { KnxProtocolDriver } from "../../knx-driver.js";
import type { HealthConfig } from "./health-model.js";
import { NativeKnxHealthAttachment } from "./native-health-attachment.js";

/**
 * SIMULATOR ONLY. The health monitor attached to a NativeKnxConnection's own tunnel (onLinkUp hook) against a virtual gateway with ONE tunnel slot:
 * the whole production-shaped path — driver → connection → shared read budget → health attachment → monitor — with exactly one tunnel. Nothing
 * here says anything about a real gateway or real devices.
 */
const HCFG: Partial<HealthConfig> = {
  checkIntervalMs: 30_000, passiveFreshnessMs: 60_000, activeFreshnessMs: 120_000, offlineMinSilenceMs: 300_000, failureRecheckMs: 20_000,
  offlineProbeIntervalMs: 120_000, responseTimeoutMs: 3_000, retryDelayMs: 1_000, slowResponseMs: 1_500, busFreshnessMs: 120_000,
};
let w: World;
let line: BusTelegram[];
afterEach(async () => { for (const c of w.connections) { const p = c.disconnect(); await w.clock.advance(100); await p.catch(() => undefined); } await w.clock.advance(300_000); w.iface.shutdown(); expect(w.leaks()).toEqual({ timers: 0, sockets: 0, channels: 0 }); });

function rig(opts: { mode?: "active" | "observe_only"; readBudget?: { maxPerMinute?: number; healthShare?: number }; maxTunnels?: number } = {}) {
  w = createWorld({ interface: { maxTunnels: opts.maxTunnels ?? 1 } });
  line = [];
  w.bus.monitor((t) => line.push(t));
  w.actuator("1.1.10", "1/0/1", "1/0/2");
  const health = new NativeKnxHealthAttachment({ clock: w.clock, health: HCFG });
  health.monitor.registerDevice({ deviceId: "dev-a", individualAddress: IA("1.1.10"), statusGroups: [GA("1/0/2")], activeCheck: "allowed" });
  const connection = w.connection({ onLinkUp: health.onLinkUp, ...(opts.mode ? { mode: opts.mode } : {}), ...(opts.readBudget ? { readBudget: opts.readBudget } : {}) });
  return { health, connection };
}
const reads = (): BusTelegram[] => line.filter((t) => t.service === "read");
const state = (h: NativeKnxHealthAttachment) => h.monitor.snapshot().devices[0]!;

describe("health monitor on the connection's own tunnel", () => {
  it("probes a device through the SAME single tunnel: one channel on a one-slot gateway, no second tunnel, read-only on the line", async () => {
    const { health, connection } = rig();
    await w.until(connection.connect(), 2_000);
    expect(health.diagnostics()).toMatchObject({ attached: true, subscriptions: 1, monitorRunning: true });
    await w.clock.advance(120_000);
    expect(w.tunnels).toHaveLength(1);
    expect(w.iface.counters.connects).toBe(1);
    expect(w.iface.counters.refusedConnects).toBe(0);
    expect(w.iface.activeChannels).toBe(1);
    expect(reads().length).toBeGreaterThanOrEqual(1);                       // the monitor really probed…
    expect(line.filter((t) => t.source === w.iface.channelAddresses()[0] && t.service !== "read")).toEqual([]); // …and the tunnel sent nothing but reads
    expect(state(health).lastResponseAt).not.toBeNull();                      // the actuator's response came back through the bus subscription
  });

  it("observe-only connection: the health monitor cannot put even a GroupValueRead on the line", async () => {
    const { health, connection } = rig({ mode: "observe_only" });
    await w.until(connection.connect(), 2_000);
    await w.clock.advance(200_000);
    expect(reads()).toEqual([]);
    expect(health.diagnostics().readsRefused).toBeGreaterThan(0);
    expect(w.iface.counters.tunnellingRequests).toBe(0);
  });

  it("three outages: exactly one subscription, one monitor loop and one tunnel after every recovery — nothing duplicated, nothing leaked while down", async () => {
    const { health, connection } = rig();
    await w.until(connection.connect(), 2_000);
    const base = connection.diagnostics().bus.activeSubscriptions;
    expect(base).toBe(1);
    for (let i = 1; i <= 3; i++) {
      w.iface.reboot(30_000);
      await w.clock.advance(28_000);
      expect(connection.linkState).toBe("recovering");
      expect(health.diagnostics()).toMatchObject({ attached: false, subscriptions: 0, monitorRunning: false });
      expect(connection.diagnostics().bus.activeSubscriptions).toBe(0);
      expect(health.monitor.snapshot().path).toMatchObject({ interface: "down" });
      await w.clock.advance(60_000);
      expect(connection.linkState).toBe("up");
      expect(health.diagnostics()).toMatchObject({ attached: true, subscriptions: 1, monitorRunning: true, linkUps: i + 1, linkDowns: i });
      expect(connection.diagnostics().bus.activeSubscriptions).toBe(base);
      expect(w.iface.activeChannels).toBe(1);
    }
    expect(w.connections).toHaveLength(1);
    expect(w.iface.counters.connects).toBe(4);                                // 1 initial + 3 recoveries (failed attempts during an outage never reach the gateway), never two at once
    expect(w.iface.counters.refusedConnects).toBe(0);                         // a one-slot gateway never had to refuse anything
    // one loop: after recovery the number of probes per interval is the monitor's own budget, not a multiple of it
    const before = reads().length;
    await w.clock.advance(60_000);
    expect(reads().length - before).toBeLessThanOrEqual(2);
  });

  it("the driver, ordinary sync reads and the health probes share ONE read budget on ONE tunnel", async () => {
    const { health, connection } = rig({ readBudget: { maxPerMinute: 6, healthShare: 0.5 } });
    const driver = new KnxProtocolDriver({ host: "10.0.0.2", createConnection: async () => connection });
    await driver.bind({ deviceId: "dev-a" as never, capability: "onoff", address: "1/0/1", config: { statusAddress: "1/0/2", dpt: "DPT1.001" } });
    health.monitor.registerDevice({ deviceId: "dev-b", individualAddress: IA("1.1.99"), statusGroups: [GA("1/0/9")], activeCheck: "allowed" }); // silent: it has to be probed
    await w.until(driver.connect(), 2_000);
    // ordinary synchronisation takes the whole minute's budget …
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i++) { const p = connection.read("1/0/2", "DPT1.001").then((r) => r.outcome, (e: { code: string }) => e.code); await w.until(p, 1_000); outcomes.push(await p); }
    expect(outcomes.every((o) => o === "value")).toBe(true);
    await expect(connection.read("1/0/2", "DPT1.001")).rejects.toMatchObject({ code: "read_limit", outcome: "not_sent" });
    // … so the health monitor's probe in the same minute is refused by the budget (inconclusive), not sent
    const probesBefore = reads().length;
    await w.clock.advance(30_000);
    expect(reads().length).toBe(probesBefore);
    expect(connection.diagnostics().readBudget.refused.rate + connection.diagnostics().readBudget.refused.health_share).toBeGreaterThan(0);
    expect(health.diagnostics().readsRefused).toBeGreaterThan(0);
    // the window slides: probing resumes on the same tunnel
    await w.clock.advance(120_000);
    expect(reads().length).toBeGreaterThan(probesBefore);
    expect(w.tunnels).toHaveLength(1);
    expect(driver.isConnected()).toBe(true);
    await w.until(driver.disconnect(), 6_000);
  });

  it("health probes never take more than their share: with sync idle they stop at the share, leaving the rest for synchronisation", async () => {
    const { connection } = rig({ readBudget: { maxPerMinute: 4, healthShare: 0.25 } });   // health: 1 per minute
    await w.until(connection.connect(), 2_000);
    await w.clock.advance(55_000);
    expect(connection.diagnostics().readBudget.healthStartedLastMinute).toBeLessThanOrEqual(1);
    for (let i = 0; i < 3; i++) await w.until(connection.read("1/0/2", "DPT1.001"), 1_000);  // sync still has its 3 reads
  });

  it("disconnect(): subscription, probes and timers are gone; the monitor does not outlive the link", async () => {
    const { health, connection } = rig();
    await w.until(connection.connect(), 2_000);
    await w.clock.advance(40_000);
    await w.until(connection.disconnect(), 6_000);
    expect(health.diagnostics()).toMatchObject({ attached: false, subscriptions: 0, monitorRunning: false });
    await w.clock.advance(200_000);
    expect(w.iface.activeChannels).toBe(0);
  });

  it("replacement on a one-slot gateway keeps working: the replaced connection's monitor stops, the new one's starts, still one tunnel at a time", async () => {
    w = createWorld({ interface: { maxTunnels: 1 } });
    w.actuator("1.1.10", "1/0/1", "1/0/2");
    const mk = () => { const h = new NativeKnxHealthAttachment({ clock: w.clock, health: HCFG }); h.monitor.registerDevice({ deviceId: "d", individualAddress: IA("1.1.10"), statusGroups: [GA("1/0/2")], activeCheck: "allowed" }); return h; };
    const h1 = mk(); const h2 = mk();
    const c1 = w.connection({ onLinkUp: h1.onLinkUp });
    await w.until(c1.connect(), 2_000);
    await w.clock.advance(5_000);
    const d1 = c1.disconnect();
    await w.until(d1, 6_000);
    const c2 = w.connection({ onLinkUp: h2.onLinkUp });
    await w.until(c2.connect(), 3_000);
    expect(h1.diagnostics()).toMatchObject({ attached: false, monitorRunning: false });
    expect(h2.diagnostics()).toMatchObject({ attached: true, monitorRunning: true });
    expect(w.iface.counters.refusedConnects).toBe(0);
    expect(w.iface.activeChannels).toBe(1);
  });
});


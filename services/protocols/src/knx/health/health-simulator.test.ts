import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseGroupAddress, parseIndividualAddress } from "../native/address.js";
import { CemiMessageCode, decodeCemi } from "../native/cemi.js";
import { decodeFrame, decodeTunnellingRequest, ServiceType } from "../native/knxnetip-frame.js";
import { ManualClock, VirtualActuator, VirtualKnxBus, VirtualKnxInterface, VirtualNetwork, VirtualSender } from "../native/simulator/index.js";
import type { KnxDatagramSocket, SocketFactory, SocketHandlers } from "../native/transport.js";
import { KnxTunnelClient } from "../native/tunnel-client.js";
import type { HealthConfig } from "./health-model.js";
import { KnxHealthMonitor, type ReadOnlyGroupBus } from "./health-monitor.js";
import { attachTunnelHealth, readOnlyBusFromTunnel } from "./tunnel-health-adapter.js";

/**
 * Health monitoring over the REAL native tunnel client, a simulated KNX/IP interface and a simulated line with modelled devices. Simulator evidence only:
 * it proves the monitor's logic and its safety against a model, not how any real gateway or device behaves.
 */
const GW = "10.0.0.2";
const IA = (s: string) => parseIndividualAddress(s);
const GA = (s: string) => parseGroupAddress(s);
const CFG: Partial<HealthConfig> = {
  checkIntervalMs: 60_000, passiveFreshnessMs: 180_000, activeFreshnessMs: 300_000, offlineMinSilenceMs: 300_000, failureRecheckMs: 20_000,
  offlineProbeIntervalMs: 120_000, responseTimeoutMs: 3_000, retryDelayMs: 1_000, slowResponseMs: 1_500, busFreshnessMs: 120_000,
};
const TUNNEL_OPTS = { heartbeatIntervalMs: 20_000, heartbeatTimeoutMs: 2_000, heartbeatMaxFailures: 2 };

let clock: ManualClock; let net: VirtualNetwork; let bus: VirtualKnxBus; let iface: VirtualKnxInterface;
let sentFrames: Buffer[]; let monitor: KnxHealthMonitor; let detach: () => void;
let tunnel: KnxTunnelClient | null; let talking = false;
const port: { current: ReadOnlyGroupBus | null; readGroup(ga: number): Promise<void> } = { current: null, readGroup: (ga) => port.current!.readGroup(ga) };
const act: Record<string, VirtualActuator> = {};
let wallSwitch: VirtualSender;

function loggedFactory(inner: SocketFactory): SocketFactory {
  return async (h: SocketHandlers) => {
    const s = await inner(h);
    const w: KnxDatagramSocket = { get localPort() { return s.localPort; }, send: (d, p, a) => { sentFrames.push(Buffer.from(d)); s.send(d, p, a); }, close: () => s.close() };
    return w;
  };
}
function actuator(name: string, ia: string, cmd: string, status: string): VirtualActuator {
  const a = new VirtualActuator({ individualAddress: IA(ia), commandGa: GA(cmd), feedbackGa: GA(status), dpt: "1.001", initial: false }, clock);
  bus.addDevice(a); act[name] = a; return a;
}
/** (Re)connects a fresh single-use tunnel client and points the monitor at it, as the future supervisor will. */
async function connectTunnel(clientIp: string): Promise<void> {
  detach?.();
  tunnel = new KnxTunnelClient({ host: GW, socketFactory: loggedFactory(net.createSocketFactory(clientIp)), clock, ...TUNNEL_OPTS });
  const p = tunnel.connect(); await clock.advance(10); await p;
  port.current = readOnlyBusFromTunnel(tunnel, monitor);
  detach = attachTunnelHealth(monitor, tunnel);
}
const dev = (id: string) => monitor.snapshot().devices.find((d) => d.deviceId === id)!;
const stateOf = (id: string) => `${dev(id).state}/${dev(id).reason}`;
const trace = (id: string): string[] => { const s: string[] = []; monitor.onEvent((e) => { if (e.kind === "state_change" && e.deviceId === id) s.push(e.to!); }); return s; };

beforeEach(async () => {
  clock = new ManualClock(); net = new VirtualNetwork(clock, 1); bus = new VirtualKnxBus(clock); sentFrames = []; tunnel = null; talking = false;
  for (const k of Object.keys(act)) delete act[k];
  iface = new VirtualKnxInterface(net, bus, clock, { address: GW });
  monitor = new KnxHealthMonitor(clock, port, CFG);
  actuator("good", "1.1.1", "1/0/1", "1/1/1");                                         // answers reads promptly
  actuator("mute", "1.1.2", "1/0/2", "1/1/2");                                         // dies later
  actuator("noread", "1.1.3", "1/0/3", "1/1/3").faults = { noFeedback: true };         // alive, never answers reads
  actuator("slow", "1.1.4", "1/0/4", "1/1/4").faults = { feedbackDelayMs: 2_500 };     // answers, slowly
  actuator("flaky", "1.1.5", "1/0/5", "1/1/5").faults = { readResponsePattern: [true, false, false] };
  wallSwitch = new VirtualSender(IA("1.1.6")); bus.addDevice(wallSwitch);             // talks, is never asked
  await connectTunnel("10.0.0.50");
  for (const [id, ia, st] of [["good", "1.1.1", "1/1/1"], ["mute", "1.1.2", "1/1/2"], ["noread", "1.1.3", "1/1/3"], ["slow", "1.1.4", "1/1/4"], ["flaky", "1.1.5", "1/1/5"]] as const) {
    monitor.registerDevice({ deviceId: id, individualAddress: IA(ia), statusGroups: [GA(st)] });
  }
  monitor.registerDevice({ deviceId: "switch", individualAddress: IA("1.1.6"), statusGroups: [] });
  monitor.start();
});
afterEach(async () => {
  talking = false; monitor.stop(); detach();
  void tunnel?.disconnect();
  await clock.advance(100_000);
  iface.shutdown();
  expect(clock.pendingTimers).toBe(0);
  expect(net.openClientSockets).toBe(0);
});

const startWallSwitch = (): void => {
  talking = true;
  clock.setTimeout(function again() { if (!talking) return; wallSwitch.emit(bus, GA("2/0/1"), "1.001", true); clock.setTimeout(again, 90_000); }, 1_000);
};

describe("health over the real tunnel client and a simulated line", () => {
  it("responsive, slow, never-answering and passive-only devices are each classified from their own evidence", async () => {
    startWallSwitch();
    await clock.advance(10 * 60_000);
    expect(dev("good")).toMatchObject({ state: "online", reason: "active_response", confidence: "high", activeCheck: "proven" });
    expect(dev("slow")).toMatchObject({ state: "degraded", reason: "slow_response" });
    expect(dev("noread")).toMatchObject({ state: "unknown", reason: "unproven_silent", activeCheck: "candidate" });
    expect(dev("switch")).toMatchObject({ state: "online", reason: "passive_telegram", confidence: "medium", checkMethod: "passive_only" });
  });

  it("a device that answered before and then dies goes degraded, then offline (never straight to offline), and recovers when it returns", async () => {
    await clock.advance(5 * 60_000);
    expect(dev("mute").state).toBe("online");
    act["mute"]!.online = false;
    const states = trace("mute");
    await clock.advance(20 * 60_000);
    const names = states.map((s) => s.split("/")[0]);
    expect(names).toContain("degraded");
    expect(names.indexOf("degraded")).toBeLessThan(names.indexOf("offline"));
    expect(dev("mute")).toMatchObject({ state: "offline", confidence: "high" });
    act["mute"]!.online = true;
    await clock.advance(5 * 60_000);
    expect(dev("mute")).toMatchObject({ state: "online", reason: "active_response" });
  });

  it("an alive device that never answers reads is never reported degraded or offline, however long the run", async () => {
    const states = trace("noread");
    await clock.advance(3 * 3_600_000);
    expect(states.map((s) => s.split("/")[0]).filter((s) => s === "offline" || s === "degraded")).toEqual([]);
  });

  it("an intermittent responder is shown degraded at times and is never declared offline", async () => {
    const states = trace("flaky");
    await clock.advance(2 * 3_600_000);
    const names = new Set(states.map((s) => s.split("/")[0]));
    expect(names.has("offline")).toBe(false);
    expect(names.has("degraded")).toBe(true);
  });

  it("gateway disconnection: tunnel loss makes everything unknown/path_down with nothing blamed on devices; a fresh tunnel restores health", async () => {
    await clock.advance(5 * 60_000);
    expect(dev("good").state).toBe("online");
    const failuresBefore = dev("good").consecutiveFailures;
    const checksFailedBefore = monitor.snapshot().load.checksFailed;       // the never-answering device legitimately accumulates some
    iface.faults.online = false;                                                   // gateway drops off the network
    await clock.advance(10 * 60_000);
    expect(monitor.snapshot().path).toMatchObject({ gateway: "unreachable", interface: "down" });
    for (const id of ["good", "mute", "slow", "switch"]) expect(stateOf(id)).toBe("unknown/path_down");
    expect(dev("good").consecutiveFailures).toBe(failuresBefore);
    expect(monitor.snapshot().load.checksFailed).toBe(checksFailedBefore);   // nothing was counted against any device during the outage
    iface.faults.online = true;
    await connectTunnel("10.0.0.51");
    await clock.advance(10 * 60_000);
    expect(dev("good")).toMatchObject({ state: "online", reason: "active_response" });
  });

  it("gateway reboot with a replaced tunnel: no device is ever marked offline across the outage", async () => {
    await clock.advance(5 * 60_000);
    const names = new Set<string>(); monitor.onEvent((e) => { if (e.kind === "state_change") names.add(e.to!.split("/")[0]!); });
    iface.reboot(3 * 60_000);
    await clock.advance(6 * 60_000);
    await connectTunnel("10.0.0.52");
    await clock.advance(10 * 60_000);
    expect(names.has("offline")).toBe(false);
    expect(dev("good").state).toBe("online");
  });

  it("bus failure: probing is suspended, devices are unknown/bus_degraded rather than offline, and health returns when the line does", async () => {
    await clock.advance(5 * 60_000);
    expect(dev("good").state).toBe("online");
    const checksFailedBefore = monitor.snapshot().load.checksFailed;
    bus.lineFault = true;
    await clock.advance(15 * 60_000);
    const snap = monitor.snapshot();
    expect(snap.devices.filter((d) => d.state === "offline")).toHaveLength(0);
    expect(snap.path.bus === "degraded" || snap.path.bus === "unknown").toBe(true);
    expect(snap.load.checksFailed - checksFailedBefore).toBe(0);                  // a failing line is never counted against a device
    bus.lineFault = false;
    wallSwitch.emit(bus, GA("2/0/1"), "1.001", true);                              // traffic on the line again
    await clock.advance(10 * 60_000);
    expect(dev("good").state).toBe("online");
  });

  it("WIRE-LEVEL SAFETY: the monitor causes only GroupValueReads — no write, no response, no other group service ever leaves the client", async () => {
    act["mute"]!.online = false;
    await clock.advance(30 * 60_000);
    let reads = 0;
    for (const d of sentFrames) {
      let f; try { f = decodeFrame(d); } catch { continue; }
      if (f.service !== ServiceType.TUNNELLING_REQUEST) continue;
      const c = decodeCemi(decodeTunnellingRequest(f.body).cemi);
      expect(c.messageCode).toBe(CemiMessageCode.L_DATA_REQ);
      expect(c.group?.service).toBe("read");
      reads++;
    }
    expect(reads).toBeGreaterThan(5);
    expect(bus.history.filter((t) => t.source === 0xff01 && t.service !== "read")).toHaveLength(0);   // nothing of ours but reads reached the line
  });

  it("LOAD: with a mixed fleet the monitor's reads on the line stay within the configured budget and one check at a time", async () => {
    for (let i = 0; i < 30; i++) {
      const n = 10 + i;
      actuator(`x${i}`, `1.2.${n}`, `3/0/${n}`, `3/1/${n}`);
      monitor.registerDevice({ deviceId: `x${i}`, individualAddress: IA(`1.2.${n}`), statusGroups: [GA(`3/1/${n}`)] });
    }
    await clock.advance(2 * 3_600_000);
    const reads = bus.history.filter((t) => t.service === "read" && t.source === 0xff01);
    expect(reads.length).toBeGreaterThan(20);
    expect(reads.length).toBeLessThanOrEqual(2 * 60 * 6 * 2);                       // maxChecksPerMinute (6) × maxAttempts (2) over 120 minutes
    expect(monitor.snapshot().load.maxConcurrentObserved).toBe(1);
  });
});
